import * as path from 'node:path';
import { checkScarpImportPath } from './editorImports';
import { scanScarpStructure, type ScarpImport } from './editorStructure';

export type ScarpGraphIssueKind =
  'missing-module' | 'unsafe-import' | 'oversized-source' |
  'duplicate-source' | 'cycle' | 'limit';
export interface ScarpGraphIssue {
  readonly kind: ScarpGraphIssueKind;
  readonly file: string;
  readonly message: string;
  readonly at?: number;
  readonly related?: readonly string[];
}
export interface ScarpGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly alias: string;
  readonly at: number;
  readonly path: string;
}
export interface ScarpGraphNode {
  readonly file: string;
  readonly imports: readonly ScarpGraphEdge[];
  readonly importedBy: readonly string[];
  readonly depth: number;
}
export interface ScarpImportGraph {
  readonly nodes: readonly ScarpGraphNode[];
  readonly edges: readonly ScarpGraphEdge[];
  readonly issues: readonly ScarpGraphIssue[];
  readonly cycles: readonly (readonly string[])[];
  readonly roots: readonly string[];
}
export interface ScarpGraphSource {
  /** Workspace-root-relative file path using forward slashes. */
  readonly file: string;
  readonly source: string;
}
export interface ScarpGraphOptions {
  readonly maxModules?: number;
  readonly maxEdges?: number;
  readonly maxSourceLength?: number;
}
const DEFAULT_MODULES = 512;
const DEFAULT_EDGES = 4096;
const DEFAULT_SOURCE_LENGTH = 1_000_000;

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function normalizedFile(filename: string): string | undefined {
  return checkScarpImportPath(filename).safe ? filename : undefined;
}
function resolve(from: string, imported: ScarpImport): string | undefined {
  if (!checkScarpImportPath(imported.path).safe) { return undefined; }
  const parent = path.posix.dirname(from);
  const combined = path.posix.normalize(path.posix.join(parent, imported.path));
  if (!checkScarpImportPath(combined).safe) { return undefined; }
  return combined;
}
interface WorkingNode {
  file: string;
  imports: ScarpGraphEdge[];
  importedBy: Set<string>;
  depth: number;
}
/**
 * Iterative Tarjan strongly-connected components. Node count is bounded,
 * recursion is deliberately avoided for worst-case linearly nested imports.
 */
function findCycles(
  nodes: ReadonlyMap<string, WorkingNode>,
  edges: readonly ScarpGraphEdge[]
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const filename of nodes.keys()) { adjacency.set(filename, []); }
  for (const edge of edges) { adjacency.get(edge.from)?.push(edge.to); }
  for (const targets of adjacency.values()) { targets.sort(); }
  const discovered = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let clock = 0;
  interface Frame {
    vertex: string;
    next: number;
    children: readonly string[];
    parent?: string;
  }
  for (const start of [...nodes.keys()].sort()) {
    if (discovered.has(start)) { continue; }
    const frames: Frame[] = [{
      vertex: start, next: 0, children: adjacency.get(start) ?? []
    }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (!discovered.has(frame.vertex)) {
        discovered.set(frame.vertex, clock);
        low.set(frame.vertex, clock++);
        stack.push(frame.vertex);
        onStack.add(frame.vertex);
      }
      if (frame.next < frame.children.length) {
        const target = frame.children[frame.next++];
        if (!nodes.has(target)) { continue; }
        if (!discovered.has(target)) {
          frames.push({
            vertex: target, next: 0,
            children: adjacency.get(target) ?? [], parent: frame.vertex
          });
        } else if (onStack.has(target)) {
          low.set(frame.vertex, Math.min(low.get(frame.vertex)!, discovered.get(target)!));
        }
        continue;
      }
      frames.pop();
      if (frame.parent) {
        low.set(frame.parent, Math.min(low.get(frame.parent)!, low.get(frame.vertex)!));
      }
      if (low.get(frame.vertex) === discovered.get(frame.vertex)) {
        const component: string[] = [];
        while (stack.length) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.vertex) { break; }
        }
        if (component.length > 1 ||
            (adjacency.get(frame.vertex) ?? []).includes(frame.vertex)) {
          cycles.push(component.sort());
        }
      }
    }
  }
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}
/** Assign shortest import distances from unreferenced roots, without DFS. */
function graphDepths(
  nodes: ReadonlyMap<string, WorkingNode>,
  edges: readonly ScarpGraphEdge[]
): string[] {
  const roots = [...nodes.values()].filter(node => node.importedBy.size === 0)
    .map(node => node.file).sort();
  // A graph containing only cycles has no unreferenced roots; start from
  // all nodes for a deterministic summary rather than hide cyclic projects.
  const queue = roots.length ? [...roots] : [...nodes.keys()].sort();
  const seen = new Set(queue);
  for (let head = 0; head < queue.length; head++) {
    const from = queue[head];
    for (const edge of edges) {
      if (edge.from !== from || seen.has(edge.to)) { continue; }
      seen.add(edge.to);
      nodes.get(edge.to)!.depth = nodes.get(from)!.depth + 1;
      queue.push(edge.to);
    }
  }
  return roots;
}
/**
 * Build a purely lexical import graph from in-memory Scarp file snapshots.
 * The compiler remains authoritative for actual import resolution.
 *
 * The graph never reads the filesystem, evaluates source, infers symbols or
 * follows paths outside its caller-provided workspace file set.
 */
