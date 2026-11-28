import type { ScarpSpan, ScarpStructure, ScarpToken } from './editorStructure';

export interface ScarpCallNode {
  readonly name: string;
  readonly nameRange: ScarpSpan;
  readonly declarationRange: ScarpSpan;
  readonly bodyRange: ScarpSpan;
  readonly public: boolean;
  readonly pure: boolean;
  readonly parameters: readonly string[];
}
export interface ScarpCallSite {
  readonly caller: string;
  readonly callee: string;
  readonly nameRange: ScarpSpan;
  readonly callRange: ScarpSpan;
}
export interface ScarpCallEdge {
  readonly from: ScarpCallNode;
  readonly to: ScarpCallNode;
  readonly sites: readonly ScarpCallSite[];
}
export interface ScarpCallGraph {
  readonly nodes: readonly ScarpCallNode[];
  readonly calls: readonly ScarpCallSite[];
  readonly rejected: readonly string[];
}
export interface ScarpCallOptions {
  readonly maximumSourceLength?: number;
  readonly maximumTokens?: number;
  readonly maximumFunctions?: number;
  readonly maximumCalls?: number;
  readonly maximumHeaderTokens?: number;
}
const DEFAULT_SOURCE = 1_000_000;
const DEFAULT_TOKENS = 80_000;
const DEFAULT_FUNCTIONS = 400;
const DEFAULT_CALLS = 5000;
const DEFAULT_HEADER_TOKENS = 256;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_GENERIC_DEPTH = 16;
const MAX_PARAMETER_COUNT = 64;
const MAX_SHADOWING_SCOPES = 512;

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  const n = value ?? fallback;
  return Number.isSafeInteger(n) && n > 0 && n <= ceiling ? n : 0;
}
function isIdentifier(token: ScarpToken | undefined): token is ScarpToken {
  return !!token && token.kind === 'word' && IDENTIFIER.test(token.text);
}
function isPunct(token: ScarpToken | undefined, value: string): boolean {
  return token?.kind === 'punctuation' && token.text === value;
}
function isValidSpan(span: ScarpSpan, max: number): boolean {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
    span.start >= 0 && span.end > span.start && span.end <= max;
}
function collectBrackets(
  tokens: readonly ScarpToken[], maxSource: number
): ReadonlyMap<number, number> | undefined {
  const paired = new Map<number, number>();
  const stack: Array<{ opening: string; index: number }> = [];
  let prev = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isValidSpan(token.span, maxSource) || token.span.start < prev) return undefined;
    prev = token.span.end;
    if (token.kind !== 'punctuation') continue;
    if (['(', '[', '{'].includes(token.text)) {
      stack.push({ opening: token.text, index: i });
      if (stack.length > MAX_SHADOWING_SCOPES) return undefined;
    } else if ([')', ']', '}'].includes(token.text)) {
      const frame = stack.pop();
      const matching = frame && (frame.opening === '(' && token.text === ')' ||
        frame.opening === '[' && token.text === ']' ||
        frame.opening === '{' && token.text === '}');
      if (!matching) return undefined;
      paired.set(frame.index, i);
    }
  }
  return stack.length === 0 ? paired : undefined;
}

/**
 * Detect a bounded generic header `foo<T, U: type>(...)` without interpreting
 * generic constraints or guessing an overloaded call signature. Only the
 * placement of the value parameter parenthesis is needed for the graph.
 */
function valueParameterOpen(
  tokens: readonly ScarpToken[], start: number, stop: number
): number | undefined {
  if (isPunct(tokens[start], '(')) return start;
  if (!isPunct(tokens[start], '<')) return undefined;
  let nested = 0;
  let seenName = false;
  for (let i = start; i < stop; i++) {
    const token = tokens[i];
    if (isPunct(token, '<')) {
      nested++;
      if (nested > MAX_GENERIC_DEPTH) return undefined;
    } else if (isPunct(token, '>')) {
      if (--nested < 0) return undefined;
      if (!nested) return isPunct(tokens[i + 1], '(') && seenName ? i + 1 : undefined;
    } else if (!nested) return undefined;
    else if (token.kind === 'word') seenName = true;
    else if (token.text === ';' || token.text === '{' || token.text === '}') return undefined;
  }
  return undefined;
}
/**
 * Extract parameter identifiers only when each comma-delimited parameter
 * starts with `name:`. Complex patterns and malformed signatures are not
 * silently misrepresented as unshadowed callable symbols.
 */
