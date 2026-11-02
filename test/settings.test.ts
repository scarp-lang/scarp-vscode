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
