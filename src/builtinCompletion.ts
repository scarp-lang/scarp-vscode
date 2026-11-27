import { PUBLISHED_SCARP_BUILTINS, type ScarpBuiltinHelp } from './builtinHelp';
import { blockedBuiltinName, builtinTokenLowerBound, previousCodeToken, scanBuiltinContext, type BuiltinToken } from './builtinLexicalContext';

export interface ScarpCompletionPrefix {
  readonly start: number;
  /** End of the entire identifier, including text after the cursor. */
  readonly end: number;
  readonly prefix: string;
}

export interface ScarpBuiltinCompletion extends ScarpCompletionPrefix {
  readonly matches: readonly ScarpBuiltinHelp[];
}

const MIN_PREFIX = 2;

/**
 * Resolve a genuine identifier prefix using bounded lexical context. Return a
 * full-token replacement range so mid-word completion cannot duplicate suffixes.
 * Prior lines (if supplied) must end at a line boundary.
 */
export function scarpCompletionPrefixAt(
  line: string, character: number, preceding = ''
): ScarpCompletionPrefix | undefined {
  if (!Number.isSafeInteger(character) || character < 0 || character > line.length) {
    return undefined;
  }
  const tokens = scanBuiltinContext(preceding + line);
  if (!tokens) return undefined;
  return scarpCompletionFromTokens(tokens, preceding.length + character, preceding.length);
}

/** Query a cached document prefix. Results remain relative to the current line. */
export function scarpCompletionFromTokens(
  tokens: readonly BuiltinToken[], cursor: number, lineStart: number
): ScarpCompletionPrefix | undefined {
  if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(lineStart) ||
      lineStart < 0 || cursor <= lineStart) return undefined;
  const index = builtinTokenLowerBound(tokens, cursor) - 1;
  const token = tokens[index];
  if (!token || token.kind !== 'word' || token.start < lineStart || cursor > token.end) return undefined;
  if (blockedBuiltinName(previousCodeToken(tokens, index))) return undefined;
  const prefix = token.text.slice(0, cursor - token.start);
  if (prefix.length < MIN_PREFIX || prefix.length > 64 || token.text.length > 64) return undefined;
  return { start: token.start - lineStart, end: token.end - lineStart, prefix };
}

export function scarpBuiltinMatches(prefix: string): readonly ScarpBuiltinHelp[] {
  return PUBLISHED_SCARP_BUILTINS.filter(help => help.name.startsWith(prefix));
}

export function scarpBuiltinCompletionAt(
  line: string, character: number, preceding = ''
): ScarpBuiltinCompletion | undefined {
  const range = scarpCompletionPrefixAt(line, character, preceding);
  if (!range) return undefined;
  const matches = scarpBuiltinMatches(range.prefix);
  return matches.length ? { ...range, matches } : undefined;
}