function parameterNames(
  tokens: readonly ScarpToken[], open: number, close: number
): readonly string[] | undefined {
  if (close <= open || close - open > 512) return undefined;
  const names: string[] = [];
  let start = open + 1;
  let nesting = 0;
  for (let i = start; i <= close; i++) {
    const tok = tokens[i];
    if (!tok) return undefined;
    if (i !== close && ['(', '[', '<'].includes(tok.text)) nesting++;
    if (i !== close && [')', ']', '>'].includes(tok.text)) nesting--;
    if (nesting < 0) return undefined;
    if ((i === close || tok.text === ',' && nesting === 0) && i > start) {
      const name = tokens[start];
      if (!isIdentifier(name) || tokens[start + 1]?.text !== ':' ||
          name.text === '_' || names.includes(name.text)) return undefined;
      names.push(name.text);
      if (names.length > MAX_PARAMETER_COUNT) return undefined;
      start = i + 1;
    } else if (i === close || tok.text === ',' && nesting === 0) start = i + 1;
  }
  return nesting === 0 ? names : undefined;
}
function hasDeclarationBoundary(tokens: readonly ScarpToken[], start: number): boolean {
  const before = tokens[start - 1];
  return !before || ['}', ';', '{'].includes(before.text);
}
function functionAt(
  source: string, tokens: readonly ScarpToken[], brackets: ReadonlyMap<number, number>,
  start: number, maxHeader: number
): { node: ScarpCallNode; next: number; bodyToken: number } | undefined {
  const keyword = tokens[start];
  if (!keyword || keyword.text !== 'funcra' || keyword.kind !== 'word' ||
      keyword.depth !== 0) return undefined;
  const name = tokens[start + 1];
  if (!isIdentifier(name) || name.text === '_') return undefined;
  const paramOpen = valueParameterOpen(tokens, start + 2,
    Math.min(tokens.length, start + maxHeader));
  if (paramOpen === undefined) return undefined;
  const paramClose = brackets.get(paramOpen);
  if (paramClose === undefined) return undefined;
  const parameters = parameterNames(tokens, paramOpen, paramClose);
  if (!parameters) return undefined;
  const searchEnd = Math.min(tokens.length, start + maxHeader);
  let bodyToken: number | undefined;
  for (let i = paramClose + 1; i < searchEnd; i++) {
    const token = tokens[i];
    if (token.depth !== 0) continue;
    if (token.text === '{') { bodyToken = i; break; }
    if (token.text === ';' || token.text === '=' || token.text === 'funcra') return undefined;
  }
  if (bodyToken === undefined) return undefined;
  const closing = brackets.get(bodyToken);
  if (closing === undefined) return undefined;
  const before = tokens[start - 1];
  const before2 = tokens[start - 2];
  const pure = before?.text === 'pure';
  const publicFlag = before?.text === 'pub' || before2?.text === 'pub' && pure;
  const startSpan = publicFlag && pure ? before2.span.start :
    (publicFlag || pure) && before ? before.span.start : keyword.span.start;
  const node: ScarpCallNode = {
    name: name.text, nameRange: name.span,
    declarationRange: { start: startSpan, end: tokens[closing].span.end },
    bodyRange: { start: tokens[bodyToken].span.end, end: tokens[closing].span.start },
    public: publicFlag, pure, parameters
  };
  return { node, next: closing + 1, bodyToken };
}
function directlyAdjacent(left: ScarpToken, right: ScarpToken, source: string): boolean {
  return !source.slice(left.span.end, right.span.start).trim();
}
function callOpen(
  source: string, tokens: readonly ScarpToken[], at: number,
  maxHeader: number
): number | undefined {
  const after = tokens[at + 1];
  if (isPunct(after, '(')) return at + 1;
  if (!isPunct(after, '<')) return undefined;
  const value = valueParameterOpen(tokens, at + 1,
    Math.min(tokens.length, at + maxHeader));
  if (value === undefined) return undefined;
  const terminal = tokens[value];
  return directlyAdjacent(tokens[at], tokens[at + 1], source) &&
    terminal ? value : undefined;
}
function isSelector(tokens: readonly ScarpToken[], i: number): boolean {
  const a = tokens[i - 1], b = tokens[i - 2];
  return a?.text === '.' || a?.text === ':' && b?.text === ':';
}
function isTypeAnnotation(tokens: readonly ScarpToken[], i: number): boolean {
  const prev = tokens[i - 1];
  return prev?.text === ':' || prev?.text === '->';
}
interface Shadowing { readonly name: string; readonly begins: number; readonly ends: number; }
function localShadows(
  tokens: readonly ScarpToken[], brackets: ReadonlyMap<number, number>,
  fn: ScarpCallNode, start: number, end: number
): readonly Shadowing[] {
  const result: Shadowing[] = [];
  const scopeEnd: Array<{ index: number; offset: number }> = [];
  for (let i = start; i <= end; i++) {
    const t = tokens[i];
    if (!t) break;
    while (scopeEnd.length && i >= scopeEnd[scopeEnd.length - 1].index) scopeEnd.pop();
    if (t.text === '{' && brackets.has(i)) {
      const closer = brackets.get(i)!;
      scopeEnd.push({ index: closer, offset: tokens[closer].span.start });
    }
    if ((t.text === 'bind' || t.text === 'var') && isIdentifier(tokens[i + 1])) {
      const name = tokens[i + 1];
      if (!['=', ':'].includes(tokens[i + 2]?.text ?? '')) continue;
      result.push({ name: name.text, begins: name.span.start,
        ends: scopeEnd.at(-1)?.offset ?? fn.bodyRange.end });
    }
    if (t.text === 'repeat') {
      // A counted repeat index exists only inside its own loop body. Read
      // a short header and reject complex `as` constructs conservatively.
      for (let j = i + 1; j < Math.min(i + 32, end); j++) {
        if (tokens[j].text === '{' && tokens[j - 1]?.kind === 'word' &&
            tokens[j - 2]?.text === 'as' && brackets.has(j)) {
          result.push({ name: tokens[j - 1].text,
            begins: tokens[j].span.end, ends: tokens[brackets.get(j)!].span.start });
          break;
        }
        if (tokens[j].text === ';' || tokens[j].text === '}') break;
      }
    }
  }
  for (const name of fn.parameters) {
    result.push({ name, begins: fn.bodyRange.start, ends: fn.bodyRange.end });
  }
  return result;
}

