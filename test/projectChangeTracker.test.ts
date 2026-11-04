import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { isWithinProject, ProjectChangeTracker } from '../src/projectChangeTracker';
import { DiagnosticOwners } from '../src/problemOwners';

const root = path.resolve('demo', 'scarp-project');
const sibling = path.resolve('demo', 'scarp-project-other');
const source = path.join(root, 'src', 'main.srp');

test('recognizes true project descendants without matching sibling prefixes', () => {
  assert.equal(isWithinProject(root, root), true);
  assert.equal(isWithinProject(root, source), true);
  assert.equal(isWithinProject(root, path.join(root, 'Scarp.project')), true);
  assert.equal(isWithinProject(root, path.join(sibling, 'src', 'main.srp')), false);
  assert.equal(isWithinProject(root, path.dirname(root)), false);
});

test('editing a project file invalidates an active verification', () => {
  const tracker = new ProjectChangeTracker();
  const watch = tracker.watch(root);
  assert.equal(watch.isCurrent(), true);
  tracker.changed(path.join(sibling, 'src', 'main.srp'));
  assert.equal(watch.isCurrent(), true);
  tracker.changed(source);
  assert.equal(watch.isCurrent(), false);
  watch.dispose();
});

test('manifest changes invalidate verification; independent projects stay current', () => {
  const tracker = new ProjectChangeTracker();
  const a = tracker.watch(root);
  const b = tracker.watch(sibling);
  tracker.changed(path.join(root, 'Scarp.project'));
  assert.equal(a.isCurrent(), false);
  assert.equal(b.isCurrent(), true);
  a.dispose();
  tracker.changed(path.join(sibling, 'main.srp'));
  assert.equal(b.isCurrent(), false);
  b.dispose();
});

test('watch scopes snapshot edits from their own start, not earlier edits', () => {
  const tracker = new ProjectChangeTracker();
  tracker.changed(source);
  const watch = tracker.watch(root);
  assert.equal(watch.isCurrent(), true);
  watch.dispose();
  tracker.changed(source);
  assert.equal(watch.isCurrent(), true);
});

test('a clean source edit clears its completed project snapshot only once', () => {
  const tracker = new ProjectChangeTracker();
  tracker.completedVerification(root, 'manifest');
  assert.deepEqual(tracker.changed(path.join(root, 'README.md')), []);
  assert.deepEqual(tracker.changed(path.join(sibling, 'main.srp')), []);
  assert.deepEqual(tracker.changed(source), ['manifest']);
  assert.deepEqual(tracker.changed(source), []);
});

test('a project edit preserves independent verification owners and siblings', () => {
  const tracker = new ProjectChangeTracker();
  const diagnostics = new DiagnosticOwners<string>();
  tracker.completedVerification(root, 'manifest-a');
  tracker.completedVerification(sibling, 'manifest-b');
  diagnostics.replace('manifest-a', new Map([['shared.srp', ['from project a']]]));
  diagnostics.replace('manifest-b', new Map([['shared.srp', ['from project b']]]));
  diagnostics.replace('standalone.srp', new Map([['standalone.srp', ['separate']]]));

  const rootOwners = tracker.changed(path.join(root, 'src', 'previously-clean.srp'));
  assert.deepEqual(rootOwners, ['manifest-a']);
  for (const owner of rootOwners) {
    assert.deepEqual([...diagnostics.replace(owner, new Map())], [
      ['shared.srp', ['from project b']]
    ]);
  }
  assert.deepEqual(tracker.changed(path.join(sibling, 'Scarp.project')), ['manifest-b']);
  assert.deepEqual([...diagnostics.invalidateChanged('standalone.srp')], [
    ['standalone.srp', []]
  ]);
});
