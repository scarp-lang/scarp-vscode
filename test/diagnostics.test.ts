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

test('uses schema-v1 JSON ranges with Unicode scalar columns', () => {
  const result = parseDiagnostics(JSON.stringify({
    schema_version: 1,
    severity: 'error',
    code: 'E0015',
    message: 'expected integer',
    span_encoding: 'utf-8-bytes',
    column_encoding: 'unicode-scalar',
    position_base: 1,
    primary: {
      path: 'lib/main.srp',
      span: [0, 8],
      start: { line: 2, column: 2 },
      end: { line: 2, column: 5 }
    },
    related: [],
    help: 'Use an integer value'
  }));
  assert.deepEqual(result, [{
    severity: 'error', code: 'E0015', message: 'expected integer',
    filename: 'lib/main.srp', line: 2, column: 2,
    endLine: 2, endColumn: 5, help: 'Use an integer value'
  }]);
});

test('accepts no-location JSON errors without inventing source locations', () => {
  assert.deepEqual(parseDiagnostics(JSON.stringify({
    schema_version: 1, severity: 'error', code: null,
    message: 'missing file', primary: null, help: null
  })), []);
});

test('falls back to legacy text when compiler does not emit JSON', () => {
  const legacy = 'warning[W0001]: legacy warning\\n --> file.srp:3:9\\n';
  const [result] = parseDiagnostics(legacy);
  assert.equal(result.filename, 'file.srp');
  assert.equal(result.line, 3);
  assert.equal(result.column, 9);
});

test('rejects mismatched diagnostic JSON schemas', () => {
  assert.deepEqual(parseDiagnostics(JSON.stringify({
    schema_version: 2, severity: 'error', message: 'future diagnostic',
    primary: { path: 'x', start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
  })), []);
});
