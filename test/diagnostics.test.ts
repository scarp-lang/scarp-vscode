import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDiagnostics, utf16OffsetForScalarColumn } from '../src/diagnostics';

test('parses compiler error and source location', () => {
  const result = parseDiagnostics("error[E0004]: expected ';', found <eof>\n --> example.srp:1:15\n");
  assert.deepEqual(result, [{
    severity: 'error', code: 'E0004', message: "expected ';', found <eof>",
    filename: 'example.srp', line: 1, column: 15
  }]);
});
test('supports a Windows drive-letter path', () => {
  const [result] = parseDiagnostics('warning[W0001]: sample\n --> C:\\work dir\\a.srp:2:3\n');
  assert.equal(result.filename, 'C:\\work dir\\a.srp');
});
test('does not invent diagnostic coordinates', () => {
  assert.deepEqual(parseDiagnostics('error: unknown command'), []);
});
test('converts Unicode scalar columns to UTF-16 offsets', () => {
  assert.equal(utf16OffsetForScalarColumn('😀x', 2), 2);
});
