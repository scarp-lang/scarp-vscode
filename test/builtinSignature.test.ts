import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpSignatureAt } from '../src/builtinSignature';

const builtins = [
  'topk', 'topk_values', 'softmax_temp', 'logsoftmax_temp',
  'sample_area', 'sample_slopes', 'sample_cumulative_area',
  'cosine_similarity', 'top_p', 'top_p_values', 'pearson_correlation',
  'read_line', 'integer_to_text', 'float_to_text',
  'text_to_integer', 'text_to_float', 'text_trim', 'text_replace',
  'bigint', 'bigint_from_integer', 'bigint_to_integer', 'bigint_abs',
  'read_line_or', 'try_read_line', 'ask', 'ask_or', 'input', 'input_integer', 'input_float', 'input_bigint', 'flush_stdout', 'flush_stderr', 'bigint_pow', 'bigint_gcd', 'bigint_lcm', 'bigint_sqrt', 'bigint_bit_length', 'bigint_to_text', 'bigint_from_radix', 'bigint_to_radix', 'bigint_and', 'bigint_or', 'bigint_xor', 'bigint_not', 'bigint_shl', 'bigint_shr', 'bigint_pow_mod', 'bigint_divmod',
  'decimal', 'decimal_from_integer', 'decimal_to_integer', 'decimal_to_text',
  'decimal_round', 'decimal_format', 'decimal_div_rounded', 'input_decimal',
  'list_len', 'list_push', 'list_set', 'list_remove', 'map_len', 'map_keys', 'map_values', 'map_contains', 'map_get_or', 'map_set', 'map_remove',
  'median', 'quantile', 'text_lower', 'text_upper', 'text_reverse', 'text_from_codepoint', 'text_rfind', 'text_count', 'bits_count_ones', 'bits_leading_zeros', 'bits_trailing_zeros', 'bits_reverse', 'bits_swap_bytes', 'bits_rotate_left', 'bits_rotate_right', 'integer_abs', 'integer_sign', 'integer_gcd', 'integer_lcm', 'array_set', 'array_concat', 'integer_hcf', 'softplus'
];

test('all published builtins provide signature help without invoking the compiler', () => {
  for (const name of builtins) {
    const hint = scarpSignatureAt('bind result = ' + name + '(');
    assert.ok(hint, name);
    assert.equal(hint.help.name, name);
    assert.match(hint.help.signature, new RegExp('^' + name + '\\('));
    assert.match(hint.help.introduced, /^v0\.0\.[67]-alpha\.\d+$/);
    assert.equal(hint.activeParameter, 0);
  }
  const zero = scarpSignatureAt('read_line(');
  assert.ok(zero);
  assert.deepEqual(zero.parameters, []);
});

test('comma tracking honors nested vectors, tuples and conditional branches', () => {
  const first = scarpSignatureAt('top_p([0.6, 0.4], ');
  assert.ok(first);
  assert.equal(first.help.name, 'top_p');
  assert.equal(first.activeParameter, 1);
  assert.deepEqual(first.parameters, ['probabilities: vector', 'mass: float']);

  const insideVector = scarpSignatureAt('top_p([0.6, ');
  assert.equal(insideVector?.help.name, 'top_p');
  assert.equal(insideVector?.activeParameter, 0);
  const insideTuple = scarpSignatureAt('top_p((0.6, 0.4), ');
  assert.equal(insideTuple?.activeParameter, 1);

  const conditional = scarpSignatureAt(
    'top_p(if true { [0.6, 0.4] } else { [0.5, 0.5] }, '
  );
  assert.equal(conditional?.help.name, 'top_p');
  assert.equal(conditional?.activeParameter, 1);
  assert.equal(scarpSignatureAt('top_p([0.6, 0.4], 0.9)'), undefined,
    'Closed calls cannot continue showing signature hints');
});

test('the innermost open call owns the help and unknown calls hide outer hints', () => {
  const nested = scarpSignatureAt('top_p(softmax_temp([0.5, 0.6], ');
  assert.equal(nested?.help.name, 'softmax_temp');
  assert.equal(nested?.activeParameter, 1);
  const outer = scarpSignatureAt('top_p(softmax_temp([0.5,0.6], 0.5), ');
  assert.equal(outer?.help.name, 'top_p');
  assert.equal(outer?.activeParameter, 1);

  assert.equal(scarpSignatureAt('top_p(user_defined('), undefined);
  assert.equal(scarpSignatureAt('top_p(module.function('), undefined);
  assert.equal(scarpSignatureAt('top_p(unknown([1, 2]'), undefined);
});

test('comments, quoted text, declarations and qualified calls never advertise help', () => {
  for (const source of [
    '// top_p(',
    'print("top_p("',
    'funcra top_p(',
    'pure funcra top_p(',
    'pub pure funcra top_p(',
    'module.top_p(',
    'module . top_p(',
    'constructor(',
    '__proto__(',
    'top_p([0.5], // cursor remains in comment',
    'top_p("quoted, text',
    'top_p([0.5, 0.4], 0.9'
  ]) {
    const result = scarpSignatureAt(source);
    if (source.endsWith('0.9')) {
      assert.equal(result?.activeParameter, 1, 'Complete arguments may have no closing parenthesis yet');
    } else {
      assert.equal(result, undefined, source);
    }
  }
  assert.equal(scarpSignatureAt('top_p([0.5], // done\n0.8')?.activeParameter, 1,
    'A finished line comment must not suppress a call on the next line');
});

