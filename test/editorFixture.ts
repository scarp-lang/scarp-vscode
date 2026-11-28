import type { ScarpStructure, ScarpSpan, ScarpToken } from '../src/editorStructure';

/**
 * Construct deliberately small structural fixtures for testing consumers of
 * the already separately tested editor scanner. Fixtures are not a parser:
 * tests using them must not make assertions about the real Scarp grammar.
 */
export function fixtureStructure(source: string): ScarpStructure {
  const lines = [0];
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '\r') {
      if (source[at + 1] === '\n') at++;
      lines.push(at + 1);
    } else if (source[at] === '\n') {
      lines.push(at + 1);
    }
  }
  const strings: ScarpSpan[] = [];
  const comments: ScarpSpan[] = [];
  const tokens: ScarpToken[] = [];
  const brackets: string[] = [];
  const isWordStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
  const isWordPart = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
  for (let at = 0; at < source.length;) {
    const begin = at;
    const c = source[at];
    if (/\s/.test(c)) { at++; continue; }
    if (c === '/' && source[at + 1] === '/') {
      at += 2;
      while (at < source.length && source[at] !== '\n' && source[at] !== '\r') at++;
      comments.push({ start: begin, end: at });
      continue;
    }
    let kind: ScarpToken['kind'] = 'punctuation';
    if (source.startsWith('"""', at)) {
      kind = 'string';
      at += 3;
      const end = source.indexOf('"""', at);
      at = end < 0 ? source.length : end + 3;
      strings.push({ start: begin, end: at });
    } else if (c === '"') {
      kind = 'string';
      at++;
      while (at < source.length) {
        if (source[at++] === '\\') { at++; continue; }
        if (source[at - 1] === '"') break;
      }
      strings.push({ start: begin, end: at });
    } else if (isWordStart(c)) {
      kind = 'word'; at++;
      while (isWordPart(source[at])) at++;
    } else if (/[0-9]/.test(c)) {
      kind = 'number'; at++;
      while (/[A-Za-z0-9_.]/.test(source[at] ?? '')) at++;
    } else { at++; }
    const token: ScarpToken = {
      kind, text: source.slice(begin, at),
      span: { start: begin, end: at }, depth: brackets.length
    };
    tokens.push(token);
    if (c === '(' || c === '[' || c === '{') brackets.push(c);
    if (c === ')' || c === ']' || c === '}') brackets.pop();
  }
  return { length: source.length, lines, tokens, strings, comments,
    pairs: [], regions: [], imports: [] };
}
export function applyEdits(
  text: string, edits: readonly { start: number; end: number; replacement: string }[]
): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}
