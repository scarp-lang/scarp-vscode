export const BUDGET_SETTINGS = [
  ['maxSteps', '--max-steps'],
  ['maxPrints', '--max-prints'],
  ['maxCallDepth', '--max-call-depth'],
  ['maxCalls', '--max-calls'],
  ['maxLiveSlots', '--max-live-slots'],
  ['maxCaptureBytes', '--max-capture-bytes'],
  ['maxVectorBytes', '--max-vector-bytes'],
  ['maxTextBytes', '--max-text-bytes'],
  ['maxTupleBytes', '--max-tuple-bytes'],
  ['maxArrayBytes', '--max-array-bytes'],
  ['maxBigIntDigits', '--max-bigint-digits'],
  ['maxBigIntBytes', '--max-bigint-bytes'],
  ['maxInputLineBytes', '--max-input-line-bytes'],
  ['maxInputBytes', '--max-input-bytes'],
  ['maxInputReads', '--max-input-reads']
] as const;

export type BudgetSettings = Record<(typeof BUDGET_SETTINGS)[number][0], number | undefined>;

export function budgetArguments(settings: BudgetSettings): string[] {
  const args: string[] = [];
  for (const [key, flag] of BUDGET_SETTINGS) {
    const value = settings[key];
    if (value === undefined) { continue; }
    if (!Number.isSafeInteger(value) || value < 0 ||
        (key === 'maxBigIntDigits' && value > 1_000_000)) {
      // Published Scarp alpha.9 has an absolute decimal digit ceiling.
      throw new Error('Invalid Scarp execution limit: ' + key);
    }
    args.push(flag, String(value));
  }
  return args;
}
