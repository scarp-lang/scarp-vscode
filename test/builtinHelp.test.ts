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
  bigint_divmod: 'v0.0.6-alpha.10',
  decimal: 'v0.0.6-alpha.11',
  decimal_from_integer: 'v0.0.6-alpha.11',
  decimal_to_integer: 'v0.0.6-alpha.11',
  decimal_to_text: 'v0.0.6-alpha.11',
  decimal_round: 'v0.0.6-alpha.11',
  decimal_format: 'v0.0.6-alpha.11',
  decimal_div_rounded: 'v0.0.6-alpha.11',
  input_decimal: 'v0.0.6-alpha.11',
  list_len: 'v0.0.6-alpha.12',
  list_push: 'v0.0.6-alpha.12',
  list_set: 'v0.0.6-alpha.12',
  list_remove: 'v0.0.6-alpha.12',
  map_len: 'v0.0.6-alpha.12',
  map_keys: 'v0.0.6-alpha.12',
  map_values: 'v0.0.6-alpha.12',
  map_contains: 'v0.0.6-alpha.12',
  map_get_or: 'v0.0.6-alpha.12',
  map_set: 'v0.0.6-alpha.12',
  map_remove: 'v0.0.6-alpha.12',
  median: 'v0.0.6-alpha.16',
  quantile: 'v0.0.6-alpha.16',
  text_lower: 'v0.0.6-alpha.16',
  text_upper: 'v0.0.6-alpha.16',
  text_reverse: 'v0.0.6-alpha.16',
  text_from_codepoint: 'v0.0.6-alpha.16',
  text_rfind: 'v0.0.6-alpha.16',
  text_count: 'v0.0.6-alpha.16',
  bits_count_ones: 'v0.0.6-alpha.16',
  bits_leading_zeros: 'v0.0.6-alpha.16',
  bits_trailing_zeros: 'v0.0.6-alpha.16',
  bits_reverse: 'v0.0.6-alpha.16',
  bits_swap_bytes: 'v0.0.6-alpha.16',
  bits_rotate_left: 'v0.0.6-alpha.16',
  bits_rotate_right: 'v0.0.6-alpha.16',
  integer_abs: 'v0.0.6-alpha.16',
  integer_sign: 'v0.0.6-alpha.16',
  integer_gcd: 'v0.0.6-alpha.16',
  integer_lcm: 'v0.0.6-alpha.16',
  array_len: 'v0.0.6-alpha.17',
  array_get_or: 'v0.0.6-alpha.17',
  input_boolean: 'v0.0.6-alpha.17',
  array_set: 'v0.0.6-alpha.18',
  array_concat: 'v0.0.7-alpha.1',
  integer_hcf: 'v0.0.7-alpha.1',
  softplus: 'v0.0.7-alpha.1'
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

test('read_line hover documents versioned interactive input correctly', () => {
  const help = scarpBuiltinAt('read_line()', 3)?.help;
  assert.ok(help);
  assert.match(help.constraints, /alpha\.6/);
  assert.match(help.constraints, /alpha\.10/);
  assert.match(help.constraints, /--interactive/);
  assert.match(help.constraints, /--input-file/);
});


test('alpha.11 decimal hovers describe exact conversion, rounding and interactive requirements', () => {
  const constructor = scarpBuiltinAt('decimal("0.1")', 2)?.help;
  assert.equal(constructor?.signature, 'decimal(value: string) -> decimal');
  assert.match(constructor!.constraints, /28 canonical coefficient digits/);
  const formatted = scarpBuiltinAt('decimal_format(value, 2, "half_even")', 3)?.help;
  assert.match(formatted!.constraints, /exactly that many/);
  const input = scarpBuiltinAt('input_decimal("Amount> ")', 3)?.help;
  assert.match(input!.constraints, /--interactive/);
});

test('alpha.12 collection hover documents immutable quotas and eager fallbacks', () => {
  const push = scarpBuiltinAt('list_push(items, 3)', 3)?.help;
  assert.equal(push?.signature, 'list_push(items: list<T>, value: T) -> list<T>');
  assert.match(push!.constraints, /4096/);
  const keys = scarpBuiltinAt('map_keys(scores)', 3)?.help;
  assert.match(keys!.constraints, /canonical|sorted/i);
  const fallback = scarpBuiltinAt('map_get_or(scores, "x", 0)', 3)?.help;
  assert.match(fallback!.constraints, /eagerly evaluated/);
  for (const name of ['list_set', 'map_set', 'map_get_or']) {
    for (const source of [
      'funcra ' + name + '(value: integer) {',
      'module.' + name + '(items)',
      '// ' + name + '(items)',
      'print("' + name + '(items)");'
    ]) {
      assert.equal(scarpBuiltinAt(source, source.indexOf(name) + 2), undefined, source);
    }
  }
});


test('alpha.16 hover uses released statistics, Unicode and i64 contracts', () => {
  const quantile = scarpBuiltinAt('quantile(values, 0.25)', 3)?.help;
  assert.equal(quantile?.signature, 'quantile(values: vector, fraction: float) -> float');
  assert.match(quantile!.constraints, /0\.0–1\.0/);
  assert.match(scarpBuiltinAt('median(values)', 3)!.help.constraints, /65,536/);
  assert.match(scarpBuiltinAt('text_reverse("a")', 5)!.help.constraints, /grapheme/);
  assert.match(scarpBuiltinAt('text_rfind("abc", "b")', 6)!.help.constraints, /-1/);
  assert.match(scarpBuiltinAt('text_count("aaa", "a")', 6)!.help.constraints, /non-regex/);
  assert.match(scarpBuiltinAt('bits_rotate_left(1, 63)', 5)!.help.constraints, /0 through 63/);
  assert.match(scarpBuiltinAt('integer_abs(-10)', 7)!.help.constraints, /overflow/);
  assert.match(scarpBuiltinAt('integer_gcd(30, 18)', 9)!.help.constraints, /gcd\(0, 0\)/);
  for (const name of ['median', 'text_upper', 'integer_lcm']) {
    assert.equal(scarpBuiltinAt('module.' + name + '(value)', 7)?.help.name, undefined);
    assert.equal(scarpBuiltinAt('// ' + name + '(value)', 4)?.help.name, undefined);
    assert.equal(scarpBuiltinAt('funcra ' + name + '() {}', 8)?.help.name, undefined);
  }
});

