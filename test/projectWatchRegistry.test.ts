import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ProjectWatchRegistry, WatchDisposable } from '../src/projectWatchRegistry';
import { ProjectChangeTracker } from '../src/projectChangeTracker';
import { DiagnosticOwners } from '../src/problemOwners';

const baseline = new Map([['Scarp.project', 'verified']]);

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
  watchers.track('a', 'manifest-a', () => {}, baseline);
  assert.deepEqual(events.map(e => e.pattern), ['**/*.srp', '{scarp.project,Scarp.project}']);
  watchers.stopOwner('manifest-a');
  assert.ok(events.every(e => e.disposed));
});

test('declarative manifest event invalidates its project but preserves independent owners', () => {
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
  }, baseline);
  events[1].changed(path.join(root, 'scarp.project'));
  assert.ok(events.every(e => e.disposed));
  assert.deepEqual([...diagnostics.replace('standalone', new Map())], [['other.srp', []]]);
  assert.deepEqual([...diagnostics.invalidateChanged('src/main.srp')], []);
});

test('oldest watch is evicted at a bounded capacity; replacement does not evict', () => {
  const events: EventWatch[] = [];
  const evicted: string[] = [];
  const watchers = new ProjectWatchRegistry(factory(events),
    (_root, owner) => evicted.push(owner), 2);
  watchers.track('a', 'old', () => {}, baseline);
  watchers.track('a', 'replaced', () => {}, baseline);
  assert.deepEqual(evicted, []);
  assert.ok(events.slice(0, 2).every(e => e.disposed));
  watchers.track('b', 'b', () => {}, baseline);
  watchers.track('c', 'c', () => {}, baseline);
  assert.deepEqual(evicted, ['replaced']);
  watchers.dispose();
  assert.ok(events.every(e => e.disposed));
});

test('watcher setup failure disposes already installed event watchers', () => {
  let disposed = false;
  const watchers = new ProjectWatchRegistry((_root, pattern) => {
    if (pattern === '{scarp.project,Scarp.project}') { throw Error('unavailable'); }
    return { dispose: () => { disposed = true; } };
  }, () => {});
  assert.throws(() => watchers.track('root', 'manifest', () => {}, baseline), /unavailable/);
  assert.equal(disposed, true);
});

test('completed root can be forgotten after watcher eviction', () => {
  const tracker = new ProjectChangeTracker();
  tracker.completedVerification('root', 'manifest');
  assert.equal(tracker.forgetCompleted('root'), 'manifest');
  assert.deepEqual(tracker.changed(path.join(path.resolve('root'), 'src', 'main.srp')), []);
});

test('focus reconciliation only evicts roots whose verified bytes changed', async () => {
  const events: EventWatch[] = [];
  const evicted: string[] = [];
  const current = new Map<string, Map<string, string>>();
  const a = path.resolve('project-a');
  const b = path.resolve('project-b');
  current.set(a, new Map([['Scarp.project', 'verified']]));
  current.set(b, new Map([['Scarp.project', 'verified']]));
  const watchers = new ProjectWatchRegistry(factory(events),
    (_root, owner) => evicted.push(owner), 8,
    async root => current.get(root) ?? new Map());
  watchers.track(a, 'owner-a', () => {}, baseline);
  watchers.track(b, 'owner-b', () => {}, baseline);
  assert.equal(await watchers.reconcile(), 0);
  current.set(a, new Map([['Scarp.project', 'changed']]));
  assert.equal(await watchers.reconcile(), 1);
  assert.deepEqual(evicted, ['owner-a']);
  assert.equal(events[0].disposed, true);
  assert.equal(events[1].disposed, true);
  assert.equal(events[2].disposed, false);
  assert.equal(await watchers.reconcile(), 0);
  watchers.dispose();
});

test('snapshot read failures invalidate only the affected root', async () => {
  const evicted: string[] = [];
  const watchers = new ProjectWatchRegistry(factory([]),
    (_root, owner) => evicted.push(owner), 8,
    async root => {
      if (root === path.resolve('failed')) { throw new Error('directory removed'); }
      return baseline;
    });
  watchers.track('failed', 'invalid', () => {}, baseline);
  watchers.track('good', 'valid', () => {}, baseline);
  assert.equal(await watchers.reconcile(), 1);
  assert.deepEqual(evicted, ['invalid']);
  watchers.dispose();
});

test('in-flight reconciliation never discards a newly reverified snapshot', async () => {
  const evicted: string[] = [];
  let release!: (value: Map<string, string>) => void;
  const pending = new Promise<Map<string, string>>(resolve => { release = resolve; });
  const watchers = new ProjectWatchRegistry(factory([]),
    (_root, owner) => evicted.push(owner), 8, async () => pending);
  watchers.track('project', 'original', () => {}, baseline);
  const first = watchers.reconcile();
  watchers.track('project', 'newer', () => {}, new Map([['Scarp.project', 'new']]));
  release(new Map([['Scarp.project', 'old']]));
  assert.equal(await first, 0);
  assert.deepEqual(evicted, []);
  watchers.dispose();
});

test('concurrent reconciliations share one filesystem scan', async () => {
  let reads = 0;
  let release!: (value: Map<string, string>) => void;
  const pending = new Promise<Map<string, string>>(resolve => { release = resolve; });
  const watchers = new ProjectWatchRegistry(factory([]), () => {}, 8,
    async () => { reads++; return pending; });
  watchers.track('project', 'owner', () => {}, baseline);
  const a = watchers.reconcile();
  const b = watchers.reconcile();
  assert.equal(a, b);
  release(new Map(baseline));
  assert.equal(await a, 0);
  assert.equal(reads, 1);
  watchers.dispose();
});
