import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DebouncedSerialTasks } from '../src/saveVerification';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function eventually(read: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (read()) { return; }
    await sleep(10);
  }
  assert.fail('Timed out waiting for debounced work');
}

test('coalesces rapid saves of the same Scarp document', async () => {
  const completed: number[] = [];
  const queue = new DebouncedSerialTasks<number>(15,
    async (_, version) => { completed.push(version); },
    error => { throw error; });
  try {
    queue.request('file:///a.srp', 1);
    queue.request('file:///a.srp', 2);
    queue.request('file:///a.srp', 3);
    await eventually(() => completed.length === 1);
    assert.deepEqual(completed, [3]);
  } finally { queue.dispose(); }
});

test('runs independent files without blocking one another', async () => {
  const completed: string[] = [];
  let releaseFirst!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const queue = new DebouncedSerialTasks<string>(5,
    async (key) => {
      if (key === 'a') { await blocked; }
      completed.push(key);
    },
    error => { throw error; });
  try {
    queue.request('a', 'first');
    await sleep(25);
    queue.request('b', 'second');
    await eventually(() => completed.includes('b'));
    assert.deepEqual(completed, ['b']);
    releaseFirst();
    await eventually(() => completed.length === 2);
  } finally {
    releaseFirst();
    queue.dispose();
  }
});

test('serializes slow verification and coalesces later saves to the newest one', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  const queue = new DebouncedSerialTasks<number>(10,
    async (_key, version) => {
      started.push(version);
      if (version === 1) { await blocked; }
    }, error => { throw error; });
  try {
    queue.request('a', 1);
    await eventually(() => started.length === 1);
    queue.request('a', 2);
    await sleep(25);
    queue.request('a', 3);
    await sleep(25);
    assert.deepEqual(started, [1], 'No overlapping checks for the same file');
    release();
    await eventually(() => started.length === 2);
    assert.deepEqual(started, [1, 3]);
  } finally {
    release();
    queue.dispose();
  }
});

test('an older rerun must not overwrite a newer save still debouncing', async () => {
  let releaseFirst!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started: number[] = [];
  const queue = new DebouncedSerialTasks<number>(40,
    async (_key, version) => {
      started.push(version);
      if (version === 1) { await blocked; }
    }, error => { throw error; });
  try {
    queue.request('file:///race.srp', 1);
    await eventually(() => started.length === 1);
    queue.request('file:///race.srp', 2);
    // The second request finishes debouncing while verification #1 is busy,
    // so it becomes a queued rerun rather than starting in parallel.
    await sleep(90);
    queue.request('file:///race.srp', 3);
    // Request #3 is newer and its debounce timer is still pending. The
    // finishing worker must not call request(#2), which would cancel #3.
    releaseFirst();
    await eventually(() => started.length === 2);
    await sleep(65);
    assert.deepEqual(started, [1, 3]);
  } finally {
    releaseFirst();
    queue.dispose();
  }
});

test('serial queue supports undefined values as valid reruns', async () => {
  let releaseFirst!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const queue = new DebouncedSerialTasks<undefined>(5, async () => {
    calls++;
    if (calls === 1) { await blocked; }
  }, error => { throw error; });
  try {
    queue.request('file:///optional.srp', undefined);
    await eventually(() => calls === 1);
    queue.request('file:///optional.srp', undefined);
    await sleep(25);
    releaseFirst();
    await eventually(() => calls === 2);
    assert.equal(calls, 2);
  } finally {
    releaseFirst();
    queue.dispose();
  }
});

test('reports failures and continues to accept new save requests', async () => {
  const errors: unknown[] = [];
  const completed: number[] = [];
  const queue = new DebouncedSerialTasks<number>(5,
    async (_, version) => {
      if (version === 1) { throw new Error('compiler unavailable'); }
      completed.push(version);
    }, error => { errors.push(error); });
  try {
    queue.request('a', 1);
    await eventually(() => errors.length === 1);
    queue.request('a', 2);
    await eventually(() => completed.length === 1);
    assert.deepEqual(completed, [2]);
  } finally { queue.dispose(); }
});

test('disposal cancels pending save checks', async () => {
  let called = false;
  const queue = new DebouncedSerialTasks<number>(40,
    async () => { called = true; }, error => { throw error; });
  queue.request('a', 1);
  queue.dispose();
  queue.request('a', 2);
  await sleep(65);
  assert.equal(called, false);
});
