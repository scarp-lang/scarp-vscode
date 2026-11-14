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

test('published alpha.4 scientific calls are scoped only at true function calls', async () => {
  const grammar = await tokenizer();
  for (const name of ['sample_area', 'sample_slopes', 'sample_cumulative_area', 'cosine_similarity']) {
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

test('published alpha.5 nucleus selection and Pearson correlation highlight only calls', async () => {
  const grammar = await tokenizer();
  for (const name of ['top_p', 'top_p_values', 'pearson_correlation']) {
    const called = tokens(`bind result = ${name}(scores, mass);`, grammar);
    assert.ok(hasScope(called, name, 'support.function.builtin.scarp'),
      `${name} must have the official builtin scope when called`);

    const longer = tokens(`bind result = ${name}_custom(scores, mass);`, grammar);
    assert.ok(hasScope(longer, `${name}_custom`, 'entity.name.function.call.scarp'));
    assert.ok(!hasScope(longer, `${name}_custom`, 'support.function.builtin.scarp'));

    const commented = tokens(`// ${name}(scores, mass)`, grammar);
    assert.ok(!hasScope(commented, name, 'support.function.builtin.scarp'));

    const quoted = tokens(`print("${name}(scores, mass)");`, grammar);
    assert.ok(!hasScope(quoted, name, 'support.function.builtin.scarp'));

    const declaration = tokens(`pure funcra ${name}(scores: vector) -> vector {`, grammar);
    assert.ok(hasScope(declaration, name, 'entity.name.function.definition.scarp'));
    assert.ok(!hasScope(declaration, name, 'support.function.builtin.scarp'));
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
test('published alpha.6 tuple types and text/input built-ins highlight without false matches', async () => {
  const grammar = await tokenizer();
  const type = tokens('bind pair: tuple<integer, tuple<string, boolean>> = (7, ("ok", true));', grammar);
  assert.ok(hasScope(type, 'tuple', 'support.type.scarp'));
  const identifier = tokens('bind tuple = 7;', grammar);
  assert.ok(!hasScope(identifier, 'tuple', 'support.type.scarp'),
    'tuple is contextual and can be an ordinary identifier');
  for (const name of [
    'read_line', 'integer_to_text', 'float_to_text',
    'text_to_integer', 'text_to_float', 'text_trim', 'text_replace'
  ]) {
    const call = tokens('bind output = ' + name + '(value);', grammar);
    assert.ok(hasScope(call, name, 'support.function.builtin.scarp'), name);
    const longer = tokens('bind output = ' + name + '_other(value);', grammar);
    assert.ok(!hasScope(longer, name + '_other', 'support.function.builtin.scarp'));
    assert.ok(!hasScope(tokens('// ' + name + '(value)', grammar), name, 'support.function.builtin.scarp'));
    assert.ok(!hasScope(tokens('print("' + name + '(value)");', grammar), name, 'support.function.builtin.scarp'));
    assert.ok(hasScope(tokens('funcra ' + name + '() {', grammar), name,
      'entity.name.function.definition.scarp'));
  }
});

test('published alpha.7 Unicode-scalar escapes and conditional values tokenize safely', async () => {
  const grammar = await tokenizer();
  const slash = String.fromCharCode(92);
  const source = 'bind label = if true { "' + slash + 'u{0928}" } elif false { "' +
    slash + 'u{1F44B}" } else { "fallback" };';
  const highlighted = tokens(source, grammar);
  for (const keyword of ['if', 'elif', 'else']) {
    assert.ok(highlighted.some(token => token.text === keyword &&
      token.scopes.includes('keyword.control.scarp')), keyword);
  }
  for (const scalar of [slash + 'u{0928}', slash + 'u{1F44B}']) {
    assert.ok(hasScope(highlighted, scalar, 'constant.character.escape.scarp'), scalar);
  }
  const malformed = tokens('print("' + slash + 'u{NOTHEX}");', grammar);
  assert.ok(!hasScope(malformed, slash + 'u{NOTHEX}', 'constant.character.escape.scarp'));
  const commented = tokens('// ' + slash + 'u{1F44B}', grammar);
  assert.ok(!hasScope(commented, slash + 'u{1F44B}', 'constant.character.escape.scarp'));
  // Scope classification is lexical only; the compiler validates Unicode scalar ranges.
});

test('published alpha.9 exact bigint syntax separates contextual type from calls', async () => {
  const grammar = await tokenizer();
  const line = 'bind total: bigint = bigint("1234567890123456789012345");';
  const highlighted = tokens(line, grammar);
  assert.ok(hasScope(highlighted, 'bigint', 'support.type.scarp'),
    'The annotation is a first-class bigint type');
  assert.ok(hasScope(highlighted, 'bigint', 'support.function.builtin.scarp'),
    'The constructor call is a real builtin, not a type name');
  const constructor = tokens('bigint("42");', grammar);
  assert.ok(hasScope(constructor, 'bigint', 'support.function.builtin.scarp'));
  assert.ok(!hasScope(constructor, 'bigint', 'support.type.scarp'),
    'Calling bigint must not be colored as a type annotation');
  for (const name of ['bigint_from_integer', 'bigint_to_integer', 'bigint_abs']) {
    assert.ok(hasScope(tokens(name + '(value);', grammar),
      name, 'support.function.builtin.scarp'), name);
    assert.ok(!hasScope(tokens(name + '_helper(value);', grammar),
      name + '_helper', 'support.function.builtin.scarp'), name);
    assert.ok(!hasScope(tokens('// ' + name + '(value)', grammar),
      name, 'support.function.builtin.scarp'), name);
    assert.ok(!hasScope(tokens('print("' + name + '(value)");', grammar),
      name, 'support.function.builtin.scarp'), name);
    assert.ok(hasScope(tokens('funcra ' + name + '() {', grammar),
      name, 'entity.name.function.definition.scarp'), name);
  }
});

test('Scarp editor configuration supports line comments, conservative brace indentation and regions', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8'));
  assert.equal(config.comments.lineComment, '//',
    'VS Code Toggle Line Comment (Ctrl+/) must use compiler-supported Scarp comments');
  assert.equal(config.comments.blockComment, undefined,
    'Do not advertise unsupported block comment delimiters');

  const increase = new RegExp(config.indentationRules.increaseIndentPattern);
  const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);
  for (const line of ['funcra run() -> unit {', '  if true {', '  {']) {
    assert.ok(increase.test(line), 'Expected editor indentation after ' + line);
  }
  for (const line of ['// {', '  // comment ending {', 'print("text");', 'if true { print("ok"); }']) {
    assert.ok(!increase.test(line), 'Do not indent from ' + line);
  }
  assert.ok(decrease.test('    }'), 'Closing block should decrease indentation');
  assert.ok(!decrease.test('    // }'), 'Commented closing brace must not dedent');

  assert.equal(config.onEnterRules.length, 1);
  const enter = config.onEnterRules[0];
  assert.equal(enter.action.indent, 'indentOutdent');
  assert.ok(new RegExp(enter.beforeText).test('funcra main() {'));
  assert.ok(new RegExp(enter.afterText).test('}'));
  assert.ok(!new RegExp(enter.beforeText).test('// {'));

  const start = new RegExp(config.folding.markers.start);
  const end = new RegExp(config.folding.markers.end);
  assert.ok(start.test('  // #region Helpers'));
  assert.ok(end.test('  // #endregion Helpers'));
  assert.ok(!start.test('  // regular comment'));
  assert.ok(!end.test('  // #region not an end marker'));
});


test('highlights native assertions without coloring longer identifiers or strings', async () => {
  const grammar = await tokenizer();
  const statement = tokens('assert(true, "assert message");', grammar);
  assert.ok(hasScope(statement, 'assert', 'keyword.control.scarp'));
  assert.ok(hasScope(statement, 'assert message', 'string.quoted.double.scarp'));
  const longer = tokens('assert_other(true);', grammar);
  assert.ok(hasScope(longer, 'assert_other', 'entity.name.function.call.scarp'));
  assert.ok(!hasScope(longer, 'assert_other', 'keyword.control.scarp'));
});

test('alpha.10 fixed arrays and new calls receive contextual scopes', async () => {
  const grammar = await tokenizer();
  const typed = tokens('bind values: array<integer, 2> = [array: 1, 2];', grammar);
  assert.ok(hasScope(typed, 'array', 'support.type.scarp'));
  assert.ok(hasScope(typed, 'integer', 'support.type.scarp'));
  const names = ['input_integer', 'try_read_line', 'bigint_pow_mod', 'flush_stdout'];
  for (const name of names) {
    assert.ok(hasScope(tokens(`bind result = ${name}();`, grammar), name,
      'support.function.builtin.scarp'), name);
    assert.ok(!hasScope(tokens(`bind ${name} = 2;`, grammar), name,
      'support.function.builtin.scarp'));
    assert.ok(!hasScope(tokens(`// ${name}()`, grammar), name,
      'support.function.builtin.scarp'));
  }
  const binding = tokens('bind array = 1;', grammar);
  assert.ok(!hasScope(binding, 'array', 'support.type.scarp'),
    'array is a contextual type marker, not a reserved binding name');
});
