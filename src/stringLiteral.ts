/** Editor-only string boundaries matching the published alpha.3 lexer.
 * The caller must invoke this at a token boundary. Offsets are UTF-16.
 * Ordinary and raw strings recover at physical newlines; triple strings
 * deliberately consume all remaining text when their closing delimiter is absent.
 */
export interface ScarpStringLiteral {
  readonly end: number;
  readonly closed: boolean;
  readonly kind: 'ordinary' | 'raw' | 'multiline';
}

export function scanScarpString(source: string, start: number): ScarpStringLiteral | undefined {
  const multiline = source.startsWith('"""', start);
  const raw = source.startsWith('r"', start);
  if (!multiline && !raw && source[start] !== '"') return undefined;
  const kind = multiline ? 'multiline' : raw ? 'raw' : 'ordinary';
  const delimiter = multiline ? '"""' : '"';
  let i = start + (multiline ? 3 : raw ? 2 : 1);
  while (i < source.length) {
    if (source.startsWith(delimiter, i)) {
      return { end: i + delimiter.length, closed: true, kind };
    }
    const ch = source[i++];
    if (!multiline && (ch === '\r' || ch === '\n')) {
      return { end: i - 1, closed: false, kind };
    }
    if (kind === 'ordinary' && ch === '\\' && i < source.length &&
        source[i] !== '\r' && source[i] !== '\n') i++;
  }
  return { end: i, closed: false, kind };
}
