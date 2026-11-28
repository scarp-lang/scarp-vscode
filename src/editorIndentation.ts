import type { ScarpStructure, ScarpToken, ScarpSpan } from './editorStructure';

/** A UTF-16 text replacement. Nothing is applied until the user requests format. */
export interface ScarpIndentEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}
export interface ScarpIndentOptions {
  /** Visual columns per indentation level (not a maximum line width). */
  readonly tabSize?: number;
  readonly insertSpaces?: boolean;
  /** Apply only to logical lines intersecting this half-open UTF-16 range. */
  readonly range?: ScarpSpan;
  readonly maximumEdits?: number;
  readonly maximumSourceLength?: number;
  /** Keep incidental trailing whitespace unless the user explicitly opts in. */
  readonly trimTrailingWhitespace?: boolean;
  readonly indentEmptyLines?: boolean;
  readonly continuationIndent?: boolean;
}
const DEFAULT_MAX_SOURCE = 1_000_000;
const DEFAULT_MAX_EDITS = 8_192;
const MAX_CONTINUATION_DEPTH = 6;
const MAX_INDENT_DEPTH = 128;

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly terminatorEnd: number;
  readonly index: number;
}
interface LexicalLine {
  readonly tokens: readonly ScarpToken[];
  readonly hasMultilineLiteral: boolean;
  readonly startsWithinString: boolean;
  readonly endsWithinString: boolean;
  readonly startsWithComment: boolean;
}

function integer(value: number | undefined, fallback: number, min: number, max: number): number | undefined {
  const result = value ?? fallback;
  return Number.isSafeInteger(result) && result >= min && result <= max ? result : undefined;
}
function validRange(span: ScarpSpan | undefined, length: number): boolean {
  return span === undefined || Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) && span.start >= 0 &&
    span.end >= span.start && span.end <= length;
}
function sourceLines(source: string, starts: readonly number[]): SourceLine[] | undefined {
  if (!starts.length || starts[0] !== 0) return undefined;
  const result: SourceLine[] = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const endNext = index + 1 < starts.length ? starts[index + 1] : source.length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endNext) ||
        start < 0 || endNext < start || endNext > source.length ||
        (index && start <= starts[index - 1])) return undefined;
    let end = endNext;
    if (end > start && source[end - 1] === '\n') end--;
    if (end > start && source[end - 1] === '\r') end--;
    result.push({ start, end, terminatorEnd: endNext, index });
  }
  return result;
}
function lineFor(starts: readonly number[], offset: number): number {
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return lo;
}
function includesRange(allowed: ScarpSpan | undefined, line: SourceLine): boolean {
  if (!allowed) return true;
  // An empty cursor range means format its logical line, not an empty selection.
  if (allowed.start === allowed.end) {
    return line.start <= allowed.start && allowed.start <= line.terminatorEnd;
  }
  return line.start < allowed.end && line.terminatorEnd > allowed.start;
}
function indentColumns(depth: number, tabSize: number, insertSpaces: boolean): string {
  return insertSpaces ? ' '.repeat(depth * tabSize) : '\t'.repeat(depth);
}
function whitespacePrefix(source: string, line: SourceLine): number {
  let at = line.start;
  while (at < line.end && (source[at] === ' ' || source[at] === '\t')) at++;
  return at;
}
function visibleText(source: string, line: SourceLine): boolean {
  for (let i = line.start; i < line.end; i++) {
    if (source[i] !== ' ' && source[i] !== '\t') return true;
  }
  return false;
}
function isOpen(token: ScarpToken): boolean {
  return token.kind === 'punctuation' &&
    (token.text === '{' || token.text === '(' || token.text === '[');
}
function isClose(token: ScarpToken): boolean {
  return token.kind === 'punctuation' &&
    (token.text === '}' || token.text === ')' || token.text === ']');
}
function matching(open: string, close: string): boolean {
  return open === '{' && close === '}' ||
    open === '(' && close === ')' || open === '[' && close === ']';
}
function orderedNonoverlappingSpans(spans: readonly ScarpSpan[], length: number): boolean {
  let end = 0;
  for (const span of spans) {
    if (!validRange(span, length) || span.start < end) return false;
    end = span.end;
  }
  return true;
}

