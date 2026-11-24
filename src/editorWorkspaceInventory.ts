import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ScarpGraphSource } from './editorImportGraph';

export interface ScarpWorkspaceInventoryOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly signal?: AbortSignal;
}
export interface ScarpWorkspaceInventoryIssue {
  readonly file: string;
  readonly reason:
    'outside-root' | 'symlink' | 'not-file' | 'oversized' |
    'invalid-utf8' | 'unreadable' | 'limit' | 'aborted';
}
export interface ScarpWorkspaceInventory {
  readonly sources: readonly ScarpGraphSource[];
  readonly issues: readonly ScarpWorkspaceInventoryIssue[];
  readonly byteCount: number;
}
const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 16_000_000;
function positive(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function within(root: string, filename: string): boolean {
  const rel = path.relative(root, filename);
  return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel);
}
function isOrdinaryRelative(filename: string): boolean {
  if (!filename || path.isAbsolute(filename) || filename.includes('\0') ||
      filename.includes('\\') || filename.includes(':')) { return false; }
  const parts = filename.split('/');
  return filename.endsWith('.srp') &&
    parts.every(part => part !== '' && part !== '.' && part !== '..');
}
function formatRelative(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join('/');
}
/**
 * Safe, bounded, read-only inventory for an explicitly selected local root.
 * The caller supplies candidate source filenames; there is no recursive
 * filesystem walker, shell, compiler process, network access or file rewrite.
 *
 * Every candidate is checked with realpath, and symbolic files are rejected.
 * Any parent-directory symlink resolving outside the selected workspace root
 * is rejected even if the original string appears to be contained by root.
 */
export async function collectScarpWorkspaceSources(
  root: string, filenames: readonly string[],
  options: ScarpWorkspaceInventoryOptions = {}
): Promise<ScarpWorkspaceInventory> {
  const maxFiles = positive(options.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = positive(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const issues: ScarpWorkspaceInventoryIssue[] = [];
  const sources: ScarpGraphSource[] = [];
  if (!maxFiles || !maxFileBytes || !maxTotalBytes || !path.isAbsolute(root)) {
    return { sources, issues: [{ file: root, reason: 'limit' }], byteCount: 0 };
  }
  let realRoot: string;
  try { realRoot = await fs.realpath(root); }
  catch {
    return { sources, issues: [{ file: root, reason: 'unreadable' }], byteCount: 0 };
  }
  let byteCount = 0;
  const seen = new Set<string>();
  // Sorting makes results stable independent of the order returned by
  // editor file discovery on different filesystems and operating systems.
  for (const filename of [...filenames].sort()) {
    if (options.signal?.aborted) {
      issues.push({ file: '', reason: 'aborted' });
      break;
    }
    if (sources.length >= maxFiles) {
      issues.push({ file: '', reason: 'limit' });
      break;
    }
    if (!path.isAbsolute(filename) || !within(root, filename)) {
      issues.push({ file: filename, reason: 'outside-root' });
      continue;
    }
    const relative = formatRelative(root, filename);
    if (!isOrdinaryRelative(relative)) {
      issues.push({ file: filename, reason: 'outside-root' });
      continue;
    }
    let realFilename: string;
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      [realFilename, info] = await Promise.all([fs.realpath(filename), fs.lstat(filename)]);
    } catch {
      issues.push({ file: filename, reason: 'unreadable' });
      continue;
    }
    if (!within(realRoot, realFilename)) {
      issues.push({ file: filename, reason: 'outside-root' });
      continue;
    }
    if (info.isSymbolicLink()) {
      issues.push({ file: filename, reason: 'symlink' });
      continue;
    }
    if (!info.isFile()) {
      issues.push({ file: filename, reason: 'not-file' });
      continue;
    }
    if (seen.has(realFilename)) { continue; }
    seen.add(realFilename);
    if (info.size > maxFileBytes ||
        byteCount + info.size > maxTotalBytes) {
      issues.push({ file: filename, reason: 'oversized' });
      continue;
    }
    let bytes: Buffer;
    try {
      // A file may grow between lstat and read. Fail closed if so, before
      // consuming the larger buffer as a compiler source snapshot.
      bytes = await fs.readFile(filename);
    } catch {
      issues.push({ file: filename, reason: 'unreadable' });
      continue;
    }
    if (options.signal?.aborted) {
      issues.push({ file: '', reason: 'aborted' });
      break;
    }
    if (bytes.length > maxFileBytes ||
        byteCount + bytes.length > maxTotalBytes) {
      issues.push({ file: filename, reason: 'oversized' });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      issues.push({ file: filename, reason: 'invalid-utf8' });
      continue;
    }
    sources.push({ file: relative, source: text });
    byteCount += bytes.length;
  }
  return { sources, issues, byteCount };
}
