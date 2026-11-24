import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanScarpStructure } from '../src/editorStructure';
import {
  scarpSourceMetrics, summarizeScarpSourceMetrics
} from '../src/editorStructuralMetrics';

test('empty source metrics count one physical line without code', () => {
  const metric = scarpSourceMetrics('');
  assert.ok(metric);
  assert.equal(metric.sourceBytes, 0);
  assert.equal(metric.sourceCodeUnits, 0);
  assert.equal(metric.physicalLines, 1);
  assert.equal(metric.nonemptyLines, 0);
  assert.equal(metric.whitespaceOnlyLines, 1);
  assert.equal(metric.functions, 0);
  assert.equal(metric.imports, 0);
});
test('real function declarations and blocks have lexical depth metadata', () => {
  const text = [
    'pure funcra add(a: integer, b: integer) -> integer {',
    '  return a + b;',
    '}',
    'print(add(1, 2));'
  ].join('\n');
  const metric = scarpSourceMetrics(text);
  assert.ok(metric);
  assert.equal(metric.functions, 1);
  assert.equal(metric.physicalLines, 4);
  assert.ok(metric.delimiterPairs >= 4);
  assert.ok(metric.maximumDelimiterDepth >= 2);
});
test('comments and quoted fake declarations never introduce extra functions', () => {
  const text = [
    '// funcra fake() {}',
    'print("record Fake {}"); // trailing',
    '// a second comment',
    'bind answer = 1;'
  ].join('\n');
  const metric = scarpSourceMetrics(text);
  assert.ok(metric);
  assert.equal(metric.functions, 0);
  assert.equal(metric.records, 0);
  assert.equal(metric.topLevelBindings, 1);
  assert.equal(metric.commentOnlyLines, 2);
  assert.equal(metric.trailingComments, 1);
});
test('published import declarations are counted at top level only', () => {
  const source = [
    'import "math.srp" as math;',
    'funcra f() { import "fake.srp" as fake; }',
    '// import "not.srp" as no;'
  ].join('\n');
  const metrics = scarpSourceMetrics(source);
  assert.ok(metrics);
  assert.equal(metrics.imports, 1);
  assert.equal(metrics.importedAliases, 1);
});
test('records, variants, mutable variables and bindings receive separate counts', () => {
  const source = [
    'record Task { title: string, }',
    'variant ResultTag { Passed, Failed, }',
    'var attempts = 0;',
    'bind ready = true;',
    'funcra check() -> boolean { return ready; }'
  ].join('\n');
  const metrics = scarpSourceMetrics(source);
  assert.ok(metrics);
  assert.equal(metrics.records, 1);
  assert.equal(metrics.variants, 1);
  assert.equal(metrics.topLevelVariables, 1);
  assert.equal(metrics.topLevelBindings, 1);
  assert.equal(metrics.functions, 1);
});
test('UTF-8 byte counts differ from UTF-16 source offsets with emoji', () => {
  const source = 'print("नमस्ते 😀");';
  const metrics = scarpSourceMetrics(source);
  assert.ok(metrics);
  assert.equal(metrics.sourceCodeUnits, source.length);
  assert.equal(metrics.sourceBytes, Buffer.byteLength(source, 'utf8'));
  assert.ok(metrics.sourceBytes > metrics.sourceCodeUnits);
});
test('CRLF is one physical newline and trailing empty line is preserved', () => {
  const metrics = scarpSourceMetrics('bind x = 1;\r\n\r\nprint(x);\r\n');
  assert.ok(metrics);
  assert.equal(metrics.physicalLines, 4);
  assert.equal(metrics.nonemptyLines, 2);
  assert.equal(metrics.whitespaceOnlyLines, 2);
});
test('exact decimal literals and ordinary floats are both numeric tokens', () => {
  const m = scarpSourceMetrics('bind exact = 0.1d; bind normal = 0.1;');
  assert.equal(m?.numericLiterals, 2);
});
test('a mismatched structure snapshot never reports made-up metrics', () => {
  const first = 'print(1);';
  const snapshot = scanScarpStructure(first);
  assert.ok(snapshot);
  assert.equal(scarpSourceMetrics('print(12);', snapshot), undefined);
});
test('oversized source and excessive nesting fail closed', () => {
  assert.equal(scarpSourceMetrics(' '.repeat(2_000_001)), undefined);
  assert.equal(scarpSourceMetrics('('.repeat(300)), undefined);
});
test('syntactic regions are counted independently of compiler execution', () => {
  const source = '// #region one\nprint(1);\n// #endregion';
  const metrics = scarpSourceMetrics(source);
  assert.equal(metrics?.regions, 1);
});
test('summaries aggregate independent Scarp modules without shared mutable state', () => {
  const files = [
    { file: 'a.srp', source: 'funcra f() -> unit { return; }' },
    { file: 'b.srp', source: 'bind count = 1;' }
  ];
  const summary = summarizeScarpSourceMetrics(files);
  assert.equal(summary.sources, 2);
  assert.equal(summary.functions, 1);
  assert.equal(summary.bindings, 1);
  assert.equal(summary.imports, 0);
});
test('a bad file does not prevent reporting another valid module', () => {
  const summary = summarizeScarpSourceMetrics([
    { file: 'bad.srp', source: '('.repeat(300) },
    { file: 'valid.srp', source: 'print(1);' }
  ]);
  assert.equal(summary.sources, 1);
  assert.ok(summary.bytes > 0);
});
test('metrics for the same file are deterministic across repeated reads', () => {
  const text = 'funcra f() {\n  print(1);\n}\n';
  assert.deepEqual(scarpSourceMetrics(text), scarpSourceMetrics(text));
});
test('many comments do not create quadratic scanning overhead', () => {
  const source = Array.from({ length: 1000 }, (_, i) =>
    '// comment ' + i).join('\n');
  const metrics = scarpSourceMetrics(source);
  assert.ok(metrics);
  assert.equal(metrics.commentOnlyLines, 1000);
  assert.equal(metrics.trailingComments, 0);
});
test('empty summary is a documented zero state', () => {
  assert.deepEqual(summarizeScarpSourceMetrics([]), {
    sources: 0, bytes: 0, lines: 0, functions: 0,
    bindings: 0, comments: 0, imports: 0, maximumDepth: 0
  });
});
