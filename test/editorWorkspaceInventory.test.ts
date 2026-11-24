import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectScarpWorkspaceSources } from '../src/editorWorkspaceInventory';

async function fixture(
  run: (root: string, files: readonly string[]) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-workspace-inventory-'));
  const names = ['main.srp', 'src/math.srp', 'src/deep/nested.srp'];
  const bodies = ['import "src/math.srp" as math;\n',
    'pub bind answer = 42;\n', 'print("नमस्ते 😀");\n'];
  try {
    for (let i = 0; i < names.length; i++) {
      const filename = path.join(root, ...names[i].split('/'));
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, bodies[i], 'utf8');
    }
    await run(root, names.map(name => path.join(root, ...name.split('/'))));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 70 });
  }
}
test('reads nested source files in deterministic workspace-relative order', async () => {
  await fixture(async (root, filenames) => {
    const inventory = await collectScarpWorkspaceSources(root, [
      filenames[2], filenames[0], filenames[1]
    ]);
    assert.deepEqual(inventory.sources.map(x => x.file),
      ['main.srp', 'src/deep/nested.srp', 'src/math.srp']);
    assert.equal(inventory.issues.length, 0);
    assert.ok(inventory.byteCount > 20);
    assert.match(inventory.sources[1].source, /नमस्ते/);
  });
});
test('duplicate filenames cannot inflate inventory results', async () => {
  await fixture(async (root, filenames) => {
    const inventory = await collectScarpWorkspaceSources(root,
      [filenames[0], filenames[0], filenames[0]]);
    assert.equal(inventory.sources.length, 1);
    assert.equal(inventory.issues.length, 0);
  });
});
test('a source outside workspace root is rejected before reading', async () => {
  await fixture(async (root, filenames) => {
    const other = path.join(os.tmpdir(), 'out-of-root.srp');
    const inventory = await collectScarpWorkspaceSources(root, [
      filenames[0], other
    ]);
    assert.equal(inventory.sources.length, 1);
    assert.equal(inventory.issues[0].reason, 'outside-root');
  });
});
test('relative root is invalid rather than silently resolved by cwd', async () => {
  const inventory = await collectScarpWorkspaceSources('relative-root', ['main.srp']);
  assert.equal(inventory.sources.length, 0);
  assert.equal(inventory.issues[0].reason, 'limit');
});
test('non-files, missing files and invalid extensions fail closed', async () => {
  await fixture(async (root, filenames) => {
    const folder = path.join(root, 'folder.srp');
    await fs.mkdir(folder);
    const inventory = await collectScarpWorkspaceSources(root, [
      folder, filenames[0] + '.txt', path.join(root, 'missing.srp')
    ]);
    assert.equal(inventory.sources.length, 0);
    assert.ok(inventory.issues.some(x => x.reason === 'not-file'));
    assert.ok(inventory.issues.some(x => x.reason === 'outside-root'));
    assert.ok(inventory.issues.some(x => x.reason === 'unreadable'));
  });
});
test('file-size caps and total byte budgets are enforced', async () => {
  await fixture(async (root, filenames) => {
    const bounded = await collectScarpWorkspaceSources(root, filenames,
      { maxFileBytes: 10 });
    assert.deepEqual(bounded.sources, []);
    assert.equal(bounded.issues.filter(x => x.reason === 'oversized').length, 3);
    const total = await collectScarpWorkspaceSources(root, filenames,
      { maxTotalBytes: 50 });
    assert.ok(total.byteCount <= 50);
    assert.ok(total.issues.some(x => x.reason === 'oversized'));
  });
});
test('file caps constrain both work and source count', async () => {
  await fixture(async (root, filenames) => {
    const inventory = await collectScarpWorkspaceSources(root, filenames,
      { maxFiles: 1 });
    assert.equal(inventory.sources.length, 1);
    assert.ok(inventory.issues.some(x => x.reason === 'limit'));
    const disabled = await collectScarpWorkspaceSources(root, filenames,
      { maxFiles: 0 });
    assert.deepEqual(disabled.sources, []);
    assert.equal(disabled.issues[0].reason, 'limit');
  });
});
test('invalid UTF-8 is never silently repaired into Scarp source', async () => {
  await fixture(async (root) => {
    const invalid = path.join(root, 'invalid.srp');
    await fs.writeFile(invalid, Buffer.from([0xff, 0xfe, 0xc0]));
    const inventory = await collectScarpWorkspaceSources(root, [invalid]);
    assert.equal(inventory.sources.length, 0);
    assert.equal(inventory.issues[0].reason, 'invalid-utf8');
  });
});
test('an already aborted inventory never reads any source files', async () => {
  await fixture(async (root, filenames) => {
    const controller = new AbortController();
    controller.abort();
    const inventory = await collectScarpWorkspaceSources(root, filenames,
      { signal: controller.signal });
    assert.deepEqual(inventory.sources, []);
    assert.equal(inventory.issues[0].reason, 'aborted');
  });
});
test('on-disk symlinks never masquerade as ordinary source files', async t => {
  await fixture(async (root, filenames) => {
    const symlink = path.join(root, 'alias.srp');
    try {
      await fs.symlink(filenames[0], symlink, 'file');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
        t.skip('Host platform disallows symbolic link fixture creation');
        return;
      }
      throw error;
    }
    const inventory = await collectScarpWorkspaceSources(root, [symlink]);
    assert.deepEqual(inventory.sources, []);
    assert.equal(inventory.issues[0].reason, 'symlink');
  });
});
test('symlinked parent directory cannot escape workspace via textual containment', async t => {
  await fixture(async (root) => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-outside-inventory-'));
    try {
      await fs.writeFile(path.join(external, 'outside.srp'), 'print(1);\n');
      const linked = path.join(root, 'linked');
      try {
        await fs.symlink(external, linked, 'dir');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
          t.skip('Host platform disallows symbolic directory links');
          return;
        }
        throw error;
      }
      const inventory = await collectScarpWorkspaceSources(
        root, [path.join(linked, 'outside.srp')]);
      assert.equal(inventory.sources.length, 0);
      assert.equal(inventory.issues[0].reason, 'outside-root');
    } finally {
      await fs.rm(external, { recursive: true, force: true, maxRetries: 6, retryDelay: 70 });
    }
  });
});
test('source content snapshots are not affected by subsequent disk rewrites', async () => {
  await fixture(async (root, filenames) => {
    const snapshot = await collectScarpWorkspaceSources(root, [filenames[0]]);
    const original = snapshot.sources[0].source;
    await fs.writeFile(filenames[0], 'print("new");\n');
    assert.equal(snapshot.sources[0].source, original);
    assert.notEqual((await collectScarpWorkspaceSources(root,
      [filenames[0]])).sources[0].source, original);
  });
});
