import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildScarpImportGraph, type ScarpGraphSource } from '../src/editorImportGraph';

const source = (file: string, content: string): ScarpGraphSource => ({
  file, source: content
});
const edge = (file: string, target: string, alias: string) =>
  source(file, 'import "' + target + '" as ' + alias + ';\nprint(1);');
test('empty project graph has no nodes, roots, cycles or issues', () => {
  assert.deepEqual(buildScarpImportGraph([]), {
    nodes: [], edges: [], issues: [], cycles: [], roots: []
  });
});
test('single independent Scarp source is a graph root', () => {
  const graph = buildScarpImportGraph([source('main.srp', 'print(1);')]);
  assert.deepEqual(graph.roots, ['main.srp']);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].depth, 0);
  assert.deepEqual(graph.nodes[0].importedBy, []);
});
test('direct import edge preserves alias, offset and target', () => {
  const graph = buildScarpImportGraph([
    edge('main.srp', 'math.srp', 'math'),
    source('math.srp', 'pub bind answer = 42;')
  ]);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0], {
    from: 'main.srp', to: 'math.srp', alias: 'math',
    at: 'import "'.length, path: 'math.srp'
  });
  assert.deepEqual(graph.roots, ['main.srp']);
  assert.equal(graph.nodes.find(n => n.file === 'math.srp')?.depth, 1);
  assert.deepEqual(graph.nodes.find(n => n.file === 'math.srp')?.importedBy,
    ['main.srp']);
});
test('nested folders resolve imports relative to importing module', () => {
  const graph = buildScarpImportGraph([
    edge('src/main.srp', 'lib/math.srp', 'math'),
    source('src/lib/math.srp', 'pub bind answer = 42;'),
    edge('src/extra/main.srp', 'nested/calc.srp', 'calc'),
    source('src/extra/nested/calc.srp', 'print(2);')
  ]);
  assert.deepEqual(graph.edges.map(e => e.to), [
    'src/extra/nested/calc.srp', 'src/lib/math.srp'
  ].sort().reverse().reverse().sort((a, b) => 0));
  assert.equal(graph.issues.length, 0);
});
test('diamond graphs preserve multiple reverse imports and shortest depth', () => {
  const graph = buildScarpImportGraph([
    source('entry.srp', 'import "a.srp" as a;\nimport "b.srp" as b;'),
    edge('a.srp', 'leaf.srp', 'leaf'),
    edge('b.srp', 'leaf.srp', 'leaf'),
    source('leaf.srp', 'print(1);')
  ]);
  assert.deepEqual(graph.roots, ['entry.srp']);
  const leaf = graph.nodes.find(n => n.file === 'leaf.srp');
  assert.deepEqual(leaf?.importedBy, ['a.srp', 'b.srp']);
  assert.equal(leaf?.depth, 2);
});
test('missing module is reported but never materialized as phantom node', () => {
  const graph = buildScarpImportGraph([edge('main.srp', 'missing.srp', 'lost')]);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.issues.length, 1);
  assert.equal(graph.issues[0].kind, 'missing-module');
  assert.equal(graph.issues[0].file, 'main.srp');
});
test('traversal imports never escape the source snapshot boundary', () => {
  const graph = buildScarpImportGraph([
    edge('nested/main.srp', '../escape.srp', 'escape'),
    source('escape.srp', 'print(1);')
  ]);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.issues[0].kind, 'unsafe-import');
});
test('self-import produces one explicit strongly connected component', () => {
  const graph = buildScarpImportGraph([edge('self.srp', 'self.srp', 'self')]);
  assert.deepEqual(graph.cycles, [['self.srp']]);
  assert.equal(graph.issues.filter(x => x.kind === 'cycle').length, 1);
});
test('three-member cycle is detected without recursive source evaluation', () => {
  const graph = buildScarpImportGraph([
    edge('a.srp', 'b.srp', 'b'),
    edge('b.srp', 'c.srp', 'c'),
    edge('c.srp', 'a.srp', 'a')
  ]);
  assert.deepEqual(graph.cycles, [['a.srp', 'b.srp', 'c.srp']]);
  assert.deepEqual(graph.roots, []);
});
test('independent cyclic and acyclic components do not contaminate each other', () => {
  const graph = buildScarpImportGraph([
    edge('a.srp', 'b.srp', 'b'),
    edge('b.srp', 'a.srp', 'a'),
    edge('entry.srp', 'leaf.srp', 'leaf'),
    source('leaf.srp', 'print(1);')
  ]);
  assert.deepEqual(graph.cycles, [['a.srp', 'b.srp']]);
  assert.ok(graph.roots.includes('entry.srp'));
  assert.equal(graph.edges.length, 3);
});
test('duplicate source snapshots cannot overwrite a previously indexed module', () => {
  const graph = buildScarpImportGraph([
    source('a.srp', 'print(1);'),
    source('a.srp', 'import "missing.srp" as missing;')
  ]);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.issues[0].kind, 'duplicate-source');
});
test('unsafe project entries are rejected before scanning', () => {
  const graph = buildScarpImportGraph([
    source('../outside.srp', 'print(1);'),
    source('/absolute.srp', 'print(2);'),
    source('good.srp', 'print(3);')
  ]);
  assert.deepEqual(graph.nodes.map(x => x.file), ['good.srp']);
  assert.equal(graph.issues.filter(x => x.kind === 'unsafe-import').length, 2);
});
test('module, source and edge limits produce explicit bounded results', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    source('m' + i + '.srp', 'print(1);'));
  const bounded = buildScarpImportGraph(many, { maxModules: 4 });
  assert.equal(bounded.nodes.length, 4);
  assert.ok(bounded.issues.some(x => x.kind === 'limit'));
  const oversized = buildScarpImportGraph([
    source('large.srp', 'a'.repeat(101))
  ], { maxSourceLength: 100 });
  assert.deepEqual(oversized.nodes, []);
  assert.equal(oversized.issues[0].kind, 'oversized-source');
  const invalid = buildScarpImportGraph(many, { maxModules: 0 });
  assert.equal(invalid.issues[0].kind, 'limit');
});
test('edge caps stop excessive references without infinite scanning', () => {
  const graph = buildScarpImportGraph([
    source('main.srp',
      ['import "a.srp" as a;', 'import "b.srp" as b;',
        'import "c.srp" as c;'].join('\n')),
    source('a.srp', 'print(1);'),
    source('b.srp', 'print(1);'),
    source('c.srp', 'print(1);')
  ], { maxEdges: 2 });
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.issues.some(x => x.kind === 'limit'));
});
test('one hundred linked modules do not exceed the JS call stack', () => {
  const count = 100;
  const files = Array.from({ length: count }, (_, i) =>
    i === count - 1
      ? source('m' + i + '.srp', 'print(0);')
      : edge('m' + i + '.srp', 'm' + (i + 1) + '.srp', 'next'));
  const graph = buildScarpImportGraph(files);
  assert.equal(graph.nodes.length, count);
  assert.equal(graph.edges.length, count - 1);
  assert.deepEqual(graph.roots, ['m0.srp']);
  assert.equal(graph.nodes.find(n => n.file === 'm99.srp')?.depth, count - 1);
});
test('source text changing within a constant graph shape remains deterministic', () => {
  const first = buildScarpImportGraph([
    source('main.srp', 'import "util.srp" as util;\nprint(1);'),
    source('util.srp', 'pub bind answer = 1;')
  ]);
  const second = buildScarpImportGraph([
    source('main.srp', 'import "util.srp" as util;\nprint(2);'),
    source('util.srp', 'pub bind answer = 2;')
  ]);
  assert.deepEqual(first, second);
});
test('strings, nested imports and comments cannot create graph edges', () => {
  const graph = buildScarpImportGraph([
    source('main.srp', [
      '// import "other.srp" as hidden;',
      'print("import \\"other.srp\\" as fake;");',
      'funcra f() { import "other.srp" as local; }'
    ].join('\n')),
    source('other.srp', 'print(1);')
  ]);
  assert.deepEqual(graph.edges, []);
});
test('graph always produces lexically ordered stable node enumeration', () => {
  const graph = buildScarpImportGraph([
    source('z.srp', 'print(1);'),
    source('b.srp', 'print(2);'),
    source('a.srp', 'print(3);')
  ]);
  assert.deepEqual(graph.nodes.map(n => n.file), ['a.srp', 'b.srp', 'z.srp']);
});
