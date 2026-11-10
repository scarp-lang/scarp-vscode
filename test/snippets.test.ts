import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
interface Snippet { prefix: string; body: string[]; description: string; }
const snippets = JSON.parse(fs.readFileSync(
  path.join(root, 'snippets/scarp.code-snippets'), 'utf8'
)) as Record<string, Snippet>;

test('registers 13 bounded Scarp snippets with unique prefixes', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.contributes.snippets,
    [{ language: 'scarp', path: './snippets/scarp.code-snippets' }]);
  assert.equal(Object.keys(snippets).length, 13);
  const prefixes = new Set<string>();
  for (const [name, snippet] of Object.entries(snippets)) {
    assert.ok(name.startsWith('Scarp: '));
    assert.match(snippet.prefix, /^s[a-z]+$/);
    assert.ok(!prefixes.has(snippet.prefix), 'Duplicate snippet prefix');
    prefixes.add(snippet.prefix);
    assert.ok(snippet.description.length >= 25);
    assert.ok(Array.isArray(snippet.body) && snippet.body.length > 0);
    assert.ok(snippet.body.every(line => typeof line === 'string' && line.length < 200));
    assert.ok(snippet.body.join('\n').length < 2000);
    assert.ok(snippet.body.includes('$0'), 'Missing final cursor stop');
  }
});

test('documents minimum compiler version and noninteractive input behavior', () => {
  for (const [name, snippet] of Object.entries(snippets)) {
    if (name.includes('(alpha.6)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.6\+/);
    }
  }
  assert.match(snippets['Scarp: Read redirected input (alpha.6)'].description,
    /no interactive prompt/);
  assert.match(snippets['Scarp: Read redirected input (alpha.6)'].body.join('\n'),
    /redirected UTF-8 stdin/);
});
