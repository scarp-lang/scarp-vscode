import * as path from 'node:path';
import { isWithinProject } from './projectChangeTracker';

export interface SourcePosition { line: number; column: number }
export interface SourceSpan {
  source: number;
  span: [number, number];
  start: SourcePosition;
  end: SourcePosition;
}
export interface IndexedSymbol {
  id: number;
  name: string;
  kind: string;
  location: SourceSpan | null;
}
export interface IndexedReference {
  target: number;
  kind: string;
  location: SourceSpan;
}
export interface NavigationIndex {
  files: string[];
  symbols: IndexedSymbol[];
  references: IndexedReference[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(): never {
  throw new Error('Invalid or unsupported Scarp references schema (expected v1).');
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function position(value: unknown): value is SourcePosition {
  return record(value) && integer(value.line) && value.line >= 1 &&
    integer(value.column) && value.column >= 1;
}
function location(value: unknown, files: number): value is SourceSpan {
  if (!record(value) || !integer(value.source) || value.source >= files ||
      !Array.isArray(value.span) || value.span.length !== 2 ||
      !integer(value.span[0]) || !integer(value.span[1]) ||
      value.span[1] < value.span[0] ||
      !position(value.start) || !position(value.end)) {
    return false;
  }
  return value.end.line > value.start.line ||
    (value.end.line === value.start.line &&
      value.end.column >= value.start.column);
}

/**
 * Index locations are file-local UTF-8 byte ranges. IDs are valid only for
 * this one CLI snapshot and MUST NOT be reused after an edit.
 */
export function parseNavigationIndex(stdout: string, canonicalRoot: string): NavigationIndex {
  let raw: unknown;
  try { raw = JSON.parse(stdout); }
  catch { return fail(); }
  if (!record(raw) ||
      raw.schema_version !== 1 ||
      raw.kind !== 'scarp.references' ||
      raw.span_encoding !== 'utf-8-bytes' ||
      raw.column_encoding !== 'unicode-scalar' ||
      raw.position_base !== 1 ||
      !path.isAbsolute(canonicalRoot) ||
      !Array.isArray(raw.files) || raw.files.length < 1 ||
      raw.files.length > 128 ||
      !Array.isArray(raw.symbols) || raw.symbols.length > 65536 ||
      !Array.isArray(raw.references) || raw.references.length > 65536) {
    return fail();
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.files.entries()) {
    if (!record(item) || item.id !== i || typeof item.path !== 'string' ||
        !path.isAbsolute(item.path) ||
        path.extname(item.path).toLowerCase() !== '.srp') {
      return fail();
    }
    const name = path.resolve(item.path);
    if (!isWithinProject(canonicalRoot, name) || seen.has(name)) { return fail(); }
    seen.add(name);
    files.push(name);
  }
  const symbols: IndexedSymbol[] = [];
  for (const [i, item] of raw.symbols.entries()) {
    if (!record(item) || item.id !== i || typeof item.name !== 'string' ||
        typeof item.kind !== 'string' ||
        !(item.location === null || location(item.location, files.length))) {
      return fail();
    }
    symbols.push({
      id: i, name: item.name, kind: item.kind,
      location: item.location as SourceSpan | null
    });
  }
  const references: IndexedReference[] = [];
  for (const item of raw.references) {
    if (!record(item) || !integer(item.target) ||
        item.target >= symbols.length || typeof item.kind !== 'string' ||
        !location(item.location, files.length)) {
      return fail();
    }
    references.push({
      target: item.target, kind: item.kind, location: item.location
    });
  }
  return { files, symbols, references };
}

/** Prefer a use-site to a declaration and never confuse an adjacent token. */
export function symbolAt(
  index: NavigationIndex, filename: string, byteOffset: number
): IndexedSymbol | undefined {
  if (!integer(byteOffset)) { return undefined; }
  const source = index.files.indexOf(path.resolve(filename));
  if (source < 0) { return undefined; }
  const use = index.references.find(ref => {
    const { location } = ref;
    return location.source === source &&
      location.span[0] <= byteOffset && byteOffset < location.span[1];
  });
  if (use) { return index.symbols[use.target]; }
  return index.symbols.find(symbol => {
    const loc = symbol.location;
    return loc !== null && loc.source === source &&
      (loc.span[0] <= byteOffset && byteOffset < loc.span[1] ||
        loc.span[0] === loc.span[1] && byteOffset === loc.span[0]);
  });
}

export function referencesFor(
  index: NavigationIndex, symbol: IndexedSymbol, includeDeclaration: boolean
): SourceSpan[] {
  const result = index.references.filter(ref => ref.target === symbol.id)
    .map(ref => ref.location);
  if (includeDeclaration && symbol.location) {
    result.unshift(symbol.location);
  }
  return result;
}
