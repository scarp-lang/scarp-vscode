import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanScarpStructure } from '../src/editorStructure';
import {
  checkScarpImportPath, resolveScarpImportPath, resolveExistingScarpImport,
  scarpImportLinks, scarpImportLinksFromStructure, scarpImportAt
} from '../src/editorImports';

test('safe import filenames use POSIX-relative source paths', () => {
  for (const valid of [
    'main.srp', 'math/vector.srp', 'nested/sub/logic.srp',
    'क्षेत्र/गणित.srp', 'sibling-name/variable_2.srp'
  ]) {
    assert.deepEqual(checkScarpImportPath(valid), { safe: true }, valid);
  }
});
test('unsafe lexical paths and ambiguous URL/drive syntax are rejected', () => {
  const rejected = [
    '', '/', '/etc/file.srp', '../escape.srp', './local.srp',
    'folder/../escape.srp', 'folder/./local.srp', 'folder//file.srp',
    'folder/', 'folder\\file.srp', 'C:\\file.srp', 'C:/file.srp',
    '\\\\server\\share.srp', 'https://host/a.srp', 'file:///a.srp',
    'a%2fb.srp', 'x%00.srp', 'x.srp?url=1', 'image.png', 'x.srp\n',
    'a.srp\0', 'x'.repeat(512) + '.srp'
  ];
  for (const invalid of rejected) {
    assert.equal(checkScarpImportPath(invalid).safe, false, invalid);
  }
});
test('path resolution stays within a single absolute workspace', () => {
  const root = path.resolve(os.tmpdir(), 'scarp-link-test-root');
  const sourceFilename = path.join(root, 'src', 'main.srp');
  const options = { workspaceRoot: root, sourceFilename };
  assert.equal(resolveScarpImportPath('lib/a.srp', options),
    path.join(root, 'src', 'lib', 'a.srp'));
  assert.equal(resolveScarpImportPath('a.srp', options),
    path.join(root, 'src', 'a.srp'));
  assert.equal(resolveScarpImportPath('../outside.srp', options), undefined);
  assert.equal(resolveScarpImportPath('a.srp', {
    workspaceRoot: root, sourceFilename: path.join(os.tmpdir(), 'other.srp')
  }), undefined);
});
test('bad workspace arguments cannot produce local import target links', () => {
  assert.equal(resolveScarpImportPath('a.srp', {
    workspaceRoot: 'not-absolute', sourceFilename: '/tmp/main.srp'
  }), undefined);
  assert.equal(resolveScarpImportPath('a.srp', {
    workspaceRoot: '/tmp/root', sourceFilename: 'main.srp'
  }), undefined);
});
async function withWorkspace(
  run: (root: string, main: string, module: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-imports-'));
  const sourceFolder = path.join(root, 'src');
  const moduleFolder = path.join(sourceFolder, 'lib');
  const main = path.join(sourceFolder, 'main.srp');
  const module = path.join(moduleFolder, 'math.srp');
  try {
    await fs.mkdir(moduleFolder, { recursive: true });
    await fs.writeFile(main, 'import "lib/math.srp" as math;\n');
    await fs.writeFile(module, 'pub bind answer = 42;\n');
    await run(root, main, module);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
test('verified real-file links preserve literal path spans and alias metadata', async () => {
  await withWorkspace(async (root, main, module) => {
    const source = 'import "lib/math.srp" as math;';
    const links = await scarpImportLinks(source, {
      workspaceRoot: root, sourceFilename: main
    });
    assert.equal(links.length, 1);
    assert.equal(links[0].relativePath, 'lib/math.srp');
    assert.equal(links[0].alias, 'math');
    assert.equal(links[0].target, await fs.realpath(module));
    assert.equal(source.slice(links[0].start, links[0].end), 'lib/math.srp');
    assert.equal(await resolveExistingScarpImport('lib/math.srp', {
      workspaceRoot: root, sourceFilename: main
    }), await fs.realpath(module));
  });
});
test('missing modules and directory targets never become document links', async () => {
  await withWorkspace(async (root, main) => {
    assert.equal(await resolveExistingScarpImport('missing.srp', {
      workspaceRoot: root, sourceFilename: main
    }), undefined);
    const folder = path.join(path.dirname(main), 'folder.srp');
    await fs.mkdir(folder);
    assert.equal(await resolveExistingScarpImport('folder.srp', {
      workspaceRoot: root, sourceFilename: main
    }), undefined);
  });
});
test('realpath containment rejects both a symlink target and source escape', async t => {
  await withWorkspace(async (root, main) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-outside-'));
    try {
      const target = path.join(outside, 'external.srp');
      await fs.writeFile(target, 'print(1);\n');
      const link = path.join(path.dirname(main), 'escape.srp');
      try {
        await fs.symlink(target, link, 'file');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
          t.skip('Host OS does not permit creation of file symlinks');
          return;
        }
        throw error;
      }
      assert.equal(await resolveExistingScarpImport('escape.srp', {
        workspaceRoot: root, sourceFilename: main
      }), undefined);
      const externalSource = path.join(path.dirname(main), 'outside-source.srp');
      await fs.symlink(target, externalSource, 'file');
      assert.equal(await resolveExistingScarpImport('lib/math.srp', {
        workspaceRoot: root, sourceFilename: externalSource
      }), undefined);
    } finally {
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
test('lexical links ignore nested imports and stale offsets', async () => {
  await withWorkspace(async (root, main) => {
    const source = [
      'import "lib/math.srp" as math;',
      'funcra f() { import "lib/math.srp" as fake; }',
      '// import "lib/math.srp" as fake;'
    ].join('\n');
    const parsed = scanScarpStructure(source);
    assert.ok(parsed);
    const links = await scarpImportLinksFromStructure(parsed, {
      workspaceRoot: root, sourceFilename: main
    });
    assert.equal(links.length, 1);
    const first = parsed.imports[0];
    assert.deepEqual(scarpImportAt(parsed, first.pathSpan.start), first);
    assert.equal(scarpImportAt(parsed, first.pathSpan.end), undefined);
    for (const offset of [-1, source.length + 1, NaN, 1.2]) {
      assert.equal(scarpImportAt(parsed, offset), undefined);
    }
  });
});
test('multiple links are reported in stable source order with realpaths', async () => {
  await withWorkspace(async (root, main) => {
    await fs.writeFile(path.join(path.dirname(main), 'second.srp'), 'print(2);\n');
    const source = [
      'import "lib/math.srp" as math;',
      'import "second.srp" as second;'
    ].join('\n');
    const links = await scarpImportLinks(source, {
      workspaceRoot: root, sourceFilename: main
    });
    assert.deepEqual(links.map(x => x.alias), ['math', 'second']);
    assert.ok(links[0].start < links[1].start);
  });
});
