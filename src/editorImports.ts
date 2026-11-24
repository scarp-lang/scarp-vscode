import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  scanScarpStructure, type ScarpImport, type ScarpStructure
} from './editorStructure';

export interface ScarpImportLink {
  readonly start: number;
  readonly end: number;
  readonly relativePath: string;
  readonly alias: string;
  readonly target: string;
}
export interface ScarpImportCheck {
  readonly safe: boolean;
  readonly reason?: string;
}
/**
 * Published Scarp imports name relative source files with forward slashes.
 * Reject external URLs, drive paths, traversal, encoded components, controls,
 * and ambiguous separators. We must not guess future compiler escape syntax.
 */
export function checkScarpImportPath(value: string): ScarpImportCheck {
  if (!value || value.length > 512) {
    return { safe: false, reason: 'Import path must be 1–512 characters.' };
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { safe: false, reason: 'Import path contains control characters.' };
  }
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') ||
      path.isAbsolute(value)) {
    return { safe: false, reason: 'Import path must be a relative POSIX path.' };
  }
  if (value.includes('%')) {
    return { safe: false, reason: 'Encoded paths are not linked.' };
  }
  if (!value.endsWith('.srp')) {
    return { safe: false, reason: 'Import must reference a .srp source file.' };
  }
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return { safe: false, reason: 'Import contains an unsafe path component.' };
  }
  return { safe: true };
}
function within(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel);
}
export interface ImportResolveOptions {
  readonly workspaceRoot: string;
  readonly sourceFilename: string;
}
/**
 * Pure lexical path qualification. The caller MUST also resolve realpaths
 * before returning this result as a clickable VS Code navigation target.
 */
export function resolveScarpImportPath(
  name: string, options: ImportResolveOptions
): string | undefined {
  if (!checkScarpImportPath(name).safe ||
      !path.isAbsolute(options.sourceFilename) ||
      !path.isAbsolute(options.workspaceRoot) ||
      !within(options.workspaceRoot, options.sourceFilename)) { return undefined; }
  const target = path.resolve(path.dirname(options.sourceFilename),
    ...name.split('/'));
  return within(options.workspaceRoot, target) ? target : undefined;
}
/**
 * Real filesystem containment gate, including symlink escapes. This is read
 * only, never evaluates the source, and does not follow non-file URL schemes.
 */
export async function resolveExistingScarpImport(
  name: string, options: ImportResolveOptions
): Promise<string | undefined> {
  const candidate = resolveScarpImportPath(name, options);
  if (!candidate) { return undefined; }
  try {
    const [realRoot, realSource, realTarget, targetStat] = await Promise.all([
      fs.realpath(options.workspaceRoot),
      fs.realpath(options.sourceFilename),
      fs.realpath(candidate),
      fs.stat(candidate)
    ]);
    if (!targetStat.isFile() || !within(realRoot, realSource) ||
        !within(realRoot, realTarget)) { return undefined; }
    return realTarget;
  } catch { return undefined; }
}
export async function scarpImportLinksFromStructure(
  structure: ScarpStructure, options: ImportResolveOptions
): Promise<readonly ScarpImportLink[]> {
  const result: ScarpImportLink[] = [];
  for (const item of structure.imports) {
    const target = await resolveExistingScarpImport(item.path, options);
    if (!target) { continue; }
    result.push({
      start: item.pathSpan.start, end: item.pathSpan.end,
      relativePath: item.path, alias: item.alias, target
    });
  }
  return result;
}
export async function scarpImportLinks(
  source: string, options: ImportResolveOptions
): Promise<readonly ScarpImportLink[]> {
  const parsed = scanScarpStructure(source);
  return parsed ? scarpImportLinksFromStructure(parsed, options) : [];
}
export function scarpImportAt(
  structure: ScarpStructure, offset: number
): ScarpImport | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > structure.length) {
    return undefined;
  }
  return structure.imports.find(item =>
    item.pathSpan.start <= offset && offset < item.pathSpan.end);
}
