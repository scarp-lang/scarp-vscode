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

test('outlines published record and variant declarations with exact names and source ranges', () => {
  const source = [
    '// record Pretend { fake: string }',
    'pub record Task { title: string, done: boolean }',
    'variant Submission {',
    '  Accepted(record Task),',
    '  Rejected(string),',
    '}',
    'pure funcra submit(title: string) -> variant Submission {',
    '  return new Submission::Accepted(new Task { title: title, done: false });',
    '}',
    'bind entry: record Task = new Task { title: "Ready", done: true };',
    'print("variant Wrong { No }");'
  ].join('\n');
  const symbols = scanScarpSymbols(source);
  assert.deepEqual(symbols.map(item => [item.kind, item.name]), [
    ['record', 'Task'], ['variant', 'Submission'],
    ['function', 'submit'], ['constant', 'entry']
  ]);
  const record = symbols[0];
  assert.equal(record.detail, 'public record type');
  assert.equal(source.slice(record.start, record.end),
    'pub record Task { title: string, done: boolean }');
  assert.equal(source.slice(record.selectionStart, record.selectionEnd), 'Task');
  const variant = symbols[1];
  assert.equal(variant.detail, 'variant type');
  assert.equal(source.slice(variant.start, variant.end),
    ['variant Submission {', '  Accepted(record Task),',
      '  Rejected(string),', '}'].join('\n'));
  assert.equal(source.slice(variant.selectionStart, variant.selectionEnd), 'Submission');
  assert.equal(source.slice(symbols[3].selectionStart, symbols[3].selectionEnd), 'entry');
});

test('nominal type outline ignores strings, incomplete declarations and nested declarations', () => {
  const source = [
    'print("record Fake { field: string }");',
    'record Complete { text: string }',
    'funcra wrapper() -> unit {',
    '  record Nested { text: string }',
    '  return;',
    '}',
    'variant Broken {',
    '  Some(string)'
  ].join('\n');
  const result = scanScarpSymbols(source);
  assert.deepEqual(result.map(x => x.name), ['Complete', 'wrapper']);
  assert.deepEqual(scanScarpSymbols('record Missing;'), []);
  assert.deepEqual(scanScarpSymbols('variant Missing {'), []);
  assert.deepEqual(scanScarpSymbols('pub pure record NotAllowed {}'), []);
});

test('record and variant spans are UTF-16 safe across emoji and CRLF source', () => {
  const source = 'print("👩‍💻");\r\npub variant Status { Good, Bad(string) }\r\n';
  const [symbol] = scanScarpSymbols(source);
  assert.equal(symbol.kind, 'variant');
  assert.equal(symbol.name, 'Status');
  assert.equal(symbol.start, source.indexOf('pub variant'));
  assert.equal(symbol.selectionStart, source.indexOf('Status'));
  assert.equal(symbol.end, source.indexOf('}\r\n') + 1);
});

test('outlines published tuple, array, and record destructuring names at file scope', () => {
  const source = [
    'bind (result, state) = make_pair(21);',
    'var [first, second, third] = [array: 3, 5, 7];',
    'bind (_, answer) = (true, 42);',
    'record Point { x: integer, y: integer }',
    'bind {x: horizontal, y: vertical} = new Point { x: 3, y: 4 };',
    'bind ([(quantity, unit_price), (_, spare_price)], currency) =',
    '  ([array: (2, 15), (1, 7)], "INR");',
    'bind after = answer;'
  ].join('\n');
  const results = scanScarpSymbols(source);
  assert.deepEqual(results.map(result => [result.kind, result.name]), [
    ['constant', 'result'], ['constant', 'state'],
    ['variable', 'first'], ['variable', 'second'], ['variable', 'third'],
    ['constant', 'answer'], ['record', 'Point'],
    ['constant', 'horizontal'], ['constant', 'vertical'],
    ['constant', 'quantity'], ['constant', 'unit_price'],
    ['constant', 'spare_price'], ['constant', 'currency'],
    ['constant', 'after']
  ]);
  for (const symbol of results) {
    assert.equal(source.slice(symbol.selectionStart, symbol.selectionEnd),
      symbol.name, 'Every Outline selection must identify only its bound name');
  }
  const root = results[0];
  assert.equal(root.start, source.indexOf('bind (result'));
  assert.equal(root.end, source.indexOf('\nvar ['));
  assert.equal(root.end, results[1].end, 'Names in a pattern share declaration range');
  assert.equal(results[2].detail, 'destructured mutable variable');
  assert.equal(results[7].detail, 'destructured binding');
});

test('destructuring skips discard and field labels, retaining singleton comma syntax', () => {
  const source = [
    'bind (one,) = (1,);',
    'bind {x: _, y: renamed} = point;',
    'bind (_, [inside, _]) = pair;',
    'funcra scope() -> unit {',
    '  bind (hidden, also_hidden) = (1, 2);',
    '}'
  ].join('\n');
  assert.deepEqual(scanScarpSymbols(source).map(s => s.name),
    ['one', 'renamed', 'inside', 'scope']);
});

test('incomplete, duplicate and malformed destructuring never fabricates symbols', () => {
  const malformed = [
    'bind (x) = (1,);', // singleton tuple requires a trailing comma
    'bind (x, x) = (1, 2);',
    'bind (x,, y) = (1, 2);',
    'bind (x y) = (1, 2);',
    'bind [x, y) = [array: 1, 2];',
    'bind {x a} = point;',
    'bind {x: a, y: a} = point;',
    'bind [] = [array: 1];',
    'bind (x, y) = (1, 2)', // missing statement terminator
    'bind (x, [y, z] = input;'
  ];
  for (const candidate of malformed) {
    assert.deepEqual(scanScarpSymbols(candidate), [], candidate);
  }
  assert.deepEqual(scanScarpSymbols([
    'bind (ok, value) = (1, 2);',
    'bind (duplicate, duplicate) = (1, 2);',
    'bind tail = value;',
    'print("bind (fake, fake2) = (1, 2);");',
    '// bind (commented, names) = (3, 4);'
  ].join('\n')).map(x => x.name), ['ok', 'value', 'tail']);
});

test('alpha.3 generic functions retain signature and selection ranges in Outline', () => {
  const source = [
    'bind text = """', 'funcra fake<T>(x: T) -> T { return x; }', '""";',
    'pure funcra pair<A, B>(first: A, second: B) -> tuple<A, B> {',
    '  return (first, second);', '}',
    'pure funcra square<T: Numeric>(value: T) -> T { return value * value; }',
    'bind answer = square::<integer>(6);'
  ].join('\r\n');
  const result = scanScarpSymbols(source);
  assert.deepEqual(result.map(s => s.name), ['text', 'pair', 'square', 'answer']);
  assert.match(result[1].detail, /<A, B>\(first: A, second: B\)/);
  assert.match(result[2].detail, /<T: Numeric>/);
  for (const s of result) assert.equal(source.slice(s.selectionStart, s.selectionEnd), s.name);
  for (const header of ['<T, T>', '<T: Unknown>', '<>', '<T']) {
    assert.deepEqual(scanScarpSymbols('funcra broken' + header + '(x: T) -> T { return x; }'), []);
  }
});
