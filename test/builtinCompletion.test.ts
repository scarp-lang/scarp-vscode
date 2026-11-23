import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpBuiltinCompletionAt } from '../src/builtinCompletion';
import { PUBLISHED_SCARP_BUILTINS } from '../src/builtinHelp';

test('all published builtins are discoverable with typed prefixes', () => {
  assert.equal(PUBLISHED_SCARP_BUILTINS.length, 90);
  for (const builtIn of PUBLISHED_SCARP_BUILTINS) {
    const line = 'bind result = ' + builtIn.name;
    const hint = scarpBuiltinCompletionAt(line, line.length);
    assert.ok(hint, builtIn.name);
    assert.equal(hint.start, line.indexOf(builtIn.name));
    assert.ok(hint.matches.some(match =>
      match.name === builtIn.name && match.signature === builtIn.signature &&
      match.introduced === builtIn.introduced));
  }
  const choices = scarpBuiltinCompletionAt('bind result = top', 17);
  assert.deepEqual(choices?.matches.map(x => x.name).sort(), [
    'top_p', 'top_p_values', 'topk', 'topk_values'
  ]);
});

test('completion refuses strings, comments, declarations, member accesses and aliases', () => {
  for (const line of [
    '// text_repl',
    'print("text_repl',
    'print("quoted \\" text_repl',
    'funcra text_repl',
    'pure funcra text_repl',
    'pub pure funcra text_repl',
    'bind text_repl',
    'var text_repl',
    'import text_repl',
    'import "lib.srp" as text_repl',
    'module.text_repl',
    'module . text_repl',
    'top_p("hello text_repl'
  ]) {
    assert.equal(scarpBuiltinCompletionAt(line, line.length), undefined, line);
  }
  const line = 'print("text_repl"); bind result = text_repl';
  const hint = scarpBuiltinCompletionAt(line, line.length);
  assert.deepEqual(hint?.matches.map(item => item.name), ['text_replace']);
});

test('prefix matching is case-sensitive and does not advertise arbitrary functions', () => {
  for (const prefix of ['TO', 'integar', '__proto__', 'constructor', 'custom']) {
    assert.equal(scarpBuiltinCompletionAt(prefix, prefix.length), undefined, prefix);
  }
  assert.equal(scarpBuiltinCompletionAt('t', 1), undefined,
    'At least two characters avoid noisy single-letter suggestions');
  assert.equal(scarpBuiltinCompletionAt('te', 2)?.matches.length, 10);
});

test('completion ranges are UTF-16 correct and bounded', () => {
  const line = 'print("🙂"); bind label = text_re';
  const result = scarpBuiltinCompletionAt(line, line.length);
  assert.equal(result?.start, line.indexOf('text_re'));
  assert.deepEqual(result?.matches.map(x => x.name), ['text_replace', 'text_reverse']);
  for (const index of [-1, line.length + 1, 1.5, NaN, Infinity]) {
    assert.equal(scarpBuiltinCompletionAt(line, index), undefined);
  }
  assert.equal(scarpBuiltinCompletionAt('x'.repeat(16385) + 'top', 16388), undefined);
  assert.equal(scarpBuiltinCompletionAt('top', 0), undefined);
});

test('alpha.9 exact bigint builtins are explicit, versioned, and safely completed', () => {
  assert.deepEqual(
    scarpBuiltinCompletionAt('bind exact = bigint_', 'bind exact = bigint_'.length)
      ?.matches.map(x => x.name).sort(),
    ['bigint_abs', 'bigint_and', 'bigint_bit_length', 'bigint_divmod', 'bigint_from_integer', 'bigint_from_radix', 'bigint_gcd', 'bigint_lcm', 'bigint_not', 'bigint_or', 'bigint_pow', 'bigint_pow_mod', 'bigint_shl', 'bigint_shr', 'bigint_sqrt', 'bigint_to_integer', 'bigint_to_radix', 'bigint_to_text', 'bigint_xor']
  );
  for (const name of ['bigint', 'bigint_abs', 'bigint_from_integer', 'bigint_to_integer']) {
    const hint = scarpBuiltinCompletionAt(name, name.length);
    assert.ok(hint?.matches.some(x => x.name === name &&
      x.introduced === 'v0.0.6-alpha.9'), name);
  }
  assert.equal(scarpBuiltinCompletionAt('module.bigint_', 14), undefined,
    'Member access never offers builtin completion');
});

test('alpha.10 builtins are versioned and only completed at actual identifiers', () => {
  const prompt = scarpBuiltinCompletionAt('bind response = input_', 'bind response = input_'.length);
  assert.deepEqual(prompt?.matches.map(x => x.name).sort(),
    ['input_bigint', 'input_boolean', 'input_decimal', 'input_float', 'input_integer']);
  for (const name of ['ask_or', 'try_read_line', 'bigint_pow_mod', 'flush_stdout']) {
    const match = scarpBuiltinCompletionAt(name, name.length)?.matches.find(x => x.name === name);
    assert.equal(match?.introduced, 'v0.0.6-alpha.10');
  }
  assert.equal(scarpBuiltinCompletionAt('module.input_', 13), undefined);
});


