/**
 * Cross-module test cases for the offline Scarp editing pipeline.
 *
 * These exercise the same source snapshots across the scanner, structure
 * providers, import graph, project catalog and report without any compiler.
 * They guard contracts at integration boundaries that isolated tests miss.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanScarpStructure } from '../src/editorStructure';
import { scarpFoldsFromStructure } from '../src/editorFolding';
import { scarpSelectionRangesFromStructure } from '../src/editorSelection';
import { ScarpStructureCache } from '../src/editorStructureCache';
import { collectScarpWorkspaceSources } from '../src/editorWorkspaceInventory';
import { buildScarpImportGraph } from '../src/editorImportGraph';
import { catalogScarpProjects, projectEntryPath } from '../src/editorProjectCatalog';
import { buildScarpProjectTree, scarpProjectChildren } from '../src/editorProjectTree';
import { formatScarpWorkspaceReport } from '../src/editorWorkspaceReport';
import { scarpSourceMetrics } from '../src/editorStructuralMetrics';
import { scarpImportLinks } from '../src/editorImports';

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-interoperability-'));
  try {
    const files: Array<[string, string]> = [
      ['basic_tuple/scarp.project', [
        'project "basic_tuple" {',
        '  version: "0.1.0"',
        '  entry: "src/main.srp"',
        '  type: "application"',
        '  dependencies {}',
        '}'
      ].join('\n')],
      ['basic_tuple/src/main.srp', [
        '// #region tuple practice',
        'import "math.srp" as math;',
        'funcra practice() -> unit {',
        '  bind values = (1, 2);',
        '  print(values);',
        '}',
        '// #endregion'
      ].join('\n')],
      ['basic_tuple/src/math.srp', 'pub bind answer = 42;\n'],
      ['basic_integer/Scarp.project', [
        'scarp-project: 1',
        'name: basic_integer',
        'entry: src/main.srp'
      ].join('\n')],
      ['basic_integer/src/main.srp', 'print(100);\n']
    ];
    for (const [filename, text] of files) {
      const target = path.join(root, ...filename.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf8');
    }
    await run(root);
  } finally {
    await fs.rm(root, {
      recursive: true, force: true, maxRetries: 6, retryDelay: 50
    });
  }
}
async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(folder: string): Promise<void> {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const name = path.join(folder, entry.name);
      if (entry.isDirectory()) { await visit(name); }
      else if (entry.isFile() && name.endsWith('.srp')) { result.push(name); }
    }
  }
  await visit(root);
  return result;
}
function contains(source: string, range: {start:number;end:number}, text: string) {
  return source.slice(range.start, range.end).includes(text);
}
test('two independent nested projects remain discoverable together', async () => {
  await withProject(async root => {
    const manifests = [
      {
        filename: 'basic_tuple/scarp.project',
        content: await fs.readFile(path.join(root, 'basic_tuple/scarp.project'), 'utf8')
      },
      {
        filename: 'basic_integer/Scarp.project',
        content: await fs.readFile(path.join(root, 'basic_integer/Scarp.project'), 'utf8')
      }
    ];
    const result = catalogScarpProjects(manifests);
    assert.equal(result.projects.length, 2);
    assert.deepEqual(result.issues, []);
    const kinds = result.projects.map(item => item.kind).sort();
    assert.deepEqual(kinds, ['declarative-v2', 'legacy-v1']);
    for (const item of result.projects) {
      const entry = projectEntryPath(item);
      assert.ok(entry);
      await fs.access(path.join(root, ...entry.split('/')));
    }
  });
});
test('nested project tree matches disk inventory without losing folder boundaries', async () => {
  await withProject(async root => {
    const sources = await filesUnder(root);
    const disk = await collectScarpWorkspaceSources(root, sources);
    assert.deepEqual(disk.issues, []);
    assert.equal(disk.sources.length, 3);
    const tree = buildScarpProjectTree(disk.sources.map(item => item.file));
    assert.deepEqual(scarpProjectChildren(tree, '').map(item => item.path),
      ['basic_integer', 'basic_tuple']);
    assert.equal(tree.sourceCount, 3);
    const tuple = tree.items.find(item => item.path === 'basic_tuple');
    assert.equal(tuple?.descendantSources, 2);
  });
});
test('editor scanner, folding and range selection share the same UTF-16 snapshot', async () => {
  await withProject(async root => {
    const file = path.join(root, 'basic_tuple/src/main.srp');
    const source = await fs.readFile(file, 'utf8');
    const structure = scanScarpStructure(source);
    assert.ok(structure);
    assert.equal(structure.imports.length, 1);
    assert.equal(structure.regions.length, 1);
    const folds = scarpFoldsFromStructure(source, structure);
    assert.ok(folds.some(item => item.kind === 'region'));
    assert.ok(folds.some(item => item.kind === 'structure'));
    const cursor = source.indexOf('values = (') + 'values = ('.length;
    const ranges = scarpSelectionRangesFromStructure(source, structure, cursor);
    assert.ok(ranges.length > 0);
    assert.ok(ranges.some(item => contains(source, item, '(1, 2)')));
    assert.ok(ranges.every(item => item.start <= cursor && item.end >= cursor));
  });
});
test('workspace source graph and existing import links agree on their target', async () => {
  await withProject(async root => {
    const main = path.join(root, 'basic_tuple/src/main.srp');
    const inventory = await collectScarpWorkspaceSources(root,
      await filesUnder(root));
    const graph = buildScarpImportGraph(inventory.sources);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.issues.length, 0);
    const edge = graph.edges[0];
    assert.equal(edge.from, 'basic_tuple/src/main.srp');
    assert.equal(edge.to, 'basic_tuple/src/math.srp');
    const links = await scarpImportLinks(
      await fs.readFile(main, 'utf8'),
      { workspaceRoot: root, sourceFilename: main }
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].target, await fs.realpath(
      path.join(root, ...edge.to.split('/'))));
  });
});
test('unsaved editor version is never silently substituted for disk snapshot', async () => {
  await withProject(async root => {
    const main = path.join(root, 'basic_tuple/src/main.srp');
    const disk = await collectScarpWorkspaceSources(root, [main]);
    const onDisk = disk.sources[0].source;
    const edited = onDisk.replace('print(values);', 'print((10, 20));');
    const cache = new ScarpStructureCache();
    const before = cache.get(main, 1, onDisk);
    const after = cache.get(main, 2, edited);
    assert.ok(before && after);
    assert.notEqual(before, after);
    assert.equal(disk.sources[0].source, onDisk);
    assert.equal((await fs.readFile(main, 'utf8')), onDisk);
  });
});
test('read-only Markdown report can summarize both project types and source graph', async () => {
  await withProject(async root => {
    const inventory = await collectScarpWorkspaceSources(root,
      await filesUnder(root));
    const projects = catalogScarpProjects([
      {
        filename: 'basic_tuple/scarp.project',
        content: await fs.readFile(path.join(root, 'basic_tuple/scarp.project'), 'utf8')
      },
      {
        filename: 'basic_integer/Scarp.project',
        content: await fs.readFile(path.join(root, 'basic_integer/Scarp.project'), 'utf8')
      }
    ]);
    const report = formatScarpWorkspaceReport(
      buildScarpImportGraph(inventory.sources), inventory, projects
    );
    assert.ok(report.includes('basic\\_tuple/src/math.srp'));
    assert.ok(report.includes('basic\\_integer/src/main.srp'));
    assert.match(report, /## Source structure/);
    assert.match(report, /declarative-v2/);
    assert.match(report, /legacy-v1/);
    assert.match(report, /not semantic diagnostics/);
  });
});
test('static metrics reflect actual nested source layout but do not run code', async () => {
  await withProject(async root => {
    const text = await fs.readFile(
      path.join(root, 'basic_tuple/src/main.srp'), 'utf8');
    const metrics = scarpSourceMetrics(text);
    assert.ok(metrics);
    assert.equal(metrics.imports, 1);
    assert.equal(metrics.functions, 1);
    assert.equal(metrics.regions, 1);
    assert.ok(metrics.delimiterPairs >= 2);
  });
});
test('missing imports affect graph warnings without creating unsafe document links', async () => {
  await withProject(async root => {
    const main = path.join(root, 'basic_tuple/src/main.srp');
    const content = await fs.readFile(main, 'utf8');
    const broken = content.replace('math.srp', 'missing.srp');
    const graph = buildScarpImportGraph([
      { file: 'basic_tuple/src/main.srp', source: broken },
      { file: 'basic_tuple/src/math.srp', source: 'pub bind answer = 42;' }
    ]);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.issues[0].kind, 'missing-module');
    const links = await scarpImportLinks(broken, {
      workspaceRoot: root, sourceFilename: main
    });
    assert.deepEqual(links, []);
  });
});
test('large but bounded source trees remain stable across independent scans', async () => {
  await withProject(async root => {
    const names = Array.from({ length: 200 }, (_, i) =>
      'group' + Math.floor(i / 10) + '/test' + i + '.srp');
    const a = buildScarpProjectTree(names);
    const b = buildScarpProjectTree([...names].reverse());
    assert.deepEqual(a, b);
    assert.equal(a.sourceCount, 200);
    assert.equal(a.items.find(item => item.path === '')?.descendantSources, 200);
    await fs.access(path.join(root, 'basic_tuple/src/main.srp'));
  });
});
test('source scanner never interprets comments as project or import directives', () => {
  const source = [
    '// import "hidden.srp" as hidden;',
    '// #region comments only',
    'print("import \\"quoted.srp\\" as fake;");',
    '// #endregion'
  ].join('\n');
  const result = scanScarpStructure(source);
  assert.ok(result);
  assert.deepEqual(result.imports, []);
  assert.equal(result.regions.length, 1);
  assert.equal(result.pairs.filter(item => item.kind === '{').length, 0);
});