/**
 * Reconstruct brace nesting conservatively, rather than trusting the number
 * of syntactically matched pairs alone. An unclosed expression, stray brace,
 * or scanner inconsistency disables all edits for that document.
 *
 * Only tokenized punctuation affects indentation. Delimiters in comments and
 * raw, triple-quoted or escaped string literals are never interpreted.
 */
function checkDelimiterIntegrity(tokens: readonly ScarpToken[], length: number): boolean {
  const stack: string[] = [];
  let previousEnd = 0;
  for (const token of tokens) {
    if (token.span.start < previousEnd || token.span.end > length ||
        token.span.start < 0 || token.span.end <= token.span.start) return false;
    previousEnd = token.span.end;
    if (isOpen(token)) {
      stack.push(token.text);
      if (stack.length > MAX_INDENT_DEPTH) return false;
    } else if (isClose(token)) {
      const popped = stack.pop();
      if (!popped || !matching(popped, token.text)) return false;
    }
  }
  return stack.length === 0;
}

/**
 * Prepare per-line metadata with monotone cursor traversal. In a multiline
 * literal even a column-0 quote on the closing line should not be shifted:
 * its payload is exact source data and may be parsed by the runtime.
 */
function lexicalLines(lines: readonly SourceLine[], structure: ScarpStructure): LexicalLine[] | undefined {
  if (!orderedNonoverlappingSpans(structure.strings, structure.length) ||
      !orderedNonoverlappingSpans(structure.comments, structure.length)) return undefined;
  let tokenIndex = 0;
  let literalIndex = 0;
  let commentIndex = 0;
  const result: LexicalLine[] = [];
  for (const line of lines) {
    const tokens: ScarpToken[] = [];
    while (tokenIndex < structure.tokens.length &&
           structure.tokens[tokenIndex].span.start < line.terminatorEnd) {
      const token = structure.tokens[tokenIndex++];
      // A string token may cover several physical lines. It appears only on
      // its opening line; the literal span controls protected lines below.
      if (token.span.start >= line.start) tokens.push(token);
    }
    while (literalIndex < structure.strings.length &&
           structure.strings[literalIndex].end <= line.start) literalIndex++;
    const active = structure.strings[literalIndex];
    const intersects = !!active && active.start < line.terminatorEnd && active.end > line.start;
    // A one-line quoted literal is harmless to its own indentation. A literal
    // occupying more than one physical line protects the whole touched line.
    const multiline = intersects && active.end > line.terminatorEnd ||
      intersects && active.start < line.start ||
      intersects && structure.lines[lineFor(structure.lines, active.end - 1)] !==
        structure.lines[lineFor(structure.lines, active.start)];
    while (commentIndex < structure.comments.length &&
           structure.comments[commentIndex].end <= line.start) commentIndex++;
    const comment = structure.comments[commentIndex];
    const prefix = whitespacePrefixFromLineTokens(line, tokens, comment);
    result.push({
      tokens,
      hasMultilineLiteral: multiline,
      startsWithinString: intersects && active.start < line.start,
      endsWithinString: intersects && active.end > line.terminatorEnd,
      startsWithComment: prefix
    });
  }
  return result;
}
function whitespacePrefixFromLineTokens(
  line: SourceLine, tokens: readonly ScarpToken[], comment: ScarpSpan | undefined
): boolean {
  if (!comment || comment.start < line.start || comment.start >= line.end) return false;
  return tokens.length === 0 || tokens[0].span.start > comment.start;
}

