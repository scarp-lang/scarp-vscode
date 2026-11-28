import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ScarpEditorAnalysisCache } from '../src/editorAnalysisCache';
import { fixtureStructure } from './editorFixture';

const sample = 'funcra alpha(x: integer) { beta(); print(x); }\nfuncra beta() {}';
const key = 'file:///workspace/main.srp';

test('the first graph request computes the local graph and caches it', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const result = cache.graph(key, 1, sample, parsed);
  assert.ok(result);
  assert.equal(result.nodes.length, 2);
  assert.equal(cache.stats().callGraphComputations, 1);
  assert.equal(cache.stats().entries, 1);
});

test('repeat graph requests reuse exactly the same cached immutable view', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const first = cache.graph(key, 1, sample, parsed);
  const second = cache.graph(key, 1, sample, parsed);
  assert.equal(first, second);
  assert.equal(cache.stats().callGraphComputations, 1);
  assert.equal(cache.stats().hits, 1);
});

test('the binding index is cached independently from the call graph', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const first = cache.bindings(key, 1, sample, parsed);
  const second = cache.bindings(key, 1, sample, parsed);
  assert.equal(first, second);
  assert.equal(cache.stats().bindingComputations, 1);
  assert.equal(cache.stats().callGraphComputations, 0);
});

test('graph and binding queries on the same version share one retained snapshot', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  assert.ok(cache.graph(key, 1, sample, parsed));
  assert.ok(cache.bindings(key, 1, sample, parsed));
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().allocatedBytes, sample.length * 2);
  assert.equal(cache.stats().callGraphComputations, 1);
  assert.equal(cache.stats().bindingComputations, 1);
});

test('an updated document version invalidates the previously computed index', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const first = cache.graph(key, 1, sample, parsed);
  const next = cache.graph(key, 2, sample, parsed);
  assert.notEqual(first, next);
  assert.equal(cache.stats().callGraphComputations, 2);
});

test('same version with changed bytes never reuses stale source analysis', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const first = cache.graph(key, 1, sample, parsed);
  const updated = sample.replace('beta();', 'beta(); beta();');
  const second = cache.graph(key, 1, updated, fixtureStructure(updated));
  assert.notEqual(first, second);
  assert.equal(second?.calls.length, 2);
});

test('a changed structure object is treated as a new scanner snapshot', () => {
  const cache = new ScarpEditorAnalysisCache();
  const first = cache.graph(key, 1, sample, fixtureStructure(sample));
  const next = cache.graph(key, 1, sample, fixtureStructure(sample));
  assert.notEqual(first, next);
  assert.equal(cache.stats().callGraphComputations, 2);
});

test('source length and parsed structure length must agree', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const corrupted = { ...parsed, length: parsed.length - 1 };
  assert.equal(cache.graph(key, 1, sample, corrupted), undefined);
  assert.equal(cache.bindings(key, 1, sample, corrupted), undefined);
  assert.equal(cache.stats().entries, 0);
});

test('the oldest snapshot is evicted once entry count exceeds capacity', () => {
  const cache = new ScarpEditorAnalysisCache({ maximumEntries: 2 });
  for (const uri of ['a', 'b', 'c']) {
    cache.graph(uri, 1, sample, fixtureStructure(sample));
  }
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().evictions, 1);
});

test('least recently used entry survives over an older entry', () => {
  const cache = new ScarpEditorAnalysisCache({ maximumEntries: 2 });
  const a = fixtureStructure(sample), b = fixtureStructure(sample);
  cache.graph('a', 1, sample, a);
  cache.graph('b', 1, sample, b);
  cache.graph('a', 1, sample, a);
  cache.graph('c', 1, sample, fixtureStructure(sample));
  const hits = cache.stats().hits;
  cache.graph('a', 1, sample, a);
  assert.equal(cache.stats().hits, hits + 1);
});

