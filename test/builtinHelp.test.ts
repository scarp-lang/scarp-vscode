import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpBuiltinAt } from '../src/builtinHelp';

const versions: Record<string, string> = {
  topk: 'v0.0.6-alpha.3',
  topk_values: 'v0.0.6-alpha.3',
  softmax_temp: 'v0.0.6-alpha.3',
  logsoftmax_temp: 'v0.0.6-alpha.3',
  sample_area: 'v0.0.6-alpha.4',
  sample_slopes: 'v0.0.6-alpha.4',
  sample_cumulative_area: 'v0.0.6-alpha.4',
  cosine_similarity: 'v0.0.6-alpha.4',
  top_p: 'v0.0.6-alpha.5',
  top_p_values: 'v0.0.6-alpha.5',
  pearson_correlation: 'v0.0.6-alpha.5',
  read_line: 'v0.0.6-alpha.6',
  integer_to_text: 'v0.0.6-alpha.6',
  float_to_text: 'v0.0.6-alpha.6',
  text_to_integer: 'v0.0.6-alpha.6',
  text_to_float: 'v0.0.6-alpha.6',
  text_trim: 'v0.0.6-alpha.6',
  text_replace: 'v0.0.6-alpha.6',
  bigint: 'v0.0.6-alpha.9',
  bigint_from_integer: 'v0.0.6-alpha.9',
  bigint_to_integer: 'v0.0.6-alpha.9',
  bigint_abs: 'v0.0.6-alpha.9',
  read_line_or: 'v0.0.6-alpha.10',
  try_read_line: 'v0.0.6-alpha.10',
  ask: 'v0.0.6-alpha.10',
  ask_or: 'v0.0.6-alpha.10',
  input: 'v0.0.6-alpha.10',
  input_integer: 'v0.0.6-alpha.10',
  input_float: 'v0.0.6-alpha.10',
  input_bigint: 'v0.0.6-alpha.10',
  flush_stdout: 'v0.0.6-alpha.10',
  flush_stderr: 'v0.0.6-alpha.10',
  bigint_pow: 'v0.0.6-alpha.10',
  bigint_gcd: 'v0.0.6-alpha.10',
  bigint_lcm: 'v0.0.6-alpha.10',
  bigint_sqrt: 'v0.0.6-alpha.10',
  bigint_bit_length: 'v0.0.6-alpha.10',
  bigint_to_text: 'v0.0.6-alpha.10',
  bigint_from_radix: 'v0.0.6-alpha.10',
  bigint_to_radix: 'v0.0.6-alpha.10',
  bigint_and: 'v0.0.6-alpha.10',
  bigint_or: 'v0.0.6-alpha.10',
  bigint_xor: 'v0.0.6-alpha.10',
  bigint_not: 'v0.0.6-alpha.10',
  bigint_shl: 'v0.0.6-alpha.10',
  bigint_shr: 'v0.0.6-alpha.10',
  bigint_pow_mod: 'v0.0.6-alpha.10',
  bigint_divmod: 'v0.0.6-alpha.10'
};

test('every shipped numerical built-in has a bounded and versioned hover signature', () => {
  for (const [name, introduced] of Object.entries(versions)) {
    const source = 'bind result = ' + name + '(scores, 1);';
    const start = source.indexOf(name);
    const call = scarpBuiltinAt(source, start + Math.floor(name.length / 2));
    assert.ok(call, name);
    assert.equal(call.start, start);
    assert.equal(call.end, start + name.length);
    assert.equal(call.help.name, name);
    assert.equal(call.help.introduced, introduced);
    assert.ok(call.help.signature.startsWith(name + '('), name);
    assert.ok(call.help.summary.length > 15);
    assert.ok(call.help.constraints.length > 15);
  }
});

test('hover only applies to real call names, not longer identifiers or other code', () => {
  for (const name of Object.keys(versions)) {
    for (const line of [
      'bind x = ' + name + '_custom(scores, 1);',
      'bind ' + name + ' = 12;',
      '// ' + name + '(scores, 1)',
      'print("' + name + '(scores, 1)");',
      'pure funcra ' + name + '(scores: vector) -> vector {',
      'module.' + name + '(scores, 1);',
      'module . ' + name + '(scores, 1);',
      name + ' + 1;'
    ]) {
      const cursor = line.indexOf(name) + Math.floor(name.length / 2);
      assert.equal(scarpBuiltinAt(line, cursor), undefined, line);
    }
  }
});

test('escaped string delimiters, comments and Unicode do not cause false hover', () => {
  const line = 'print("quoted ' + String.fromCharCode(92) +
    '" top_p(0.5)"); // pearson_correlation(x,y)';
  assert.equal(scarpBuiltinAt(line, line.indexOf('top_p') + 2), undefined);
  assert.equal(scarpBuiltinAt(line, line.indexOf('pearson_correlation') + 2), undefined);

  const source = 'print("🙂"); bind result = top_p([1.0], 1.0);';
  const offset = source.indexOf('top_p');
  const found = scarpBuiltinAt(source, offset + 2);
  assert.ok(found);
  assert.equal(found.start, offset, 'VS Code uses UTF-16 columns, including emoji');
  assert.equal(scarpBuiltinAt(source, offset + 'top_p'.length), undefined);
});

test('calls with whitespace and an opening parenthesis on the next line are recognized', () => {
  const name = 'pearson_correlation';
  assert.equal(scarpBuiltinAt(name + '  ', 3)?.help.name, undefined);
  assert.equal(scarpBuiltinAt(name + '  ', 3, ' (x, y)')?.help.name, name);
  assert.equal(scarpBuiltinAt(name, 3, '// not a call (')?.help.name, undefined);
  assert.equal(scarpBuiltinAt(name + ' // comment', 3, '(x,y)')?.help.name, undefined);
});

test('inherited object property names are never mistaken for published builtins', () => {
  for (const source of ['constructor(', '__proto__(', 'toString(']) {
    assert.equal(scarpBuiltinAt(source, 1), undefined, source);
  }
});

test('large or invalid lexical inputs are refused without scanning an unbounded line', () => {
  const source = 'top_p([0.5,0.5], 0.9)';
  for (const position of [-1, source.length, 0.5, NaN, Infinity]) {
    assert.equal(scarpBuiltinAt(source, position), undefined);
  }
  assert.equal(scarpBuiltinAt('a'.repeat(16385) + source, 16386), undefined);
  assert.equal(scarpBuiltinAt(source, 2, ' '.repeat(16385)), undefined);
  assert.equal(scarpBuiltinAt('top_p value', 2), undefined,
    'A name without an actual call must not advertise builtin help');
});