/**
 * Build a bounded *same-file* call graph from source tokens. This is not a
 * compiler name resolver: project imports, methods, closures, ambiguous names
 * and dynamic values are never assigned a guessed edge. A graph can be used
 * for read-only call-hierarchy UI in Restricted Mode without running code.
 */
export function scarpLocalCallGraph(
  source: string, structure: ScarpStructure, options: ScarpCallOptions = {}
): ScarpCallGraph | undefined {
  const maxSource = bounded(options.maximumSourceLength, DEFAULT_SOURCE, 2_000_000);
  const maxTokens = bounded(options.maximumTokens, DEFAULT_TOKENS, 120_000);
  const maxFns = bounded(options.maximumFunctions, DEFAULT_FUNCTIONS, 2048);
  const maxCalls = bounded(options.maximumCalls, DEFAULT_CALLS, 30_000);
  const maxHeader = bounded(options.maximumHeaderTokens, DEFAULT_HEADER_TOKENS, 1000);
  if (!maxSource || !maxTokens || !maxFns || !maxCalls || !maxHeader ||
      source.length > maxSource || structure.length !== source.length ||
      structure.tokens.length > maxTokens) return undefined;
  const tokens = structure.tokens;
  const brackets = collectBrackets(tokens, source.length);
  if (!brackets) return undefined;
  const nodes: ScarpCallNode[] = [];
  const bounds: Array<{ begin: number; end: number; fn: ScarpCallNode }> = [];
  const rejected: string[] = [];
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at];
    if (token.text !== 'funcra' || token.depth !== 0 ||
        !hasDeclarationBoundary(tokens, at) &&
        tokens[at - 1]?.text !== 'pure' && tokens[at - 1]?.text !== 'pub') {
      at++; continue;
    }
    const found = functionAt(source, tokens, brackets, at, maxHeader);
    if (!found) { at++; continue; }
    if (nodes.length >= maxFns) return undefined;
    nodes.push(found.node);
    bounds.push({ begin: found.bodyToken + 1, end: found.next - 1, fn: found.node });
    at = found.next;
  }
  // Names may be overloaded or redefined in future Scarp versions. Rather
  // than invent an arbitrary binding, suppress those edges entirely.
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  const byName = new Map(nodes.filter(n => counts.get(n.name) === 1)
    .map(node => [node.name, node]));
  for (const [name, count] of counts) if (count > 1) rejected.push(name);
  const calls: ScarpCallSite[] = [];
  for (const bound of bounds) {
    const shadow = localShadows(tokens, brackets, bound.fn, bound.begin, bound.end);
    for (let i = bound.begin; i < bound.end; i++) {
      const candidate = tokens[i];
      if (!isIdentifier(candidate) || !byName.has(candidate.text)) continue;
      if (isSelector(tokens, i) || isTypeAnnotation(tokens, i) ||
          tokens[i + 1]?.text === ':' || tokens[i - 1]?.text === 'as' ||
          tokens[i - 1]?.text === 'new') continue;
      if (shadow.some(s => s.name === candidate.text &&
          candidate.span.start >= s.begins && candidate.span.start < s.ends)) continue;
      const open = callOpen(source, tokens, i, maxHeader);
      if (open === undefined) continue;
      const close = brackets.get(open);
      if (close === undefined || close >= bound.end) continue;
      const callee = byName.get(candidate.text)!;
      calls.push({ caller: bound.fn.name, callee: callee.name,
        nameRange: candidate.span,
        callRange: { start: candidate.span.start, end: tokens[close].span.end } });
      if (calls.length > maxCalls) return undefined;
    }
  }
  return { nodes, calls, rejected };
}

