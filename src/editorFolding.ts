import { scanScarpString } from './stringLiteral';
import {
  scanScarpStructure, scarpLineAt, type ScarpPair,
  type ScarpSpan, type ScarpStructure
} from './editorStructure';

export type ScarpFoldKind = 'region' | 'comment' | 'imports' | 'structure' | 'string';
export interface ScarpFold {
  readonly start: number;
  readonly end: number;
  readonly kind: ScarpFoldKind;
  readonly startOffset: number;
  readonly endOffset: number;
}
export interface ScarpFoldingOptions {
  readonly minimumLines?: number;
  readonly maximumRanges?: number;
  readonly foldParens?: boolean;
  readonly foldBrackets?: boolean;
  readonly foldBraces?: boolean;
  readonly foldComments?: boolean;
  readonly foldRegions?: boolean;
  readonly foldImports?: boolean;
  readonly foldStrings?: boolean;
}
const DEFAULT_RANGES = 5000;

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) { return fallback; }
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function foldFromSpan(
  structure: ScarpStructure, span: ScarpSpan, kind: ScarpFoldKind,
  minimumLines: number
): ScarpFold | undefined {
  const start = scarpLineAt(structure.lines, span.start);
  const end = scarpLineAt(structure.lines, Math.max(span.start, span.end - 1));
  if (start < 0 || end - start < minimumLines) { return undefined; }
  return { start, end, kind, startOffset: span.start, endOffset: span.end };
}
function structuralRange(pair: ScarpPair): ScarpSpan {
  return { start: pair.open.start, end: pair.close.end };
}
function commentRuns(text: string, structure: ScarpStructure): ScarpSpan[] {
  const runs: ScarpSpan[] = [];
  let runStart = -1;
  let runEnd = -1;
  let lastLine = -2;
  const emit = () => {
    if (runStart >= 0 && lastLine > scarpLineAt(structure.lines, runStart)) {
      runs.push({ start: runStart, end: runEnd });
    }
  };
  for (const span of structure.comments) {
    const line = scarpLineAt(structure.lines, span.start);
    const lineStart = structure.lines[line];
    if (text.slice(lineStart, span.start).trim() !== '') {
      emit(); runStart = -1; lastLine = -2; continue;
    }
    if (runStart < 0 || line !== lastLine + 1) {
      emit(); runStart = span.start;
    }
    runEnd = span.end; lastLine = line;
  }
  emit();
  return runs;
}
function importRuns(text: string, structure: ScarpStructure): ScarpSpan[] {
  const runs: ScarpSpan[] = [];
  let start = -1;
  let end = -1;
  let previousLine = -2;
  const emit = () => {
    if (start >= 0 && scarpLineAt(structure.lines, end - 1) >
        scarpLineAt(structure.lines, start)) {
      runs.push({ start, end });
    }
  };
  for (const item of structure.imports) {
    const line = scarpLineAt(structure.lines, item.declarationSpan.start);
    if (line !== scarpLineAt(structure.lines, item.declarationSpan.end - 1)) {
      emit(); start = -1; previousLine = -2; continue;
    }
    const lineStart = structure.lines[line];
    if (text.slice(lineStart, item.declarationSpan.start).trim() !== '') {
      emit(); start = -1; previousLine = -2; continue;
    }
    if (start < 0 || line !== previousLine + 1) {
      emit(); start = item.declarationSpan.start;
    }
    end = item.declarationSpan.end; previousLine = line;
  }
  emit();
  return runs;
}
function rank(kind: ScarpFoldKind): number {
  switch (kind) {
    case 'region': return 0;
    case 'structure': return 1;
    case 'string': return 2;
    case 'imports': return 3;
    case 'comment': return 4;
  }
}
/**
 * Deterministic, compiler-free folding. Unclosed syntax never creates fake
 * regions; duplicates on the same line interval collapse in priority order.
 */
export function scarpFoldsFromStructure(
  text: string, structure: ScarpStructure,
  options: ScarpFoldingOptions = {}
): readonly ScarpFold[] {
  if (structure.length !== text.length) { return []; }
  const minimumLines = limit(options.minimumLines, 1);
  const maximumRanges = limit(options.maximumRanges, DEFAULT_RANGES);
  if (!maximumRanges) { return []; }
  const candidates: ScarpFold[] = [];
  const add = (span: ScarpSpan, kind: ScarpFoldKind) => {
    const fold = foldFromSpan(structure, span, kind, minimumLines);
    if (fold) { candidates.push(fold); }
  };
  if (options.foldRegions !== false) {
    for (const region of structure.regions) {
      add(region.span, 'region');
      if (candidates.length > maximumRanges * 8) { return []; }
    }
  }
  for (const pair of structure.pairs) {
    if (pair.kind === '{' && options.foldBraces === false ||
        pair.kind === '(' && options.foldParens === false ||
        pair.kind === '[' && options.foldBrackets === false) { continue; }
    add(structuralRange(pair), 'structure');
    if (candidates.length > maximumRanges * 8) { return []; }
  }
  if (options.foldStrings !== false) {
    for (const span of structure.strings) {
      if (!text.startsWith('"""', span.start)) continue;
      const literal = scanScarpString(text, span.start);
      if (!literal?.closed || literal.end !== span.end) continue;
      add(span, 'string');
      if (candidates.length > maximumRanges * 8) { return []; }
    }
  }
  if (options.foldComments !== false) {
    for (const span of commentRuns(text, structure)) { add(span, 'comment'); }
  }
  if (options.foldImports !== false) {
    for (const span of importRuns(text, structure)) { add(span, 'imports'); }
  }
  candidates.sort((a, b) =>
    a.start - b.start || a.end - b.end ||
    rank(a.kind) - rank(b.kind) || a.startOffset - b.startOffset);
  const folds: ScarpFold[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const key = item.start + ':' + item.end;
    if (seen.has(key)) { continue; }
    seen.add(key); folds.push(item);
    if (folds.length >= maximumRanges) { break; }
  }
  return folds;
}
export function scarpFolds(
  source: string, options?: ScarpFoldingOptions
): readonly ScarpFold[] {
  const parsed = scanScarpStructure(source);
  return parsed ? scarpFoldsFromStructure(source, parsed, options) : [];
}