export function buildScarpImportGraph(
  sources: readonly ScarpGraphSource[],
  options: ScarpGraphOptions = {}
): ScarpImportGraph {
  const maximumModules = positiveLimit(options.maxModules, DEFAULT_MODULES);
  const maximumEdges = positiveLimit(options.maxEdges, DEFAULT_EDGES);
  const maximumSource = positiveLimit(options.maxSourceLength, DEFAULT_SOURCE_LENGTH);
  const nodes = new Map<string, WorkingNode>();
  const issues: ScarpGraphIssue[] = [];
  const parsed = new Map<string, ReturnType<typeof scanScarpStructure>>();
  if (!maximumModules || !maximumEdges || !maximumSource) {
    return { nodes: [], edges: [], issues: [{
      kind: 'limit', file: '', message: 'Invalid import graph limits.'
    }], cycles: [], roots: [] };
  }
  for (const source of sources) {
    if (nodes.size >= maximumModules) {
      issues.push({
        kind: 'limit', file: '', message: 'Source module limit exceeded.'
      });
      break;
    }
    const filename = normalizedFile(source.file);
    if (!filename) {
      issues.push({
        kind: 'unsafe-import', file: source.file,
        message: 'Unsafe workspace source path.'
      });
      continue;
    }
    if (nodes.has(filename)) {
      issues.push({
        kind: 'duplicate-source', file: filename,
        message: 'Duplicate workspace source snapshot.'
      });
      continue;
    }
    if (source.source.length > maximumSource) {
      issues.push({
        kind: 'oversized-source', file: filename,
        message: 'Source exceeds the import graph text limit.'
      });
      continue;
    }
    const structure = scanScarpStructure(source.source, {
      maxLength: maximumSource, maxTokens: 80_000, maxDepth: 256
    });
    if (!structure) {
      issues.push({
        kind: 'oversized-source', file: filename,
        message: 'Source cannot be indexed within structural limits.'
      });
      continue;
    }
    nodes.set(filename, { file: filename, imports: [], importedBy: new Set(), depth: 0 });
    parsed.set(filename, structure);
  }
  const edges: ScarpGraphEdge[] = [];
  for (const [filename, node] of nodes) {
    const structure = parsed.get(filename)!;
    for (const imported of structure.imports) {
      if (edges.length >= maximumEdges) {
        issues.push({
          kind: 'limit', file: filename, at: imported.pathSpan.start,
          message: 'Import graph edge limit exceeded.'
        });
        break;
      }
      const target = resolve(filename, imported);
      if (!target) {
        issues.push({
          kind: 'unsafe-import', file: filename, at: imported.pathSpan.start,
          message: 'Unsafe or unsupported relative import: ' + imported.path
        });
        continue;
      }
      if (!nodes.has(target)) {
        issues.push({
          kind: 'missing-module', file: filename, at: imported.pathSpan.start,
          message: 'Referenced source file is absent from the snapshot: ' + target
        });
        continue;
      }
      const edge: ScarpGraphEdge = {
        from: filename, to: target, alias: imported.alias,
        at: imported.pathSpan.start, path: imported.path
      };
      edges.push(edge);
      node.imports.push(edge);
      nodes.get(target)!.importedBy.add(filename);
    }
  }
  const cycles = findCycles(nodes, edges);
  for (const cycle of cycles) {
    issues.push({
      kind: 'cycle', file: cycle[0],
      message: 'Syntactic import cycle: ' + cycle.join(' → '),
      related: cycle
    });
  }
  const roots = graphDepths(nodes, edges);
  issues.sort((a, b) =>
    a.file.localeCompare(b.file) || (a.at ?? -1) - (b.at ?? -1) ||
    a.kind.localeCompare(b.kind));
  const results = [...nodes.values()].map(node => ({
    file: node.file, imports: node.imports,
    importedBy: [...node.importedBy].sort(), depth: node.depth
  })).sort((a, b) => a.file.localeCompare(b.file));
  return { nodes: results, edges, issues, cycles, roots };
}