interface Frame { readonly open: string; readonly offset: number; }
function leadingClosings(tokens: readonly ScarpToken[], source: string, nonspace: number): number {
  let cursor = nonspace;
  let count = 0;
  for (const token of tokens) {
    if (token.span.start !== cursor || !isClose(token)) break;
    count++;
    cursor = token.span.end;
    while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor++;
  }
  return count;
}
/**
 * Return minimal prefix replacements for a complete, bounded Scarp document.
 *
 * Formatting only changes *leading indentation* by default; no punctuation,
 * string data, comments, line endings, or token spacing is normalized. This
 * intentionally avoids semantic guesses and keeps the formatter idempotent.
 * The whole source must pass delimiter validation, even in range mode, so
 * partial indentation never hides an invalid surrounding block.
 */
export function scarpIndentationEdits(
  source: string, structure: ScarpStructure, options: ScarpIndentOptions = {}
): readonly ScarpIndentEdit[] {
  const tabSize = integer(options.tabSize, 4, 1, 16);
  const maxEdits = integer(options.maximumEdits, DEFAULT_MAX_EDITS, 1, 32768);
  const maxSource = integer(options.maximumSourceLength, DEFAULT_MAX_SOURCE, 1, 2_000_000);
  if (!tabSize || !maxEdits || !maxSource || source.length > maxSource ||
      structure.length !== source.length || !validRange(options.range, source.length) ||
      !checkDelimiterIntegrity(structure.tokens, source.length)) return [];
  const lines = sourceLines(source, structure.lines);
  if (!lines) return [];
  const lexical = lexicalLines(lines, structure);
  if (!lexical || lexical.length !== lines.length) return [];
  const edits: ScarpIndentEdit[] = [];
  const frames: Frame[] = [];
  const insertSpaces = options.insertSpaces !== false;

  for (const line of lines) {
    const meta = lexical[line.index];
    const first = whitespacePrefix(source, line);
    const nonempty = visibleText(source, line);
    const closing = leadingClosings(meta.tokens, source, first);
    let indentFrames = frames.length;
    let adjusted = 0;
    // Closing delimiters at the start of a line align with their corresponding
    // openings, including cases such as ")]" before a closing block brace.
    for (let i = frames.length - 1; i >= 0 && adjusted < closing; i--, adjusted++) {
      indentFrames--;
    }
    let blocks = 0, continuation = 0;
    for (let i = 0; i < indentFrames; i++) {
      if (frames[i].open === '{') blocks++;
      else continuation++;
    }
    const depth = Math.min(MAX_INDENT_DEPTH,
      blocks + (options.continuationIndent === false ? 0 :
        Math.min(continuation, MAX_CONTINUATION_DEPTH)));
    const writable = !meta.hasMultilineLiteral &&
      (nonempty || options.indentEmptyLines === true) &&
      includesRange(options.range, line);
    if (writable) {
      const replacement = indentColumns(depth, tabSize, insertSpaces);
      if (source.slice(line.start, first) !== replacement) {
        edits.push({ start: line.start, end: first, replacement });
      }
      if (options.trimTrailingWhitespace && nonempty && !meta.startsWithComment) {
        let trailing = line.end;
        while (trailing > first && (source[trailing - 1] === ' ' ||
               source[trailing - 1] === '\t')) trailing--;
        if (trailing < line.end && trailing >= first) {
          edits.push({ start: trailing, end: line.end, replacement: '' });
        }
      }
      if (edits.length > maxEdits) return [];
    }
    for (const token of meta.tokens) {
      if (isOpen(token)) frames.push({ open: token.text, offset: token.span.start });
      else if (isClose(token)) {
        const frame = frames.pop();
        if (!frame || !matching(frame.open, token.text)) return [];
      }
    }
  }
  return frames.length === 0 ? edits : [];
}

/** A pure helper used by tests and editor previews, never edits the document. */
export function applyScarpIndentationEdits(
  source: string, edits: readonly ScarpIndentEdit[]
): string | undefined {
  let offset = source.length;
  let result = source;
  for (const edit of [...edits].reverse()) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) ||
        edit.start < 0 || edit.end > offset || edit.start > edit.end) return undefined;
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    offset = edit.start;
  }
  return result;
}
