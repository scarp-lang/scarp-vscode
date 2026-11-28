import type { ScarpSpan } from './editorStructure';
import {
  scarpBindingAt, scarpBindingReferences,
  type ScarpLocalBindings
} from './editorLocalBindings';
import {
  scarpCallNodeAt, type ScarpCallGraph
} from './editorCallHierarchy';

export interface ScarpHighlight {
  readonly span: ScarpSpan;
  readonly kind: 'read' | 'write' | 'text';
}
export interface ScarpHighlightOptions {
  readonly maximumHighlights?: number;
  readonly includeFunctionReferences?: boolean;
  readonly includeLocalVariables?: boolean;
}
function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 2000;
  return Number.isSafeInteger(value) && value > 0 && value <= 20_000 ? value : 0;
}
function within(span: ScarpSpan, offset: number): boolean {
  return span.start <= offset && offset < span.end;
}
function validRange(span: ScarpSpan): boolean {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
    span.start >= 0 && span.start < span.end;
}
function sortAndValidate(result: ScarpHighlight[], maximum: number): readonly ScarpHighlight[] {
  if (result.length > maximum) return [];
  result.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  let previous = -1;
  for (const item of result) {
    if (!validRange(item.span) || item.span.start < previous) return [];
    previous = item.span.end;
  }
  return result;
}

/**
 * Produce precise, read-only document highlights from local lexical indexes.
 * The compiler-backed navigation provider remains authoritative for semantic
 * symbol resolution across modules; these highlights never infer a type,
 * follow a filesystem path or modify a document.
 */
export function scarpDocumentHighlights(
  graph: ScarpCallGraph | undefined, bindings: ScarpLocalBindings | undefined,
  offset: number, options: ScarpHighlightOptions = {}
): readonly ScarpHighlight[] {
  const maximum = boundedLimit(options.maximumHighlights);
  if (!maximum || !Number.isSafeInteger(offset) || offset < 0) return [];
  if (options.includeLocalVariables !== false && bindings) {
    const binding = scarpBindingAt(bindings, offset);
    if (binding) {
      const result = scarpBindingReferences(bindings, binding).map(item => ({
        span: item.span,
        kind: item.kind === 'definition' || item.kind === 'write'
          ? 'write' as const : 'read' as const
      }));
      return sortAndValidate(result, maximum);
    }
  }
  if (options.includeFunctionReferences !== false && graph) {
    const node = scarpCallNodeAt(graph, offset) ??
      graph.nodes.find(functionNode => graph.calls.some(call =>
        call.callee === functionNode.name && within(call.nameRange, offset)));
    if (!node || graph.nodes.filter(other => other.name === node.name).length !== 1) return [];
    const result: ScarpHighlight[] = [{ span: node.nameRange, kind: 'write' }];
    for (const call of graph.calls) {
      if (call.callee !== node.name) continue;
      result.push({ span: call.nameRange, kind: 'read' });
    }
    return sortAndValidate(result, maximum);
  }
  return [];
}
