import { PUBLISHED_SCARP_BUILTINS, type ScarpBuiltinHelp } from './builtinHelp';
import { blockedBuiltinName, previousCodeToken, scanBuiltinContext } from './builtinLexicalContext';

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
  const cursor = preceding.length + character;
  const index = tokens.findIndex(token => token.kind === 'word' &&
    token.start >= preceding.length && token.start < cursor && cursor <= token.end);
  if (index < 0) return undefined;
  const token = tokens[index];
  if (blockedBuiltinName(previousCodeToken(tokens, index))) return undefined;
  const prefix = token.text.slice(0, cursor - token.start);
  if (prefix.length < MIN_PREFIX || prefix.length > 64 || token.text.length > 64) return undefined;

  return { start: token.start - preceding.length,
    end: token.end - preceding.length, prefix };
}

export function scarpBuiltinCompletionAt(
  line: string, character: number, preceding = ''
): ScarpBuiltinCompletion | undefined {
  const range = scarpCompletionPrefixAt(line, character, preceding);
  if (!range) return undefined;
  const matches = PUBLISHED_SCARP_BUILTINS.filter(help => help.name.startsWith(range.prefix));
  return matches.length ? { ...range, matches } : undefined;
}
