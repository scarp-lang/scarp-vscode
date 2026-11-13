import * as path from 'node:path';
import { isWithinProject } from './projectChangeTracker';

export interface BrowsableProjectModule {
  id: number;
  filename: string;
  displayPath: string;
  isEntry: boolean;
  importCount: number;
  publicSymbols: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new Error('Unsupported or malformed Scarp module inspection JSON (expected schema v1, v2, or v3).');
}

/**
 * Validate compiler-provided module metadata before showing paths in the editor.
 * The official filesystem loader returns canonical absolute labels. Reject
 * malformed, out-of-project, duplicate or unversioned inventories rather than
 * opening arbitrary files from an unexpected CLI response.
 */
export function parseBrowsableProjectModules(
  stdout: string, canonicalProjectRoot: string
): BrowsableProjectModule[] {
  let raw: unknown;
  try { raw = JSON.parse(stdout); }
  catch { return invalid(); }
  // Schema v2 and v3 extend signature type strings and keep the module graph fields.
  if (!object(raw) ||
      (raw.schema_version !== 1 && raw.schema_version !== 2 && raw.schema_version !== 3) ||
      !Number.isSafeInteger(raw.entry) ||
      !Array.isArray(raw.modules) || raw.modules.length < 1 ||
      raw.modules.length > 128 ||
      !path.isAbsolute(canonicalProjectRoot)) {
    return invalid();
  }

  const entry = raw.entry as number;
  const seenIds = new Set<number>();
  const seenPaths = new Set<string>();
  const importTargets: number[] = [];
  const modules: BrowsableProjectModule[] = [];

  for (const candidate of raw.modules as unknown[]) {
    if (!object(candidate) ||
        !Number.isSafeInteger(candidate.id) ||
        (candidate.id as number) < 0 ||
        typeof candidate.path !== 'string' ||
        !path.isAbsolute(candidate.path) ||
        path.extname(candidate.path).toLowerCase() !== '.srp' ||
        !Array.isArray(candidate.imports) ||
        !Array.isArray(candidate.symbols) ||
        candidate.imports.length > 1024 ||
        candidate.symbols.length > 4096) {
      return invalid();
    }
    const id = candidate.id as number;
    const filename = path.resolve(candidate.path);
    if (!isWithinProject(canonicalProjectRoot, filename) ||
        seenIds.has(id) || seenPaths.has(filename)) {
      return invalid();
    }
    if (!(candidate.imports as unknown[]).every(imp =>
      object(imp) && Number.isSafeInteger(imp.target) &&
      (imp.target as number) >= 0)) {
      return invalid();
    }
    if (!(candidate.symbols as unknown[]).every(symbol =>
      object(symbol) && typeof symbol.name === 'string' &&
      typeof symbol.public === 'boolean')) {
      return invalid();
    }

    // Imports may point to later modules; verify targets after reading every node.
    for (const imp of candidate.imports as Array<{ target: number }>) {
      importTargets.push(imp.target);
    }
    seenIds.add(id);
    seenPaths.add(filename);
    const relative = path.relative(canonicalProjectRoot, filename);
    modules.push({
      id,
      filename,
      displayPath: relative.split(path.sep).join('/').replace(/[\r\n\t]/g, ' '),
      isEntry: id === entry,
      importCount: candidate.imports.length,
      publicSymbols: candidate.symbols.filter(symbol =>
        object(symbol) && symbol.public === true).length
    });
  }

  if (!seenIds.has(entry) ||
      modules.some(module => module.id >= modules.length) ||
      importTargets.some(target => !seenIds.has(target))) {
    return invalid();
  }
  return modules;
}
