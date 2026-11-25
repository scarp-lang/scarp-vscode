import { scarpBuiltinByName, type ScarpBuiltinHelp } from './builtinHelp';
import { blockedBuiltinName, isGroupingParenthesis, previousCodeToken, scanBuiltinContext } from './builtinLexicalContext';

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
  grouping: boolean;
}

const MAX_DEPTH = 128;

function parametersOf(help: ScarpBuiltinHelp): string[] {
  const start = help.signature.indexOf('(');
  const end = help.signature.indexOf(')', start + 1);
  if (start < 0 || end < 0) { return []; }
  const contents = help.signature.slice(start + 1, end).trim();
  if (!contents) { return []; }
  // Generic type arguments are not function arguments: map<K, V> is one type.
  const parameters: string[] = [];
  let angleDepth = 0;
  let from = 0;
  for (let i = 0; i < contents.length; i++) {
    if (contents[i] === '<') { angleDepth++; }
    else if (contents[i] === '>') { angleDepth = Math.max(0, angleDepth - 1); }
    else if (contents[i] === ',' && angleDepth === 0) {
      parameters.push(contents.slice(from, i).trim());
      from = i + 1;
    }
  }
  parameters.push(contents.slice(from).trim());
  return parameters;
}

/**
 * Inspect a bounded source prefix, tracking nested calls and expression groups.
 * When the editor deliberately starts its window mid-document, unmatched
 * leading closing delimiters may belong to omitted source; a mismatch inside
 * a locally observed group remains an error.
 */
export function scarpSignatureAt(
  prefix: string, truncated = false
): ScarpSignatureHint | undefined {
  if (!prefix.length) return undefined;
  const tokens = scanBuiltinContext(prefix);
  if (!tokens) return undefined;
  const last = tokens[tokens.length - 1];
  if (last && last.end === prefix.length && !last.closed) return undefined;

  const stack: Frame[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'punctuation') continue;
    const ch = token.text;
    if (ch === '(' || ch === '[' || ch === '{') {
      let nameIndex = index - 1;
      while (nameIndex >= 0 && tokens[nameIndex].kind === 'comment') nameIndex--;
      const previous = tokens[nameIndex];
      const grouping = ch === '(' && isGroupingParenthesis(previous);
      const help = ch === '(' && !grouping && previous?.kind === 'word' &&
        !blockedBuiltinName(previousCodeToken(tokens, nameIndex))
        ? scarpBuiltinByName(previous.text) : undefined;
      stack.push({ kind: ch, argument: 0, grouping, help });
      if (stack.length > MAX_DEPTH) return undefined;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const expected = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const top = stack.pop();
      if (!top) {
        if (!truncated) return undefined;
      } else if (top.kind !== expected) {
        return undefined;
      }
    } else if (ch === ',' && stack[stack.length - 1]?.kind === '(') {
      stack[stack.length - 1].argument++;
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame.kind !== '(' || frame.grouping) continue;
    if (!frame.help) return undefined;
    const params = parametersOf(frame.help);
    return {
      help: frame.help,
      parameters: params,
      activeParameter: Math.min(frame.argument, Math.max(0, params.length - 1))
    };
  }
  return undefined;
}
