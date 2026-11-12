import { PUBLISHED_SCARP_BUILTINS, type ScarpBuiltinHelp } from './builtinHelp';

export interface ScarpBuiltinCompletion {
  readonly start: number;
  readonly prefix: string;
  readonly matches: readonly ScarpBuiltinHelp[];
}

const MAX_LINE_LENGTH = 16_384;
const MIN_PREFIX = 2;

function identifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Resolve only a bounded, genuine identifier prefix in Scarp source.
 * Avoid suggesting builtins inside comments, strings, member access,
 * declaration names or malformed positions. This does not resolve symbols:
 * user functions and installed compiler capabilities remain authoritative.
 */
export function scarpBuiltinCompletionAt(
  line: string, character: number
): ScarpBuiltinCompletion | undefined {
  if (!Number.isSafeInteger(character) || character < 0 ||
      character > line.length || line.length > MAX_LINE_LENGTH) {
    return undefined;
  }

  let inString = false;
  for (let i = 0; i < character; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '/' && line[i + 1] === '/') { return undefined; }
  }
  if (inString) { return undefined; }

  let start = character;
  while (start > 0 && identifierPart(line[start - 1])) { start--; }
  const prefix = line.slice(start, character);
  if (prefix.length < MIN_PREFIX || prefix.length > 64 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) { return undefined; }
  const before = line.slice(0, start);
  // A user-declared function, import alias or binding name must not suggest
  // runtime builtins. Qualified calls are resolved by the compiler instead.
  if (/\.\s*$/.test(before) ||
      /\b(?:funcra|bind|var|import|as|pub|pure)\s*$/.test(before)) {
    return undefined;
  }

  const matches = PUBLISHED_SCARP_BUILTINS.filter(help =>
    help.name.startsWith(prefix));
  return matches.length ? { start, prefix, matches } : undefined;
}
