import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanScarpSymbols } from '../src/documentSymbols';

test('extracts actual top-level Scarp functions, including public pure contracts', () => {
  const source = [
    'funcra add(a: integer, b: integer) -> integer {',
    '  return a + b;',
    '}',
    '',
    'pub pure funcra adjust(value: integer = answer) -> integer',
    'needs ready;',
    'ensures result >= answer;',
    '{',
    '  bind local = value;',
    '  if true { var nested = local; }',
    '  return local;',
    '}'
  ].join('\n');
  const symbols = scanScarpSymbols(source);
  assert.deepEqual(symbols.map(s => [s.kind, s.name]), [
    ['function', 'add'], ['function', 'adjust']
  ]);
  assert.equal(symbols[0].selectionStart, source.indexOf('add('));
  assert.equal(symbols[0].selectionEnd, source.indexOf('add(') + 3);
  assert.equal(symbols[0].end, source.indexOf('}\n\n') + 1);
  assert.equal(symbols[1].start, source.indexOf('pub pure'));
  assert.equal(symbols[1].end, source.length);
  assert.match(symbols[1].detail, /^public pure \(value: integer/);
  assert.ok(symbols[1].detail.includes('ensures result >= answer;'));
});

test('shows imports, file-scope bindings, mutable variables and public bindings', () => {
  const source = [
    'import "modules/linear.srp" as linear;',
    'bind width = 6;',
    'pub bind area: integer = width * 2;',
    'var count = add(1, sum([2, 3]));',
    'while count > 0 {',
    '  bind hidden = count;',
    '  count -= 1;',
    '}',
    'bind tail = count;'
  ].join('\n');
  const symbols = scanScarpSymbols(source);
  assert.deepEqual(symbols.map(s => [s.kind, s.name]), [
    ['import', 'linear'], ['constant', 'width'],
    ['constant', 'area'], ['variable', 'count'], ['constant', 'tail']
  ]);
  assert.equal(symbols[0].detail, 'from "modules/linear.srp"');
  assert.equal(source.slice(symbols[0].selectionStart, symbols[0].selectionEnd), 'linear');
  assert.equal(symbols[2].detail, 'public binding');
  assert.equal(symbols[3].end, source.indexOf('while') - 1);
});

test('ignores comments, quoted pseudo-declarations and function call arguments', () => {
  const source = [
    '// pub funcra fake() -> integer { return 1; }',
    'print("bind ignored = 7;");',
    'write("import \\"not-real.srp\\" as fake;");',
    'print(funcra);',
    'bind real = 1;',
    'funcra actual() -> unit {',
    '  print("funcra pretend() { }");',
    '  // var ghost = 42;',
    '  return;',
    '}'
  ].join('\n');
  assert.deepEqual(scanScarpSymbols(source).map(s => s.name), ['real', 'actual']);
});

test('does not confuse braces inside strings, comments, or loops with function bodies', () => {
  const source = [
    'funcra first() -> unit {',
    ' print("}"); // }',
    ' if true { print("nested"); }',
    ' return;',
    '}',
    'funcra second() -> unit { return; }'
  ].join('\n');
  const [first, second] = scanScarpSymbols(source);
  assert.ok(first && second);
  assert.equal(first.end, source.indexOf('\nfuncra second'));
  assert.equal(second.start, source.indexOf('funcra second'));
});

test('recovers incomplete declarations without throwing or emitting fabricated symbols', () => {
  assert.deepEqual(scanScarpSymbols('bind no_initializer;'), []);
  assert.deepEqual(scanScarpSymbols('import "x" as ;'), []);
  assert.deepEqual(scanScarpSymbols('funcra missing('), []);
  const pending = scanScarpSymbols('funcra pending(value: integer) -> unit');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, 'pending');
  assert.equal(pending[0].end, 'funcra pending(value: integer)'.length);
});

test('keeps UTF-16 offsets correct around non-ASCII characters and CRLF', () => {
  const source = 'print("😀");\r\nbind café = 1;\r\nfuncra next() -> unit { return; }';
  const result = scanScarpSymbols(source);
  assert.deepEqual(result.map(s => s.name), ['next']);
  assert.equal(result[0].selectionStart, source.indexOf('next('));
});

test('does not attempt to outline oversized or malformed code indefinitely', () => {
  assert.deepEqual(scanScarpSymbols(' '.repeat(2_000_001)), []);
  const source = 'funcra broken() -> unit { print("unterminated\nbind still_nested = 1;';
  const result = scanScarpSymbols(source);
  assert.deepEqual(result.map(s => s.name), ['broken']);
});
