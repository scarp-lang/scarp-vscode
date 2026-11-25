import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BUILTIN_CONTEXT_LIMIT, scanBuiltinContext, previousCodeToken,
  blockedBuiltinName, isGroupingParenthesis
} from '../src/builtinLexicalContext';

test('shared context keeps UTF-16 spans and ignores punctuation in quoted or commented text', () => {
  const source = 'print("🙂, \\" )"); // fake .\r\nmodule::integer_gcd(1, 2)';
  const tokens = scanBuiltinContext(source);
  assert.ok(tokens);
  assert.equal(tokens.filter(token => token.kind === 'comment').length, 1);
  assert.equal(tokens.filter(token => token.kind === 'string').length, 1);
  assert.equal(tokens.filter(token => token.text === '::').length, 1);
  const index = tokens.findIndex(token => token.text === 'integer_gcd');
  assert.equal(tokens[index].start, source.indexOf('integer_gcd'));
  assert.equal(source.slice(tokens[index].start, tokens[index].end), 'integer_gcd');
  assert.equal(blockedBuiltinName(previousCodeToken(tokens, index)), true);
  for (const token of tokens) assert.equal(source.slice(token.start, token.end), token.text);
});

test('context is bounded and malformed digit-leading names never become builtin identifiers', () => {
  assert.equal(scanBuiltinContext(' '.repeat(BUILTIN_CONTEXT_LIMIT + 1)), undefined);
  assert.deepEqual(scanBuiltinContext(' '.repeat(BUILTIN_CONTEXT_LIMIT)), []);
  assert.deepEqual(scanBuiltinContext('123integer_gcd')?.map(token => token.kind), ['number']);
  for (const source of ['"incomplete', '// unfinished']) {
    assert.equal(scanBuiltinContext(source)?.[0].closed, false);
  }
  const recovered = scanBuiltinContext('"broken\\\r\ninteger_gcd');
  assert.equal(recovered?.[0].closed, false);
  assert.equal(recovered?.[1].text, 'integer_gcd');
});

test('lexical grouping distinguishes expression parentheses from callable positions', () => {
  for (const source of ['return', '=', ',', '(', 'if', 'needs']) {
    const token = scanBuiltinContext(source)?.[0];
    assert.equal(isGroupingParenthesis(token), true, source);
  }
  for (const source of ['custom', 'integer_gcd', ')', ']', '::', '1']) {
    const token = scanBuiltinContext(source)?.[0];
    assert.equal(isGroupingParenthesis(token), false, source);
  }
});
