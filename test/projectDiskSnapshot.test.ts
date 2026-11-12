import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findProjectManifest } from '../src/projectManifest';
import {
  snapshotProjectDisk, snapshotScarpSourceFile, sameProjectDisk
} from '../src/projectDiskSnapshot';

async function project(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-disk-snapshot-'));
  await fs.mkdir(path.join(directory, 'src'));
  await fs.writeFile(path.join(directory, 'Scarp.project'),
    'scarp-project: 1\nname: test\nentry: src/main.srp\n');
  await fs.writeFile(path.join(directory, 'src', 'main.srp'), 'print("one");\n');
  return directory;
}

test('an unchanged project retains its disk fingerprint', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshotProjectDisk(root);
  assert.equal(before.size, 2);
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), true);
  await fs.writeFile(path.join(root, 'README.md'), 'unrelated documentation');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), true);
});

test('detects external source edits, new files and deletions', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'src', 'main.srp');
  const before = await snapshotProjectDisk(root);
  await fs.writeFile(source, 'print("changed outside the editor");\n');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), false);

  const updated = await snapshotProjectDisk(root);
  await fs.mkdir(path.join(root, 'src', 'library'));
  const imported = path.join(root, 'src', 'library', 'math.srp');
  await fs.writeFile(imported, 'pub bind result = 1;\n');
  assert.equal(sameProjectDisk(updated, await snapshotProjectDisk(root)), false);

  const withImport = await snapshotProjectDisk(root);
  await fs.unlink(imported);
  assert.equal(sameProjectDisk(withImport, await snapshotProjectDisk(root)), false);
});

test('detects an external manifest rewrite', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshotProjectDisk(root);
  await fs.writeFile(path.join(root, 'Scarp.project'),
    'scarp-project: 1\nname: different\nentry: src/main.srp\n');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), false);
});

test('recognizes and snapshots the declarative manifest through edits and deletion', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.ok(await findProjectManifest(root));
  await fs.unlink(path.join(root, 'Scarp.project'));
  const manifest = path.join(root, 'scarp.project');
  await fs.writeFile(manifest, 'project "modern" { version: "0.1.0" }\n');
  assert.equal(await findProjectManifest(root), 'scarp.project');
  const before = await snapshotProjectDisk(root);
  assert.ok(before.has('scarp.project'));
  await fs.appendFile(manifest, '\n');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), false);
  await fs.unlink(manifest);
  assert.equal(await findProjectManifest(root), undefined);
  await assert.rejects(snapshotProjectDisk(root), /manifest disappeared/);
});

test('snapshots are project-local, not matching sibling prefixes', async t => {
  const root = await project();
  const sibling = root + '-other';
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(sibling, { recursive: true, force: true });
  });
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'other.srp'), 'print("one");');
  const before = await snapshotProjectDisk(root);
  await fs.writeFile(path.join(sibling, 'other.srp'), 'print("changed");');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), true);
});

test('fails closed when source tree includes an unmonitored directory symlink', async t => {
  if (process.platform === 'win32') { t.skip('Windows symlink creation needs privileges'); return; }
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink('src', path.join(root, 'alias'), 'dir');
  await assert.rejects(snapshotProjectDisk(root), /unmonitored symlinked directory/);
});

test('tracks target edits through source file symlinks', async t => {
  if (process.platform === 'win32') { t.skip('Windows symlink creation needs privileges'); return; }
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink('main.srp', path.join(root, 'src', 'alias.srp'), 'file');
  const before = await snapshotProjectDisk(root);
  await fs.writeFile(path.join(root, 'src', 'main.srp'), 'print("altered");\n');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root)), false);
});

test('detects equal-size rewrites even when modification time is restored', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'src', 'main.srp');
  const times = await fs.stat(file);
  const original = await snapshotProjectDisk(root);
  await fs.writeFile(file, 'print("two");\n');
  await fs.utimes(file, times.atime, times.mtime);
  assert.equal(sameProjectDisk(original, await snapshotProjectDisk(root)), false);
});

test('rejects source symlinks that point outside the explicit project', async t => {
  if (process.platform === 'win32') { t.skip('Windows symlink creation needs privileges'); return; }
  const root = await project();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-outside-source-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const outsideFile = path.join(outside, 'secret.srp');
  await fs.writeFile(outsideFile, 'print("outside");\n');
  await fs.symlink(outsideFile, path.join(root, 'src', 'outside.srp'));
  await assert.rejects(snapshotProjectDisk(root), /symlink escapes the project/);
});

test('rejects oversized input before reading it into extension host memory', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'src', 'main.srp');
  await fs.truncate(file, 64 * 1024 * 1024 + 1);
  await assert.rejects(snapshotProjectDisk(root), /source bytes exceed the disk snapshot limit/);
});

test('standalone source navigation uses the same bounded snapshot without a manifest', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-nav-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.srp'), 'import "lib.srp" as lib;\n');
  await fs.writeFile(path.join(root, 'lib.srp'), 'pub bind x = 1;\n');
  await assert.rejects(snapshotProjectDisk(root), /manifest disappeared/);
  const before = await snapshotProjectDisk(root, false);
  assert.equal(before.size, 2);
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root, false)), true);
  await fs.writeFile(path.join(root, 'lib.srp'), 'pub bind x = 2;\n');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root, false)), false);
  const after = await snapshotProjectDisk(root, false);
  await fs.writeFile(path.join(root, 'README.md'), 'not a navigation input');
  assert.equal(sameProjectDisk(after, await snapshotProjectDisk(root, false)), true);
});

test('standalone navigation snapshot detects newly added source files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-nav-new-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.srp'), 'print(1);\n');
  const before = await snapshotProjectDisk(root, false);
  await fs.writeFile(path.join(root, 'external.srp'), 'bind x = 1;\n');
  assert.equal(sameProjectDisk(before, await snapshotProjectDisk(root, false)), false);
});


test('single-file fingerprint detects external rewrites without scanning sibling sources', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const selected = path.join(root, 'src', 'main.srp');
  const sibling = path.join(root, 'src', 'unrelated.srp');
  const original = await snapshotScarpSourceFile(selected);
  assert.equal(original, await snapshotScarpSourceFile(selected));
  await fs.writeFile(sibling, 'pub bind unrelated = 1;\n');
  assert.equal(original, await snapshotScarpSourceFile(selected),
    'Only the explicitly selected standalone input is fingerprinted');
  const times = await fs.stat(selected);
  await fs.writeFile(selected, 'print("two");\n');
  await fs.utimes(selected, times.atime, times.mtime);
  assert.notEqual(original, await snapshotScarpSourceFile(selected),
    'Even an equal-size rewrite with restored mtime must invalidate results');
});

test('single-file fingerprint detects unlink, oversize and symlink target rewrites', async t => {
  const root = await project();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'src', 'main.srp');
  const alias = path.join(root, 'src', 'alias.srp');
  if (process.platform !== 'win32') {
    await fs.symlink('main.srp', alias, 'file');
    const prior = await snapshotScarpSourceFile(alias);
    await fs.writeFile(source, 'print("updated");\n');
    assert.notEqual(prior, await snapshotScarpSourceFile(alias));
  }
  await fs.truncate(source, 64 * 1024 * 1024 + 1);
  await assert.rejects(snapshotScarpSourceFile(source), /snapshot byte limit/);
  await fs.unlink(source);
  await assert.rejects(snapshotScarpSourceFile(source), /ENOENT/);
});
