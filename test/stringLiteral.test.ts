import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanScarpString } from '../src/stringLiteral';

test('literal boundaries follow the compiler delimiter and escape rules', () => {
  const cases = [
    { source: '"a\\"b" end', end: 6, kind: 'ordinary', closed: true },
    { source: 'r"a\\" end', end: 5, kind: 'raw', closed: true },
    { source: '"""a\r\n😀""" end', end: 11, kind: 'multiline', closed: true },
    { source: '"""a"', end: 5, kind: 'multiline', closed: false },
    { source: 'r"x\r\ny', end: 3, kind: 'raw', closed: false },
    { source: '"x\\\ny', end: 3, kind: 'ordinary', closed: false },
  ];
  for (const { source, ...expected } of cases) {
    assert.deepEqual(scanScarpString(source, 0), expected, source);
  }
  assert.equal(scanScarpString('raw', 0), undefined);
  assert.deepEqual(scanScarpString('  ""', 2), { end: 4, closed: true, kind: 'ordinary' });
});
