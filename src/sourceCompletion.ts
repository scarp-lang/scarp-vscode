import { scanScarpString } from './stringLiteral';
import { scanScarpStructure, type ScarpToken } from './editorStructure';

export type SourceCompletionKind = 'function' | 'constant' | 'variable' | 'parameter' | 'import';

export interface SourceCompletion {
  readonly name: string;
  readonly kind: SourceCompletionKind;
  readonly declaration: number;
  readonly detail: string;
}

export const SOURCE_COMPLETION_LIMIT = 128_000;
const MAX_TOKENS = 24_000;
const MAX_DEPTH = 128;
const MAX_RESULTS = 100;
const MAX_HEADER_TOKENS = 512;
const MAX_PATTERN_DEPTH = 32;
const MAX_PATTERN_NAMES = 128;
const RESERVED = new Set([
  'bind', 'var', 'funcra', 'pub', 'pure', 'import', 'as', 'record', 'variant',
  'case', 'new', 'if', 'else', 'while', 'repeat', 'break', 'continue', 'return',
  'match', 'on', 'needs', 'ensures', 'true', 'false', '_'
]);

interface Binding {
  readonly symbols: readonly SourceCompletion[];
  assigned: boolean;
}
interface Scope {
  readonly kind: 'root' | '(' | '[' | '{';
  readonly symbols: Map<string, SourceCompletion>;
  readonly callable: boolean;
  statement: boolean;
  pending?: Binding;
}

function scope(kind: Scope['kind'], callable = false): Scope {
  return { kind, callable, symbols: new Map(), statement: kind === 'root' || kind === '{' };
}
function isName(token: ScarpToken | undefined): token is ScarpToken & { kind: 'word' } {
  return token !== undefined && token.kind === 'word' && !RESERVED.has(token.text) &&
    token.text.length <= 64;
}
function symbol(token: ScarpToken, kind: SourceCompletionKind, detail: string): SourceCompletion {
  return { name: token.text, kind, declaration: token.span.start, detail };
}
function insert(frame: Scope, value: SourceCompletion): void {
  frame.symbols.set(value.name, value);
}
function isBlock(frame: Scope): boolean {
  return frame.kind === 'root' || frame.kind === '{';
}

/**
 * Recognize a typed callable header without parsing its expressions or
 * executing contracts. Incomplete or exotic headers deliberately contribute
 * no speculative parameters. Parameter type commas (array, map, tuple)
 * never become parameter separators.
 */
function callableHeader(tokens: readonly ScarpToken[], start: number):
  { body: number; callable: SourceCompletion; parameters: SourceCompletion[] } | undefined {
  const name = tokens[start + 1];
  if (!isName(name) || tokens[start + 2]?.text !== '(') return undefined;
  const end = Math.min(tokens.length, start + MAX_HEADER_TOKENS);
  const parameters: SourceCompletion[] = [];
  let angle = 0;
  let nested = 0;
  let segment = start + 3;
  let close = -1;
  function parameter(from: number, to: number): boolean {
    if (from === to) return true;
    const name = tokens[from];
    if (!isName(name) || tokens[from + 1]?.text !== ':' || from + 2 >= to) return false;
    if (parameters.some(item => item.name === name.text)) return false;
    parameters.push(symbol(name, 'parameter', 'Typed function parameter'));
    return true;
  }
  for (let i = segment; i < end; i++) {
    const t = tokens[i].text;
    if (t === '(' || t === '[') nested++;
    else if (t === ')' && nested === 0) {
      if (angle !== 0 || !parameter(segment, i)) return undefined;
      close = i;
      break;
    } else if (t === ')' || t === ']') {
      if (--nested < 0) return undefined;
    } else if (t === '<') angle++;
    else if (t === '>') {
      // "->" in a nested callable type is not a generic close.
      if (tokens[i - 1]?.text !== '-' && --angle < 0) return undefined;
    } else if (t === ',' && !angle && !nested) {
      if (segment === i || !parameter(segment, i)) return undefined;
      segment = i + 1;
    } else if (t === ';' || t === '{' || t === '}') {
      return undefined;
    }
  }
  if (close < 0) return undefined;
  // Return types may contain generic and tuple punctuation. Contracts and
  // complex defaults are intentionally outside this lexical header recognizer.
  for (let i = close + 1; i < end; i++) {
    const t = tokens[i].text;
    if (t === '{') return {
      body: i, callable: symbol(name, 'function', 'Function declared in this document'), parameters
    };
    if (t === ';' || t === '}' || t === 'funcra' || t === 'bind' ||
        t === 'var' || t === 'needs' || t === 'ensures' || t === '=') return undefined;
  }
  return undefined;
}

