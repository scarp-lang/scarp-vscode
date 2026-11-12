import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpSignatureAt } from '../src/builtinSignature';

const builtins = [
  'topk', 'topk_values', 'softmax_temp', 'logsoftmax_temp',
  'sample_area', 'sample_slopes', 'sample_cumulative_area',
  'cosine_similarity', 'top_p', 'top_p_values', 'pearson_correlation',
  'read_line', 'integer_to_text', 'float_to_text',
  'text_to_integer', 'text_to_float', 'text_trim', 'text_replace'
];

test('all published builtins provide signature help without invoking the compiler', () => {
  for (const name of builtins) {
    const hint = scarpSignatureAt('bind result = ' + name + '(');
    assert.ok(hint, name);
    assert.equal(hint.help.name, name);
    assert.match(hint.help.signature, new RegExp('^' + name + '\\('));
    assert.ok(hint.help.introduced.startsWith('v0.0.6-alpha.'));
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