test('escaped quotes, Unicode scalars and UTF-16 offsets do not change call nesting', () => {
  const source = 'text_replace("🙂,' + '\\u{1F44B}' + '", "x", ';
  const call = scarpSignatureAt(source);
  assert.equal(call?.help.name, 'text_replace');
  assert.equal(call?.activeParameter, 2);
  assert.equal(scarpSignatureAt('top_p("quoted \\" bracket ) still string'), undefined,
    'An unfinished string must not display the outer signature');
  assert.equal(scarpSignatureAt('top_p("quoted \\" bracket ) still string"')?.help.name,
    'top_p', 'A completed string argument retains the outer signature');
});

test('malformed or oversized sources fail closed with a strict nesting budget', () => {
  assert.equal(scarpSignatureAt(''), undefined);
  assert.equal(scarpSignatureAt('a'.repeat(16385)), undefined);
  assert.equal(scarpSignatureAt('top_p(' + '('.repeat(128)), undefined);
  assert.equal(scarpSignatureAt('top_p([1,2),'), undefined);
  assert.equal(scarpSignatureAt('top_p((]'), undefined);
  assert.equal(scarpSignatureAt('top_p("never closed'), undefined);
  assert.equal(scarpSignatureAt('top_p(' + ' '.repeat(16384)), undefined);
});

test('alpha.10 prompt and advanced arithmetic signatures select exact arguments', () => {
  const prompt = scarpSignatureAt('ask_or("Name: ", ');
  assert.equal(prompt?.activeParameter, 1);
  assert.deepEqual(prompt?.parameters, ['prompt: string', 'fallback: string']);
  const modular = scarpSignatureAt('bigint_pow_mod(bigint("23"), 4, ');
  assert.equal(modular?.activeParameter, 2);
  assert.deepEqual(modular?.parameters, ['value: bigint', 'exponent: integer', 'modulus: bigint']);
  assert.deepEqual(scarpSignatureAt('flush_stdout(')?.parameters, []);
  assert.deepEqual(scarpSignatureAt('try_read_line(')?.parameters, []);
});


test('alpha.11 decimal calls show exact argument positions without compiler execution', () => {
  const rounded = scarpSignatureAt('decimal_round(decimal("1.225"), 2, ');
  assert.deepEqual(rounded?.parameters,
    ['value: decimal', 'places: integer', 'mode: string']);
  assert.equal(rounded?.activeParameter, 2);
  const division = scarpSignatureAt('decimal_div_rounded(decimal("1"), decimal("3"), ');
  assert.deepEqual(division?.parameters,
    ['left: decimal', 'right: decimal', 'places: integer', 'mode: string']);
  assert.equal(division?.activeParameter, 2);
  assert.equal(scarpSignatureAt('input_decimal(')?.help.introduced, 'v0.0.6-alpha.11');
  assert.equal(scarpSignatureAt('module.decimal_round('), undefined);
});

test('alpha.12 collection signatures preserve generic map commas as one parameter', () => {
  const set = scarpSignatureAt('map_set(values, "k", ');
  assert.deepEqual(set?.parameters, ['items: map<K, V>', 'key: K', 'value: V']);
  assert.equal(set?.activeParameter, 2);
  const fallback = scarpSignatureAt('map_get_or(values, "missing", ');
  assert.deepEqual(fallback?.parameters, ['items: map<K, V>', 'key: K', 'fallback: V']);
  assert.equal(fallback?.activeParameter, 2);
  assert.deepEqual(scarpSignatureAt('list_push(')?.parameters, ['items: list<T>', 'value: T']);
  assert.equal(scarpSignatureAt('module.map_get_or('), undefined);
  assert.equal(scarpSignatureAt('map_set([map: "a": 1, "z": 2], ')?.activeParameter, 1);
});


test('alpha.16 signature help tracks arity and nested arguments', () => {
  assert.deepEqual(scarpSignatureAt('median(')?.parameters, ['values: vector']);
  const quantile = scarpSignatureAt('quantile([4.0, 1.0], ');
  assert.equal(quantile?.help.introduced, 'v0.0.6-alpha.16');
  assert.deepEqual(quantile?.parameters, ['values: vector', 'fraction: float']);
  assert.equal(quantile?.activeParameter, 1);
  assert.deepEqual(scarpSignatureAt('text_rfind("banana", ')?.parameters,
    ['value: string', 'needle: string']);
  assert.equal(scarpSignatureAt('bits_rotate_right(15, ')?.activeParameter, 1);
  assert.deepEqual(scarpSignatureAt('integer_lcm(')?.parameters,
    ['left: integer', 'right: integer', '...more: integer']);
  assert.equal(scarpSignatureAt('my_module.quantile('), undefined);
  assert.equal(scarpSignatureAt('print("quantile(1, 2)"), '), undefined);
});

