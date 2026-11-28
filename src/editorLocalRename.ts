import type { ScarpStructure, ScarpSpan, ScarpToken } from './editorStructure';
import {
  scarpLocalBindings, scarpBindingAt, scarpBindingReferences,
  type ScarpLocalBinding
} from './editorLocalBindings';
import { scarpLocalCallGraph } from './editorCallHierarchy';

export interface ScarpRenameEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}
export interface ScarpRenamePlan {
  readonly originalName: string;
  readonly newName: string;
  readonly declaration: ScarpSpan;
  readonly edits: readonly ScarpRenameEdit[];
}
export interface ScarpRenameOptions {
  readonly maximumTextLength?: number;
  readonly maximumEdits?: number;
  readonly maximumIdentifierLength?: number;
}
const RESERVED = new Set([
  'as', 'bind', 'break', 'case', 'continue', 'else', 'ensures',
  'false', 'float', 'funcra', 'if', 'import', 'integer', 'match',
  'needs', 'new', 'on', 'print', 'pub', 'pure', 'record', 'repeat',
  'return', 'string', 'true', 'unit', 'var', 'variant', 'while',
  'bigint', 'decimal', 'boolean', 'list', 'map', 'array', 'tuple',
  'option', 'self', 'super', 'none', 'some', 'ok', 'err'
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function validMax(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : 0;
}
/** Prevent renaming into any known reserved spelling or import-like name. */
export function validScarpLocalRenameName(
  name: unknown, maximumIdentifierLength = 64
): name is string {
  return typeof name === 'string' && name.length > 0 &&
    name.length <= maximumIdentifierLength && NAME.test(name) &&
    !RESERVED.has(name) && name !== '_';
}
function isProtectedContext(tokens: readonly ScarpToken[], i: number): boolean {
  const previous = tokens[i - 1];
  const next = tokens[i + 1];
  return previous?.text === '.' || previous?.text === ':' &&
    tokens[i - 2]?.text === ':' || next?.text === ':' ||
    previous?.text === 'new' || previous?.text === 'as';
}
/**
 * A local lexical rename does not claim to replace compiler name resolution.
 * It operates only on known, self-contained source spans within one function.
 * Any unresolved identifier occurrence which *might* refer to the selected
 * binding disables the plan rather than risking an incomplete rename.
 */
export function scarpLocalRenamePlan(
  source: string, structure: ScarpStructure, offset: number,
  replacement: unknown, options: ScarpRenameOptions = {}
): ScarpRenamePlan | undefined {
  const maxText = validMax(options.maximumTextLength, 256_000, 2_000_000);
  const maxEdits = validMax(options.maximumEdits, 512, 20_000);
  const maxIdentifier = validMax(options.maximumIdentifierLength, 64, 128);
  if (!maxText || !maxEdits || !maxIdentifier || source.length > maxText ||
      source.length !== structure.length || !Number.isSafeInteger(offset) ||
      offset < 0 || offset >= source.length ||
      !validScarpLocalRenameName(replacement, maxIdentifier)) return undefined;
  const graph = scarpLocalCallGraph(source, structure);
  const locals = scarpLocalBindings(source, structure);
  if (!graph || !locals) return undefined;
  const binding: ScarpLocalBinding | undefined = scarpBindingAt(locals, offset);
  if (!binding || binding.name === replacement ||
      binding.declaration.end - binding.declaration.start !== binding.name.length) return undefined;
  const node = graph.nodes.find(fn => fn.name === binding.functionName &&
    fn.bodyRange.start <= binding.visibility.start &&
    binding.visibility.end <= fn.bodyRange.end);
  if (!node || graph.nodes.filter(fn => fn.name === node.name).length !== 1 ||
      locals.ambiguous.some(span => span.start >= node.bodyRange.start &&
        span.end <= node.bodyRange.end)) return undefined;
  const references = scarpBindingReferences(locals, binding);
  if (!references.length || references.length > maxEdits) return undefined;
  const known = new Set(locals.references.filter(ref => ref.name === binding.name)
    .map(ref => ref.span.start));
  const fnStart = node.declarationRange.start;
  const fnEnd = node.declarationRange.end;
  const tokens = structure.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.span.start < fnStart || token.span.end > fnEnd ||
        token.kind !== 'word') continue;
    // Reject *all* occurrences of the replacement name within the function,
    // even ones not resolved as local bindings (potential imported callables,
    // fields and future language extensions). No accidental capture.
    if (token.text === replacement) return undefined;
    if (token.text === binding.name && !known.has(token.span.start) &&
        !isProtectedContext(tokens, i)) return undefined;
  }
  if (locals.bindings.some(other => other.functionName === node.name &&
      other.name === replacement)) return undefined;
  const edits = references.map(ref => ({
    start: ref.span.start, end: ref.span.end, replacement
  })).sort((a, b) => a.start - b.start);
  let previous = -1;
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < previous ||
        edit.end > source.length || source.slice(edit.start, edit.end) !== binding.name) {
      return undefined;
    }
    previous = edit.end;
  }
  if (!edits.some(edit => edit.start === binding.declaration.start &&
      edit.end === binding.declaration.end)) return undefined;
  return { originalName: binding.name, newName: replacement,
    declaration: binding.declaration, edits };
}
