import type { ScarpStructure, ScarpToken, ScarpSpan } from './editorStructure';
import { scarpLocalCallGraph, type ScarpCallGraph, type ScarpCallNode } from './editorCallHierarchy';

export type ScarpBindingKind = 'parameter' | 'immutable' | 'mutable' | 'repeat';
export type ScarpReferenceKind = 'definition' | 'read' | 'write';
export interface ScarpLocalBinding {
  readonly id: number;
  readonly name: string;
  readonly kind: ScarpBindingKind;
  readonly functionName: string;
  readonly declaration: ScarpSpan;
  readonly visibility: ScarpSpan;
  readonly scope: number;
}
export interface ScarpLocalReference {
  readonly bindingId: number;
  readonly name: string;
  readonly kind: ScarpReferenceKind;
  readonly span: ScarpSpan;
}
export interface ScarpLocalBindings {
  readonly bindings: readonly ScarpLocalBinding[];
  readonly references: readonly ScarpLocalReference[];
  readonly ambiguous: readonly ScarpSpan[];
}
export interface ScarpLocalBindingOptions {
  readonly maximumTokens?: number;
  readonly maximumBindings?: number;
  readonly maximumReferences?: number;
  readonly maximumScopes?: number;
  readonly maximumSourceLength?: number;
}
interface Scope {
  readonly id: number;
  readonly parent: number | undefined;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}
const MAX_SOURCE = 1_000_000;
const MAX_TOKENS = 80_000;
const MAX_BINDINGS = 4096;
const MAX_REFERENCES = 30_000;
const MAX_SCOPES = 4096;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set([
  'funcra', 'bind', 'var', 'pub', 'pure', 'if', 'else', 'while',
  'repeat', 'as', 'import', 'return', 'true', 'false', 'match',
  'needs', 'ensures', 'record', 'variant', 'case', 'new', 'on',
  'break', 'continue', 'unit', 'integer', 'float', 'decimal', 'boolean',
  'string', 'bigint', 'array', 'list', 'map', 'tuple', 'option', 'result'
]);
function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  const n = value ?? fallback;
  return Number.isSafeInteger(n) && n > 0 && n <= ceiling ? n : 0;
}
function isName(t: ScarpToken | undefined): t is ScarpToken {
  return !!t && t.kind === 'word' && IDENTIFIER.test(t.text) && !KEYWORDS.has(t.text);
}
function inside(span: ScarpSpan, at: number): boolean {
  return span.start <= at && at < span.end;
}
function tokenIndex(tokens: readonly ScarpToken[], position: number): number {
  let low = 0, high = tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].span.start < position) low = mid + 1;
    else high = mid;
  }
  return low;
}
function equalSpan(a: ScarpSpan, b: ScarpSpan): boolean {
  return a.start === b.start && a.end === b.end;
}
function hasDeclarationBoundary(tokens: readonly ScarpToken[], index: number): boolean {
  const prior = tokens[index - 1];
  return !prior || [';', '{', '}'].includes(prior.text);
}
function isSelector(tokens: readonly ScarpToken[], index: number): boolean {
  const a = tokens[index - 1];
  const b = tokens[index - 2];
  return a?.text === '.' || a?.text === ':' && b?.text === ':';
}
function isLabel(tokens: readonly ScarpToken[], index: number): boolean {
  const t = tokens[index + 1];
  return t?.text === ':' && tokens[index - 1]?.text !== ':';
}
function isTypeName(tokens: readonly ScarpToken[], index: number): boolean {
  const prev = tokens[index - 1];
  return prev?.text === ':' || prev?.text === '->' ||
    prev?.text === 'as' || prev?.text === 'new';
}
function isWrite(tokens: readonly ScarpToken[], at: number): boolean {
  const next = tokens[at + 1];
  if (next?.text === '=' && tokens[at - 1]?.text !== '=') return true;
  return ['+', '-', '*', '/', '%'].includes(next?.text ?? '') &&
    tokens[at + 2]?.text === '=';
}

/**
 * Assign brace scopes with exact closing offsets. Parentheses, brackets and
 * comments cannot create local scopes; Scarp lexical blocks use braces.
 * Malformed braces disable the analysis, never assign a guessed lifetime.
 */
