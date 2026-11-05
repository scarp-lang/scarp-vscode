import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { isWithinProject } from './projectChangeTracker';

/**
 * Bounded, local filesystem fingerprint for an explicit Scarp project.
 * Capture the manifest and all .srp source bytes, including symlinked files,
 * before and after the official compiler's static verification.
 *
 * Standalone navigation can opt out of requiring a root manifest while
 * retaining the same bounded source hashing and symlink protection.
 *
 * Directories linked outside the project are not traversed. Oversized or
 * unmonitorable trees fail closed instead of accepting possibly stale errors.
 * A snapshot is not a continuous background filesystem watcher.
 */
export type ProjectDiskSnapshot = ReadonlyMap<string, string>;

const MAX_ENTRIES = 20_000;
const MAX_SCARP_FILES = 4_096;
const MAX_DEPTH = 32;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

function signature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size,
    stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function isInput(relativePath: string): boolean {
  return relativePath === 'Scarp.project' ||
    path.extname(relativePath).toLowerCase() === '.srp';
}

/** Detect rewrites even when a tool restores size/mtime after saving. */
async function fingerprint(file: string, before: BigIntStats): Promise<string> {
  const hash = createHash('sha256');
  let readBytes = 0n;
  // Streaming keeps a concurrent file growth from allocating an unbounded
  // Buffer in the VS Code Extension Host.
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const bytes = chunk as Buffer;
    readBytes += BigInt(bytes.length);
    if (readBytes > before.size || readBytes > BigInt(MAX_SOURCE_BYTES)) {
      throw new Error('Scarp source changed or exceeded the snapshot byte limit: ' + file);
    }
    hash.update(bytes);
  }
  const after = await fs.stat(file, { bigint: true });
  if (signature(before) !== signature(after) || readBytes !== before.size) {
    throw new Error('Scarp source changed while taking a disk snapshot: ' + file);
  }
  return signature(after) + ':' + hash.digest('hex');
}

export async function snapshotProjectDisk(
  root: string, requireManifest = true
): Promise<ProjectDiskSnapshot> {
  const rootPath = path.resolve(root);
  const canonicalRoot = await fs.realpath(rootPath);
  const result = new Map<string, string>();
  const stack: Array<{ directory: string; depth: number }> = [
    { directory: rootPath, depth: 0 }
  ];
  let entries = 0;
  let totalBytes = 0n;

  while (stack.length) {
    const { directory, depth } = stack.pop()!;
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    for (const child of children) {
      if (++entries > MAX_ENTRIES) {
        throw new Error('Scarp project has too many filesystem entries to verify safely.');
      }

      const absolute = path.join(directory, child.name);
      const relative = path.relative(rootPath, absolute);

      if (child.isSymbolicLink()) {
        const link = await fs.lstat(absolute, { bigint: true });
        const target = await fs.stat(absolute, { bigint: true });
        if (target.isDirectory()) {
          throw new Error('Scarp project contains an unmonitored symlinked directory: ' +
            relative);
        }
        if (isInput(relative)) {
          if (!target.isFile()) { throw new Error('Scarp input is not a file: ' + relative); }
          const canonical = await fs.realpath(absolute);
          if (!isWithinProject(canonicalRoot, canonical)) {
            throw new Error('Scarp input symlink escapes the project: ' + relative);
          }
          totalBytes += target.size;
          if (totalBytes > BigInt(MAX_SOURCE_BYTES)) {
            throw new Error('Scarp project source bytes exceed the disk snapshot limit.');
          }
          const digest = await fingerprint(absolute, target);
          const linkAfter = await fs.lstat(absolute, { bigint: true });
          if (signature(link) !== signature(linkAfter)) {
            throw new Error('Scarp source symlink changed during verification: ' + relative);
          }
          result.set(relative, signature(link) + ' -> ' + digest);
          if (result.size > MAX_SCARP_FILES) {
            throw new Error('Scarp project has too many source files to verify safely.');
          }
        }
        continue;
      }

      if (child.isDirectory()) {
        if (depth >= MAX_DEPTH) {
          throw new Error('Scarp project directory nesting exceeds the verification limit.');
        }
        stack.push({ directory: absolute, depth: depth + 1 });
      } else if (isInput(relative)) {
        const stat = await fs.lstat(absolute, { bigint: true });
        if (!stat.isFile()) {
          throw new Error('Scarp input is not a regular file: ' + relative);
        }
        totalBytes += stat.size;
        if (totalBytes > BigInt(MAX_SOURCE_BYTES)) {
          throw new Error('Scarp project source bytes exceed the disk snapshot limit.');
        }
        result.set(relative, await fingerprint(absolute, stat));
      }

      if (result.size > MAX_SCARP_FILES) {
        throw new Error('Scarp project has too many source files to verify safely.');
      }
    }
  }

  if (requireManifest && !result.has('Scarp.project')) {
    throw new Error('Scarp project manifest disappeared during verification.');
  }
  return result;
}

export function sameProjectDisk(
  first: ProjectDiskSnapshot, second: ProjectDiskSnapshot
): boolean {
  if (first.size !== second.size) { return false; }
  for (const [file, fingerprintValue] of first) {
    if (second.get(file) !== fingerprintValue) { return false; }
  }
  return true;
}
