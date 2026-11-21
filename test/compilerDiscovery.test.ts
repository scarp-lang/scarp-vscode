import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { compilerDiscoveryCandidates, discoverInstalledCompiler, resolveConfiguredCompiler } from '../src/compilerDiscovery';

test('Windows discovery uses bounded absolute PATH and common installation locations', () => {
  const env: NodeJS.ProcessEnv = {
    Path: '"C:\\Tools With Spaces\\bin";.;C:\\Tools With Spaces\\bin;C:\\Other\\bin',
    LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    CARGO_HOME: 'C:\\RustHome'
  };
  const candidates = compilerDiscoveryCandidates('win32', env, 'C:\\Users\\Ada');
  assert.equal(candidates[0], 'C:\\Tools With Spaces\\bin\\scarp.exe');
  assert.ok(candidates.includes('C:\\Users\\Ada\\AppData\\Local\\Programs\\Scarp\\scarp.exe'));
  assert.ok(candidates.includes('C:\\RustHome\\bin\\scarp.exe'));
  assert.ok(candidates.includes('C:\\Program Files\\Scarp\\scarp.exe'));
  assert.equal(candidates.filter(x => x.toLowerCase() ===
    'c:\\tools with spaces\\bin\\scarp.exe').length, 1);
  assert.ok(!candidates.some(x => x.includes(';.')));
  assert.ok(!candidates.some(x => x === '.\\scarp.exe'));
});

test('Linux and macOS discovery never recursively scans source, Downloads or relative PATH', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const candidates = compilerDiscoveryCandidates(platform, {
      PATH: './local:/opt/scarp/bin:/opt/scarp/bin:/x'.repeat(100),
      CARGO_HOME: '/home/ada/.cargo'
    }, '/home/ada');
    assert.ok(candidates.includes('/home/ada/.cargo/bin/scarp'));
    assert.ok(candidates.includes('/home/ada/.local/bin/scarp'));
    assert.equal(candidates.filter(x => x === '/opt/scarp/bin/scarp').length, 1);
    assert.ok(!candidates.some(x => x.startsWith('.') || x.includes('/Downloads/')));
    assert.ok(candidates.length <= 64);
  }
  assert.ok(compilerDiscoveryCandidates('darwin', { PATH: '' }, '/Users/ada')
    .includes('/opt/homebrew/bin/scarp'));
});

async function makeExecutable(filename: string, versionOutput: string): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, [
    '#!/usr/bin/env node',
    'process.stdout.write(' + JSON.stringify(versionOutput) + ');'
  ].join('\n') + '\n', { mode: 0o755 });
  await fs.chmod(filename, 0o755);
}

test('installed compiler discovery ignores non-Scarp programs and recognizes a cargo installation', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lookalike = path.join(root, 'first', 'scarp');
  const valid = path.join(root, '.cargo', 'bin', 'scarp');
  await makeExecutable(lookalike, 'another tool 1.0.0\n');
  await makeExecutable(valid, 'scarp 0.0.6-alpha.17\n');
  const found = await discoverInstalledCompiler({
    platform: process.platform,
    env: { PATH: path.dirname(lookalike), CARGO_HOME: path.join(root, '.cargo') },
    home: root
  });
  assert.deepEqual(found, { binary: valid, version: '0.0.6-alpha.17' });
});

test('missing compiler returns no result and pre-cancellation refuses probes', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-discovery-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = path.join(root, '.cargo', 'bin', 'scarp');
  await makeExecutable(compiler, 'scarp 0.0.6-alpha.17\n');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverInstalledCompiler({
    platform: process.platform, home: root,
    env: { PATH: '', CARGO_HOME: path.join(root, '.cargo') },
    signal: controller.signal
  }), /cancelled/);
  await fs.rm(compiler);
  assert.equal(await discoverInstalledCompiler({
    platform: process.platform, home: root,
    env: { PATH: '', CARGO_HOME: path.join(root, '.cargo') }
  }), undefined);
});

test('explicit compiler overrides cannot be silently replaced by a discovered installation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-discovery-override-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (process.platform !== 'win32') {
    await makeExecutable(path.join(root, '.cargo', 'bin', 'scarp'),
      'scarp 0.0.6-alpha.17\n');
  }
  const selected = path.join(root, 'missing', process.platform === 'win32' ?
    'scarp.exe' : 'scarp');
  await assert.rejects(resolveConfiguredCompiler(selected, true, undefined, {
    home: root, env: { PATH: '', CARGO_HOME: path.join(root, '.cargo') }
  }), /Scarp compiler not found at/);
  await assert.rejects(resolveConfiguredCompiler(process.execPath, true, undefined, {
    home: root, env: { PATH: '', CARGO_HOME: path.join(root, '.cargo') }
  }), /Invalid Scarp --version response/);
  await assert.rejects(resolveConfiguredCompiler('', true),
    /Set scarp.compilerPath/);
});
