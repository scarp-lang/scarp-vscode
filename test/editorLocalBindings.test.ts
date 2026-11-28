import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpLocalBindings, scarpBindingAt, scarpBindingReferences,
  type ScarpLocalBindings
} from '../src/editorLocalBindings';
import { fixtureStructure } from './editorFixture';

function index(source: string): ScarpLocalBindings {
  const result = scarpLocalBindings(source, fixtureStructure(source));
  assert.ok(result, 'Expected a valid read-only local index');
  return result;
}
function references(source: string, name: string, occurrence = 0) {
  const data = index(source);
  const matches = data.bindings.filter(b => b.name === name);
  const selected = matches[occurrence];
  assert.ok(selected, `Missing local ${name} declaration`);
  return scarpBindingReferences(data, selected).map(r => ({
    text: source.slice(r.span.start, r.span.end),
    start: r.span.start, kind: r.kind
  }));
}

test('recognizes simple immutable function-local bindings', () => {
  const source = 'funcra f() { bind count = 3; print(count); }';
  const data = index(source);
  assert.equal(data.bindings.length, 1);
  assert.equal(data.bindings[0].name, 'count');
  assert.equal(data.bindings[0].kind, 'immutable');
  assert.deepEqual(references(source, 'count').map(r => r.kind), ['definition', 'read']);
});

test('recognizes mutable locals and classifies simple assignments', () => {
  const source = 'funcra f() { var counter = 1; counter = 2; print(counter); }';
  const found = references(source, 'counter');
  assert.deepEqual(found.map(r => r.kind), ['definition', 'write', 'read']);
});

test('compound assignments count as writes', () => {
  for (const operator of ['+=', '-=', '*=', '/=', '%=']) {
    const source = `funcra f() { var n = 1; n ${operator} 2; }`;
    assert.deepEqual(references(source, 'n').map(r => r.kind),
      ['definition', 'write'], operator);
  }
});

test('reads are confined to the declaring function body', () => {
  const source = 'funcra first() { bind x = 3; print(x); }\nfuncra second() { print(x); }';
  const found = references(source, 'x');
  assert.equal(found.length, 2);
  assert.ok(found.every(item => item.start < source.indexOf('second')));
});

test('function parameters are visible within the body', () => {
  const source = 'funcra f(input: integer) { print(input); }';
  const found = references(source, 'input');
  assert.deepEqual(found.map(r => r.kind), ['definition', 'read']);
  assert.equal(index(source).bindings[0].kind, 'parameter');
});

test('parameter names are not interpreted as local declarations', () => {
  const source = 'funcra f(first: integer, second: string) { print(first, second); }';
  assert.deepEqual(index(source).bindings.map(b => b.name), ['first', 'second']);
});

test('shadowed locals resolve to the closest lexical block', () => {
  const source = 'funcra f() { bind n = 1; if true { bind n = 2; print(n); } print(n); }';
  const data = index(source);
  assert.equal(data.bindings.length, 2);
  const outer = references(source, 'n');
  const inner = references(source, 'n', 1);
  assert.equal(outer.length, 2);
  assert.equal(inner.length, 2);
  assert.equal(outer[1].start, source.lastIndexOf('print(n)') + 'print('.length);
  assert.equal(inner[1].start, source.indexOf('print(n)') + 'print('.length);
});

test('siblings do not see each other’s local variables', () => {
  const source = 'funcra f() { if true { bind n = 1; print(n); } if false { print(n); } }';
  assert.equal(references(source, 'n').length, 2);
});

test('a name used before its local declaration stays unresolved', () => {
  const source = 'funcra f() { print(x); bind x = 2; print(x); }';
  assert.deepEqual(references(source, 'x').map(r => r.kind), ['definition', 'read']);
});

test('a repeat index binds within its repeat body but not beyond', () => {
  const source = 'funcra f() { repeat 3 as i { print(i); } print(i); }';
  assert.equal(index(source).bindings[0].kind, 'repeat');
  assert.deepEqual(references(source, 'i').map(r => r.kind), ['definition', 'read']);
});

test('repeat loop index shadows an outer local of the same name', () => {
  const source = 'funcra f() { bind i = 4; repeat 3 as i { print(i); } print(i); }';
  assert.equal(references(source, 'i').length, 2);
  assert.equal(references(source, 'i', 1).length, 2);
});

test('multiple loops of the same index name do not share references', () => {
  const source = 'funcra f() { repeat 3 as i { print(i); } repeat 5 as i { print(i); } }';
  assert.equal(index(source).bindings.length, 2);
  assert.equal(references(source, 'i').length, 2);
  assert.equal(references(source, 'i', 1).length, 2);
});

test('strings containing identifiers cannot introduce references', () => {
  const source = 'funcra f() { bind n = 1; print("n = n"); print(n); }';
  assert.equal(references(source, 'n').length, 2);
});

