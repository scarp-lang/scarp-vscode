import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as oniguruma from 'vscode-oniguruma';
import { Registry } from 'vscode-textmate';

const root = path.resolve(__dirname, '../..');
const readJson = (filename: string) =>
  JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));

async function tokenizer() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(new Uint8Array(wasm));
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: source => new oniguruma.OnigString(source)
    }),
    loadGrammar: async scope => scope === 'source.scarp-project'
      ? readJson('syntaxes/scarp-project.tmLanguage.json') : null
  });
  const grammar = await registry.loadGrammar('source.scarp-project');
  assert.ok(grammar);
  return grammar;
}

function scopes(line: string, grammar: NonNullable<Awaited<ReturnType<typeof tokenizer>>>) {
  return grammar.tokenizeLine(line, null).tokens.map(token => ({
    text: line.slice(token.startIndex, token.endIndex),
    scopes: token.scopes
  }));
}

function highlighted(
  line: string, fragment: string, scope: string,
  grammar: NonNullable<Awaited<ReturnType<typeof tokenizer>>>
): boolean {
  return scopes(line, grammar).some(token =>
    token.text.includes(fragment) && token.scopes.includes(scope));
}

test('only the exact lowercase declarative manifest receives the new editor language', () => {
  const pkg = readJson('package.json');
  const language = pkg.contributes.languages.find((entry: { id: string }) =>
    entry.id === 'scarp-project');
  assert.deepEqual(language, {
    id: 'scarp-project',
    aliases: ['Scarp Project Manifest'],
    filenames: ['scarp.project'],
    configuration: './scarp-project.language-configuration.json'
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(language, 'extensions'),
    'Do not associate arbitrary *.project files');
  const association = pkg.contributes.grammars.find((entry: { language: string }) =>
    entry.language === 'scarp-project');
  assert.deepEqual(association, {
    language: 'scarp-project', scopeName: 'source.scarp-project',
    path: './syntaxes/scarp-project.tmLanguage.json'
  });
  assert.equal(readJson('syntaxes/scarp-project.tmLanguage.json').scopeName,
    association.scopeName);
  assert.deepEqual(pkg.contributes.snippets.filter((entry: { language: string }) =>
    entry.language === 'scarp-project'), [{
    language: 'scarp-project', path: './snippets/scarp-project.code-snippets'
  }]);
});

test('project manifest editing supports compiler-valid comments, braces and a v2 snippet', () => {
  const config = readJson('scarp-project.language-configuration.json');
  assert.equal(config.comments.lineComment, '//');
  assert.deepEqual(config.brackets, [['{', '}']]);
  assert.ok(config.autoClosingPairs.some((pair: { open: string; close: string }) =>
    pair.open === '"' && pair.close === '"'));
  const snippet = readJson('snippets/scarp-project.code-snippets')['Declarative Scarp project'];
  assert.equal(snippet.prefix, 'sproject');
  assert.ok(snippet.body.includes('    dependencies {}'));
  assert.ok(snippet.body.includes('    type: "application"'));
  assert.ok(!snippet.body.some((line: string) =>
    /cargo\.toml|npm|install|run /.test(line)), 'A manifest template must not run commands');
});

test('actual TextMate grammar colors all official v2 manifest constructs', async () => {
  const grammar = await tokenizer();
  const source = [
    'project "task-board" {',
    '    version: "0.1.0"',
    '    entry: "src/main.srp"',
    '    type: "application"',
    '    dependencies {}',
    '} // end'
  ];
  assert.ok(highlighted(source[0], 'project', 'keyword.declaration.scarp-project', grammar));
  assert.ok(highlighted(source[0], 'task-board', 'string.quoted.double.scarp-project', grammar));
  for (let i = 1; i <= 3; i++) {
    const name = source[i].trim().split(':')[0];
    assert.ok(highlighted(source[i], name, 'support.type.property-name.scarp-project', grammar),
      name);
  }
  assert.ok(highlighted(source[4], 'dependencies', 'keyword.other.dependencies.scarp-project',
    grammar));
  assert.ok(highlighted(source[5], '// end', 'comment.line.double-slash.scarp-project',
    grammar));
  assert.ok(highlighted(source[4], '{', 'punctuation.section.block.scarp-project', grammar));
});

test('strings shield comment markers, field names and the project keyword', async () => {
  const grammar = await tokenizer();
  const string = scopes('  entry: "project version: // literal"', grammar);
  assert.ok(string.some(token => token.text.includes('// literal') &&
    token.scopes.includes('string.quoted.double.scarp-project')));
  assert.ok(!string.some(token =>
    token.scopes.includes('comment.line.double-slash.scarp-project')));
  assert.ok(!string.some(token => token.scopes.includes('keyword.declaration.scarp-project')));
  const comment = scopes('// version: "project" dependencies {}', grammar);
  assert.ok(!comment.some(token =>
    token.scopes.includes('support.type.property-name.scarp-project') ||
    token.scopes.includes('keyword.other.dependencies.scarp-project')));
  const longer = scopes('  version_extra: "0.1.0"', grammar);
  assert.ok(!longer.some(token =>
    token.scopes.includes('support.type.property-name.scarp-project')));
});

test('manifest strings recognize only quote and backslash escapes, with EOL recovery', async () => {
  const grammar = await tokenizer();
  const slash = String.fromCharCode(92);
  const quoted = '  entry: "src/a' + slash + '"' + 'b.srp"';
  assert.ok(highlighted(quoted, slash + '"', 'constant.character.escape.scarp-project',
    grammar));
  const invalid = '  entry: "src/a' + slash + 'n.srp"';
  assert.ok(highlighted(invalid, slash + 'n', 'invalid.illegal.escape.scarp-project',
    grammar));
  const open = grammar.tokenizeLine('  entry: "unfinished', null);
  const next = grammar.tokenizeLine('  type: "application"', open.ruleStack);
  assert.ok(next.tokens.some(token =>
    '  type: "application"'.slice(token.startIndex, token.endIndex).includes('type') &&
    token.scopes.includes('support.type.property-name.scarp-project')),
  'A malformed string cannot color every subsequent manifest field');
});
