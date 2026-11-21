import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseCompilerVersion, compareCompilerVersions,
  assessCompilerUpdate, compilerEditorCompatibility
} from '../src/compilerStatus';

test('recognizes published Scarp versions including multi-digit alpha identifiers', () => {
  assert.deepEqual(parseCompilerVersion('0.0.6-alpha.17'), {
    major: 0, minor: 0, patch: 6, prerelease: ['alpha', '17']
  });
  assert.deepEqual(parseCompilerVersion('1.0.0'), {
    major: 1, minor: 0, patch: 0, prerelease: []
  });
  for (const invalid of [
    '', 'v0.0.6-alpha.17', 'scarp 0.0.6-alpha.17',
    '0.0.6-alpha.', '0.0.6-alpha..17', '0.0.6-alpha.017',
    '00.0.6', '0.00.6', '0.0.06', '0.0.6-alpha!',
    '0.0.6+metadata', '0.0.6-beta_1', '9999999999999999999999999999.0.1'
  ]) {
    assert.equal(parseCompilerVersion(invalid), undefined, invalid);
  }
});

test('compares alpha prereleases numerically rather than lexicographically', () => {
  assert.equal(compareCompilerVersions('0.0.6-alpha.9', '0.0.6-alpha.10'), -1);
  assert.equal(compareCompilerVersions('0.0.6-alpha.10', '0.0.6-alpha.9'), 1);
  assert.equal(compareCompilerVersions('0.0.6-alpha.17', '0.0.6-alpha.17'), 0);
  assert.equal(compareCompilerVersions('0.0.6-alpha.17', '0.0.6'), -1);
  assert.equal(compareCompilerVersions('0.0.6', '0.0.6-alpha.17'), 1);
  assert.equal(compareCompilerVersions('0.0.5-alpha.99', '0.0.6-alpha.1'), -1);
  assert.equal(compareCompilerVersions('0.0.6-alpha.2', '0.1.0-alpha.1'), -1);
  assert.equal(compareCompilerVersions('0.0.6-alpha.17', '1.0.0'), -1);
  assert.equal(compareCompilerVersions('1.0.0', '0.0.6-alpha.17'), 1);
});

test('orders SemVer numeric and nonnumeric identifiers and identifier length', () => {
  assert.equal(compareCompilerVersions('1.0.0-9', '1.0.0-alpha'), -1);
  assert.equal(compareCompilerVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareCompilerVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareCompilerVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareCompilerVersions('1.0.0-beta.11', '1.0.0-beta.2'), 1);
  assert.equal(compareCompilerVersions('1.0.0-beta.999999999999999999999', '1.0.0-beta.2'), 1);
  assert.equal(compareCompilerVersions('bogus', '0.0.6-alpha.17'), undefined);
});

test('classifies explicit check for published releases without inventing updates', () => {
  const published = '0.0.6-alpha.17';
  assert.equal(assessCompilerUpdate(undefined, published).state, 'not-installed');
  assert.equal(assessCompilerUpdate('0.0.6-alpha.16', published).state, 'update-available');
  assert.equal(assessCompilerUpdate(published, published).state, 'current');
  assert.equal(assessCompilerUpdate('0.0.6-alpha.18', published).state, 'ahead');
  assert.equal(assessCompilerUpdate('unparseable', published).state, 'unrecognized');
  assert.match(assessCompilerUpdate('0.0.6-alpha.16', published).message,
    /explicit confirmation/);
});

test('compatibility guidance does not claim version is proof of compiler capability', () => {
  assert.match(compilerEditorCompatibility(undefined), /Not checked/);
  assert.match(compilerEditorCompatibility('0.0.6-alpha.16'), /older than/i);
  assert.match(compilerEditorCompatibility('0.0.6-alpha.17'), /capability probes/i);
  assert.match(compilerEditorCompatibility('0.0.6-alpha.99'), /capability probes/i);
  assert.match(compilerEditorCompatibility('malformed'), /Unknown version/);
});
