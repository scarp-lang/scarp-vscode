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
  throw new Error('Unsupported or malformed Scarp module inspection JSON (expected schema v1 through v5).');
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
  // Schemas 4/5 add nominal record/variant symbols, retaining the same graph
  // shape, absolute canonical paths and source-order public visibility.
  if (!object(raw) ||
      ![1, 2, 3, 4, 5].includes(raw.schema_version as number) ||
      !Number.isSafeInteger(raw.entry) ||
      !Array.isArray(raw.modules) || raw.modules.length < 1 ||
      raw.modules.length > 128 ||
      !path.isAbsolute(canonicalProjectRoot)) {
    return invalid();
  }

  const schema = raw.schema_version as number;
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
    if (!(candidate.symbols as unknown[]).every(symbol => {
      if (!object(symbol) || typeof symbol.name !== 'string' ||
          typeof symbol.public !== 'boolean') { return false; }
      // Preserve legacy v1-v3 metadata contracts without inventing
      // semantics for their historical kind/parameter representations.
      if (schema < 4) {
        return symbol.kind !== 'record' && symbol.kind !== 'variant';
      }
      if (symbol.kind === 'record') {
        return Array.isArray(symbol.fields) && symbol.fields.length <= 32 &&
          symbol.fields.every(field =>
            object(field) && typeof field.name === 'string' &&
            typeof field.type === 'string' && field.type.length <= 4096);
      }
      if (symbol.kind === 'variant') {
        return schema >= 5 && Array.isArray(symbol.cases) &&
          symbol.cases.length <= 32 && symbol.cases.every(item =>
            object(item) && typeof item.name === 'string' &&
            (item.payload === null ||
              typeof item.payload === 'string' && item.payload.length <= 4096));
      }
      return symbol.kind === 'constant' || symbol.kind === 'function';
    })) {
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
