import type { ScarpImportGraph, ScarpGraphEdge } from './editorImportGraph';
import type { ScarpProjectCatalog } from './editorProjectCatalog';

export type ScarpDependencyDirection = 'imports' | 'imported-by' | 'both';
export interface ScarpDependencyQuery {
  readonly source: string;
  readonly direction?: ScarpDependencyDirection;
  readonly maxDepth?: number;
  readonly maxResults?: number;
}
export interface ScarpDependencyStep {
  readonly from: string;
  readonly to: string;
  readonly alias: string;
  readonly distance: number;
  readonly path: readonly string[];
}
export interface ScarpDependencyResult {
  readonly source: string;
  readonly direction: ScarpDependencyDirection;
  readonly steps: readonly ScarpDependencyStep[];
  readonly missing: boolean;
  readonly truncated: boolean;
}
export interface ScarpProjectModuleSummary {
  readonly project: string;
  readonly entry: string;
  readonly modules: readonly string[];
  readonly externalReferences: readonly string[];
  readonly cyclicModules: readonly string[];
  readonly truncated: boolean;
}
const DEFAULT_DEPTH = 24;
const DEFAULT_RESULTS = 1024;
function limit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value >= 0 ? value : -1;
}
function edgeCompare(a: ScarpGraphEdge, b: ScarpGraphEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to) ||
    a.alias.localeCompare(b.alias) || a.at - b.at;
}
function neighbors(
  graph: ScarpImportGraph, filename: string, direction: ScarpDependencyDirection
): readonly { from: string; to: string; alias: string }[] {
  const results: { from: string; to: string; alias: string }[] = [];
  for (const edge of graph.edges) {
    if ((direction === 'imports' || direction === 'both') && edge.from === filename) {
      results.push({ from: edge.from, to: edge.to, alias: edge.alias });
    }
    if ((direction === 'imported-by' || direction === 'both') && edge.to === filename) {
      results.push({ from: edge.to, to: edge.from, alias: edge.alias });
    }
  }
  return results.sort((a, b) =>
    a.to.localeCompare(b.to) || a.alias.localeCompare(b.alias));
}
/**
 * Explore transitive imports or reverse dependencies from an indexed module.
 * Breadth-first traversal creates deterministic shortest paths to each
 * reachable module without code execution, shell or filesystem access.
 */
export function queryScarpDependencies(
  graph: ScarpImportGraph, query: ScarpDependencyQuery
): ScarpDependencyResult {
  const direction = query.direction ?? 'imports';
  const depth = limit(query.maxDepth, DEFAULT_DEPTH);
  const count = limit(query.maxResults, DEFAULT_RESULTS);
  const missing = !graph.nodes.some(node => node.file === query.source);
  const result: ScarpDependencyStep[] = [];
  if (missing || depth < 0 || count < 0 ||
      !['imports', 'imported-by', 'both'].includes(direction)) {
    return {
      source: query.source, direction,
      steps: [], missing, truncated: depth < 0 || count < 0
    };
  }
  const queue: { file: string; path: readonly string[]; distance: number }[] = [
    { file: query.source, path: [query.source], distance: 0 }
  ];
  const visited = new Set<string>([query.source]);
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (item.distance >= depth) { continue; }
    for (const next of neighbors(graph, item.file, direction)) {
      if (visited.has(next.to)) { continue; }
      if (result.length >= count) {
        truncated = true;
        break;
      }
      visited.add(next.to);
      const path = [...item.path, next.to];
      const step: ScarpDependencyStep = {
        from: next.from, to: next.to,
        alias: next.alias, distance: item.distance + 1, path
      };
      result.push(step);
      queue.push({ file: next.to, path, distance: step.distance });
    }
    if (truncated) { break; }
  }
  return { source: query.source, direction, steps: result, missing, truncated };
}
/**
 * Group the reachable modules for each recognized project entrypoint.
 * Projects remain independent even if one workspace contains many Scarp
 * practice folders. Cross-project references are informational only.
 */
export function summarizeScarpProjectDependencies(
  graph: ScarpImportGraph, catalog: ScarpProjectCatalog,
  maxResults = DEFAULT_RESULTS
): readonly ScarpProjectModuleSummary[] {
  const summaries: ScarpProjectModuleSummary[] = [];
  const edgeSet = new Set(graph.nodes.map(item => item.file));
  const ordered = [...catalog.projects].sort((a, b) =>
    a.root.localeCompare(b.root));
  for (const project of ordered) {
    const entry = project.root ? project.root + '/' + project.entry : project.entry;
    const visited = queryScarpDependencies(graph, {
      source: entry, maxResults
    });
    const all = [entry, ...visited.steps.map(step => step.to)];
    const projectPrefix = project.root ? project.root + '/' : '';
    const modules = all.filter(file =>
      edgeSet.has(file) && file.startsWith(projectPrefix)).sort();
    const externalReferences = all.filter(file =>
      edgeSet.has(file) && !file.startsWith(projectPrefix)).sort();
    const related = new Set(all);
    const cyclicModules = graph.cycles.flat().filter(file => related.has(file)).sort();
    summaries.push({
      project: project.manifest, entry,
      modules: [...new Set(modules)],
      externalReferences: [...new Set(externalReferences)],
      cyclicModules: [...new Set(cyclicModules)],
      truncated: visited.truncated
    });
  }
  return summaries;
}
/** Return the smallest known source-to-target path in a chosen direction. */
export function shortestScarpDependencyPath(
  graph: ScarpImportGraph, from: string, to: string,
  direction: ScarpDependencyDirection = 'imports'
): readonly string[] | undefined {
  if (from === to && graph.nodes.some(n => n.file === from)) { return [from]; }
  const explored = queryScarpDependencies(graph, { source: from, direction });
  return explored.steps.find(step => step.to === to)?.path;
}
export function directScarpImportEdges(
  graph: ScarpImportGraph, source: string
): readonly ScarpGraphEdge[] {
  return graph.edges.filter(edge => edge.from === source).sort(edgeCompare);
}
