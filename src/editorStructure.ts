/**
 * Compiler-free bounded structural scan of a Scarp source document.
 *
 * This is editor infrastructure, not a Scarp parser. It never executes source,
 * loads imports, reads the filesystem or infers types. Malformed input is
 * represented conservatively: unmatched delimiters are discarded rather than
 * producing speculative navigation or folding ranges.
 *
 * All offsets are UTF-16 offsets, matching VS Code TextDocument.positionAt.
 */
export type ScarpBracket = '(' | '[' | '{';
export type ScarpBracketClose = ')' | ']' | '}';
export interface ScarpSpan {
  readonly start: number;
  readonly end: number;
}
export interface ScarpPair {
  readonly kind: ScarpBracket;
  readonly open: ScarpSpan;
  readonly close: ScarpSpan;
  /** Includes both delimiters. */
  readonly span: ScarpSpan;
  /** Excludes the delimiters. */
  readonly inner: ScarpSpan;
  readonly depth: number;
}
export interface ScarpRegion {
  readonly label: string;
  readonly opening: ScarpSpan;
  readonly closing: ScarpSpan;
  readonly span: ScarpSpan;
}
export interface ScarpImport {
  readonly path: string;
  readonly alias: string;
  /** String content, without quote characters. */
  readonly pathSpan: ScarpSpan;
  readonly declarationSpan: ScarpSpan;
}
export interface ScarpToken {
  readonly kind: 'word' | 'string' | 'number' | 'punctuation';
  readonly text: string;
  readonly span: ScarpSpan;
  readonly depth: number;
}
export interface ScarpStructure {
  readonly length: number;
  readonly lines: readonly number[];
  readonly pairs: readonly ScarpPair[];
  readonly regions: readonly ScarpRegion[];
  readonly comments: readonly ScarpSpan[];
  readonly strings: readonly ScarpSpan[];
  readonly imports: readonly ScarpImport[];
  readonly tokens: readonly ScarpToken[];
}
export interface ScarpScanOptions {
  readonly maxLength?: number;
  readonly maxTokens?: number;
  readonly maxDepth?: number;
}
const DEFAULT_MAX_LENGTH = 2_000_000;
const DEFAULT_MAX_TOKENS = 120_000;
const DEFAULT_MAX_DEPTH = 256;

interface Opening {
  readonly kind: ScarpBracket;
  readonly start: number;
  readonly depth: number;
}
interface RegionOpening {
  readonly start: number;
  readonly label: string;
}
interface MutableToken {
  kind: ScarpToken['kind'];
  text: string;
  span: ScarpSpan;
  depth: number;
}
interface MutableScan {
  pairs: ScarpPair[];
  regions: ScarpRegion[];
  comments: ScarpSpan[];
  strings: ScarpSpan[];
  tokens: MutableToken[];
  lines: number[];
}

function wordStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}
function wordContinue(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}
function decimalDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9]/.test(ch);
}
function validLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function closingFor(open: ScarpBracket): ScarpBracketClose {
  return open === '(' ? ')' : open === '[' ? ']' : '}';
}
function matching(open: ScarpBracket, close: string): boolean {
  return closingFor(open) === close;
}
function makeSpan(start: number, end: number): ScarpSpan {
  return { start, end };
}
function lineEnd(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r') { i++; }
  return i;
}
function newlineAfter(text: string, offset: number): number {
  if (text[offset] === '\r' && text[offset + 1] === '\n') { return offset + 2; }
  return offset + 1;
}
function pushToken(result: MutableScan, token: MutableToken, maxTokens: number): boolean {
  if (result.tokens.length >= maxTokens) { return false; }
  result.tokens.push(token);
  return true;
}
function regionDirective(comment: string): { close: boolean; label: string } | undefined {
  // VS Code #region conventions. The markers must occupy their own comment
  // prefix; ordinary prose mentioning "#region" is not a directive.
  const trimmed = comment.slice(2).trim();
  const opening = /^#region(?:\s+(.*))?$/.exec(trimmed);
  if (opening) { return { close: false, label: (opening[1] || '').trim() }; }
  if (/^#endregion(?:\s+.*)?$/.test(trimmed)) {
    return { close: true, label: '' };
  }
  return undefined;
}

