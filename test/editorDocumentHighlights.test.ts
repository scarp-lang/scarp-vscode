import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpDocumentHighlights } from '../src/editorDocumentHighlights';
import { scarpLocalCallGraph } from '../src/editorCallHierarchy';
import { scarpLocalBindings } from '../src/editorLocalBindings';
import { fixtureStructure } from './editorFixture';

function highlights(text: string, at: number,
  options: Parameters<typeof scarpDocumentHighlights>[3] = {}) {
  const parsed = fixtureStructure(text);
  const graph = scarpLocalCallGraph(text, parsed);
  const bindings = scarpLocalBindings(text, parsed);
  return scarpDocumentHighlights(graph, bindings, at, options).map(item => ({
    text: text.slice(item.span.start, item.span.end),
    start: item.span.start, kind: item.kind
  }));
}

test('local immutable declarations and uses appear together', () => {
  const source = 'funcra f() { bind x = 1; print(x); }';
  const result = highlights(source, source.indexOf('x = 1'));
  assert.deepEqual(result.map(x => x.kind), ['write', 'read']);
  assert.deepEqual(result.map(x => x.text), ['x', 'x']);
});

test('a local parameter highlights its declaration and reads', () => {
  const source = 'funcra f(value: integer) { print(value); print(value); }';
  const result = highlights(source, source.indexOf('value'));
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(x => x.kind), ['write', 'read', 'read']);
});

test('mutable assignments are marked as writes', () => {
  const source = 'funcra f() { var count = 0; count += 1; print(count); }';
  const result = highlights(source, source.indexOf('count = 0'));
  assert.deepEqual(result.map(x => x.kind), ['write', 'write', 'read']);
});

test('a function declaration highlights all local calls', () => {
  const source = 'funcra a() { b(); b(); }\nfuncra b() {}';
  const at = source.indexOf('b() {}');
  const result = highlights(source, at);
  assert.deepEqual(result.map(x => x.text), ['b', 'b', 'b']);
  assert.deepEqual(result.map(x => x.kind), ['read', 'read', 'write']);
});

test('a callsite can select its matching function declaration', () => {
  const source = 'funcra a() { b(); }\nfuncra b() {}';
  const result = highlights(source, source.indexOf('b();'));
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(x => x.kind), ['read', 'write']);
});

test('shadowed local names select only the correct declaration', () => {
  const source = 'funcra f() { bind n = 1; if true { bind n = 2; print(n); } print(n); }';
  const inner = highlights(source, source.indexOf('bind n = 2') + 'bind '.length);
  const outer = highlights(source, source.indexOf('bind n = 1') + 'bind '.length);
  assert.equal(inner.length, 2);
  assert.equal(outer.length, 2);
  assert.notDeepEqual(inner.map(x => x.start), outer.map(x => x.start));
});

test('same name in another function remains independent', () => {
  const source = 'funcra a() { bind n = 1; print(n); }\nfuncra b() { bind n = 2; print(n); }';
  const result = highlights(source, source.indexOf('bind n = 1') + 5);
  assert.equal(result.length, 2);
  assert.ok(result.every(x => x.start < source.indexOf('funcra b')));
});

test('comments and strings can never select a lexical symbol', () => {
  const source = 'funcra f() { bind n = 1; print("n"); // n\nprint(n); }';
  const quoted = source.indexOf('"n"') + 1;
  const comment = source.indexOf('// n') + 3;
  assert.deepEqual(highlights(source, quoted), []);
  assert.deepEqual(highlights(source, comment), []);
});

test('a record field or method selector is not assigned to an unrelated local', () => {
  const source = 'funcra f() { bind value = 1; obj.value; print(value); }';
  const field = source.indexOf('.value') + 1;
  assert.deepEqual(highlights(source, field), []);
});

test('function and local highlighting can be controlled independently', () => {
  const source = 'funcra f() { bind n = 1; print(n); }';
  const local = source.indexOf('bind n') + 5;
  const functionName = source.indexOf('f()');
  assert.deepEqual(highlights(source, local, { includeLocalVariables: false }), []);
  assert.deepEqual(highlights(source, functionName,
    { includeFunctionReferences: false }), []);
});

test('a cursor on irrelevant punctuation has no lexical highlights', () => {
  const source = 'funcra f() { bind n = 1; print(n); }';
  assert.deepEqual(highlights(source, source.indexOf('{')), []);
  assert.deepEqual(highlights(source, source.indexOf(';')), []);
});

test('invalid or noninteger positions never return a guessed range', () => {
  const source = 'funcra f(n: integer) { print(n); }';
  for (const cursor of [-1, Infinity, NaN, 9999]) {
    assert.deepEqual(highlights(source, cursor), []);
  }
});

test('highlight budget returns no partial result', () => {
  const source = 'funcra a() { b(); b(); b(); }\nfuncra b() {}';
  const selected = source.indexOf('funcra b') + 7;
  assert.deepEqual(highlights(source, selected, { maximumHighlights: 2 }), []);
});

test('zero, fractional or NaN highlight limits fail closed', () => {
  const source = 'funcra f(n: integer) { print(n); }';
  for (const value of [0, -1, NaN, 1.2, Infinity]) {
    assert.deepEqual(highlights(source, source.indexOf('n: integer'), {
      maximumHighlights: value
    }), []);
  }
});

test('source spans remain UTF-16 exact after emoji and combining marks', () => {
  const source = 'funcra f(n: integer) { print("😀é"); print(n); }';
  const result = highlights(source, source.indexOf('n: integer'));
  assert.equal(result[1].start, source.lastIndexOf('n);'));
});

test('without either index no highlights are invented', () => {
  assert.deepEqual(scarpDocumentHighlights(undefined, undefined, 0), []);
});

test('a future duplicate function spelling never yields ambiguous highlights', () => {
  const source = 'funcra a() { b(); }\nfuncra b() {}\nfuncra b() {}';
  assert.deepEqual(highlights(source, source.indexOf('b();')), []);
});

test('individual matching spans are sorted in ascending file order', () => {
  const source = 'funcra a() { b(); }\nfuncra b() { b(); }';
  const result = highlights(source, source.indexOf('funcra b') + 7);
  assert.deepEqual(result.map(r => r.start),
    [...result.map(r => r.start)].sort((a, b) => a - b));
});
