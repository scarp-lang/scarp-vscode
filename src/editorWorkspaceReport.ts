import type {
  ScarpImportGraph, ScarpGraphIssue, ScarpGraphNode, ScarpGraphEdge
} from './editorImportGraph';
import type { ScarpWorkspaceInventory } from './editorWorkspaceInventory';
import type { ScarpProjectCatalog } from './editorProjectCatalog';
import { scarpSourceMetrics, summarizeScarpSourceMetrics } from './editorStructuralMetrics';

export interface ScarpWorkspaceReportOptions {
  readonly title?: string;
  readonly maxCharacters?: number;
}
const DEFAULT_MAX_CHARACTERS = 256_000;
const MAX_ROWS_PER_SECTION = 1024;
function safeCell(value: string): string {
  // No raw HTML, links or arbitrary table markup from a source path.
  return value.replace(/[\r\n\t]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([|<>\[\]*_\x60!])/g, '\\$1');
}
function stableItems<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}
function line(parts: string[]): string {
  return '| ' + parts.map(safeCell).join(' | ') + ' |';
}
function table(header: readonly string[], data: readonly (readonly string[])[]): string[] {
  const rows = [
    line([...header]),
    '| ' + header.map(() => '---').join(' | ') + ' |'
  ];
  for (const row of data.slice(0, MAX_ROWS_PER_SECTION)) {
    rows.push(line([...row]));
  }
  if (data.length > MAX_ROWS_PER_SECTION) {
    rows.push('_Remaining rows omitted due to report limit._');
  }
  return rows;
}
function edgeKey(edge: ScarpGraphEdge): string {
  return edge.from + '\0' + edge.to + '\0' + edge.alias;
}
function issueKey(issue: ScarpGraphIssue): string {
  return issue.file + '\0' + issue.kind + '\0' + (issue.at ?? -1);
}
function nodeKey(node: ScarpGraphNode): string {
  return node.file;
}
/**
 * Deterministic read-only Markdown source report. This module contains no
 * VS Code API, shell, network, compiler invocation or disk writer.
 */