test('published alpha.17 array and Boolean input hovers retain exact interpreter semantics', () => {
  const length = scarpBuiltinAt('array_len([array: 1, 2])', 3)?.help;
  assert.equal(length?.signature, 'array_len(values: array<T, N>) -> integer');
  assert.equal(length?.introduced, 'v0.0.6-alpha.17');
  assert.match(length!.constraints, /4,096/);

  const fallback = scarpBuiltinAt('array_get_or(values, -1, 0)', 5)?.help;
  assert.equal(fallback?.signature,
    'array_get_or(values: array<T, N>, index: integer, fallback: T) -> T');
  assert.match(fallback!.constraints, /eagerly evaluated/);
  assert.match(fallback!.constraints, /negative or out-of-bounds/);

  const prompt = scarpBuiltinAt('input_boolean("Continue? ")', 5)?.help;
  assert.equal(prompt?.signature, 'input_boolean(prompt: string) -> boolean');
  assert.match(prompt!.constraints, /--interactive/);
  assert.match(prompt!.constraints, /lowercase true or false/);
  assert.match(prompt!.constraints, /E0084/);
  assert.match(prompt!.constraints, /E0055/);
  for (const name of ['array_len', 'array_get_or', 'input_boolean']) {
    for (const source of ['module.' + name + '(x)', '// ' + name + '(x)',
      'print("' + name + '(x)");', 'funcra ' + name + '(x: integer) {']) {
      assert.equal(scarpBuiltinAt(source, source.indexOf(name) + 2), undefined, source);
    }
  }
});

test('published alpha.18 persistent array_set hover preserves immutable semantics', () => {
  const help = scarpBuiltinAt('array_set(original, 1, 99)', 4)?.help;
  assert.equal(help?.name, 'array_set');
  assert.equal(help?.introduced, 'v0.0.6-alpha.18');
  assert.equal(help?.signature,
    'array_set(values: array<T, N>, index: integer, replacement: T) -> array<T, N>');
  assert.match(help!.summary, /preserving the original/);
  assert.match(help!.constraints, /E0063/);
  assert.match(help!.constraints, /E0064/);
  assert.match(help!.constraints, /--max-array-bytes/);
  for (const line of [
    'module.array_set(values, 0, 1)',
    'array_set_helper(values, 0, 1)',
    '// array_set(values, 0, 1)',
    'print("array_set(values, 0, 1)")',
    'pure funcra array_set(values: integer) -> integer {'
  ]) {
    assert.equal(scarpBuiltinAt(line, line.indexOf('array_set') + 2), undefined, line);
  }
});

test('0.0.7-alpha.1 contracts distinguish new calls from expanded historical calls', () => {
  for (const name of ['integer_gcd', 'integer_lcm', 'integer_hcf']) {
    const help = scarpBuiltinAt(name + '(2, 4, 6)', 2)?.help;
    assert.ok(help);
    assert.equal(help.variadicSince, 'v0.0.7-alpha.1');
    assert.match(help.signature, /\.\.\.more: integer/);
    assert.match(help.constraints, /1,024/);
    assert.equal(help.introduced, name === 'integer_hcf'
      ? 'v0.0.7-alpha.1' : 'v0.0.6-alpha.16');
  }
  assert.match(scarpBuiltinAt('integer_lcm(2, 4, 0)', 2)!.help.constraints, /zero operand returns 0/);
  const array = scarpBuiltinAt('array_concat(first, second)', 3)!.help;
  assert.match(array.signature, /array<T, M \+ N>/);
  assert.match(array.constraints, /identical element types/);
  assert.match(array.constraints, /4,096/);
  assert.match(array.constraints, /E0062/);
  assert.match(array.constraints, /E0064/);
  assert.match(array.constraints, /empty operand/);
  assert.equal(scarpBuiltinAt('softplus(values)', 2)!.help.signature,
    'softplus(values: vector) -> vector');
});

test('hover rejects digit-leading, qualified and multiline declaration names', () => {
  for (const line of ['123integer_gcd(2, 4)', 'Type::integer_gcd(2, 4)',
    'new integer_gcd(2, 4)', 'case integer_gcd(2, 4)']) {
    assert.equal(scarpBuiltinAt(line, line.indexOf('integer_gcd') + 2), undefined, line);
  }
  for (const preceding of ['module.\n', 'module. // comment\r\n', 'Type::\n', 'funcra\n', 'new\n']) {
    assert.equal(scarpBuiltinAt('integer_gcd(2, 4)', 2, '', preceding), undefined, preceding);
  }
  assert.equal(scarpBuiltinAt('integer_gcd(2, 4)', 2, '', 'bind value =\n')?.help.name,
    'integer_gcd');
  assert.equal(scarpBuiltinAt('integer_gcd(2, 4)', 2, '', '// module.\n')?.help.name,
    'integer_gcd');
});
