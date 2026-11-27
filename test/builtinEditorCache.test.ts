import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BuiltinEditorCache } from '../src/builtinEditorCache';
import { BUILTIN_DOCUMENT_LIMIT, BUILTIN_DOCUMENT_TOKEN_LIMIT } from '../src/builtinLexicalContext';
import { scarpCompletionFromTokens } from '../src/builtinCompletion';
import { scarpBuiltinFromTokens } from '../src/builtinHelp';
import { scarpSignatureFromTokens, scarpSignatureAt } from '../src/builtinSignature';

test('snapshot reuse is exact, versioned and isolated by document', () => {
  const cache = new BuiltinEditorCache();
  const first = cache.get('a', 1, 'integer_gcd(1, 2);');
  assert.ok(first);
  assert.equal(cache.get('a', 1, first.source), first);
  assert.notEqual(cache.get('b', 1, first.source), first);
  assert.notEqual(cache.get('a', 2, first.source), first);
  assert.notEqual(cache.get('a', 2, 'integer_abs(1);'), first);
  cache.invalidate('a');
  assert.equal(cache.stats().entries, 1);
  cache.clear();
  assert.deepEqual(cache.stats(), { entries: 0, units: 0, tokens: 0 });
});

test('long literal contents never produce help; code after the delimiter does', () => {
  const cache = new BuiltinEditorCache();
  const inside = 'integer_gcd(1, 2);';
  const after = 'integer_gcd(3, 4);';
  const source = 'bind message = """\r\n' + 'x'.repeat(40_000) + '\r\n' + inside +
    '\r\n""";\r\n' + after;
  const snapshot = cache.get('a', 1, source);
  assert.ok(snapshot);
  for (const start of [source.indexOf(inside), source.lastIndexOf(after)]) {
    const isCode = start === source.lastIndexOf(after);
    const prefix = scarpCompletionFromTokens(snapshot.tokens, start + 10, start);
    assert.equal(prefix?.prefix, isCode ? 'integer_gc' : undefined);
    const hover = scarpBuiltinFromTokens(snapshot.tokens, source, start + 3, start, start + after.length);
    assert.equal(hover?.help.name, isCode ? 'integer_gcd' : undefined);
    const hint = scarpSignatureFromTokens(snapshot.tokens, start + 'integer_gcd(3, '.length);
    assert.equal(hint?.activeParameter, isCode ? 1 : undefined);
  }
});

test('querying cached future tokens agrees with prefix-only signatures', () => {
  const cache = new BuiltinEditorCache();
  const sources = [
    'text_replace("abc", "x", "y");',
    'integer_gcd(1, // comment\n 2);',
    'integer_gcd(1, custom(2));',
    'integer_gcd(1, r"abc");',
    'text_replace("""a\n,b""", "x", "y");',
    'integer_gcd(1, 2); integer_abs(3);'
  ];
  for (const source of sources) {
    const snapshot = cache.get('a', 1, source);
    assert.ok(snapshot);
    // Compare ordinary expression boundaries; a future third quote is
    // intentionally known to the editor snapshot rather than guessed.
    for (let cursor = 1; cursor <= source.length; cursor++) {
      if (source.includes('"""') && source[cursor - 1] === '"') continue;
      if (source[cursor - 1] === '/' && source[cursor] === '/') continue;
      assert.deepEqual(scarpSignatureFromTokens(snapshot.tokens, cursor),
        scarpSignatureAt(source.slice(0, cursor)), source + ' @ ' + cursor);
    }
  }
});

test('long whitespace does not lose preceding declaration and qualification context', () => {
  const cache = new BuiltinEditorCache();
  for (const preceding of ['module.', 'funcra', 'new', 'Type::']) {
    const source = preceding + '\n' + '// ignored\n'.repeat(3000) + 'integer_gcd(1, 2)';
    const snapshot = cache.get('a', 1, source);
    assert.ok(snapshot);
    const start = source.lastIndexOf('integer_gcd');
    assert.equal(scarpCompletionFromTokens(snapshot.tokens, start + 10, start), undefined);
    assert.equal(scarpBuiltinFromTokens(snapshot.tokens, source, start + 3, start, source.length), undefined);
    assert.equal(scarpSignatureFromTokens(snapshot.tokens, start + 12), undefined);
  }
});

test('cache bounds retained text, token counts, entries and oversized scans', () => {
  const cache = new BuiltinEditorCache();
  for (let i = 0; i < 10; i++) {
    assert.ok(cache.get(String(i), 1, ' '.repeat(BUILTIN_DOCUMENT_LIMIT)));
    assert.ok(cache.stats().units <= BUILTIN_DOCUMENT_LIMIT * 2);
    assert.ok(cache.stats().entries <= 4);
  }
  for (let i = 0; i < 10; i++) {
    assert.ok(cache.get(String(i), 2, ';'.repeat(BUILTIN_DOCUMENT_TOKEN_LIMIT)));
    assert.ok(cache.stats().tokens <= BUILTIN_DOCUMENT_TOKEN_LIMIT * 2);
  }
  const dense = ';'.repeat(BUILTIN_DOCUMENT_TOKEN_LIMIT + 1);
  assert.equal(cache.get('dense', 1, dense), undefined);
  assert.equal(cache.get('dense', 1, dense), undefined);
  assert.ok(cache.get('dense', 2, 'integer_gcd(1, 2)'));
  assert.equal(cache.get('oversize', 1, ' '.repeat(BUILTIN_DOCUMENT_LIMIT + 1)), undefined);
});