test('alpha.11 exact decimal completion is versioned and excludes false lexical positions', () => {
  const source = 'bind result = decimal_';
  const names = scarpBuiltinCompletionAt(source, source.length)?.matches.map(x => x.name).sort();
  assert.deepEqual(names, ['decimal_div_rounded', 'decimal_format',
    'decimal_from_integer', 'decimal_round', 'decimal_to_integer', 'decimal_to_text']);
  for (const name of ['decimal', 'input_decimal', 'decimal_div_rounded']) {
    const choice = scarpBuiltinCompletionAt(name, name.length);
    assert.equal(choice?.matches.find(x => x.name === name)?.introduced, 'v0.0.6-alpha.11');
    assert.equal(scarpBuiltinCompletionAt('module.' + name, ('module.' + name).length), undefined);
    assert.equal(scarpBuiltinCompletionAt('// ' + name, ('// ' + name).length), undefined);
  }
});

test('alpha.12 collection completion is versioned and rejects lexical false positives', () => {
  for (const prefix of ['list_', 'map_']) {
    const found = scarpBuiltinCompletionAt(prefix, prefix.length);
    assert.ok(found);
    assert.equal(found.matches.length, prefix === 'list_' ? 4 : 7);
    assert.ok(found.matches.every(x => x.introduced === 'v0.0.6-alpha.12'));
    assert.equal(scarpBuiltinCompletionAt('module.' + prefix,
      ('module.' + prefix).length), undefined);
    assert.equal(scarpBuiltinCompletionAt('// ' + prefix,
      ('// ' + prefix).length), undefined);
  }
});


test('alpha.16 completions expose the precise published groups without false positions', () => {
  const bits = scarpBuiltinCompletionAt('bits_', 5);
  assert.deepEqual(bits?.matches.map(x => x.name).sort(), [
    'bits_count_ones', 'bits_leading_zeros', 'bits_reverse',
    'bits_rotate_left', 'bits_rotate_right', 'bits_swap_bytes', 'bits_trailing_zeros'
  ]);
  const statistics = scarpBuiltinCompletionAt('quant', 5);
  assert.equal(statistics?.matches.find(x => x.name === 'quantile')?.introduced,
    'v0.0.6-alpha.16');
  for (const name of ['median', 'text_lower', 'text_from_codepoint',
    'integer_abs', 'integer_lcm']) {
    const result = scarpBuiltinCompletionAt(name, name.length);
    assert.equal(result?.matches.find(x => x.name === name)?.introduced,
      'v0.0.6-alpha.16', name);
    assert.equal(scarpBuiltinCompletionAt('module.' + name,
      ('module.' + name).length), undefined);
    assert.equal(scarpBuiltinCompletionAt('// ' + name,
      ('// ' + name).length), undefined);
  }
});

test('published alpha.17 array access and Boolean prompt complete only in source expressions', () => {
  const arrays = scarpBuiltinCompletionAt('bind count = array_', 'bind count = array_'.length);
  assert.deepEqual(arrays?.matches.map(item => item.name), ['array_len', 'array_get_or', 'array_set']);
  assert.deepEqual(arrays?.matches.map(item => item.introduced), [
    'v0.0.6-alpha.17', 'v0.0.6-alpha.17', 'v0.0.6-alpha.18'
  ]);
  const prompt = scarpBuiltinCompletionAt('bind ok = input_bo', 'bind ok = input_bo'.length);
  assert.deepEqual(prompt?.matches.map(item => item.name), ['input_boolean']);
  for (const line of [
    'funcra array_len', 'module.array_get_or', '// input_boolean',
    'print("input_boolean', 'bind array_len', 'pub pure funcra input_boolean'
  ]) {
    assert.equal(scarpBuiltinCompletionAt(line, line.length), undefined, line);
  }
});

test('published alpha.18 persistent array update suggests only true call sites', () => {
  const line = 'bind updated = array_se';
  const completion = scarpBuiltinCompletionAt(line, line.length);
  assert.deepEqual(completion?.matches.map(item => item.name), ['array_set']);
  assert.equal(completion?.matches[0].introduced, 'v0.0.6-alpha.18');
  for (const line of [
    'module.array_set',
    'funcra array_set',
    'bind array_set',
    '// array_set',
    'print("array_set',
    'array_set_helper'
  ]) {
    assert.equal(scarpBuiltinCompletionAt(line, line.length), undefined, line);
  }
});
