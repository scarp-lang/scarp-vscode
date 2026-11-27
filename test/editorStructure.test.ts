import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scanScarpStructure, scarpLineAt, scarpPositionAt, scarpStructureEqual
} from '../src/editorStructure';

function scan(text: string) {
  const parsed = scanScarpStructure(text);
  assert.ok(parsed, 'Expected bounded source to scan');
  return parsed;
}
test('empty files have no fake syntax and one valid line', () => {
  const x = scan('');
  assert.deepEqual(x.lines, [0]);
  assert.deepEqual(x.pairs, []);
  assert.deepEqual(x.imports, []);
  assert.deepEqual(x.regions, []);
  assert.deepEqual(x.tokens, []);
  assert.deepEqual(scarpPositionAt(x, 0), { line: 0, character: 0 });
});
test('bracket pairs preserve offsets, depth and UTF-16 enclosure', () => {
  const text = 'funcra test() {\n  print([array: (1, 2)]);\n}';
  const x = scan(text);
  assert.equal(x.pairs.length, 5);
  const braces = x.pairs.find(p => p.kind === '{');
  assert.ok(braces);
  assert.equal(text.slice(braces.span.start, braces.span.end),
    '{\n  print([array: (1, 2)]);\n}');
  assert.equal(braces.depth, 0);
  assert.ok(x.pairs.some(p => p.kind === '[' && p.depth === 2));
});
test('comments and quoted punctuation never form structural brackets', () => {
  const text = 'print("({[]})"); // { [ (\n// } ] )\nvar x = [array: 1, 2];';
  const x = scan(text);
  assert.equal(x.comments.length, 2);
  assert.equal(x.strings.length, 1);
  assert.equal(x.pairs.filter(p => p.kind === '[').length, 1);
  assert.equal(x.pairs.filter(p => p.kind === '{').length, 0);
});
test('unterminated strings recover on a physical newline', () => {
  const x = scan('print("unfinished\nvar x = (1, 2);\nprint("done");');
  assert.ok(x.pairs.some(p => p.kind === '('));
  assert.equal(x.strings.length, 2);
});
test('CRLF, lone CR and surrogate pairs use precise UTF-16 offsets', () => {
  const source = 'a\r\nb\rc\n😀';
  const x = scan(source);
  assert.deepEqual(x.lines, [0, 3, 5, 7]);
  assert.deepEqual(scarpPositionAt(x, 7), { line: 3, character: 0 });
  assert.deepEqual(scarpPositionAt(x, source.length),
    { line: 3, character: 2 });
  assert.equal(scarpLineAt(x.lines, -1), -1);
  assert.equal(scarpPositionAt(x, source.length + 1), undefined);
});
test('nested regions are matched and unmatched regions are ignored', () => {
  const source = '// #region Outer\n// #region Inner\nprint(1);\n// #endregion\n// #endregion';
  const x = scan(source);
  assert.deepEqual(x.regions.map(r => r.label), ['Outer', 'Inner']);
  assert.equal(x.regions[0].span.end, source.length);
  assert.deepEqual(scan('// #region unmatched').regions, []);
  assert.deepEqual(scan('print("// #region fake");').regions, []);
});
test('mismatched delimiters fail closed without losing valid later siblings', () => {
  const source = 'funcra a() { print(1]; }\nfuncra b() { print(2); }';
  const x = scan(source);
  assert.ok(x.pairs.some(p =>
    source.slice(p.span.start, p.span.end) === '{ print(2); }'));
  assert.ok(!x.pairs.some(p =>
    source.slice(p.span.start, p.span.end) === '{ print(1]; }'));
});
test('bounds reject malicious size, stack and token floods', () => {
  assert.equal(scanScarpStructure('('.repeat(257)), undefined);
  assert.equal(scanScarpStructure(' '.repeat(200), { maxLength: 100 }), undefined);
  assert.equal(scanScarpStructure('a b c', { maxTokens: 2 }), undefined);
  assert.equal(scanScarpStructure('a', { maxDepth: 0 }), undefined);
  assert.equal(scanScarpStructure('a', { maxDepth: NaN }), undefined);
});
test('real imports are top-level declarations, not strings or comments', () => {
  const source = [
    'import "lib/math.srp" as math;',
    'funcra f() { import "nested.srp" as bad; }',
    '// import "comment.srp" as fake;',
    'print("import \\"string.srp\\" as fake;");',
    'import "lib/text.srp" as text;'
  ].join('\n');
  const x = scan(source);
  assert.deepEqual(x.imports.map(item => [item.path, item.alias]), [
    ['lib/math.srp', 'math'], ['lib/text.srp', 'text']
  ]);
  assert.equal(source.slice(x.imports[0].pathSpan.start,
    x.imports[0].pathSpan.end), 'lib/math.srp');
});
test('malformed and escaped import constructs are never linked', () => {
  const lines = [
    'import "x.srp" as ;', 'import "x.srp" alias;',
    'import "x.srp" as name', 'import "x\\u{2f}y.srp" as x;',
    'funcra f() { import "x.srp" as inside; }',
    '// import "x.srp" as fake;'
  ];
  for (const source of lines) {
    assert.deepEqual(scan(source).imports, [], source);
  }
});
test('snapshot equality is structural and deterministic', () => {
  const a = scan('print((1, 2));');
  assert.ok(scarpStructureEqual(a, scan('print((1, 2));')));
  assert.ok(scarpStructureEqual(a, scan('print((1, 3));')));
  assert.ok(!scarpStructureEqual(a, scan('print(1);')));
});
test('large valid source remains bounded and stable', () => {
  for (const count of [1, 2, 8, 64, 256]) {
    const source = Array.from({ length: count }, (_, i) =>
      'funcra f_' + i + '() -> unit { print(1); }').join('\n');
    const x = scan(source);
    assert.equal(x.pairs.filter(p => p.kind === '{').length, count);
  }
});

test('alpha.3 literals shield fake imports, regions and brackets and preserve CRLF offsets', () => {
  const source = [
    'bind raw = r"ends with a backslash\\"; var after = (1);',
    'bind text = """',
    '// #region fake',
    'import "fake.srp" as fake; { [ (',
    '😀',
    '""";',
    'import "real.srp" as real;'
  ].join('\r\n');
  const x = scan(source);
  assert.equal(x.strings.length, 3);
  assert.deepEqual(x.comments, []);
  assert.deepEqual(x.regions, []);
  assert.deepEqual(x.imports.map(item => item.path), ['real.srp']);
  assert.equal(x.pairs.length, 1);
  assert.deepEqual(x.lines, [0, ...Array.from(source.matchAll(/\r\n/g), m => m.index! + 2)]);
});
test('unfinished triple strings suppress structure to EOF; unfinished raw strings recover', () => {
  const x = scan('bind x = """\nimport "fake.srp" as fake;\n{ }');
  assert.equal(x.strings[0].end, x.length);
  assert.deepEqual(x.imports, []);
  assert.deepEqual(x.pairs, []);
  assert.equal(scan('bind x = r"unfinished\nvar y = (1);').pairs.length, 1);
  assert.deepEqual(scan('import """fake.srp""" as fake;').imports, []);
});
