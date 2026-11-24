import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ScarpStructureCache } from '../src/editorStructureCache';

test('cold cache scans and reuses identical source snapshots', () => {
  const cache = new ScarpStructureCache();
  const first = cache.get('file:a', 1, 'print((1, 2));');
  assert.ok(first);
  const second = cache.get('file:a', 1, 'print((1, 2));');
  assert.equal(first, second);
  assert.deepEqual(cache.stats(), {
    entries: 1, allocatedBytes: 'print((1, 2));'.length * 2,
    hits: 1, misses: 1, evictions: 0
  });
});
test('version changes invalidate stale scan ranges', () => {
  const cache = new ScarpStructureCache();
  const before = cache.get('file:a', 1, 'print(1);');
  const after = cache.get('file:a', 2, 'print((1, 2));');
  assert.notEqual(before, after);
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().misses, 2);
});
test('identical version with changed source cannot reuse obsolete snapshot', () => {
  const cache = new ScarpStructureCache();
  const before = cache.get('file:a', 1, 'print(1);');
  const after = cache.get('file:a', 1, 'print(2, 3);');
  assert.notEqual(before, after);
  assert.equal(cache.stats().hits, 0);
});
test('different documents never accidentally share lexical tokens', () => {
  const cache = new ScarpStructureCache();
  const a = cache.get('file:a', 1, 'print(1);');
  const b = cache.get('file:b', 1, 'print(2);');
  assert.notEqual(a, b);
  assert.equal(cache.stats().entries, 2);
});
test('entry LRU eviction preserves the most recently touched document', () => {
  const cache = new ScarpStructureCache({ maximumEntries: 2 });
  cache.get('file:a', 1, 'print(1);');
  cache.get('file:b', 1, 'print(2);');
  cache.get('file:a', 1, 'print(1);');
  cache.get('file:c', 1, 'print(3);');
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().evictions, 1);
  cache.get('file:b', 1, 'print(2);');
  assert.equal(cache.stats().misses, 4);
});
test('cache memory accounting includes UTF-16 code units', () => {
  const cache = new ScarpStructureCache({ maximumBytes: 28 });
  const value = 'print("😀");';
  cache.get('file:a', 1, value);
  assert.equal(cache.stats().allocatedBytes, value.length * 2);
  cache.get('file:b', 1, 'print(1);');
  assert.ok(cache.stats().allocatedBytes <= 28);
  assert.ok(cache.stats().evictions >= 1);
});
test('too-large snapshots are scanned without being retained in cache', () => {
  const cache = new ScarpStructureCache({ maximumBytes: 16 });
  const result = cache.get('file:large', 1, 'print((1, 2));');
  assert.ok(result);
  assert.equal(cache.stats().entries, 0);
});
test('unscannable excessive nesting is negatively cached per source revision', () => {
  const cache = new ScarpStructureCache();
  const huge = '('.repeat(300);
  assert.equal(cache.get('file:deep', 1, huge), undefined);
  assert.equal(cache.get('file:deep', 1, huge), undefined);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.get('file:deep', 2, 'print(1);')?.pairs.length, 1);
});
test('invalid keys and versions cannot create any cache entry', () => {
  const cache = new ScarpStructureCache();
  for (const version of [-1, 1.5, NaN, Infinity]) {
    assert.equal(cache.get('file:a', version, 'print(1);'), undefined);
  }
  assert.equal(cache.get('', 1, 'print(1);'), undefined);
  assert.equal(cache.stats().entries, 0);
});
test('invalid capacity and memory limits disable caching safely', () => {
  for (const value of [-1, 0, 0.5, NaN, Infinity]) {
    const cache = new ScarpStructureCache({ maximumEntries: value });
    assert.equal(cache.get('a', 1, 'print(1);'), undefined);
    assert.equal(cache.stats().entries, 0);
  }
});
test('manual invalidation releases the exact owned entry', () => {
  const cache = new ScarpStructureCache();
  cache.get('a', 1, 'print(1);');
  cache.get('b', 1, 'print(2);');
  cache.invalidate('a');
  assert.equal(cache.stats().entries, 1);
  cache.invalidate('a');
  assert.equal(cache.stats().entries, 1);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().allocatedBytes, 0);
});
test('repeat edits retain bounded allocations across many documents', () => {
  const cache = new ScarpStructureCache({
    maximumEntries: 5, maximumBytes: 1500
  });
  for (let i = 0; i < 1000; i++) {
    cache.get('file:' + (i % 20), i,
      'funcra f() { print(' + i + '); }');
    assert.ok(cache.stats().entries <= 5);
    assert.ok(cache.stats().allocatedBytes <= 1500);
  }
  assert.ok(cache.stats().evictions > 0);
});
test('a structural scan limit is preserved behind cache access', () => {
  const cache = new ScarpStructureCache({
    scan: { maxLength: 10, maxTokens: 2, maxDepth: 1 }
  });
  assert.equal(cache.get('a', 1, 'print((1, 2));'), undefined);
  assert.equal(cache.get('b', 1, 'a b c'), undefined);
  assert.ok(cache.get('c', 1, 'x'));
});