export function formatScarpWorkspaceReport(
  graph: ScarpImportGraph,
  inventory?: ScarpWorkspaceInventory,
  projects?: ScarpProjectCatalog,
  options: ScarpWorkspaceReportOptions = {}
): string {
  const title = safeCell(options.title || 'Scarp workspace source report');
  const maxChars = options.maxCharacters === undefined
    ? DEFAULT_MAX_CHARACTERS : options.maxCharacters;
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) {
    return '# Scarp workspace report\n\nReport limit too small.\n';
  }
  const metrics = inventory ? summarizeScarpSourceMetrics(inventory.sources) : undefined;
  const lines: string[] = [
    '# ' + title,
    '',
    '> Read-only compiler-free editor snapshot; not semantic diagnostics.',
    '> Missing imports and cycles are lexical hints only.',
    '',
    '## Summary',
    '',
    ...table(['Metric', 'Value'], [
      ['Indexed modules', String(graph.nodes.length)],
      ['Indexed imports', String(graph.edges.length)],
      ['Import cycles', String(graph.cycles.length)],
      ['Graph issues', String(graph.issues.length)],
      ['Graph root modules', String(graph.roots.length)],
      ['Workspace input bytes', String(inventory?.byteCount ?? 'not recorded')],
      ['Disk inventory issues', String(inventory?.issues.length ?? 0)],
      ['Recognized projects', String(projects?.projects.length ?? 0)],
      ['Lexical source lines', String(metrics?.lines ?? 'not recorded')],
      ['Outlined functions', String(metrics?.functions ?? 'not recorded')],
      ['Maximum bracket nesting', String(metrics?.maximumDepth ?? 'not recorded')]
    ]),
    ''
  ];
  if (projects) {
    lines.push('## Projects', '');
    if (!projects.projects.length) {
      lines.push('_No supported project preview entries._', '');
    } else {
      lines.push(...table(
        ['Project', 'Manifest', 'Entry', 'Format'],
        stableItems(projects.projects, x => x.root).map(x => [
          x.name, x.manifest, x.root ? x.root + '/' + x.entry : x.entry, x.kind
        ])
      ), '');
    }
  }
  if (inventory) {
    lines.push('## Source structure', '');
    const rows = inventory.sources.map(item => {
      const profile = scarpSourceMetrics(item.source);
      return [
        item.file, String(profile?.physicalLines ?? '-'),
        String(profile?.functions ?? '-'),
        String(profile?.topLevelBindings ?? '-'),
        String(profile?.maximumDelimiterDepth ?? '-')
      ];
    });
    if (rows.length) {
      lines.push(...table(
        ['File', 'Lines', 'Functions', 'Bindings', 'Max nesting'],
        stableItems(rows, item => item[0])
      ), '');
    } else {
      lines.push('_No source metrics available._', '');
    }
  }
  lines.push('## Indexed modules', '');
  if (graph.nodes.length) {
    lines.push(...table(
      ['File', 'Imports', 'Imported by', 'Minimum depth'],
      stableItems(graph.nodes, nodeKey).map(node => [
        node.file, String(node.imports.length),
        String(node.importedBy.length), String(node.depth)
      ])
    ), '');
  } else {
    lines.push('_No indexed source modules._', '');
  }
  lines.push('## Source imports', '');
  if (graph.edges.length) {
    lines.push(...table(
      ['From', 'Target', 'Alias', 'Source offset'],
      stableItems(graph.edges, edgeKey).map(edge => [
        edge.from, edge.to, edge.alias, String(edge.at)
      ])
    ), '');
  } else {
    lines.push('_No resolved lexical imports._', '');
  }
  lines.push('## Cyclic references', '');
  if (!graph.cycles.length) {
    lines.push('_No syntactic import cycles found._', '');
  } else {
    for (const cycle of graph.cycles.slice(0, MAX_ROWS_PER_SECTION)) {
      lines.push('- ' + cycle.map(safeCell).join(' → '));
    }
    lines.push('');
  }
  lines.push('## Graph observations', '');
  if (!graph.issues.length) {
    lines.push('_No graph issues in the snapshot._', '');
  } else {
    lines.push(...table(
      ['Kind', 'Source', 'Observation'],
      stableItems(graph.issues, issueKey).map(issue => [
        issue.kind, issue.file, issue.message
      ])
    ), '');
  }
  if (inventory) {
    lines.push('## Disk inventory observations', '');
    if (!inventory.issues.length) {
      lines.push('_No disk-read issues found._', '');
    } else {
      lines.push(...table(
        ['Reason', 'Candidate'],
        stableItems(inventory.issues, item => item.file).map(item => [
          item.reason, item.file
        ])
      ), '');
    }
  }
  if (projects) {
    lines.push('## Project preview observations', '');
    if (!projects.issues.length) {
      lines.push('_No unsupported manifest previews._', '');
    } else {
      lines.push(...table(
        ['Kind', 'Manifest', 'Detail'],
        stableItems(projects.issues, item => item.manifest).map(item => [
          item.kind, item.manifest, item.detail
        ])
      ), '');
    }
  }
  lines.push('## Scope and limitations', '');
  lines.push(
    'This is a static snapshot of the selected local workspace folder.',
    'The official Scarp compiler defines actual syntax, imports, types,',
    'diagnostics and runnable project entries. This report never executes',
    'source, installs dependencies, calls a shell or modifies project files.',
    'Import navigation additionally requires a trusted workspace and',
    'filesystem realpath containment checks to prevent symlink escapes.',
    ''
  );
  const result = lines.join('\n');
  if (result.length <= maxChars) { return result; }
  const marker = '\n\n_Report truncated to its configured size limit._\n';
  const slice = result.slice(0, Math.max(0, maxChars - marker.length));
  const newline = slice.lastIndexOf('\n');
  return slice.slice(0, newline >= 0 ? newline : slice.length) + marker;
}
