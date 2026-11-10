undefined
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
