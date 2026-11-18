import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { parseBrowsableProjectModules, safeCanonicalModulePath } from '../src/projectModules';

const root = path.resolve('demo project');
const source = (relative: string) => path.join(root, relative);
const inventory = (modules: unknown[], entry = 0, schema = 1): string =>
  JSON.stringify({ schema_version: schema, entry, modules, constant_dependencies: [] });
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

test('requires a supported schema, a real entry module and bounded module arrays', () => {
  const good = JSON.parse(inventory([moduleEntry(0, 'src/main.srp')]));
  for (const bad of [
    '{not json', '{}',
    ...([0, 6, '3', 1.5].map(schema_version => JSON.stringify({ ...good, schema_version }))),
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

test('rejects dangling import edges in all supported schemas', () => {
  // Inventory order does not have to match import order: forward references work.
  const entry = moduleEntry(0, 'src/main.srp', [
    { path: 'library.srp', alias: 'lib', target: 1 }
  ]);
  const library = moduleEntry(1, 'src/library.srp');

  for (const schema of [1, 2, 3, 4, 5]) {
    assert.equal(
      parseBrowsableProjectModules(inventory([entry, library], 0, schema), root).length,
      2, `Schema v${schema} must permit forward module references`
    );
    for (const bad of [
      inventory([entry], 0, schema),
      inventory([entry, moduleEntry(1, 'src/library.srp', [{ target: 2 }])], 0, schema),
      inventory([moduleEntry(0, 'src/main.srp', [{ target: Number.MAX_SAFE_INTEGER }])],
        0, schema),
      inventory([moduleEntry(0, 'src/main.srp', [{ target: 0.5 }])], 0, schema)
    ]) {
      assert.throws(
        () => parseBrowsableProjectModules(bad, root),
        /module inspection JSON/,
        `Schema v${schema} must reject dangling and non-integer import targets`
      );
    }
  }
});

for (const [schema, resultType] of [
  [2, 'tuple<integer, string>'],
  [3, 'tuple<array<string, 2>, integer>']
] as const) {
  test(`browses schema v${schema} inventories with structural signatures within the project`, () => {
    const modules = [
      moduleEntry(0, 'src/main.srp', [{ path: 'records.srp', alias: 'r', target: 1 }]),
      moduleEntry(1, 'src/records.srp', [], [{
        name: 'read', public: true, kind: 'function',
        result: resultType, parameters: []
      }])
    ];
    assert.deepEqual(parseBrowsableProjectModules(inventory(modules, 0, schema), root).map(
      module => [module.displayPath, module.isEntry, module.publicSymbols]
    ), [['src/main.srp', true, 0], ['src/records.srp', false, 1]]);
    const malformed = JSON.parse(inventory(modules, 0, schema));
    malformed.modules[1].path = path.resolve('elsewhere/records.srp');
    assert.throws(() => parseBrowsableProjectModules(JSON.stringify(malformed), root),
      /module inspection JSON/);
  });
}

test('published schema v4 records and v5 variants preserve module browsing and visibility', () => {
  const record = {
    name: 'Task', public: true, kind: 'record',
    fields: [{ name: 'title', type: 'string' }, { name: 'items', type: 'list<integer>' }]
  };
  const variant = {
    name: 'Outcome', public: false, kind: 'variant',
    cases: [{ name: 'Ok', payload: 'record Task' }, { name: 'Err', payload: null }]
  };
  const main = moduleEntry(0, 'src/main.srp', [{ target: 1 }]);
  const file = 'src/models.srp';
  const v4 = inventory([main, moduleEntry(1, file, [], [record])], 0, 4);
  const v5 = inventory([main, moduleEntry(1, file, [], [record, variant])], 0, 5);
  for (const [json, count] of [[v4, 1], [v5, 1]] as const) {
    const modules = parseBrowsableProjectModules(json, root);
    assert.deepEqual(modules.map(m => [m.displayPath, m.importCount, m.publicSymbols]), [
      ['src/main.srp', 1, 0], ['src/models.srp', 0, count]
    ]);
  }
});

test('v4/v5 reject malformed or premature nominal metadata and unknown schema upgrades', () => {
  const record = {
    name: 'Record', public: true, kind: 'record',
    fields: [{ name: 'x', type: 'integer' }]
  };
  const variant = {
    name: 'Event', public: true, kind: 'variant',
    cases: [{ name: 'Click', payload: 'record Record' },
      { name: 'Idle', payload: null }]
  };
  const invalid = [
    inventory([moduleEntry(0, 'src/main.srp', [], [variant])], 0, 4),
    inventory([moduleEntry(0, 'src/main.srp', [], [{
      ...record, fields: [{ name: 'x', type: 42 }]
    }])], 0, 4),
    inventory([moduleEntry(0, 'src/main.srp', [], [{
      ...record, fields: Array.from({ length: 33 }, (_, i) =>
        ({ name: 'field' + i, type: 'integer' }))
    }])], 0, 5),
    inventory([moduleEntry(0, 'src/main.srp', [], [{
      ...variant, cases: [{ name: 'Bad', payload: false }]
    }])], 0, 5),
    inventory([moduleEntry(0, 'src/main.srp', [], [{
      ...variant, cases: [{ name: 'Bad', payload: 'string'.repeat(1000) }]
    }])], 0, 5),
    inventory([moduleEntry(0, 'src/main.srp', [], [{
      name: 'Unknown', public: true, kind: 'future-schema-type'
    }])], 0, 5),
    inventory([moduleEntry(0, 'src/main.srp', [], [record])], 0, 3),
    inventory([moduleEntry(0, 'src/main.srp', [], [variant])], 0, 3),
    inventory([moduleEntry(0, 'src/main.srp', [], [record])], 0, 6)
  ];
  for (const text of invalid) {
    assert.throws(() => parseBrowsableProjectModules(text, root),
      /module inspection JSON/);
  }
});


test('normalizes Windows Rust verbatim paths only after canonical root containment', () => {
  const win = path.win32;
  const root = 'D:\\a\\temp\\project with spaces';
  const normal = 'D:\\a\\temp\\project with spaces\\src\\main.srp';
  const verbatim = '\\\\?\\D:\\a\\temp\\project with spaces\\src\\main.srp';
  const expected = { filename: normal, relative: 'src\\main.srp' };
  assert.deepEqual(safeCanonicalModulePath(root, normal, win), expected);
  assert.deepEqual(safeCanonicalModulePath(root, verbatim, win), expected);
  assert.equal(safeCanonicalModulePath(root,
    '\\\\?\\D:\\a\\temp\\project with spaces-other\\escape.srp', win), undefined);
  assert.equal(safeCanonicalModulePath(root, 'C:\\outside\\source.srp', win), undefined);
  assert.equal(safeCanonicalModulePath(root, 'relative.srp', win), undefined);

  const uncRoot = '\\\\server\\share\\project';
  const uncFile = '\\\\?\\UNC\\server\\share\\project\\lib\\source.srp';
  assert.deepEqual(safeCanonicalModulePath(uncRoot, uncFile, win), {
    filename: '\\\\server\\share\\project\\lib\\source.srp',
    relative: 'lib\\source.srp'
  });
  assert.equal(safeCanonicalModulePath(uncRoot,
    '\\\\?\\UNC\\server\\share\\project-extra\\lib\\evil.srp', win), undefined);
});

test('Windows 8.3 short roots and Rust long canonical labels match without escaping the root', () => {
  const win = path.win32;
  const shortRoot = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\scarp-test';
  const longRoot = '\\\\?\\C:\\Users\\runneradmin\\AppData\\Local\\Temp\\scarp-test';
  const longFile = longRoot + '\\typed source.srp';
  const resolveAlias = (filename: string): string =>
    filename === shortRoot ? longRoot : filename;
  assert.deepEqual(
    safeCanonicalModulePath(shortRoot, longFile, win, resolveAlias),
    { filename: win.join(shortRoot, 'typed source.srp'), relative: 'typed source.srp' }
  );
  const sibling = '\\\\?\\C:\\Users\\runneradmin\\AppData\\Local\\Temp\\scarp-test-other\\bad.srp';
  assert.equal(safeCanonicalModulePath(shortRoot, sibling, win, resolveAlias), undefined);
  const symlinkEscape = (filename: string): string =>
    filename === shortRoot ? longRoot :
      filename === win.join(shortRoot, 'alias.srp') ? 'D:\\outside\\file.srp' : filename;
  assert.equal(safeCanonicalModulePath(shortRoot,
    win.join(shortRoot, 'alias.srp'), win, symlinkEscape), undefined);
});