function scanScopes(
  tokens: readonly ScarpToken[], fn: ScarpCallNode, maxScopes: number
): { scopes: readonly Scope[]; scopeByToken: ReadonlyMap<number, number> } | undefined {
  const scopes: Scope[] = [{ id: 0, parent: undefined,
    start: fn.bodyRange.start, end: fn.bodyRange.end, depth: 0 }];
  const scopeByToken = new Map<number, number>();
  const stack: number[] = [0];
  let at = tokenIndex(tokens, fn.bodyRange.start);
  const stop = tokenIndex(tokens, fn.bodyRange.end);
  while (at < stop) {
    const t = tokens[at];
    scopeByToken.set(at, stack[stack.length - 1]);
    if (t.kind === 'punctuation' && t.text === '{') {
      if (scopes.length >= maxScopes) return undefined;
      const parent = stack[stack.length - 1];
      const child: Scope = { id: scopes.length, parent,
        start: t.span.end, end: -1, depth: stack.length };
      scopes.push(child);
      stack.push(child.id);
    } else if (t.kind === 'punctuation' && t.text === '}') {
      if (stack.length <= 1) return undefined;
      const scopeId = stack.pop()!;
      const before = scopes[scopeId];
      scopes[scopeId] = { ...before, end: t.span.start };
    }
    at++;
  }
  return stack.length === 1 ? { scopes, scopeByToken } : undefined;
}
function functionParameters(
  tokens: readonly ScarpToken[], fn: ScarpCallNode
): readonly ScarpToken[] {
  if (!fn.parameters.length) return [];
  const from = tokenIndex(tokens, fn.declarationRange.start);
  const to = tokenIndex(tokens, fn.bodyRange.start);
  // Only names actually present in the exact signature are eligible. Avoid
  // guessing from return-type names or contracts outside parameter clauses.
  const matches: ScarpToken[] = [];
  for (let i = from; i + 1 < to; i++) {
    const token = tokens[i];
    if (!isName(token) || tokens[i + 1].text !== ':' ||
        !fn.parameters.includes(token.text) ||
        matches.some(existing => existing.text === token.text)) continue;
    matches.push(token);
  }
  return matches.length === fn.parameters.length ? matches : [];
}
function repeatIndices(
  tokens: readonly ScarpToken[], begin: number, end: number,
  scopes: readonly Scope[], scopeByToken: ReadonlyMap<number, number>
): Array<{ token: ScarpToken; scope: number; visible: ScarpSpan }> {
  const indices: Array<{ token: ScarpToken; scope: number; visible: ScarpSpan }> = [];
  for (let i = begin; i < end; i++) {
    const token = tokens[i];
    if (token.text !== 'repeat' || token.kind !== 'word') continue;
    for (let j = i + 1; j < Math.min(end, i + 32); j++) {
      if (tokens[j].text === '{') {
        const name = tokens[j - 1];
        if (tokens[j - 2]?.text !== 'as' || !isName(name)) break;
        const parent = scopeByToken.get(j);
        const sc = scopes.find(scope => scope.parent === parent &&
          scope.start === tokens[j].span.end);
        if (sc && sc.end >= sc.start) {
          indices.push({ token: name, scope: sc.id,
            visible: { start: name.span.start, end: sc.end } });
        }
        break;
      }
      if ([';', '}', ')'].includes(tokens[j].text)) break;
    }
  }
  return indices;
}
function nearestVisibleBinding(
  bindings: readonly ScarpLocalBinding[], scopes: readonly Scope[],
  scope: number, name: string, offset: number
): ScarpLocalBinding | 'ambiguous' | undefined {
  // Traverse outward from the token's exact lexical block. A binding from
  // a sibling block is never visible, even if the source text is identical.
  let current: number | undefined = scope;
  while (current !== undefined) {
    const local = bindings.filter(b => b.scope === current && b.name === name &&
      b.visibility.start <= offset && offset < b.visibility.end);
    if (local.length > 1) return 'ambiguous';
    if (local.length === 1) return local[0];
    current = scopes[current]?.parent;
  }
  return undefined;
}

/**
 * Read-only local binding resolution within a single fully matched function.
 * This conservative lexical index deliberately ignores imports, fields,
 * destructured patterns, closure captures and future Scarp syntax. It never
 * invokes a compiler or edits a file. Unsupported constructs yield no result.
 */
