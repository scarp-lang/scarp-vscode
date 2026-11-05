import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { parseBrowsableProjectModules } from '../src/projectModules';

const root = path.resolve('demo project');
const source = (relative: string) => path.join(root, relative);
const inventory = (modules: unknown[], entry = 0): string =>
  JSON.stringify({ schema_version: 1, entry, modules, constant_dependencies: [] });
const moduleEntry = (id: number, name: string, imports: unknown[] = [],
  symbols: unknown[] = []): unknown =>
  ({ id, path: source(name), imports, symbols, dependencies: [], dependents: [] });

test('browses entry and imported modules with public symbol counts', () => {
  const json = inventory([
    moduleEntry(0, 'src/main.srp', [
      { path: 'lib.srp', alias: 'lib', target: 1 }
    ]),
    moduleEntry(1, path.join('src', 'café.srp'), [], [
      { name: 'exported', public: true },
      { name: 'private', public: false }
    ])
  ]);
  assert.deepEqual(parseBrowsableProjectModules(json, root), [
    { id: 0, filename: source('src/main.srp'), displayPath: 'src/main.srp',
      isEntry: true, importCount: 1, publicSymbols: 0 },
    { id: 1, filename: source(path.join('src', 'café.srp')),
      displayPath: 'src/café.srp',
      isEntry: false, importCount: 0, publicSymbols: 1 }
  ]);
});

test('requires schema v1, a real entry module and bounded module arrays', () => {
  const good = JSON.parse(inventory([moduleEntry(0, 'src/main.srp')]));
  for (const bad of [
    '{not json', '{}',
    JSON.stringify({ ...good, schema_version: 2 }),
    inventory([], 0), inventory([moduleEntry(0, 'src/main.srp')], 3),
    inventory([moduleEntry(-1, 'src/main.srp')]),
    inventory([moduleEntry(0, 'src/main.srp'), moduleEntry(0, 'src/lib.srp')]),
    inventory([moduleEntry(0, 'src/main.srp'), moduleEntry(1, 'src/main.srp')]),
    inventory(Array.from({ length: 129 }, (_, i) =>
      moduleEntry(i, 'src/' + i + '.srp')))
  ]) {
    assert.throws(() => parseBrowsableProjectModules(bad, root), /module inspection JSON/);
  }
});

test('rejects relative and out-of-root compiler paths, including prefix collisions', () => {
  const badPaths = [
    'relative.srp', path.resolve('other.srp'),
    path.join(path.dirname(root), path.basename(root) + '-other', 'evil.srp'),
    path.join(root, '..', 'escape.srp')
  ];
  for (const candidate of badPaths) {
    const entry = { id: 0, path: candidate, imports: [], symbols: [] };
    assert.throws(() => parseBrowsableProjectModules(inventory([entry]), root),
      /module inspection JSON/);
  }
});

test('rejects invalid imports, symbols, non-source paths and abnormal IDs', () => {
  for (const entry of [
    moduleEntry(0, 'src/main.txt'),
    moduleEntry(2, 'src/main.srp'),
    moduleEntry(0, 'src/main.srp', [{ target: 'outside' }]),
    moduleEntry(0, 'src/main.srp', [], [{ name: 'x', public: 'yes' }]),
    moduleEntry(0, 'src/main.srp', Array(1025).fill({ target: 0 })),
    moduleEntry(0, 'src/main.srp', [], Array(4097).fill({ name: 'x', public: true }))
  ]) {
    assert.throws(() => parseBrowsableProjectModules(inventory([entry]), root),
      /module inspection JSON/);
  }
});