/** Read only a bounded destructuring pattern, not its initializer. */
function bindingPattern(tokens: readonly ScarpToken[], start: number):
  { names: ScarpToken[]; next: number } | undefined {
  const names: ScarpToken[] = [];
  const seen = new Set<string>();
  const limit = Math.min(tokens.length, start + MAX_HEADER_TOKENS);
  let at = start;
  function member(depth: number): boolean {
    if (depth > MAX_PATTERN_DEPTH || at >= limit) return false;
    const token = tokens[at++];
    if (token.text === '_') return true;
    if (isName(token)) {
      if (seen.has(token.text) || names.length >= MAX_PATTERN_NAMES) return false;
      seen.add(token.text);
      names.push(token);
      return true;
    }
    const open = token.text;
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : undefined;
    if (!close) return false;
    let count = 0;
    let trailing = false;
    while (at < limit) {
      if (tokens[at].text === close) {
        at++;
        return count > 0 && (open !== '(' || count > 1 || trailing);
      }
      if (count > 0 && !trailing) return false;
      if (open === '{') {
        if (!isName(tokens[at]) || tokens[at + 1]?.text !== ':') return false;
        at += 2;
      }
      if (!member(depth + 1)) return false;
      count++;
      trailing = tokens[at]?.text === ',';
      if (trailing) at++;
      else if (tokens[at]?.text !== close) return false;
    }
    return false;
  }
  if (!member(0)) return undefined;
  return { names, next: at };
}

/** Counted-repeat indices exist only in the body. Complex brace expressions
 * in the count are deliberately not guessed. */
function repeatHeader(tokens: readonly ScarpToken[], start: number):
  { body: number; index: SourceCompletion } | undefined {
  const depth = tokens[start].depth;
  const end = Math.min(tokens.length, start + MAX_HEADER_TOKENS);
  for (let i = start + 1; i < end; i++) {
    const token = tokens[i];
    if (token.depth !== depth) continue;
    if (token.text === ';' || token.text === '}') return undefined;
    if (token.text === '{') {
      const name = tokens[i - 1];
      if (i <= start + 3 || tokens[i - 2]?.text !== 'as' || !isName(name)) return undefined;
      return { body: i, index: symbol(name, 'constant', 'Immutable integer repeat index') };
    }
  }
  return undefined;
}

/**
 * Conservative, prefix-only lexical completion. Only complete declarations
 * preceding the replacement token are considered. A closing block discards
 * its declarations, and a callable boundary hides outer local values rather
 * than guessing Scarp capture semantics. No source execution, type inference,
 * imports, filesystem or network access occurs.
 */
