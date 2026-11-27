import { scanScarpString } from './stringLiteral';

/**
 * Lightweight Scarp document symbols for Outline / Go to Symbol.
 *
 * This is an editor-only, error-tolerant scanner, NOT a replacement for the
 * compiler's parser. Keyword spellings and file-scope declaration forms match
 * the published Scarp grammar through v0.0.6-alpha.14. No code or imports are executed.
 */
export type ScarpSymbolKind = 'function' | 'constant' | 'variable' | 'import' | 'record' | 'variant';

export interface ScarpSourceSymbol {
  kind: ScarpSymbolKind;
  name: string;
  detail: string;
  start: number;
  end: number;
  selectionStart: number;
  selectionEnd: number;
}

interface Token {
  type: 'identifier' | 'string' | 'other';
  text: string;
  start: number;
  end: number;
}

const MAX_LENGTH = 2_000_000;

function idStart(ch: string): boolean { return /[A-Za-z_]/.test(ch); }
function idContinue(ch: string): boolean { return /[A-Za-z_0-9]/.test(ch); }

function tokenize(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') { i++; }
      continue;
    }
    const start = i;
    const literal = scanScarpString(source, i);
    if (literal) {
      i = literal.end;
      result.push({ type: 'string', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (idStart(ch)) {
      i++;
      while (i < source.length && idContinue(source[i])) { i++; }
      result.push({ type: 'identifier', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      i++;
      while (i < source.length && /[A-Za-z_0-9.]/.test(source[i])) { i++; }
      result.push({ type: 'other', text: source.slice(start, i), start, end: i });
      continue;
    }
    i++;
    result.push({ type: 'other', text: ch, start, end: i });
  }
  return result;
}

function matching(tokens: readonly Token[], index: number, open: string, close: string): number {
  let depth = 0;
  for (let i = index; i < tokens.length; i++) {
    if (tokens[i].text === open) { depth++; }
    if (tokens[i].text === close && --depth === 0) { return i; }
  }
  return -1;
}

function statementEnd(tokens: readonly Token[], index: number): number {
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = index; i < tokens.length; i++) {
    switch (tokens[i].text) {
      case '(': parens++; break;
      case ')': parens--; break;
      case '[': brackets++; break;
      case ']': brackets--; break;
      case '{': braces++; break;
      case '}': braces--; break;
      case ';':
        if (parens === 0 && brackets === 0 && braces === 0) { return i; }
    }
    if (parens < 0 || brackets < 0 || braces < 0) { break; }
  }
  return -1;
}

/**
 * Outline the names introduced by a published alpha.12+ tuple, array or
 * record binding pattern. Record field labels and the discard "_" are not
 * declarations. This bounded, syntax-only reader does not evaluate or type
 * check the initializer; malformed or incomplete patterns emit no symbols.
 */
function destructuredDeclaration(
  tokens: readonly Token[], index: number
): { symbols: ScarpSourceSymbol[]; next: number } | undefined {
  const keyword = tokens[index]?.text;
  if (keyword !== 'bind' && keyword !== 'var') { return undefined; }
  const opener = tokens[index + 1]?.text;
  const closes: Readonly<Record<string, string>> = {
    '(': ')', '[': ']', '{': '}'
  };
  if (!opener || !closes[opener]) { return undefined; }

  interface Group {
    open: string;
    close: string;
    count: number;
    afterMember: boolean;
    trailingComma: boolean;
  }
  const stack: Group[] = [{
    open: opener, close: closes[opener], count: 0,
    afterMember: false, trailingComma: false
  }];
  const names: Token[] = [];
  const seen = new Set<string>();
  let cursor = index + 2;
  while (stack.length && cursor < tokens.length) {
    const group = stack[stack.length - 1];
    const token = tokens[cursor];
    if (token.text === group.close) {
      // Scarp requires nonempty groups and a trailing comma on singleton tuples.
      if (!group.count ||
          (group.open === '(' && group.count === 1 && !group.trailingComma)) {
        return undefined;
      }
      stack.pop();
      cursor++;
      continue;
    }
    if (group.afterMember) {
      if (token.text !== ',') { return undefined; }
      group.afterMember = false;
      group.trailingComma = true;
      cursor++;
      continue;
    }
    if (token.text === ',' || token.text === '=' || token.text === ';') {
      return undefined;
    }
    if (group.open === '{') {
      // {x: valueName} introduces valueName, not the record field x.
      if (token.type !== 'identifier' || tokens[cursor + 1]?.text !== ':') {
        return undefined;
      }
      cursor += 2;
    }
    const member = tokens[cursor];
    if (!member) { return undefined; }
    group.count++;
    group.afterMember = true;
    group.trailingComma = false;
    if (closes[member.text]) {
      if (stack.length >= 32) { return undefined; }
      stack.push({
        open: member.text, close: closes[member.text], count: 0,
        afterMember: false, trailingComma: false
      });
      cursor++;
    } else if (member.type === 'identifier') {
      if (member.text !== '_') {
        if (names.length >= 128 || seen.has(member.text)) { return undefined; }
        names.push(member);
        seen.add(member.text);
      }
      cursor++;
    } else {
      return undefined;
    }
  }

  if (stack.length || tokens[cursor]?.text !== '=') { return undefined; }
  const last = statementEnd(tokens, cursor);
  if (last < 0) { return undefined; }
  const begin = tokens[index].start;
  const end = tokens[last].end;
  const detail = keyword === 'bind' ? 'destructured binding' :
    'destructured mutable variable';
  return {
    symbols: names.map(name => ({
      kind: keyword === 'bind' ? 'constant' : 'variable',
      name: name.text, detail, start: begin, end,
      selectionStart: name.start, selectionEnd: name.end
    })),
    next: last + 1
  };
}

interface Found {
  symbol: ScarpSourceSymbol;
  next: number;
}

function declaration(source: string, tokens: readonly Token[], startIndex: number): Found | undefined {
  let i = startIndex;
  const begin = tokens[i];
  let exported = false;
  if (tokens[i]?.text === 'pub') { exported = true; i++; }
  let pure = false;
  if (tokens[i]?.text === 'pure') { pure = true; i++; }
  const keyword = tokens[i]?.text;
  if (keyword === 'record' || keyword === 'variant') {
    // The compiler's published nominal declarations have a name and braces
    // at file scope. Annotations such as "record Task" are not declarations.
    const name = tokens[i + 1];
    if (pure || name?.type !== 'identifier' || tokens[i + 2]?.text !== '{') {
      return undefined;
    }
    const closeBrace = matching(tokens, i + 2, '{', '}');
    if (closeBrace < 0) { return undefined; }
    return {
      symbol: {
        kind: keyword, name: name.text,
        detail: (exported ? 'public ' : '') + keyword + ' type',
        start: begin.start, end: tokens[closeBrace].end,
        selectionStart: name.start, selectionEnd: name.end
      },
      next: closeBrace + 1
    };
  }
  if (keyword === 'funcra') {
    const name = tokens[i + 1];
    if (name?.type !== 'identifier' || tokens[i + 2]?.text !== '(') { return undefined; }
    const closeParen = matching(tokens, i + 2, '(', ')');
    if (closeParen < 0) { return undefined; }
    // Contracts can follow the signature; locate its next top-level body.
    let brace = -1;
    let nestedParen = 0;
    let nestedBracket = 0;
    for (let j = closeParen + 1; j < tokens.length; j++) {
      const t = tokens[j].text;
      if (t === '(') { nestedParen++; }
      else if (t === ')') { nestedParen--; }
      else if (t === '[') { nestedBracket++; }
      else if (t === ']') { nestedBracket--; }
      else if (t === '{' && nestedParen === 0 && nestedBracket === 0) {
        brace = j;
        break;
      }
      if (nestedParen < 0 || nestedBracket < 0) { break; }
    }
    const closeBrace = brace < 0 ? -1 : matching(tokens, brace, '{', '}');
    const last = closeBrace >= 0 ? closeBrace : brace >= 0 ? tokens.length - 1 : closeParen;
    const signatureEnd = brace >= 0 ? tokens[brace].start : tokens[closeParen].end;
    const signature = source.slice(tokens[i + 2].start, signatureEnd).replace(/\s+/g, ' ').trim();
    const prefix = (exported ? 'public ' : '') + (pure ? 'pure ' : '');
    return {
      symbol: {
        kind: 'function', name: name.text,
        detail: (prefix + signature).slice(0, 160),
        start: begin.start, end: tokens[last].end,
        selectionStart: name.start, selectionEnd: name.end
      },
      next: last + 1
    };
  }
  if (pure) { return undefined; }
  if (keyword === 'bind' || (keyword === 'var' && !exported)) {
    const name = tokens[i + 1];
    if (name?.type !== 'identifier' ||
        (tokens[i + 2]?.text !== '=' && tokens[i + 2]?.text !== ':')) {
      return undefined;
    }
    const last = statementEnd(tokens, i + 2);
    if (last < 0) { return undefined; }
    const decl = source.slice(name.end, tokens[last].start).trim();
    if (!decl.includes('=')) { return undefined; }
    return {
      symbol: {
        kind: keyword === 'bind' ? 'constant' : 'variable',
        name: name.text,
        detail: (exported ? 'public ' : '') + (keyword === 'bind' ? 'binding' : 'mutable variable'),
        start: begin.start, end: tokens[last].end,
        selectionStart: name.start, selectionEnd: name.end
      },
      next: last + 1
    };
  }
  if (keyword === 'import' && !exported) {
    const path = tokens[i + 1];
    const alias = tokens[i + 3];
    if (path?.type !== 'string' || tokens[i + 2]?.text !== 'as' ||
        alias?.type !== 'identifier' || tokens[i + 4]?.text !== ';') {
      return undefined;
    }
    return {
      symbol: {
        kind: 'import', name: alias.text,
        detail: 'from ' + path.text,
        start: begin.start, end: tokens[i + 4].end,
        selectionStart: alias.start, selectionEnd: alias.end
      },
      next: i + 5
    };
  }
  return undefined;
}

/** Return top-level nominal types, functions, bindings, variables and imports. */
export function scanScarpSymbols(source: string): ScarpSourceSymbol[] {
  if (source.length > MAX_LENGTH) { return []; }
  const tokens = tokenize(source);
  const symbols: ScarpSourceSymbol[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let statementStart = true;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (statementStart && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      const destructured = destructuredDeclaration(tokens, i);
      if (destructured) {
        symbols.push(...destructured.symbols);
        i = destructured.next;
        statementStart = true;
        continue;
      }
      const found = declaration(source, tokens, i);
      if (found) {
        symbols.push(found.symbol);
        i = found.next;
        statementStart = true;
        continue;
      }
    }
    switch (token.text) {
      case '{': braceDepth++; statementStart = true; break;
      case '}': braceDepth = Math.max(0, braceDepth - 1); statementStart = true; break;
      case '(': parenDepth++; statementStart = false; break;
      case ')': parenDepth = Math.max(0, parenDepth - 1); statementStart = false; break;
      case '[': bracketDepth++; statementStart = false; break;
      case ']': bracketDepth = Math.max(0, bracketDepth - 1); statementStart = false; break;
      case ';': statementStart = true; break;
      default: statementStart = false;
    }
    i++;
  }
  return symbols;
}
