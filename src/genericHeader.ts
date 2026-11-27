/** Bounded recognition of the published alpha.3 declaration-only type
 * parameter list. This is not a type parser or a semantic resolver.
 * The two editor scanners both emit individual angle punctuation.
 */
const MAX_TYPE_PARAMETERS = 64;
const RESERVED = new Set([
  'integer', 'float', 'boolean', 'string', 'unit', 'vector', 'tile', 'bigint',
  'decimal', 'tuple', 'array', 'list', 'map', 'option', 'result', 'record',
  'variant', 'funcra', 'pure', 'bind', 'var', 'pub', 'import', 'as', 'if',
  'elif', 'else', 'while', 'repeat', 'return', 'break', 'continue', 'assert',
  'match', 'on', 'case', 'new', 'needs', 'ensures', 'true', 'false',
  'and', 'or', 'not'
]);

/** Return the opening value-parameter parenthesis index, or undefined for
 * malformed, unsupported or incomplete headers. Non-generic headers work
 * unchanged. The limit bounds even malicious partial declarations.
 */
export function valueParameterStart(
  tokens: readonly { readonly text: string }[], start: number
): number | undefined {
  if (tokens[start]?.text === '(') return start;
  if (tokens[start]?.text !== '<') return undefined;
  const seen = new Set<string>();
  let i = start + 1;
  for (;;) {
    const name = tokens[i++]?.text;
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        RESERVED.has(name) || seen.has(name) ||
        seen.size >= MAX_TYPE_PARAMETERS) return undefined;
    seen.add(name);
    if (tokens[i]?.text === ':') {
      const constraint = tokens[i + 1]?.text;
      if (constraint !== 'Numeric' && constraint !== 'Comparable') return undefined;
      i += 2;
    }
    if (tokens[i]?.text === ',') {
      i++;
      if (tokens[i]?.text !== '>') continue;
    }
    if (tokens[i]?.text !== '>') return undefined;
    return tokens[i + 1]?.text === '(' ? i + 1 : undefined;
  }
}
