import { scanScarpString } from './stringLiteral';
import {
  scanScarpStructure, scarpLineAt, type ScarpPair,
  type ScarpSpan, type ScarpStructure, type ScarpToken
} from './editorStructure';

export interface ScarpSelection {
  readonly start: number;
  readonly end: number;
}
export interface ScarpSelectionOptions {
  readonly maxRanges?: number;
  readonly includeDocument?: boolean;
  readonly includeLine?: boolean;
  readonly includeToken?: boolean;
  readonly includeStringContent?: boolean;
  readonly includeDelimiterContent?: boolean;
}
const MAX_SELECTIONS = 48;

function contains(range: ScarpSpan, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}
function strictlyContains(parent: ScarpSpan, child: ScarpSpan): boolean {
  return parent.start <= child.start && child.end <= parent.end &&
    (parent.start < child.start || child.end < parent.end);
}
function same(a: ScarpSpan, b: ScarpSpan): boolean {
  return a.start === b.start && a.end === b.end;
}
function validRange(r: ScarpSpan, length: number): boolean {
  return Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) &&
    r.start >= 0 && r.end <= length && r.end >= r.start;
}
function select(source: string, span: ScarpSpan, cursor: number): ScarpSelection | undefined {
  return contains(span, cursor) && validRange(span, source.length)
    ? { start: span.start, end: span.end } : undefined;
}
function lineRange(
  source: string, structure: ScarpStructure, offset: number
): ScarpSpan {
  const line = scarpLineAt(structure.lines, offset);
  const from = structure.lines[line];
  const until = line + 1 < structure.lines.length
    ? structure.lines[line + 1] : source.length;
  let end = until;
  while (end > from && (source[end - 1] === '\r' ||
                        source[end - 1] === '\n')) { end--; }
  return { start: from, end };
}
function tokenRange(tokens: readonly ScarpToken[], offset: number): ScarpSpan | undefined {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tokens[mid].span.end <= offset) { lo = mid + 1; }
    else { hi = mid; }
  }
  const found = tokens[lo];
  return found && found.span.start <= offset && offset < found.span.end
    ? found.span : undefined;
}
function pairCandidates(
  pair: ScarpPair, cursor: number, options: ScarpSelectionOptions
): ScarpSpan[] {
  const result: ScarpSpan[] = [];
  if (contains(pair.span, cursor)) {
    if (options.includeDelimiterContent !== false && contains(pair.inner, cursor)) {
      result.push(pair.inner);
    }
    result.push(pair.span);
  }
  return result;
}
function quotedContent(source: string, span: ScarpSpan): ScarpSpan | undefined {
  const literal = scanScarpString(source, span.start);
  if (!literal?.closed || literal.end !== span.end) return undefined;
  const triple = source.startsWith('"""', span.start);
  const raw = source.startsWith('r"', span.start);
  return { start: span.start + (triple ? 3 : raw ? 2 : 1),
    end: span.end - (triple ? 3 : 1) };
}
/**
 * Syntactic Expand Selection ranges, ordered from smallest to largest.
 * Each parent strictly contains the preceding range, as required by VS Code.
 * No compiler, project symbol index or workspace access is involved.
 */
export function scarpSelectionRangesFromStructure(
  source: string, structure: ScarpStructure, cursor: number,
  options: ScarpSelectionOptions = {}
): readonly ScarpSelection[] {
  if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      cursor > source.length || source.length !== structure.length) { return []; }
  const maxRanges = options.maxRanges === undefined ? MAX_SELECTIONS :
    Number.isSafeInteger(options.maxRanges) && options.maxRanges >= 0
      ? options.maxRanges : 0;
  if (!maxRanges) { return []; }
  const candidates: ScarpSelection[] = [];
  const add = (span: ScarpSpan) => {
    const found = select(source, span, cursor);
    if (found && !candidates.some(candidate => same(candidate, found))) {
      candidates.push(found);
    }
  };
  const token = tokenRange(structure.tokens, cursor);
  if (token && options.includeToken !== false) { add(token); }
  let activeString: ScarpSpan | undefined;
  let activeContent: ScarpSpan | undefined;
  if (options.includeStringContent !== false) {
    for (const span of structure.strings) {
      if (!contains(span, cursor)) continue;
      const inside = quotedContent(source, span);
      if (inside && contains(inside, cursor)) {
        activeString = span;
        activeContent = inside;
        add(inside);
      }
    }
  }
  for (const pair of structure.pairs) {
    for (const span of pairCandidates(pair, cursor, options)) { add(span); }
  }
  for (const item of structure.regions) { add(item.span); }
  for (const item of structure.imports) {
    add(item.pathSpan); add(item.declarationSpan);
  }
  for (const item of structure.comments) { add(item); }
  if (options.includeLine !== false) {
    const line = lineRange(source, structure, cursor);
    // Opening and closing lines of a multiline literal can intersect the
    // literal without containing it. Such a line would displace the exact
    // content range in the strict ancestor chain.
    const crossesLiteral = activeString && activeContent &&
      !(line.start >= activeContent.start && line.end <= activeContent.end) &&
      !(line.start <= activeString.start && line.end >= activeString.end);
    if (contains(line, cursor) && !crossesLiteral) { add(line); }
  }
  if (options.includeDocument !== false) {
    add({ start: 0, end: source.length });
  }
  candidates.sort((a, b) =>
    (a.end - a.start) - (b.end - b.start) ||
    a.start - b.start || b.end - a.end);
  if (!candidates.length) { return []; }
  const chain: ScarpSelection[] = [candidates[0]];
  for (const next of candidates.slice(1)) {
    if (strictlyContains(next, chain[chain.length - 1])) {
      chain.push(next);
      if (chain.length >= maxRanges) { break; }
    }
  }
  return chain.slice(0, maxRanges);
}
export function scarpSelectionRanges(
  source: string, cursor: number, options?: ScarpSelectionOptions
): readonly ScarpSelection[] {
  const parsed = scanScarpStructure(source);
  return parsed ? scarpSelectionRangesFromStructure(source, parsed, cursor, options) : [];
}