/** Find one declared function by its name or a precise cursor selection. */
export function scarpCallNodeAt(
  graph: ScarpCallGraph, offset: number
): ScarpCallNode | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return graph.nodes.find(n => n.nameRange.start <= offset && offset < n.nameRange.end);
}
function edgeGroups(
  graph: ScarpCallGraph, node: ScarpCallNode, direction: 'incoming' | 'outgoing'
): readonly ScarpCallEdge[] {
  const name = node.name;
  const duplicates = graph.nodes.filter(n => n.name === name);
  if (duplicates.length !== 1) return [];
  const seen = new Map<string, ScarpCallSite[]>();
  for (const call of graph.calls) {
    const eligible = direction === 'incoming' ? call.callee === name : call.caller === name;
    if (!eligible) continue;
    const other = direction === 'incoming' ? call.caller : call.callee;
    seen.set(other, [...(seen.get(other) ?? []), call]);
  }
  const edges: ScarpCallEdge[] = [];
  for (const [other, sites] of seen) {
    const otherNode = graph.nodes.find(n => n.name === other);
    if (!otherNode) continue;
    edges.push(direction === 'incoming'
      ? { from: otherNode, to: node, sites }
      : { from: node, to: otherNode, sites });
  }
  return edges.sort((a, b) => direction === 'incoming'
    ? a.from.name.localeCompare(b.from.name)
    : a.to.name.localeCompare(b.to.name));
}
export function scarpIncomingCalls(
  graph: ScarpCallGraph, node: ScarpCallNode
): readonly ScarpCallEdge[] {
  return edgeGroups(graph, node, 'incoming');
}
export function scarpOutgoingCalls(
  graph: ScarpCallGraph, node: ScarpCallNode
): readonly ScarpCallEdge[] {
  return edgeGroups(graph, node, 'outgoing');
}
