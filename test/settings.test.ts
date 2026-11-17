import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { budgetArguments, BudgetSettings } from '../src/settings';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

test('alpha.10 fixed array budget is opt-in and checked', () => {
  assert.deepEqual(budgetArguments({ maxArrayBytes: 8_388_608 } as BudgetSettings),
    ['--max-array-bytes', '8388608']);
  assert.deepEqual(budgetArguments({ maxArrayBytes: 0 } as BudgetSettings),
    ['--max-array-bytes', '0']);
  for (const bad of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budgetArguments({ maxArrayBytes: bad } as BudgetSettings),
      /Invalid Scarp execution limit: maxArrayBytes/);
  }
  assert.ok(!budgetArguments({} as BudgetSettings).includes('--max-array-bytes'));
});


test('published alpha.13 settings describe shared collection quotas and explicit input modes', () => {
  // This is a metadata contract. The executor forwards the same opt-in flags;
  // no compiler is installed or executed to render Settings.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const properties = pkg.contributes.configuration.properties as Record<string, {
    description: string; default?: number;
  }>;
  const arrayHelp = properties['scarp.maxArrayBytes'].description;
  assert.match(arrayHelp, /fixed arrays/);
  assert.match(arrayHelp, /lists and maps/);
  assert.match(arrayHelp, /alpha\.12/);
  assert.match(arrayHelp, /static Verify/);
  const tupleHelp = properties['scarp.maxTupleBytes'].description;
  for (const word of ['tuple', 'record', 'variant', 'alpha.12']) {
    assert.ok(tupleHelp.includes(word), word);
  }
  for (const key of ['maxInputLineBytes', 'maxInputBytes', 'maxInputReads']) {
    const description = properties['scarp.' + key].description;
    assert.match(description, /alpha\.6/);
    assert.match(description, /alpha\.10/);
    assert.match(description, /--interactive/);
    assert.match(description, /Does not enable interactive execution/);
  }
  // Enabling shared quota flags remains explicitly opt-in.
  assert.deepEqual(budgetArguments({ maxTupleBytes: 0, maxArrayBytes: 0 } as BudgetSettings),
    ['--max-tuple-bytes', '0', '--max-array-bytes', '0']);
  assert.deepEqual(budgetArguments({} as BudgetSettings), []);
});

