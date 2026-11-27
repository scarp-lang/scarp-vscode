import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { valueParameterStart } from '../src/genericHeader';

function read(...words: string[]) {
  return valueParameterStart(words.map(text => ({ text })), 0);
}

test('recognizes published generic declaration lists including a trailing comma', () => {
  assert.equal(read('('), 0);
  assert.equal(read('<', 'T', '>', '('), 3);
  assert.equal(read('<', 'T', ':', 'Numeric', ',', 'U', ':', 'Comparable', ',', '>', '('), 10);
  assert.equal(valueParameterStart(['funcra', 'identity', '<', 'T', '>', '('].map(text => ({ text })), 2), 5);
});

test('rejects invalid or partial lists, duplicates, reserved types and unknown constraints', () => {
  for (const words of [
    ['<', '>', '('], ['<', 'T', '>'], ['<', 'integer', '>', '('],
    ['<', 'T', ',', 'T', '>', '('], ['<', 'T', ':', 'Other', '>', '('],
    ['<', 'T', ',', ',', '>', '('], ['<', 'T', 'U', '>', '('],
    ['<', 'T', ':', 'Numeric', '>', ';'], ['<', 'T', ':', '>', '(']
  ]) assert.equal(read(...words), undefined, words.join(' '));
});

test('enforces the compiler type parameter count limit', () => {
  const header = (n: number) => ['<', ...Array.from({ length: n }, (_, i) => ['T' + i, ',']).flat(), '>', '('];
  assert.equal(read(...header(64)), 130);
  assert.equal(read(...header(65)), undefined);
});
