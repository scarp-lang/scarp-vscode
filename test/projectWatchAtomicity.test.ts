import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ProjectWatchRegistry, type WatchDisposable } from '../src/projectWatchRegistry';

interface WatchRecord {
  readonly root: string;
  readonly pattern: string;
  disposed: boolean;
}

const snapshot = (version: string) => new Map([['scarp.project', version]]);

function fixtures() {
  const created: WatchRecord[] = [];
  let failRoot: string | undefined;
  let failPattern: string | undefined;
  const factory = (root: string, pattern: string): WatchDisposable => {
    if (root === failRoot && pattern === failPattern) {
      throw new Error('watcher refused: ' + pattern);
    }
    const record = { root, pattern, disposed: false };
    created.push(record);
    return { dispose() { record.disposed = true; } };
  };
  const fail = (root: string, pattern = '{scarp.project,Scarp.project}') => {
    failRoot = path.resolve(root);
    failPattern = pattern;
  };
  const clearFailure = () => { failRoot = undefined; failPattern = undefined; };
  return { created, factory, fail, clearFailure };
}

test('a failed same-root replacement retains existing live watchers and verified baseline', async () => {
  const events = fixtures();
  const evicted: string[] = [];
  const root = path.resolve('project');
  const live = snapshot('verified');
  const registry = new ProjectWatchRegistry(events.factory,
    (_root, owner) => evicted.push(owner), 2, async () => live);
  registry.track(root, 'old-owner', () => {}, live);
  const original = [...events.created];
  events.fail(root);
  assert.throws(() => registry.track(root, 'new-owner', () => {}, snapshot('new')),
    /watcher refused/);
  assert.ok(original.every(w => !w.disposed), 'old verified watchers must remain installed');
  assert.ok(events.created[2].disposed, 'partially created candidate must be disposed');
  assert.deepEqual(evicted, []);
  assert.equal(await registry.reconcile(), 0, 'old verified baseline must remain valid');
  registry.stopOwner('old-owner');
  assert.ok(original.every(w => w.disposed));
  registry.dispose();
});

test('failed new-root tracking at maximum capacity never evicts an unrelated project', async () => {
  const events = fixtures();
  const evicted: string[] = [];
  const a = path.resolve('alpha');
  const b = path.resolve('beta');
  const registry = new ProjectWatchRegistry(events.factory,
    (_root, owner) => evicted.push(owner), 1, async () => snapshot('ok'));
  registry.track(a, 'owner-a', () => {}, snapshot('ok'));
  events.fail(b);
  assert.throws(() => registry.track(b, 'owner-b', () => {}, snapshot('ok')),
    /watcher refused/);
  assert.ok(events.created[0] && !events.created[0].disposed);
  assert.ok(events.created[1] && !events.created[1].disposed);
  assert.deepEqual(evicted, []);
  assert.equal(await registry.reconcile(), 0);
  events.clearFailure();
  registry.track(b, 'owner-b', () => {}, snapshot('ok'));
  assert.deepEqual(evicted, ['owner-a']);
  assert.ok(events.created[0].disposed && events.created[1].disposed);
  registry.dispose();
});

test('a successful replacement disposes exactly the previous watchers and keeps the new owner', async () => {
  const events = fixtures();
  const evicted: string[] = [];
  const root = path.resolve('replace');
  const newer = snapshot('new');
  const registry = new ProjectWatchRegistry(events.factory,
    (_root, owner) => evicted.push(owner), 1, async () => newer);
  registry.track(root, 'previous', () => {}, snapshot('old'));
  registry.track(root, 'current', () => {}, newer);
  assert.deepEqual(evicted, [], 'replacing the same path should not consume capacity');
  assert.ok(events.created[0].disposed && events.created[1].disposed);
  assert.ok(!events.created[2].disposed && !events.created[3].disposed);
  assert.equal(await registry.reconcile(), 0);
  registry.stopOwner('previous');
  assert.ok(!events.created[2].disposed, 'old owners must not remove replacement watches');
  registry.stopOwner('current');
  assert.ok(events.created[2].disposed && events.created[3].disposed);
});

test('failing to install the first watcher leaves no partial project to reconcile', async () => {
  const events = fixtures();
  const root = path.resolve('missing');
  events.fail(root, '**/*.srp');
  let reads = 0;
  const registry = new ProjectWatchRegistry(events.factory, () => {}, 1,
    async () => { reads++; return snapshot('ok'); });
  assert.throws(() => registry.track(root, 'owner', () => {}, snapshot('ok')),
    /watcher refused/);
  assert.equal(await registry.reconcile(), 0);
  assert.equal(reads, 0);
  assert.equal(events.created.length, 0);
  registry.dispose();
});

test('successful staging still copies the verification snapshot, never sharing mutable maps', async () => {
  const events = fixtures();
  const root = path.resolve('snapshot-copy');
  const input = snapshot('verified');
  const registry = new ProjectWatchRegistry(events.factory, () => {}, 1,
    async () => snapshot('verified'));
  registry.track(root, 'owner', () => {}, input);
  input.set('scarp.project', 'later mutation');
  assert.equal(await registry.reconcile(), 0);
  registry.dispose();
});
