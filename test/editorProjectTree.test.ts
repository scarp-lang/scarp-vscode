import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildScarpProjectTree, scarpProjectChildren, scarpProjectParent,
  scarpProjectBreadcrumb, scarpProjectFile, validProjectSourcePath
} from '../src/editorProjectTree';

test('empty project tree has exactly its root folder', () => {
  const tree = buildScarpProjectTree([]);
  assert.equal(tree.sourceCount, 0);
  assert.deepEqual(tree.rejected, []);
  assert.deepEqual(tree.items.map(i => [i.kind, i.path]), [['folder', '']]);
  assert.deepEqual(scarpProjectChildren(tree, ''), []);
});
test('top-level source names become immediate project children', () => {
  const tree = buildScarpProjectTree(['main.srp', 'math.srp']);
  assert.deepEqual(scarpProjectChildren(tree, '').map(i => i.path),
    ['main.srp', 'math.srp']);
  assert.equal(tree.items[0].descendantSources, 2);
});
test('nested practice folders retain their hierarchy and descendant counts', () => {
  const tree = buildScarpProjectTree([
    'basic_tuple/main.srp',
    'basic_tuple/tests/tuple.srp',
    'basic_integer/main.srp',
    'advanced/collections/maps/main.srp'
  ]);
  assert.deepEqual(scarpProjectChildren(tree, '').map(i => i.path),
    ['advanced', 'basic_integer', 'basic_tuple']);
  assert.deepEqual(scarpProjectChildren(tree, 'basic_tuple').map(i => i.path),
    ['basic_tuple/tests', 'basic_tuple/main.srp']);
  assert.equal(tree.items.find(i => i.path === 'basic_tuple')?.descendantSources, 2);
  assert.equal(tree.items.find(i => i.path === 'advanced')?.descendantSources, 1);
  assert.equal(tree.items.find(i => i.path === '')?.descendantSources, 4);
  assert.equal(tree.items.find(i => i.path === 'advanced/collections/maps')?.depth, 3);
});
test('duplicate files cannot inflate tree children or source counts', () => {
  const tree = buildScarpProjectTree([
    'src/main.srp', 'src/main.srp', 'src/main.srp'
  ]);
  assert.equal(tree.sourceCount, 1);
  assert.equal(scarpProjectChildren(tree, 'src').length, 1);
});
test('filename validator rejects traversal and unsupported extensions', () => {
  for (const invalid of [
    '', '../outside.srp', './main.srp', 'src/../main.srp',
    'src//main.srp', '/etc/passwd.srp', 'C:/src/main.srp',
    'src\\main.srp', 'src/%2e%2e/main.srp', 'README.md',
    'x.srp\n', 'src/invalid:.srp', 'folder/'
  ]) {
    assert.equal(validProjectSourcePath(invalid), false, invalid);
  }
  assert.equal(validProjectSourcePath('src/main.srp'), true);
});
test('file components have bounded length and depth', () => {
  assert.equal(validProjectSourcePath('x'.repeat(129) + '.srp'), false);
  assert.equal(validProjectSourcePath('a/b/c/main.srp', 3), false);
  assert.equal(validProjectSourcePath('a/b/c/main.srp', 4), true);
  assert.equal(validProjectSourcePath('folder/main.srp', 32, 8), false);
});
test('maximum file count caps result without silently inventing files', () => {
  const tree = buildScarpProjectTree([
    'one.srp', 'two.srp', 'three.srp', 'four.srp'
  ], { maximumFiles: 2 });
  assert.equal(tree.sourceCount, 2);
  assert.equal(tree.rejected.length, 2);
  assert.equal(tree.items.filter(x => x.kind === 'source').length, 2);
});
test('invalid limits reject every file but preserve a root node', () => {
  for (const value of [0, -1, 1.2, NaN, Infinity]) {
    const tree = buildScarpProjectTree(['main.srp'], {
      maximumDepth: value
    });
    assert.equal(tree.sourceCount, 0);
    assert.deepEqual(tree.rejected, ['main.srp']);
  }
});
test('nonexistent folders have no synthetic children, parents or breadcrumbs', () => {
  const tree = buildScarpProjectTree(['src/main.srp']);
  assert.deepEqual(scarpProjectChildren(tree, 'missing'), []);
  assert.equal(scarpProjectParent(tree, 'missing'), undefined);
  assert.deepEqual(scarpProjectBreadcrumb(tree, 'missing'), []);
});
test('file selection is exact and cannot confuse sibling names', () => {
  const tree = buildScarpProjectTree([
    'src/main.srp', 'src/main_extra.srp', 'src/main.srp2'
  ]);
  assert.equal(tree.sourceCount, 2);
  assert.equal(scarpProjectFile(tree, 'src/main.srp')?.kind, 'source');
  assert.equal(scarpProjectFile(tree, 'src/main')?.kind, undefined);
  assert.equal(scarpProjectFile(tree, 'src/main.srp2'), undefined);
});
test('project breadcrumb and parent traversal are stable', () => {
  const tree = buildScarpProjectTree(['a/b/c/file.srp']);
  assert.deepEqual(scarpProjectBreadcrumb(tree, 'a/b/c'),
    ['(project root)', 'a', 'b', 'c']);
  assert.equal(scarpProjectParent(tree, 'a/b/c'), 'a/b');
  assert.equal(scarpProjectParent(tree, 'a/b'), 'a');
  assert.equal(scarpProjectParent(tree, 'a'), '');
  assert.equal(scarpProjectParent(tree, ''), '');
});
test('tree output is stable irrespective of discovery ordering', () => {
  const names = [
    'z/math.srp', 'a/main.srp', 'm/one.srp', 'm/two.srp'
  ];
  assert.deepEqual(buildScarpProjectTree(names),
    buildScarpProjectTree([...names].reverse()));
});
test('project file names with Unicode are preserved as UTF-16-safe labels', () => {
  const tree = buildScarpProjectTree([
    'अभ्यास/गणित.srp', 'अभ्यास/ट्यूपल.srp', 'emoji😀/main.srp'
  ]);
  assert.equal(tree.sourceCount, 3);
  assert.ok(scarpProjectChildren(tree, '').some(i => i.path === 'अभ्यास'));
});
test('many nested source files remain bounded by input size', () => {
  const names = Array.from({ length: 500 }, (_, i) =>
    'src/folder' + Math.floor(i / 10) + '/file' + i + '.srp');
  const tree = buildScarpProjectTree(names);
  assert.equal(tree.sourceCount, 500);
  assert.equal(tree.items.find(i => i.path === '')?.descendantSources, 500);
  assert.ok(tree.items.length < 1000);
});
test('a malicious file name cannot become an implicit folder', () => {
  const tree = buildScarpProjectTree([
    'normal/ok.srp', 'normal/../escape.srp', 'normal//bad.srp'
  ]);
  assert.equal(tree.sourceCount, 1);
  assert.deepEqual(tree.rejected, ['normal/../escape.srp', 'normal//bad.srp'].sort());
});
test('folder-only navigation never offers non-Scarp disk entries', () => {
  const tree = buildScarpProjectTree([
    'src/main.srp', 'docs/readme.md', 'dist/app.js'
  ]);
  assert.deepEqual(scarpProjectChildren(tree, '').map(i => i.path), ['src']);
  assert.equal(tree.rejected.length, 2);
});
