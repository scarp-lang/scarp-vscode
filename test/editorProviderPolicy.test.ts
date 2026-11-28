import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpEditorSnapshotAllowed, sameScarpSnapshot,
  scarpEditorRangeAllowed, scarpEditorResultAllowed,
  type ScarpEditorSnapshot
} from '../src/editorProviderPolicy';

const baseline: ScarpEditorSnapshot = {
  key: 'file:///workspace/main.srp', scheme: 'file', languageId: 'scarp',
  version: 1, text: 'bind answer = 42;\n'
};
const environment = { cancellationRequested: false, workspaceTrusted: true };

test('accepts a bounded Scarp source document in a trusted workspace', () => {
  assert.equal(scarpEditorSnapshotAllowed(baseline, environment), true);
});

test('format-only policy also accepts trusted and restricted local documents', () => {
  assert.equal(scarpEditorSnapshotAllowed(baseline,
    { cancellationRequested: false, workspaceTrusted: false }), true);
});

test('write-oriented actions can demand a trusted workspace explicitly', () => {
  assert.equal(scarpEditorSnapshotAllowed(baseline, environment, {
    requireTrust: true
  }), true);
  assert.equal(scarpEditorSnapshotAllowed(baseline, {
    cancellationRequested: false, workspaceTrusted: false
  }, { requireTrust: true }), false);
});

test('cancelled requests cannot produce later results', () => {
  assert.equal(scarpEditorSnapshotAllowed(baseline, {
    cancellationRequested: true, workspaceTrusted: true
  }), false);
});

test('only file and untitled schemes can be handled by local editor adapters', () => {
  for (const scheme of ['http', 'https', 'vscode-remote', 'git', 'scarp',
    'vscode-userdata', 'filex', 'untitled-other']) {
    assert.equal(scarpEditorSnapshotAllowed({ ...baseline, scheme }, environment),
      false, scheme);
  }
  assert.equal(scarpEditorSnapshotAllowed({ ...baseline, scheme: 'untitled' },
    environment), true);
});

test('untitled source formatting is independently configurable', () => {
  const sample = { ...baseline, scheme: 'untitled' };
  assert.equal(scarpEditorSnapshotAllowed(sample, environment, {
    allowUntitled: false
  }), false);
  assert.equal(scarpEditorSnapshotAllowed(sample, environment, {
    allowUntitled: true
  }), true);
});

test('language ID must be the exact official Scarp language ID', () => {
  for (const languageId of ['plaintext', 'scarp-project', 'Scarp', 'srp', '',
    'typescript', 'rust']) {
    assert.equal(scarpEditorSnapshotAllowed({ ...baseline, languageId },
      environment), false, languageId);
  }
});

test('version must be a nonnegative safe integer', () => {
  for (const version of [NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(scarpEditorSnapshotAllowed({ ...baseline, version }, environment),
      false, String(version));
  }
  assert.equal(scarpEditorSnapshotAllowed({ ...baseline, version: 0 }, environment), true);
  assert.equal(scarpEditorSnapshotAllowed({
    ...baseline, version: Number.MAX_SAFE_INTEGER
  }, environment), true);
});

test('a document without a usable URI key cannot enter a cache', () => {
  assert.equal(scarpEditorSnapshotAllowed({ ...baseline, key: '' }, environment), false);
  assert.equal(scarpEditorSnapshotAllowed({
    ...baseline, key: 'x'.repeat(8193)
  }, environment), false);
});

test('document character counts have a strict, user-independent cap', () => {
  const text = 'x'.repeat(1_000_001);
  assert.equal(scarpEditorSnapshotAllowed({ ...baseline, text }, environment), false);
  assert.equal(scarpEditorSnapshotAllowed({ ...baseline, text }, environment, {
    maximumSourceBytes: 1_000_002
  }), true);
});

test('bad configured source caps never silently fall back to default', () => {
  for (const maximumSourceBytes of [-1, NaN, Infinity, 3.5, 2_000_001]) {
    assert.equal(scarpEditorSnapshotAllowed(baseline, environment, {
      maximumSourceBytes
    }), false, String(maximumSourceBytes));
  }
});

test('the explicit zero-byte cap is valid for empty sources only', () => {
  const empty = { ...baseline, text: '' };
  assert.equal(scarpEditorSnapshotAllowed(empty, environment, {
    maximumSourceBytes: 0
  }), true);
  assert.equal(scarpEditorSnapshotAllowed(baseline, environment, {
    maximumSourceBytes: 0
  }), false);
});

test('snapshots are equal only if source text and version both match', () => {
  assert.equal(sameScarpSnapshot(baseline, { ...baseline }), true);
  assert.equal(sameScarpSnapshot(baseline, { ...baseline, version: 2 }), false);
  assert.equal(sameScarpSnapshot(baseline, {
    ...baseline, text: 'bind answer = 43;\n'
  }), false);
});

test('equal text with a different document key cannot reuse stale data', () => {
  assert.equal(sameScarpSnapshot(baseline, {
    ...baseline, key: 'file:///another/main.srp'
  }), false);
});

test('identical URI under another scheme cannot reuse an editor snapshot', () => {
  assert.equal(sameScarpSnapshot(baseline, {
    ...baseline, scheme: 'git'
  }), false);
});

test('an edited language assignment invalidates source-aware editor caches', () => {
  assert.equal(sameScarpSnapshot(baseline, {
    ...baseline, languageId: 'plaintext'
  }), false);
});

test('all document edits require monotonically ordered, in-bounds offsets', () => {
  const length = baseline.text.length;
  for (const [start, end] of [[0, 0], [0, length], [length, length],
    [2, 5], [length - 1, length]]) {
    assert.equal(scarpEditorRangeAllowed(start, end, length), true);
  }
});

test('reversed, negative, fractional and nonfinite editor ranges fail', () => {
  const length = baseline.text.length;
  for (const [start, end] of [[-1, 2], [2, 1], [0, length + 1],
    [NaN, NaN], [Infinity, 5], [1.5, 6], [0, Infinity]]) {
    assert.equal(scarpEditorRangeAllowed(start, end, length), false);
  }
});

test('invalid document lengths are not accepted as range bounds', () => {
  for (const length of [-1, NaN, Infinity, 1.5]) {
    assert.equal(scarpEditorRangeAllowed(0, 0, length), false);
  }
});

test('result budgets require safe nonnegative integral counts', () => {
  assert.equal(scarpEditorResultAllowed(0, 0), true);
  assert.equal(scarpEditorResultAllowed(1, 1), true);
  assert.equal(scarpEditorResultAllowed(1, 0), false);
  assert.equal(scarpEditorResultAllowed(5, 4), false);
});

test('result budget rejects NaN, infinities, fractions and negative values', () => {
  for (const bad of [NaN, Infinity, -1, 2.5]) {
    assert.equal(scarpEditorResultAllowed(bad, 10), false);
    assert.equal(scarpEditorResultAllowed(1, bad), false);
  }
});

test('policy decisions are stable across repeated reads', () => {
  const baselineCopy = JSON.parse(JSON.stringify(baseline)) as ScarpEditorSnapshot;
  for (let repeat = 0; repeat < 100; repeat++) {
    assert.equal(scarpEditorSnapshotAllowed(baseline, environment), true);
    assert.equal(sameScarpSnapshot(baseline, baselineCopy), true);
    assert.equal(scarpEditorRangeAllowed(0, baseline.text.length,
      baseline.text.length), true);
  }
});