test('comments containing variable names do not contribute references', () => {
  const source = 'funcra f() {\nbind n = 1; // n n n\nprint(n);\n}';
  assert.equal(references(source, 'n').length, 2);
});

test('a field access does not resolve to a same-named local variable', () => {
  const source = 'funcra f() { bind field = 1; object.field; print(field); }';
  assert.equal(references(source, 'field').length, 2);
});

test('a module-member selector does not resolve to a local name', () => {
  const source = 'funcra f() { bind value = 2; module::value; print(value); }';
  assert.equal(references(source, 'value').length, 2);
});

test('record labels are never linked to a local with the same spelling', () => {
  const source = 'funcra f() { bind label = 2; bind x = { label: 4 }; print(label); }';
  assert.equal(references(source, 'label').length, 2);
});

test('type annotation identifiers are excluded from variable reads', () => {
  const source = 'funcra f() { bind n = 4; bind x: n = 1; print(n); }';
  assert.equal(references(source, 'n').length, 2);
});

test('declarations from nested destructuring are not guessed', () => {
  const source = 'funcra f() { bind (left, right) = values; print(left); }';
  assert.deepEqual(index(source).bindings, []);
});

test('top-level symbols are outside the local-only index', () => {
  const source = 'bind global = 2;\nfuncra f() { print(global); }';
  assert.deepEqual(index(source).bindings, []);
});

test('functions with a similar but different name are isolated', () => {
  const source = 'funcra f() { bind n = 1; print(n); }\nfuncra ff() { bind n = 3; print(n); }';
  assert.equal(index(source).bindings.length, 2);
  assert.equal(references(source, 'n').length, 2);
  assert.equal(references(source, 'n', 1).length, 2);
});

test('parameter shadowing is lexically scoped', () => {
  const source = 'funcra f(n: integer) { print(n); if true { bind n = 3; print(n); } print(n); }';
  assert.deepEqual(references(source, 'n').map(r => r.kind),
    ['definition', 'read', 'read']);
  assert.deepEqual(references(source, 'n', 1).map(r => r.kind),
    ['definition', 'read']);
});

test('a missing local definition yields no accidental highlight group', () => {
  const source = 'funcra f() { print(undefinedName); }';
  const data = index(source);
  assert.deepEqual(data.bindings, []);
  assert.deepEqual(data.references, []);
});

test('cursor lookup selects a declaration and every resolved occurrence', () => {
  const source = 'funcra f() { bind value = 7; print(value); }';
  const data = index(source);
  const declaration = source.indexOf('value');
  const use = source.lastIndexOf('value');
  assert.equal(scarpBindingAt(data, declaration)?.name, 'value');
  assert.equal(scarpBindingAt(data, use + 2)?.name, 'value');
  assert.equal(scarpBindingAt(data, source.indexOf('print')), undefined);
});

test('invalid cursors cannot resolve an arbitrary symbol', () => {
  const data = index('funcra f() { bind a = 1; print(a); }');
  for (const cursor of [-1, Infinity, NaN, 999999]) {
    assert.equal(scarpBindingAt(data, cursor), undefined);
  }
});

test('an unrelated binding object cannot access another graph’s references', () => {
  const left = index('funcra f() { bind value = 2; print(value); }');
  const right = index('funcra g() { bind other = 1; }');
  assert.deepEqual(scarpBindingReferences(right, left.bindings[0]), []);
});

test('references preserve exact UTF-16 offsets after emoji', () => {
  const source = 'funcra f() { print("😀"); bind n = 4; print(n); }';
  const found = references(source, 'n');
  assert.equal(found[0].start, source.indexOf('n = 4'));
});

test('an invalid bracket sequence disables the whole lexical analysis', () => {
  for (const source of [
    'funcra f() { bind a = 2; ',
    'funcra f() { bind a = 2; } }',
    'funcra f() { bind a = (2; }'
  ]) {
    assert.equal(scarpLocalBindings(source, fixtureStructure(source)), undefined);
  }
});

test('resource limits reject expensive lexical analysis', () => {
  const source = 'funcra f() { bind a = 2; print(a); }';
  const parsed = fixtureStructure(source);
  for (const options of [
    { maximumSourceLength: 5 }, { maximumTokens: 5 },
    { maximumBindings: 0 }, { maximumReferences: 1 },
    { maximumScopes: NaN }
  ]) {
    assert.equal(scarpLocalBindings(source, parsed, options), undefined);
  }
});

test('empty files and functions without locals produce an empty index', () => {
  assert.deepEqual(index(''), { bindings: [], references: [], ambiguous: [] });
  assert.deepEqual(index('funcra f() { print(3); }'),
    { bindings: [], references: [], ambiguous: [] });
});

test('indexes are deterministic across repeated reads of unchanged snapshots', () => {
  const source = 'funcra f(n: integer) { bind x = n + 2; print(x); }';
  assert.deepEqual(index(source), index(source));
});
