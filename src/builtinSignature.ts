import { scarpBuiltinByName, type ScarpBuiltinHelp } from './builtinHelp';

/**
 * Lightweight syntactic signature help for released Scarp built-ins.
 * No compiler process, semantic indexing or untrusted source execution.
 * A bounded prefix is intentional: incorrect help is worse than no help.
 */
export interface ScarpSignatureHint {
  readonly help: ScarpBuiltinHelp;
  readonly parameters: readonly string[];
  readonly activeParameter: number;
}

interface Frame {
  kind: '(' | '[' | '{';
  help?: ScarpBuiltinHelp;
  argument: number;
}

const MAX_PREFIX = 16_384;
const MAX_DEPTH = 128;

function identifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function parametersOf(help: ScarpBuiltinHelp): string[] {
  const start = help.signature.indexOf('(');
  const end = help.signature.indexOf(')', start + 1);
  if (start < 0 || end < 0) { return []; }
  const contents = help.signature.slice(start + 1, end).trim();
  return contents ? contents.split(',').map(part => part.trim()) : [];
}

function callHelp(source: string, at: number): ScarpBuiltinHelp | undefined {
  // The opening '(' must belong to an unqualified identifier, not a
  // function declaration, member access or arbitrary parenthesized expression.
  let end = at;
  while (end > 0 && /\s/.test(source[end - 1])) { end--; }
  let start = end;
  while (start > 0 && identifierPart(source[start - 1])) { start--; }
  const name = source.slice(start, end);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { return undefined; }
  const context = source.slice(Math.max(0, start - 128), start);
  if (/\.\s*$/.test(context) || /\bfuncra\s*$/.test(context)) { return undefined; }
  return scarpBuiltinByName(name);
}

/**
 * Inspect only the text *before the cursor*, up to 16 Ki UTF-16 code units.
 * Nested calls, vectors, tuples and conditional-value blocks are tracked
 * without evaluating source. A cursor in comments, strings or a different
 * (including unknown) inner function never inherits outer builtin help.
 */
export function scarpSignatureAt(prefix: string): ScarpSignatureHint | undefined {
  if (prefix.length === 0 || prefix.length > MAX_PREFIX) { return undefined; }
  const stack: Frame[] = [];
  let inString = false;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') { inString = false; }
      // Scarp strings are single-line. An unfinished string does not
      // consume future lines in the editor's error-tolerant view.
      if (ch === '\n' || ch === '\r') { inString = false; }
      continue;
    }
    if (ch === '"' ) { inString = true; continue; }
    if (ch === '/' && prefix[i + 1] === '/') {
      while (i < prefix.length && prefix[i] !== '\n' && prefix[i] !== '\r') { i++; }
      i--;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ kind: ch, argument: 0, help: ch === '(' ? callHelp(prefix, i) : undefined });
      if (stack.length > MAX_DEPTH) { return undefined; }
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const expected = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const top = stack.pop();
      if (!top || top.kind !== expected) { return undefined; }
    } else if (ch === ',' && stack[stack.length - 1]?.kind === '(') {
      stack[stack.length - 1].argument++;
    }
  }
  if (inString) { return undefined; }

  // A cursor inside a vector/conditional expression can still be within a
  // function argument. An unknown inner call, however, hides outer hints.
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame.kind !== '(') { continue; }
    if (!frame.help) { return undefined; }
    const params = parametersOf(frame.help);
    return {
      help: frame.help,
      parameters: params,
      activeParameter: Math.min(frame.argument, Math.max(0, params.length - 1))
    };
  }
  return undefined;
}