export function scarpSourceCompletions(
  preceding: string, prefix: string
): readonly SourceCompletion[] {
  if (preceding.length > SOURCE_COMPLETION_LIMIT ||
      !/^[A-Za-z_][A-Za-z0-9_]{1,63}$/.test(prefix)) return [];
  const parsed = scanScarpStructure(preceding, {
    maxLength: SOURCE_COMPLETION_LIMIT, maxTokens: MAX_TOKENS, maxDepth: MAX_DEPTH
  });
  if (!parsed) return [];
  // A caller must provide text ending immediately before the token. Do not
  // offer identifiers if the prefix is actually inside a comment or string.
  const final = parsed.tokens[parsed.tokens.length - 1];
  const lastComment = parsed.comments[parsed.comments.length - 1];
  if (lastComment?.end === preceding.length ||
      (final?.kind === 'string' && final.span.end === preceding.length &&
        !scanScarpString(final.text, 0)?.closed)) return [];

  const frames: Scope[] = [scope('root')];
  const tokens = parsed.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const frame = frames[frames.length - 1];
    const token = tokens[i];
    const t = token.text;
    if (token.kind === 'word' && isBlock(frame) && frame.statement) {
      let declaration = i;
      if (t === 'pub') declaration++;
      if (tokens[declaration]?.text === 'pure') declaration++;
      const keyword = tokens[declaration]?.text;
      if (keyword === 'funcra') {
        const header = callableHeader(tokens, declaration);
        // Don't pretend a half-written declaration header is an expression.
        if (!header) return [];
        else {
          insert(frame, header.callable);
          frame.statement = true;
          const child = scope('{', true);
          insert(child, header.callable); // recursion
          for (const param of header.parameters) insert(child, param);
          frames.push(child);
          if (frames.length > MAX_DEPTH) return [];
          i = header.body;
          continue;
        }
      }
      if (keyword === 'bind' || keyword === 'var') {
        const kind = keyword === 'bind' ? 'constant' : 'variable';
        const detail = keyword === 'bind' ? 'Immutable binding' : 'Mutable variable';
        const name = tokens[declaration + 1];
        const separator = tokens[declaration + 2]?.text;
        if (isName(name) && (separator === ':' || separator === '=')) {
          frame.pending = { symbols: [symbol(name, kind, detail)], assigned: false };
        } else if (name && ['(', '[', '{'].includes(name.text)) {
          const pattern = bindingPattern(tokens, declaration + 1);
          if (!pattern || tokens[pattern.next]?.text !== '=') return [];
          frame.pending = {
            symbols: pattern.names.map(item => symbol(item, kind, 'Destructured ' + detail.toLowerCase())),
            assigned: true
          };
          frame.statement = false;
          i = pattern.next;
          continue;
        }
      }
      if (t === 'repeat') {
        const header = repeatHeader(tokens, i);
        if (header) {
          frame.statement = true;
          const child = scope('{');
          insert(child, header.index);
          frames.push(child);
          if (frames.length > MAX_DEPTH) return [];
          i = header.body;
          continue;
        }
      }
      if (keyword === 'import' && frame.kind === 'root') {
        const alias = tokens[declaration + 3];
        if (tokens[declaration + 1]?.kind === 'string' &&
            tokens[declaration + 2]?.text === 'as' && isName(alias) &&
            tokens[declaration + 4]?.text === ';') {
          insert(frame, symbol(alias, 'import', 'Module alias (members are not resolved)'));
          i = declaration + 4;
          continue;
        }
      }
    }
    if (token.kind !== 'punctuation') {
      frame.statement = false;
      continue;
    }
    if (t === '(' || t === '[' || t === '{') {
      frame.statement = false;
      frames.push(scope(t));
      if (frames.length > MAX_DEPTH) return [];
    } else if (t === ')' || t === ']' || t === '}') {
      const expected = t === ')' ? '(' : t === ']' ? '[' : '{';
      if (frame.kind !== expected) return [];
      frames.pop();
      const parent = frames[frames.length - 1];
      if (t === '}' && isBlock(parent) && !parent.pending) parent.statement = true;
    } else if (t === ';' && isBlock(frame)) {
      if (frame.pending?.assigned && tokens[i - 1]?.text !== '=') {
        for (const item of frame.pending.symbols) insert(frame, item);
      }
      frame.pending = undefined;
      frame.statement = true;
    } else if (t === '=' && frame.pending) {
      frame.pending.assigned = true;
    } else {
      frame.statement = false;
    }
  }

  // A partially written typed binding header is not an expression context.
  const current = frames[frames.length - 1];
  if (current.pending && !current.pending.assigned) return [];
  const found = new Map<string, SourceCompletion>();
  let crossedCallable = false;
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    for (const item of frame.symbols.values()) {
      if (crossedCallable && item.kind !== 'function' && item.kind !== 'import') continue;
      if (item.name.startsWith(prefix) && !found.has(item.name)) found.set(item.name, item);
    }
    if (frame.callable) crossedCallable = true;
  }
  return [...found.values()].slice(0, MAX_RESULTS);
}