function collectImports(tokens: readonly ScarpToken[]): ScarpImport[] {
  const imports: ScarpImport[] = [];
  for (let i = 0; i + 4 < tokens.length; i++) {
    const start = tokens[i];
    if (start.text !== 'import' || start.kind !== 'word' || start.depth !== 0) {
      continue;
    }
    // The published spelling is: import "relative.srp" as alias;
    // Disallow annotation-like or partial constructs, as well as adjacent
    // tokens that would turn this into an expression.
    const str = tokens[i + 1];
    const as = tokens[i + 2];
    const alias = tokens[i + 3];
    const end = tokens[i + 4];
    if (str.kind !== 'string' || as.text !== 'as' || alias.kind !== 'word' ||
        end.text !== ';' || as.depth !== 0 || alias.depth !== 0 || end.depth !== 0) {
      continue;
    }
    if (!str.text.startsWith('"') || !str.text.endsWith('"') ||
        str.text.length < 3 || str.text.includes('\\')) {
      // Escaped paths require compiler interpretation; a lexical link must
      // never guess how the compiler decodes an escape sequence.
      continue;
    }
    imports.push({
      path: str.text.slice(1, -1),
      alias: alias.text,
      pathSpan: makeSpan(str.span.start + 1, str.span.end - 1),
      declarationSpan: makeSpan(start.span.start, end.span.end)
    });
    i += 4;
  }
  return imports;
}

/**
 * Return a structural snapshot or undefined on bounded-resource failures.
 * Invalid delimiter sequences invalidate the affected open frames but keep
 * independent valid siblings and text metadata usable.
 */
