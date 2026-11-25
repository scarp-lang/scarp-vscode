import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

interface AlphaVersion { patch: number; alpha: number; }
interface SnippetCompatibility {
  parseSnippetCutoff(value?: string): AlphaVersion | undefined;
  snippetMinimum(name: string): AlphaVersion | undefined;
  snippetSupported(name: string, cutoff?: AlphaVersion): boolean;
}
const root = path.resolve(__dirname, '../..');
const load = createRequire(__filename);
const { parseSnippetCutoff, snippetMinimum, snippetSupported } =
  load(path.join(root, 'scripts/snippet-compatibility.cjs')) as SnippetCompatibility;
const snippets = Object.keys(JSON.parse(fs.readFileSync(
  path.join(root, 'snippets/scarp.code-snippets'), 'utf8')));

test('legacy numeric cutoffs mean v0.0.6, never the new alpha series', () => {
  assert.deepEqual(parseSnippetCutoff('20'), { patch: 6, alpha: 20 });
  assert.deepEqual(parseSnippetCutoff('v0.0.7-alpha.1'), { patch: 7, alpha: 1 });
  assert.equal(snippetMinimum('Scarp: Basic print'), undefined);
  assert.deepEqual(snippetMinimum('Scarp: Historical (alpha.20)'), { patch: 6, alpha: 20 });
  assert.deepEqual(snippetMinimum('Scarp: New (v0.0.7-alpha.1)'), { patch: 7, alpha: 1 });
  const newName = 'Scarp: New (v0.0.7-alpha.1)';
  assert.equal(snippetSupported(newName, parseSnippetCutoff('999')), false);
  assert.equal(snippetSupported(newName, parseSnippetCutoff('v0.0.7-alpha.1')), true);
  assert.equal(snippetSupported(newName, parseSnippetCutoff('v0.0.8-alpha.1')), true);
  assert.equal(snippetSupported('Scarp: Future (v0.0.7-alpha.10)',
    parseSnippetCutoff('v0.0.7-alpha.2')), false);
});

test('all historical snippet inventories stay unchanged after the series transition', () => {
  const counts: Record<string, number> = {
    '6': 13, '7': 14, '9': 15, '11': 17, '12': 24,
    '17': 26, '20': 28, 'v0.0.6-alpha.20': 28, 'v0.0.7-alpha.1': 31
  };
  for (const [version, count] of Object.entries(counts)) {
    assert.equal(snippets.filter(name => snippetSupported(name, parseSnippetCutoff(version))).length,
      count, version);
  }
  assert.equal(snippets.filter(name => snippetSupported(name, parseSnippetCutoff())).length, 31);
});

test('malformed version-like requirements fail closed', () => {
  for (const value of ['', '0', '01', '-1', '1.5', 'Infinity', 'v0.0.7-alpha.0',
    'v0.0.7-alpha.01', 'v0.0.7-alpha.1-beta', '0.0.7-alpha.1', 'v0.0.7-alpha.9007199254740992']) {
    assert.throws(() => parseSnippetCutoff(value), /version/i, value);
  }
  for (const name of ['Example (alpha.01)', 'Example (alpha.0)', 'Example (v0.0.7-alpha.bad)']) {
    assert.throws(() => snippetSupported(name, parseSnippetCutoff('20')), /version|requirement/i);
  }
});
