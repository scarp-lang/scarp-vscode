import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ProjectWatchRegistry, WatchDisposable } from '../src/projectWatchRegistry';
import { ProjectChangeTracker } from '../src/projectChangeTracker';
import { DiagnosticOwners } from '../src/problemOwners';

type EventWatch = { pattern: string; changed: (filename: string) => void; disposed: boolean };
function factory(events: EventWatch[]) {
  return (_root: string, pattern: string, changed: (filename: string) => void): WatchDisposable => {
    const record = { pattern, changed, disposed: false };
    events.push(record);
    return { dispose: () => { record.disposed = true; } };
  };
}

test('scoped source and manifest watchers are disposed with their owner', () => {
  const events: EventWatch[] = [];
  const watchers = new ProjectWatchRegistry(factory(events), () => {});
  watchers.track('a', 'manifest-a', () => {});
  assert.deepEqual(events.map(e => e.pattern), ['**/*.srp', 'Scarp.project']);
  watchers.stopOwner('manifest-a');
  assert.ok(events.every(e => e.disposed));
});

test('external source event invalidates its project but preserves independent owners', () => {
  const events: EventWatch[] = [];
  const tracker = new ProjectChangeTracker();
  const diagnostics = new DiagnosticOwners<string>();
  const watchers = new ProjectWatchRegistry(factory(events), () => {});
  const root = path.resolve('project');
  tracker.completedVerification(root, 'manifest');
  diagnostics.replace('manifest', new Map([['src/main.srp', ['outdated']]]));
  diagnostics.replace('standalone', new Map([['other.srp', ['untouched']]]));
  watchers.track(root, 'manifest', file => {
    for (const owner of tracker.changed(file)) {
      watchers.stopOwner(owner);
      diagnostics.replace(owner, new Map());
    }
  });
  events[0].changed(path.join(root, 'src', 'external.srp'));
  assert.ok(events.every(e => e.disposed));
  assert.deepEqual([...diagnostics.replace('standalone', new Map())], [['other.srp', []]]);
  assert.deepEqual([...diagnostics.invalidateChanged('src/main.srp')], []);
});

test('oldest watch is evicted at a bounded capacity; replacement does not evict', () => {
  const events: EventWatch[] = [];
  const evicted: string[] = [];
  const watchers = new ProjectWatchRegistry(factory(events),
    (_root, owner) => evicted.push(owner), 2);
  watchers.track('a', 'old', () => {});
  watchers.track('a', 'replaced', () => {});
  assert.deepEqual(evicted, []);
  assert.ok(events.slice(0, 2).every(e => e.disposed));
  watchers.track('b', 'b', () => {});
  watchers.track('c', 'c', () => {});
  assert.deepEqual(evicted, ['replaced']);
  watchers.dispose();
  assert.ok(events.every(e => e.disposed));
});

test('watcher setup failure disposes already installed event watchers', () => {
  let disposed = false;
  const watchers = new ProjectWatchRegistry((_root, pattern) => {
    if (pattern === 'Scarp.project') { throw Error('unavailable'); }
    return { dispose: () => { disposed = true; } };
  }, () => {});
  assert.throws(() => watchers.track('root', 'manifest', () => {}), /unavailable/);
  assert.equal(disposed, true);
});

test('completed root can be forgotten after watcher eviction', () => {
  const tracker = new ProjectChangeTracker();
  tracker.completedVerification('root', 'manifest');
  assert.equal(tracker.forgetCompleted('root'), 'manifest');
  assert.deepEqual(tracker.changed(path.join(path.resolve('root'), 'src', 'main.srp')), []);
});