export function scanScarpStructure(
  source: string, options: ScarpScanOptions = {}
): ScarpStructure | undefined {
  const maxLength = validLimit(options.maxLength, DEFAULT_MAX_LENGTH);
  const maxTokens = validLimit(options.maxTokens, DEFAULT_MAX_TOKENS);
  const maxDepth = validLimit(options.maxDepth, DEFAULT_MAX_DEPTH);
  if (!maxLength || !maxTokens || !maxDepth || source.length > maxLength) {
    return undefined;
  }
  const result: MutableScan = {
    pairs: [], regions: [], comments: [], strings: [], tokens: [], lines: [0]
  };
  const stack: Opening[] = [];
  const regionStack: RegionOpening[] = [];
  let i = 0;
  let invalidDepth = false;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\r' || ch === '\n') {
      i = newlineAfter(source, i);
      result.lines.push(i);
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      const end = lineEnd(source, i + 2);
      const span = makeSpan(start, end);
      result.comments.push(span);
      const directive = regionDirective(source.slice(start, end));
      if (directive?.close) {
        const opened = regionStack.pop();
        if (opened) {
          result.regions.push({
            label: opened.label,
            opening: makeSpan(opened.start, opened.start + 2),
            closing: span,
            span: makeSpan(opened.start, end)
          });
        }
      } else if (directive && regionStack.length < maxDepth) {
        regionStack.push({ start, label: directive.label });
      }
      i = end;
      continue;
    }

    if (ch === '"') {
      const start = i++;
      let terminated = false;
      while (i < source.length) {
        if (source[i] === '\r' || source[i] === '\n') { break; }
        if (source[i] === '\\') {
          // Single-line strings; an escape may consume only one following
          // non-newline code unit. Bad escapes are for the compiler to report.
          if (i + 1 < source.length &&
              source[i + 1] !== '\r' && source[i + 1] !== '\n') {
            i += 2;
          } else { i++; }
          continue;
        }
        if (source[i++] === '"') { terminated = true; break; }
      }
      result.strings.push(makeSpan(start, i));
      if (!pushToken(result, {
        kind: 'string', text: source.slice(start, i),
        span: makeSpan(start, i), depth: stack.length
      }, maxTokens)) { return undefined; }
      // An unfinished string should not consume subsequent source lines.
      // collectImports checks the ending quote before constructing any link.
      if (!terminated && i === source.length) { break; }
      continue;
    }

    if (wordStart(ch)) {
      const start = i++;
      while (wordContinue(source[i])) { i++; }
      if (!pushToken(result, {
        kind: 'word', text: source.slice(start, i),
        span: makeSpan(start, i), depth: stack.length
      }, maxTokens)) { return undefined; }
      continue;
    }
    if (decimalDigit(ch)) {
      const start = i++;
      while (wordContinue(source[i]) || source[i] === '.') { i++; }
      if (!pushToken(result, {
        kind: 'number', text: source.slice(start, i),
        span: makeSpan(start, i), depth: stack.length
      }, maxTokens)) { return undefined; }
      continue;
    }

    const isOpening = ch === '(' || ch === '[' || ch === '{';
    const isClosing = ch === ')' || ch === ']' || ch === '}';
    const depth = stack.length;
    if (!pushToken(result, {
      kind: 'punctuation', text: ch, span: makeSpan(i, i + 1), depth
    }, maxTokens)) { return undefined; }

    if (isOpening) {
      if (stack.length >= maxDepth) {
        // Failing closed is preferable to false folds in deeply malformed
        // code. The caller can still show TextMate coloring and diagnostics.
        invalidDepth = true;
        break;
      }
      stack.push({ kind: ch as ScarpBracket, start: i, depth });
    } else if (isClosing) {
      const top = stack[stack.length - 1];
      if (top && matching(top.kind, ch)) {
        stack.pop();
        result.pairs.push({
          kind: top.kind,
          open: makeSpan(top.start, top.start + 1),
          close: makeSpan(i, i + 1),
          span: makeSpan(top.start, i + 1),
          inner: makeSpan(top.start + 1, i),
          depth: top.depth
        });
      } else {
        // A stray closing bracket is not attached to a guessed opening.
        // On mismatched nesting, invalidate the open stack so a later
        // closing bracket cannot accidentally validate an impossible pair.
        stack.length = 0;
      }
    }
    i++;
  }
  if (invalidDepth) { return undefined; }
  result.pairs.sort((a, b) =>
    a.span.start - b.span.start || b.span.end - a.span.end);
  result.regions.sort((a, b) =>
    a.span.start - b.span.start || b.span.end - a.span.end);
  return {
    length: source.length, lines: result.lines,
    pairs: result.pairs, regions: result.regions,
    comments: result.comments, strings: result.strings,
    tokens: result.tokens, imports: collectImports(result.tokens)
  };
}

/** Convert a UTF-16 offset into a zero-based line without a full file scan. */
export function scarpLineAt(lines: readonly number[], offset: number): number {
  if (!lines.length || !Number.isSafeInteger(offset) || offset < 0) { return -1; }
  let lo = 0;
  let hi = lines.length;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (lines[mid] <= offset) { lo = mid; }
    else { hi = mid; }
  }
  return lo;
}

/** Stable line position conversion for import links and structural ranges. */
export function scarpPositionAt(
  structure: ScarpStructure, offset: number
): { line: number; character: number } | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > structure.length) {
    return undefined;
  }
  const line = scarpLineAt(structure.lines, offset);
  if (line < 0) { return undefined; }
  return { line, character: offset - structure.lines[line] };
}

/** Deliberately deterministic: no cancellation, clock or global cache. */
export function scarpStructureEqual(a: ScarpStructure, b: ScarpStructure): boolean {
  // Intended for tests and cache invalidation, not semantic source equality.
  return a.length === b.length &&
    JSON.stringify(a.lines) === JSON.stringify(b.lines) &&
    JSON.stringify(a.pairs) === JSON.stringify(b.pairs) &&
    JSON.stringify(a.regions) === JSON.stringify(b.regions) &&
    JSON.stringify(a.imports) === JSON.stringify(b.imports);
}
