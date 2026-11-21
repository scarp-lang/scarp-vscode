import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { setupRecoveryFor, type CompilerRecoveryKind } from '../src/compilerSetupRecovery';

test('compiler setup recovery maps integrity failures to safe, actionable choices', () => {
  const samples = [
    'Scarp installer: checksum file did not match SHA-256',
    'Scarp installer: invalid ZIP member size or CRC',
    'Scarp installer: unsafe compiler tar member',
    'Scarp installer: downloaded executable failed official version validation',
    'Scarp installer: unexpected official asset metadata: archive'
  ];
  for (const failure of samples) {
    const issue = setupRecoveryFor(new Error(failure));
    assert.equal(issue.kind, 'integrity', failure);
    assert.equal(issue.actions.includes('choose'), true);
    assert.equal(issue.actions.includes('releases'), true);
    assert.match(issue.explanation, /No unsafe package will be selected/);
    assert.doesNotMatch(issue.explanation, /skip verification|bypass integrity/i);
  }
});

test('invalid installed directory is distinct from download/integrity failures', () => {
  const issue = setupRecoveryFor(new Error(
    'Scarp installer: an existing installation failed validation: /tmp/compilers/scarp'
  ));
  assert.equal(issue.kind, 'existing-invalid');
  assert.equal(issue.actions.includes('retry'), false,
    'Do not recommend repeatedly re-downloading over an immutable invalid folder');
  assert.match(issue.explanation, /not overwritten/);
});

test('network, proxy, timeout and release-catalogue problems allow manual retry', () => {
  const cases = [
    'GitHub download failed (HTTP 429)',
    'GitHub download failed (HTTP 503)',
    'Scarp installer: official release catalogue is not valid JSON',
    'GitHub download timed out after 45 seconds',
    'TypeError: fetch failed'
  ];
  for (const failure of cases) {
    const issue = setupRecoveryFor(failure);
    assert.equal(issue.kind, 'network', failure);
    assert.ok(issue.actions.includes('retry'), failure);
    assert.ok(issue.actions.includes('choose'), failure);
  }
});

test('unsupported platforms suggest a local binary instead of repeated downloads', () => {
  const issue = setupRecoveryFor(
    new Error('Scarp installer: No official native package for linux/arm64. Use the source build instructions')
  );
  assert.equal(issue.kind, 'unsupported-host');
  assert.equal(issue.actions.includes('retry'), false);
  assert.deepEqual(issue.actions, ['choose', 'releases', 'settings']);
});

test('bad configured paths and other errors do not silently install binaries', () => {
  const expected: [string, CompilerRecoveryKind][] = [
    ['Scarp compiler not found at C:\\missing\\scarp.exe', 'local-executable'],
    ['Invalid Scarp --version response from /usr/local/bin/scarp', 'local-executable'],
    ['Unexpected filesystem permissions', 'other']
  ];
  for (const [error, kind] of expected) {
    const issue = setupRecoveryFor(new Error(error));
    assert.equal(issue.kind, kind);
    assert.ok(issue.actions.every(action =>
      ['choose', 'retry', 'settings', 'releases'].includes(action)));
  }
});