test('published alpha.17 signatures track array generics and Boolean prompt arity', () => {
  const len = scarpSignatureAt('array_len(');
  assert.deepEqual(len?.parameters, ['values: array<T, N>']);
  assert.equal(len?.help.introduced, 'v0.0.6-alpha.17');
  const lookup = scarpSignatureAt('array_get_or([array: 2, 4], -1, ');
  assert.deepEqual(lookup?.parameters,
    ['values: array<T, N>', 'index: integer', 'fallback: T']);
  assert.equal(lookup?.activeParameter, 2);
  assert.deepEqual(scarpSignatureAt('input_boolean(')?.parameters, ['prompt: string']);
  assert.equal(scarpSignatureAt('module.array_get_or('), undefined);
  assert.equal(scarpSignatureAt('// input_boolean('), undefined);
});

test('published alpha.18 array_set signature treats fixed-array generics as one parameter', () => {
  const hint = scarpSignatureAt('bind result = array_set([array: 4, 8, 12], 1, ');
  assert.equal(hint?.help.name, 'array_set');
  assert.equal(hint?.help.introduced, 'v0.0.6-alpha.18');
  assert.deepEqual(hint?.parameters, [
    'values: array<T, N>', 'index: integer', 'replacement: T'
  ]);
  assert.equal(hint?.activeParameter, 2);
  assert.equal(scarpSignatureAt('module.array_set('), undefined);
  assert.equal(scarpSignatureAt('// array_set('), undefined);
});

test('variadic integer signatures keep the active rest parameter across nested arguments', () => {
  for (const name of ['integer_gcd', 'integer_hcf', 'integer_lcm']) {
    const args = ['','2, ', '2, 3, ', '2, integer_abs(-3), 4, ',
      Array.from({ length: 1023 }, () => '1').join(',') + ','];
    for (const [index, source] of args.entries()) {
      const hint = scarpSignatureAt(name + '(' + source);
      assert.ok(hint);
      assert.deepEqual(hint.parameters, ['left: integer', 'right: integer', '...more: integer']);
      assert.equal(hint.activeParameter, Math.min(index, 2));
      assert.equal(hint.help.variadicSince, 'v0.0.7-alpha.1');
    }
    assert.equal(scarpSignatureAt(name + '(2, 3, unknown('), undefined);
    assert.equal(scarpSignatureAt(name + '(2, 3, 4)'), undefined);
  }
});

test('array concatenation keeps generic commas separate from source argument commas', () => {
  const hint = scarpSignatureAt('array_concat([array: 1, 2], ');
  assert.deepEqual(hint?.parameters, ['left: array<T, M>', 'right: array<T, N>']);
  assert.equal(hint?.activeParameter, 1);
  assert.equal(scarpSignatureAt('softplus([1.0, ')?.activeParameter, 0);
  for (const name of ['array_concat', 'integer_hcf', 'softplus']) {
    assert.equal(scarpSignatureAt('module.' + name + '('), undefined);
    assert.equal(scarpSignatureAt('funcra ' + name + '('), undefined);
    assert.equal(scarpSignatureAt('// ' + name + '('), undefined);
  }
});

test('grouped expressions retain their enclosing call without miscounting inner commas', () => {
  assert.equal(scarpSignatureAt('integer_gcd((1 + ')?.activeParameter, 0);
  assert.equal(scarpSignatureAt('integer_gcd((1 + 2), (3 + ')?.activeParameter, 1);
  assert.equal(scarpSignatureAt('integer_gcd((integer_abs(-2')?.help.name, 'integer_abs');
  assert.equal(scarpSignatureAt('integer_gcd((custom('), undefined);
  assert.equal(scarpSignatureAt('array_concat((first), ')?.activeParameter, 1);
});

test('truncated source windows recover only unmatched leading closing delimiters', () => {
  const source = '}\n);\ninteger_gcd(1, ';
  assert.equal(scarpSignatureAt(source), undefined);
  assert.equal(scarpSignatureAt(source, true)?.help.name, 'integer_gcd');
  assert.equal(scarpSignatureAt(source, true)?.activeParameter, 1);
  assert.equal(scarpSignatureAt('}\ninteger_gcd([1), ', true), undefined);
  assert.equal(scarpSignatureAt('}\ninteger_gcd((1, ', true)?.activeParameter, 0);
});

test('signature help follows lexical qualification across comment and line boundaries', () => {
  for (const source of ['module. // note\ninteger_gcd(', 'Type::\ninteger_gcd(',
    'funcra // note\ninteger_gcd(', '123integer_gcd(', 'new integer_gcd(']) {
    assert.equal(scarpSignatureAt(source), undefined, source);
  }
  assert.equal(scarpSignatureAt('integer_gcd // comment\n(1, ')?.activeParameter, 1);
  assert.equal(scarpSignatureAt('bind value =\ninteger_gcd(1, ')?.activeParameter, 1);
  assert.equal(scarpSignatureAt('integer_gcd(1, // unfinished'), undefined);
  assert.equal(scarpSignatureAt('"broken\\\ninteger_gcd(1, ')?.activeParameter, 1);
});