export function scarpLocalBindings(
  source: string, structure: ScarpStructure, options: ScarpLocalBindingOptions = {}
): ScarpLocalBindings | undefined {
  const sourceMax = bounded(options.maximumSourceLength, MAX_SOURCE, 2_000_000);
  const tokenMax = bounded(options.maximumTokens, MAX_TOKENS, 120_000);
  const bindingMax = bounded(options.maximumBindings, MAX_BINDINGS, 30_000);
  const refMax = bounded(options.maximumReferences, MAX_REFERENCES, 100_000);
  const scopeMax = bounded(options.maximumScopes, MAX_SCOPES, 16_384);
  if (!sourceMax || !tokenMax || !bindingMax || !refMax || !scopeMax ||
      source.length > sourceMax || structure.length !== source.length ||
      structure.tokens.length > tokenMax) return undefined;
  const graph: ScarpCallGraph | undefined = scarpLocalCallGraph(source, structure);
  if (!graph) return undefined;
  const tokens = structure.tokens;
  const bindings: ScarpLocalBinding[] = [];
  const references: ScarpLocalReference[] = [];
  const ambiguous: ScarpSpan[] = [];
  for (const fn of graph.nodes) {
    const scanned = scanScopes(tokens, fn, scopeMax);
    if (!scanned) return undefined;
    const { scopes, scopeByToken } = scanned;
    const begin = tokenIndex(tokens, fn.bodyRange.start);
    const end = tokenIndex(tokens, fn.bodyRange.end);
    const local: ScarpLocalBinding[] = [];
    const addBinding = (
      token: ScarpToken, kind: ScarpBindingKind, scope: number,
      visible: ScarpSpan
    ): void => {
      const entry: ScarpLocalBinding = {
        id: bindings.length + local.length, name: token.text, kind,
        functionName: fn.name, declaration: token.span, visibility: visible, scope
      };
      local.push(entry);
    };
    for (const name of functionParameters(tokens, fn)) {
      addBinding(name, 'parameter', 0, { start: fn.bodyRange.start, end: fn.bodyRange.end });
    }
    for (let i = begin; i < end; i++) {
      const token = tokens[i];
      if (!['bind', 'var'].includes(token.text) ||
          token.kind !== 'word' || !hasDeclarationBoundary(tokens, i)) continue;
      const name = tokens[i + 1];
      const after = tokens[i + 2];
      if (!isName(name) || !after || !['=', ':'].includes(after.text)) continue;
      const scope = scopeByToken.get(i);
      if (scope === undefined) continue;
      const endOffset = scopes[scope].end;
      if (endOffset <= name.span.start) continue;
      addBinding(name, token.text === 'bind' ? 'immutable' : 'mutable', scope,
        { start: name.span.start, end: endOffset });
    }
    for (const item of repeatIndices(tokens, begin, end, scopes, scopeByToken)) {
      addBinding(item.token, 'repeat', item.scope, item.visible);
    }
    if (bindings.length + local.length > bindingMax) return undefined;
    const declarations = new Map(local.map(b => [b.declaration.start, b]));
    for (const binding of local) {
      references.push({ bindingId: binding.id, name: binding.name,
        kind: 'definition', span: binding.declaration });
    }
    for (let i = begin; i < end; i++) {
      const t = tokens[i];
      if (!isName(t) || declarations.has(t.span.start) ||
          isSelector(tokens, i) || isLabel(tokens, i) || isTypeName(tokens, i) ||
          // No synthetic reference should be created for a declaration or
          // a type/case header after its keyword.
          ['bind', 'var', 'funcra', 'record', 'variant', 'import', 'case']
            .includes(tokens[i - 1]?.text ?? '')) continue;
      const scope = scopeByToken.get(i);
      if (scope === undefined) continue;
      const binding = nearestVisibleBinding(local, scopes, scope, t.text, t.span.start);
      if (binding === 'ambiguous') { ambiguous.push(t.span); continue; }
      if (!binding) continue;
      references.push({ bindingId: binding.id, name: t.text,
        kind: isWrite(tokens, i) ? 'write' : 'read', span: t.span });
      if (references.length > refMax) return undefined;
    }
    bindings.push(...local);
  }
  references.sort((a, b) => a.span.start - b.span.start);
  return { bindings, references, ambiguous };
}

/** A cursor can select either a declaration or one of its resolved uses. */
export function scarpBindingAt(
  index: ScarpLocalBindings, offset: number
): ScarpLocalBinding | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  const reference = index.references.find(ref => inside(ref.span, offset));
  return reference ? index.bindings.find(b => b.id === reference.bindingId) : undefined;
}
export function scarpBindingReferences(
  index: ScarpLocalBindings, binding: ScarpLocalBinding
): readonly ScarpLocalReference[] {
  return index.bindings.some(b => b.id === binding.id && b.name === binding.name &&
      b.kind === binding.kind && b.functionName === binding.functionName &&
      equalSpan(b.declaration, binding.declaration))
    ? index.references.filter(ref => ref.bindingId === binding.id) : [];
}
