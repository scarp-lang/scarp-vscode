import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpBuiltinCompletionAt } from '../src/builtinCompletion';
import { PUBLISHED_SCARP_BUILTINS } from '../src/builtinHelp';

test('all published builtins are discoverable with typed prefixes', () => {
  assert.equal(PUBLISHED_SCARP_BUILTINS.length, 48);
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
  assert.equal(scarpBuiltinCompletionAt('te', 2)?.matches.length, 4);
});

test('completion ranges are UTF-16 correct and bounded', () => {
  const line = 'print("🙂"); bind label = text_re';
  const result = scarpBuiltinCompletionAt(line, line.length);
  assert.equal(result?.start, line.indexOf('text_re'));
  assert.deepEqual(result?.matches.map(x => x.name), ['text_replace']);
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
    ['input_bigint', 'input_float', 'input_integer']);
  for (const name of ['ask_or', 'try_read_line', 'bigint_pow_mod', 'flush_stdout']) {
    const match = scarpBuiltinCompletionAt(name, name.length)?.matches.find(x => x.name === name);
    assert.equal(match?.introduced, 'v0.0.6-alpha.10');
  }
  assert.equal(scarpBuiltinCompletionAt('module.input_', 13), undefined);
});