test('byte-budget evictions bound retained UTF-16 source memory', () => {
  const cache = new ScarpEditorAnalysisCache({
    maximumEntries: 10, maximumTotalBytes: sample.length * 2 + 1
  });
  cache.graph('a', 1, sample, fixtureStructure(sample));
  cache.graph('b', 1, sample, fixtureStructure(sample));
  assert.equal(cache.stats().entries, 1);
  assert.ok(cache.stats().allocatedBytes <= sample.length * 2 + 1);
});

test('a snapshot larger than total byte budget is computed but not retained', () => {
  const cache = new ScarpEditorAnalysisCache({ maximumTotalBytes: 8 });
  const parsed = fixtureStructure(sample);
  assert.ok(cache.graph(key, 1, sample, parsed));
  assert.ok(cache.graph(key, 1, sample, parsed));
  assert.equal(cache.stats().callGraphComputations, 2);
  assert.equal(cache.stats().entries, 0);
});

test('invalidating a selected document never discards another document', () => {
  const cache = new ScarpEditorAnalysisCache();
  const a = fixtureStructure(sample), b = fixtureStructure(sample);
  cache.graph('a', 1, sample, a);
  cache.graph('b', 1, sample, b);
  cache.invalidate('a');
  assert.equal(cache.stats().entries, 1);
  const hits = cache.stats().hits;
  cache.graph('b', 1, sample, b);
  assert.equal(cache.stats().hits, hits + 1);
});

test('cache clearing releases all computed indexes and accounting', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  cache.graph(key, 1, sample, parsed);
  cache.bindings(key, 1, sample, parsed);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().allocatedBytes, 0);
});

test('malformed capacity options fail closed', () => {
  for (const value of [0, -1, NaN, Infinity, 0.5]) {
    const cache = new ScarpEditorAnalysisCache({ maximumEntries: value });
    assert.equal(cache.graph(key, 1, sample, fixtureStructure(sample)), undefined);
    assert.equal(cache.stats().entries, 0);
  }
});

test('empty keys and malformed version numbers never enter the cache', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  for (const version of [-1, Infinity, NaN, 1.4]) {
    assert.equal(cache.graph(key, version, sample, parsed), undefined);
  }
  assert.equal(cache.graph('', 1, sample, parsed), undefined);
  assert.equal(cache.stats().entries, 0);
});

test('a bogus URI-sized identifier is rejected before allocating source data', () => {
  const cache = new ScarpEditorAnalysisCache();
  assert.equal(cache.graph('x'.repeat(8193), 1, sample, fixtureStructure(sample)), undefined);
  assert.equal(cache.stats().allocatedBytes, 0);
});

test('a malformed source cap does not turn into an infinite analysis allowance', () => {
  for (const n of [-1, 0, 2_000_001, NaN, Infinity]) {
    const cache = new ScarpEditorAnalysisCache({ maximumSourceBytes: n });
    assert.equal(cache.graph(key, 1, sample, fixtureStructure(sample)), undefined);
  }
});

test('separate instances never share source or diagnostics', () => {
  const first = new ScarpEditorAnalysisCache();
  const second = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  assert.notEqual(first.graph(key, 1, sample, parsed), second.graph(key, 1, sample, parsed));
  assert.equal(first.stats().entries, 1);
  assert.equal(second.stats().entries, 1);
});

test('repeated cache reads cannot mutate source or structure values', () => {
  const cache = new ScarpEditorAnalysisCache();
  const parsed = fixtureStructure(sample);
  const before = JSON.stringify(parsed);
  for (let i = 0; i < 50; i++) {
    assert.ok(cache.graph(key, 1, sample, parsed));
    assert.ok(cache.bindings(key, 1, sample, parsed));
  }
  assert.equal(JSON.stringify(parsed), before);
  assert.equal(cache.stats().callGraphComputations, 1);
  assert.equal(cache.stats().bindingComputations, 1);
});
