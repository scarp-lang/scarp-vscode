import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as oniguruma from 'vscode-oniguruma';
import { Registry } from 'vscode-textmate';

interface Highlighted { text: string; scopes: readonly string[]; }

const root = path.resolve(__dirname, '../..');
const grammarPath = path.join(root, 'syntaxes/scarp.tmLanguage.json');

async function tokenizer() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(new Uint8Array(wasm));
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: source => new oniguruma.OnigString(source)
    }),
    loadGrammar: async scope => scope === 'source.scarp'
      ? JSON.parse(fs.readFileSync(grammarPath, 'utf8'))
      : null
  });
  const grammar = await registry.loadGrammar('source.scarp');
  assert.ok(grammar, 'TextMate should load Scarp grammar with Oniguruma');
  return grammar;
}

function tokens(line: string, grammar: Awaited<ReturnType<typeof tokenizer>>): Highlighted[] {
  return grammar.tokenizeLine(line, null).tokens.map(token => ({
    text: line.slice(token.startIndex, token.endIndex),
    scopes: token.scopes
  }));
}

function hasScope(parts: readonly Highlighted[], fragment: string, scope: string): boolean {
  return parts.some(part => part.text.includes(fragment) && part.scopes.includes(scope));
}

test('published VS Code contribution registers the actual Scarp grammar file', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.publisher, 'ScarpLang');
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  const [contribution] = packageJson.contributes.grammars;
  assert.deepEqual(contribution, {
    language: 'scarp', scopeName: 'source.scarp',
    path: './syntaxes/scarp.tmLanguage.json'
  });
  const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
  assert.equal(grammar.scopeName, contribution.scopeName);
  assert.ok(grammar.fileTypes.includes('srp'));
});

test('real TextMate tokenizer recognizes current Scarp syntax and avoids false comment tokens', async () => {
  const grammar = await tokenizer();
  const source = [
    'pure funcra add(a: integer, b: integer) -> integer {',
    '  bind flags = 0xAF | 0b1010; var total: float = 1.5e-2;',
    '  if true and not false { print("// string text"); } // actual comment',
    '  return add(42, total);',
    '}'
  ];
  const first = tokens(source[0], grammar);
  assert.ok(hasScope(first, 'pure', 'storage.modifier.scarp'));
  assert.ok(hasScope(first, 'funcra', 'storage.type.function.scarp'));
  assert.ok(hasScope(first, 'add', 'entity.name.function.definition.scarp'));
  assert.ok(hasScope(first, 'integer', 'support.type.scarp'));

  const second = tokens(source[1], grammar);
  assert.ok(hasScope(second, 'bind', 'storage.modifier.scarp'));
  assert.ok(hasScope(second, 'var', 'storage.modifier.scarp'));
  for (const number of ['0xAF', '0b1010', '1.5e-2']) {
    assert.ok(hasScope(second, number, 'constant.numeric.scarp'), number);
  }
  const third = tokens(source[2], grammar);
  for (const fragment of ['if', 'and', 'not', 'true', 'false']) {
    assert.ok(third.some(part => part.text === fragment && part.scopes.some(scope =>
      scope.startsWith('keyword.') || scope.startsWith('constant.language.'))), fragment);
  }
  assert.ok(hasScope(third, '// string text', 'string.quoted.double.scarp'));
  assert.ok(!third.some(part => part.text.includes('// string text') &&
    part.scopes.includes('comment.line.double-slash.scarp')));
  assert.ok(hasScope(third, '// actual comment', 'comment.line.double-slash.scarp'));
  assert.ok(hasScope(third, 'print', 'support.function.builtin.scarp'));

  const fourth = tokens(source[3], grammar);
  assert.ok(hasScope(fourth, 'return', 'keyword.control.scarp'));
  assert.ok(hasScope(fourth, 'add', 'entity.name.function.call.scarp'));
});

test('published alpha.3 numerical builtins are highlighted only as calls', async () => {
  const grammar = await tokenizer();
  for (const name of ['topk', 'topk_values', 'softmax_temp', 'logsoftmax_temp']) {
    const highlighted = tokens(`bind result = ${name}(scores, 3);`, grammar);
    assert.ok(hasScope(highlighted, name, 'support.function.builtin.scarp'),
      `${name} should be recognized as an actual compiler built-in`);
  }

  const longer = tokens('bind result = topk_custom(scores);', grammar);
  assert.ok(hasScope(longer, 'topk_custom', 'entity.name.function.call.scarp'));
  assert.ok(!hasScope(longer, 'topk_custom', 'support.function.builtin.scarp'));
  const comment = tokens('// softmax_temp([1.0], 0.5)', grammar);
  assert.ok(!comment.some(part => part.scopes.includes('support.function.builtin.scarp')));
  const string = tokens('print("logsoftmax_temp([1.0], 0.5)");', grammar);
  assert.ok(!string.some(part =>
    part.text.includes('logsoftmax_temp') &&
    part.scopes.includes('support.function.builtin.scarp')));

  // User-declared functions are still declarations, not builtin calls.
  const definition = tokens('pure funcra topk(scores: vector) -> vector {', grammar);
  assert.ok(hasScope(definition, 'topk', 'entity.name.function.definition.scarp'));
  assert.ok(!hasScope(definition, 'topk', 'support.function.builtin.scarp'));
});

test('unreleased sampled calculus names are scoped only at true function calls', async () => {
  const grammar = await tokenizer();
  for (const name of ['sample_area', 'sample_slopes']) {
    const call = tokens(`bind result = ${name}(time, values);`, grammar);
    assert.ok(hasScope(call, name, 'support.function.builtin.scarp'));
    const longer = tokens(`bind result = ${name}_custom(time, values);`, grammar);
    assert.ok(hasScope(longer, `${name}_custom`, 'entity.name.function.call.scarp'));
    assert.ok(!hasScope(longer, `${name}_custom`, 'support.function.builtin.scarp'));
    const comment = tokens(`// ${name}(time, values)`, grammar);
    assert.ok(!hasScope(comment, name, 'support.function.builtin.scarp'));
    const quoted = tokens(`print("${name}(time, values)");`, grammar);
    assert.ok(!hasScope(quoted, name, 'support.function.builtin.scarp'));
  }
});

test('escaping, longest shift operators, and unterminated strings match compiler lexer rules', async () => {
  const grammar = await tokenizer();
  const escaped = tokens('print("a\\\"b\\n");', grammar);
  assert.ok(escaped.some(t => t.scopes.includes('constant.character.escape.scarp')));
  const bitwise = tokens('flags >>>= 2; flags <<= 1; flags &= 0xFF;', grammar);
  for (const operator of ['>>>=', '<<=', '&=']) {
    assert.ok(bitwise.some(t => t.text === operator &&
      t.scopes.includes('keyword.operator.scarp')), operator);
  }
  const invalid = grammar.tokenizeLine('bind x = "missing close', null);
  const next = grammar.tokenizeLine('var y = 2;', invalid.ruleStack);
  assert.ok(next.tokens.some(t =>
    'var y = 2;'.slice(t.startIndex, t.endIndex) === 'var' &&
    t.scopes.includes('storage.modifier.scarp')),
    'An unfinished string must not color the next line as a string');
});
