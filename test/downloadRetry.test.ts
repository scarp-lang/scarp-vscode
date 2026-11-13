import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { withHostDownloadRetry } from './integration/downloadRetry';

function hostTimeout(): Error {
  const error = new Error('@vscode/test-electron request timeout out after 15000ms');
  error.name = 'TimeoutError';
  return error;
}

test('retries transient test-electron host request timeouts at most twice', async () => {
  let attempts = 0;
  const retries: number[] = [];
  const result = await withHostDownloadRetry(async () => {
    attempts++;
    if (attempts < 3) { throw hostTimeout(); }
    return 'test host ready';
  }, attempt => retries.push(attempt));
  assert.equal(result, 'test host ready');
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [2, 3]);
});

test('does not hide VS Code extension test failures behind retries', async () => {
  let attempts = 0;
  const failure = new Error('Extension assertion failed');
  await assert.rejects(
    withHostDownloadRetry(async () => {
      attempts++;
      throw failure;
    }, () => assert.fail('An extension failure must not be retried')),
    error => error === failure
  );
  assert.equal(attempts, 1);
});

test('does not retry unrelated request timeouts', async () => {
  let attempts = 0;
  const unrelated = new Error('extension test request timeout after 15000ms');
  unrelated.name = 'TimeoutError';
  await assert.rejects(withHostDownloadRetry(async () => {
    attempts++;
    throw unrelated;
  }, () => assert.fail('An unrelated timeout must not be retried')),
  error => error === unrelated);
  assert.equal(attempts, 1);
});

test('returns the final host timeout when download retries are exhausted', async () => {
  let attempts = 0;
  const retries: number[] = [];
  await assert.rejects(withHostDownloadRetry(async () => {
    attempts++;
    throw hostTimeout();
  }, attempt => retries.push(attempt)), /@vscode\/test-electron request timeout/);
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [2, 3]);
});
