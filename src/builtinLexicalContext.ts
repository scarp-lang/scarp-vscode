import { scanScarpString } from './stringLiteral';

/**
 * Small bounded lexical view shared by editor-only builtin providers.
 * Offsets are UTF-16 code units. This is not compiler semantic resolution.
 */
export const BUILTIN_CONTEXT_LIMIT = 16_384;

export interface BuiltinToken {
  readonly kind: 'word' | 'number' | 'punctuation' | 'string' | 'comment';
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}

const DECLARATION_WORDS = new Set([
  'funcra', 'bind', 'var', 'import', 'as', 'pub', 'pure',
  'record', 'variant', 'case', 'new'
]);
const GROUPING_WORDS = new Set([
  'if', 'else', 'while', 'repeat', 'return', 'match', 'on',
  'needs', 'ensures'
]);

function wordPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

export const BUILTIN_DOCUMENT_LIMIT = 128_000;
export const BUILTIN_DOCUMENT_TOKEN_LIMIT = 24_000;

export function scanBuiltinContext(
  source: string, documentMode = false
): readonly BuiltinToken[] | undefined {
  const limit = documentMode ? BUILTIN_DOCUMENT_LIMIT : BUILTIN_CONTEXT_LIMIT;
  if (source.length > limit) return undefined;
  const tokens: BuiltinToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i++;
    let kind: BuiltinToken['kind'] = 'punctuation';
    let closed = true;
    const literal = scanScarpString(source, start);
    if (ch === '/' && source[i] === '/') {
      kind = 'comment';
      i++;
      while (i < source.length && source[i] !== '\r' && source[i] !== '\n') i++;
      closed = i < source.length;
    } else if (literal) {
      kind = 'string';
      i = literal.end;
      closed = literal.closed;
    } else if (wordPart(ch)) {
      // Consume digit-leading malformed words as one nonidentifier, rather than
      // treating a builtin suffix as a standalone callable.
      kind = /[0-9]/.test(ch) ? 'number' : 'word';
      while (wordPart(source[i])) i++;
    } else if (ch === ':' && source[i] === ':') {
      i++;
    }
    if (tokens.length >= BUILTIN_DOCUMENT_TOKEN_LIMIT) return undefined;
    tokens.push({ kind, text: source.slice(start, i), start, end: i, closed });
  }
  return tokens;
}

/** Comments are trivia for context, but their own contents are never scanned. */
export function previousCodeToken(
  tokens: readonly BuiltinToken[], index: number
): BuiltinToken | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].kind !== 'comment') return tokens[i];
  }
  return undefined;
}

export function blockedBuiltinName(previous: BuiltinToken | undefined): boolean {
  return previous !== undefined &&
    (previous.text === '.' || previous.text === '::' ||
      (previous.kind === 'word' && DECLARATION_WORDS.has(previous.text)));
}

/** A plain parenthesized expression should not hide an enclosing call. */
export function isGroupingParenthesis(previous: BuiltinToken | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === 'word') return GROUPING_WORDS.has(previous.text);
  if (previous.kind === 'number' || previous.kind === 'string') return false;
  return previous.text !== ')' && previous.text !== ']' &&
    previous.text !== '.' && previous.text !== '::';
}

/** First token beginning at or after offset. Works on UTF-16 offsets. */
export function builtinTokenLowerBound(tokens: readonly BuiltinToken[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (tokens[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
