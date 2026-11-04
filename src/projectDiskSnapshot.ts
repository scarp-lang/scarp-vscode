import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Bounded, local filesystem fingerprint for an explicit Scarp project.
 * Only the manifest and .srp sources affect the compiler's static results.
 * Do not follow symlinked directories: their contents cannot be safely
 * bounded using the project tree alone.
 *
 * This detects changes to file identity, size and high-resolution timestamps,
 * not adversarial same-metadata rewrites. It never reads source contents.
 */
export type ProjectDiskSnapshot = ReadonlyMap<string, string>;

const MAX_ENTRIES = 20_000;
const MAX_SCARP_FILES = 4_096;
const MAX_DEPTH = 32;

function signature(stat: Awaited<ReturnType<typeof fs.lstat>>): string {
  return [stat.dev, stat.ino, stat.mode, stat.size,
    stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

/** True for Scarp inputs, excluding files unrelated to the compiler. */
function isInput(relativePath: string): boolean {
  return relativePath === 'Scarp.project' ||
    path.extname(relativePath).toLowerCase() === '.srp';
}

export async function snapshotProjectDisk(root: string): Promise<ProjectDiskSnapshot> {
  const rootPath = path.resolve(root);
  const result = new Map<string, string>();
  const stack: Array<{ directory: string; depth: number }> = [
    { directory: rootPath, depth: 0 }
  ];
  let entries = 0;

  while (stack.length) {
    const { directory, depth } = stack.pop()!;
    const children = await fs.readdir(directory, { withFileTypes: true });
    // A deterministic traversal also makes snapshot comparisons predictable.
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    for (const child of children) {
      if (++entries > MAX_ENTRIES) {
        throw new Error('Scarp project has too many filesystem entries to verify safely.');
      }

      const absolute = path.join(directory, child.name);
      const relative = path.relative(rootPath, absolute);

      if (child.isSymbolicLink()) {
        // The compiler can follow a .srp symlink. Capture the target's
        // metadata as well as the link's own identity.
        const link = await fs.lstat(absolute, { bigint: true });
        const target = await fs.stat(absolute, { bigint: true });
        if (target.isDirectory()) {
          throw new Error('Scarp project contains an unmonitored symlinked directory: ' +
            relative);
        }
        if (isInput(relative)) {
          if (!target.isFile()) {
            throw new Error('Scarp input is not a file: ' + relative);
          }
          result.set(relative, signature(link) + ' -> ' + signature(target));
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
        result.set(relative, signature(stat));
      }

      if (result.size > MAX_SCARP_FILES) {
        throw new Error('Scarp project has too many source files to verify safely.');
      }
    }
  }

  if (!result.has('Scarp.project')) {
    throw new Error('Scarp project manifest disappeared during verification.');
  }
  return result;
}

export function sameProjectDisk(
  first: ProjectDiskSnapshot, second: ProjectDiskSnapshot
): boolean {
  if (first.size !== second.size) { return false; }
  for (const [file, fingerprint] of first) {
    if (second.get(file) !== fingerprint) { return false; }
  }
  return true;
}
