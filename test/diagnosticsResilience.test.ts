import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDiagnostics, utf16OffsetForScalarColumn } from '../src/diagnostics';

function jsonDiagnostic(
  name: string, row: number, column: number,
  severity: 'error' | 'warning' = 'error'
): string {
  return JSON.stringify({
    schema_version: 1, severity, code: severity === 'error' ? 'E0004' : 'W0001',
    message: 'diagnostic ' + row, span_encoding: 'utf-8-bytes',
    column_encoding: 'unicode-scalar', position_base: 1,
    primary: {
      path: name, span: [0, 1],
      start: { line: row, column }, end: { line: row, column: column + 1 }
    },
    related: [], help: 'Review the value'
  });
}

test('recognizes more than one schema-v1 diagnostic in newline-delimited output', () => {
  const parsed = parseDiagnostics([
    jsonDiagnostic('src/main.srp', 2, 3),
    jsonDiagnostic('src/lib.srp', 8, 12, 'warning')
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(d => [d.filename, d.line, d.column, d.severity]), [
    ['src/main.srp', 2, 3, 'error'], ['src/lib.srp', 8, 12, 'warning']
  ]);
});

test('recognizes JSON envelopes after bounded progress text', () => {
  const parsed = parseDiagnostics([
    'Scarp verification started', jsonDiagnostic('lib/math.srp', 13, 1),
    'Finished with errors'
  ].join('\r\n'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].filename, 'lib/math.srp');
});

test('keeps legacy diagnostics and structured ones in the original order', () => {
  const parsed = parseDiagnostics([
    'warning[W0001]: old source warning', ' --> old.srp:3:6',
    jsonDiagnostic('new.srp', 5, 4),
    'error[E0033]: another legacy error', ' --> after.srp:7:11'
  ].join('\n'));
  assert.deepEqual(parsed.map(d => d.filename), ['old.srp', 'new.srp', 'after.srp']);
});

test('never reuses a structured envelope location for an older legacy error', () => {
  const parsed = parseDiagnostics([
    'error[E0004]: incomplete old error',
    jsonDiagnostic('not-the-old-error.srp', 4, 5),
    ' --> misleading.srp:999:42'
  ].join('\n'));
  assert.deepEqual(parsed.map(d => d.filename), ['not-the-old-error.srp']);
});

test('a schema-v1 diagnostic without a source location is not converted to a fake Problem', () => {
  const locationless = JSON.stringify({
    schema_version: 1, severity: 'error', code: null,
    message: 'missing entrypoint', primary: null, help: null
  });
  const parsed = parseDiagnostics([
    locationless, jsonDiagnostic('valid.srp', 3, 2)
  ].join('\n'));
  assert.deepEqual(parsed.map(d => d.filename), ['valid.srp']);
});

test('unknown schemas, arbitrary JSON and malformed envelopes do not become Problems', () => {
  const unrelated = [
    '{"schema_version":2,"severity":"error","message":"future"}',
    '{"schema_version":1,"severity":"error","message":123}',
    '{"location":"main.srp","message":"arbitrary JSON"}',
    '{broken json}', '[]', 'null'
  ];
  assert.deepEqual(parseDiagnostics(unrelated.join('\n')), []);
});

test('correctly retains valid JSON strings containing escaped newlines and brackets', () => {
  const parsed = parseDiagnostics(jsonDiagnostic('lib/{vector}.srp', 9, 1)
    .replace('diagnostic 9', 'diagnostic \\n { nested } \\t'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].filename, 'lib/{vector}.srp');
  assert.match(parsed[0].message, /nested/);
});

test('legacy source coordinate parser still accepts Windows drive letters and spaces', () => {
  const parsed = parseDiagnostics('error[E0004]: expected token\n' +
    ' --> C:\\users\\my code\\main.srp:21:42\n');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].filename, 'C:\\users\\my code\\main.srp');
  assert.equal(parsed[0].line, 21);
});

test('rejects invalid 0-based source coordinates and reversed JSON ranges safely', () => {
  const invalid = JSON.parse(jsonDiagnostic('broken.srp', 2, 1));
  invalid.primary.start.column = 0;
  assert.deepEqual(parseDiagnostics(JSON.stringify(invalid)), []);
  const reversed = JSON.parse(jsonDiagnostic('reversed.srp', 9, 10));
  reversed.primary.end = { line: 8, column: 5 };
  const parsed = parseDiagnostics(JSON.stringify(reversed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].endLine, undefined);
  assert.equal(parsed[0].endColumn, undefined);
});

test('bounded parser refuses inputs exceeding the Extension Host output limit', () => {
  const input = jsonDiagnostic('first.srp', 1, 1) + '\n' + ' '.repeat(1024 * 1024);
  assert.deepEqual(parseDiagnostics(input), []);
});

