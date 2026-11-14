import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { budgetArguments, BudgetSettings } from '../src/settings';

test('passes only configured execution budgets', () => {
  assert.deepEqual(budgetArguments({ maxSteps: 200, maxPrints: 0 } as BudgetSettings),
    ['--max-steps', '200', '--max-prints', '0']);
});
test('rejects invalid budgets', () => {
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budgetArguments({ maxSteps: value } as BudgetSettings));
  }
});

test('passes the official alpha.4 text budget through the compiler argv', () => {
  assert.deepEqual(budgetArguments({ maxTextBytes: 2048 } as BudgetSettings),
    ['--max-text-bytes', '2048']);
});
test('forwards opt-in alpha.6 tuple and redirected input quotas without changing defaults', () => {
  assert.deepEqual(budgetArguments({
    maxTupleBytes: 8192, maxInputLineBytes: 64,
    maxInputBytes: 128, maxInputReads: 0
  } as BudgetSettings), [
    '--max-tuple-bytes', '8192', '--max-input-line-bytes', '64',
    '--max-input-bytes', '128', '--max-input-reads', '0'
  ]);
  assert.deepEqual(budgetArguments({} as BudgetSettings), []);
});

test('alpha.9 exact BigInt limits are explicit and preserve older compiler defaults', () => {
  assert.deepEqual(budgetArguments({
    maxBigIntDigits: 10_000,
    maxBigIntBytes: 8_388_608
  } as BudgetSettings), [
    '--max-bigint-digits', '10000', '--max-bigint-bytes', '8388608'
  ]);
  assert.deepEqual(budgetArguments({
    maxBigIntDigits: 0, maxBigIntBytes: 0
  } as BudgetSettings), [
    '--max-bigint-digits', '0', '--max-bigint-bytes', '0'
  ]);
  assert.deepEqual(budgetArguments({ maxBigIntDigits: 1_000_000 } as BudgetSettings),
    ['--max-bigint-digits', '1000000']);
  for (const bad of [-1, 1.5, Infinity, NaN, 1_000_001,
    Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budgetArguments({ maxBigIntDigits: bad } as BudgetSettings),
      /Invalid Scarp execution limit: maxBigIntDigits/);
  }
  for (const bad of [-1, 0.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budgetArguments({ maxBigIntBytes: bad } as BudgetSettings),
      /Invalid Scarp execution limit: maxBigIntBytes/);
  }
  assert.deepEqual(budgetArguments({} as BudgetSettings), [],
    'Unconfigured BigInt limits never reach pre-alpha.9 compilers');
});