test('bounded diagnostic list prevents oversized JSON Lines floods', () => {
  const input = Array.from({ length: 700 }, (_, i) => jsonDiagnostic('src/file.srp', i + 1, 1))
    .join('\n');
  const parsed = parseDiagnostics(input);
  assert.equal(parsed.length, 512);
  assert.equal(parsed[511].line, 512);
});

test('Unicode scalar columns convert without allocating codepoint arrays', () => {
  assert.equal(utf16OffsetForScalarColumn('', 100), 0);
  assert.equal(utf16OffsetForScalarColumn('😀a🚀b', 1), 0);
  assert.equal(utf16OffsetForScalarColumn('😀a🚀b', 2), 2);
  assert.equal(utf16OffsetForScalarColumn('😀a🚀b', 3), 3);
  assert.equal(utf16OffsetForScalarColumn('😀a🚀b', 4), 5);
  assert.equal(utf16OffsetForScalarColumn('😀a🚀b', 5), 6);
  assert.equal(utf16OffsetForScalarColumn('😀a🚀b', 9999), 6);
  assert.equal(utf16OffsetForScalarColumn('abc', NaN), 0);
  assert.equal(utf16OffsetForScalarColumn('abc', Infinity), 0);
  assert.equal(utf16OffsetForScalarColumn('abc', 2.5), 0);
});

test('Unicode scanner agrees with the Unicode-scalar specification for varied strings', () => {
  const parts = ['a', '₹', 'क', '🚀', '\u0301', '\ud800', '\udc00', '\ud83d\ude00'];
  for (let i = 0; i < 250; i++) {
    const source = Array.from({ length: i % 19 }, (_, j) => parts[(i * 11 + j * 7) % parts.length]).join('');
    for (let column = 0; column < 25; column++) {
      const expected = column <= 1 ? 0 : Array.from(source).slice(0, column - 1).join('').length;
      assert.equal(utf16OffsetForScalarColumn(source, column), expected,
        `case ${i} column ${column}`);
    }
  }
});

test('preserves compiler related source locations for declaration and import notes', () => {
  const diagnostic = JSON.parse(jsonDiagnostic('main.srp', 3, 5));
  diagnostic.related = [
    { message: 'defined in the imported module', location: {
      path: 'src/library.srp', start: { line: 10, column: 2 },
      end: { line: 10, column: 8 }, span: [20, 28]
    } },
    { message: 'binding declared here', location: {
      path: 'main.srp', start: { line: 1, column: 1 },
      end: { line: 1, column: 8 }, span: [0, 7]
    } }
  ];
  const parsed = parseDiagnostics(JSON.stringify(diagnostic));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].related, [
    { message: 'defined in the imported module', filename: 'src/library.srp',
      line: 10, column: 2, endLine: 10, endColumn: 8 },
    { message: 'binding declared here', filename: 'main.srp',
      line: 1, column: 1, endLine: 1, endColumn: 8 }
  ]);
});

test('unreadable, malformed and locationless related locations are filtered', () => {
  const diagnostic = JSON.parse(jsonDiagnostic('main.srp', 1, 1));
  diagnostic.related = [
    { message: 'no location', location: null },
    { message: '', location: { path: 'a.srp', start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
    { message: 'no file', location: { path: '', start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
    { message: 'invalid coordinate', location: { path: 'a.srp', start: { line: 0, column: 1 }, end: { line: 1, column: 2 } } },
    { message: 'valid note', location: { path: 'a.srp', start: { line: 2, column: 1 }, end: { line: 2, column: 4 } } }
  ];
  const parsed = parseDiagnostics(JSON.stringify(diagnostic));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].related, [{
    message: 'valid note', filename: 'a.srp', line: 2, column: 1,
    endLine: 2, endColumn: 4
  }]);
});

test('related information is capped independently of primary diagnostic volume', () => {
  const diagnostic = JSON.parse(jsonDiagnostic('main.srp', 1, 1));
  diagnostic.related = Array.from({ length: 100 }, (_, i) => ({
    message: 'note ' + i,
    location: { path: 'other.srp', start: { line: i + 1, column: 1 },
      end: { line: i + 1, column: 2 } }
  }));
  const parsed = parseDiagnostics(JSON.stringify(diagnostic));
  assert.equal(parsed[0].related?.length, 8);
  assert.equal(parsed[0].related?.[7].message, 'note 7');
});

test('a malformed related array cannot suppress the valid primary diagnostic', () => {
  const diagnostic = JSON.parse(jsonDiagnostic('main.srp', 1, 1));
  diagnostic.related = { message: 'not an array' };
  const parsed = parseDiagnostics(JSON.stringify(diagnostic));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].related, undefined);
});
