import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpLocalRenamePlan, validScarpLocalRenameName
} from '../src/editorLocalRename';
import { fixtureStructure, applyEdits } from './editorFixture';

function plan(source: string, at: number, name: unknown,
  options: Parameters<typeof scarpLocalRenamePlan>[4] = {}) {
  return scarpLocalRenamePlan(source, fixtureStructure(source), at, name, options);
}
function renamed(source: string, at: number, name: string) {
  const result = plan(source, at, name);
  assert.ok(result, 'A conservative rename plan was expected');
  return applyEdits(source, result.edits);
}

test('renames a local declaration and only its resolved uses', () => {
  const source = 'funcra f() { bind count = 1; print(count); print(count); }';
  assert.equal(renamed(source, source.indexOf('count'), 'total'),
    'funcra f() { bind total = 1; print(total); print(total); }');
});

test('renaming from a use targets its declaration', () => {
  const source = 'funcra f() { var value = 3; print(value); }';
  assert.equal(renamed(source, source.lastIndexOf('value'), 'result'),
    'funcra f() { var result = 3; print(result); }');
});

test('rename includes mutable assignments', () => {
  const source = 'funcra f() { var n = 2; n += 3; print(n); }';
  assert.equal(renamed(source, source.indexOf('n ='), 'counter'),
    'funcra f() { var counter = 2; counter += 3; print(counter); }');
});

test('renames function parameters and their local references', () => {
  const source = 'funcra calc(input: integer) -> integer { return input + input; }';
  assert.equal(renamed(source, source.indexOf('input'), 'operand'),
    'funcra calc(operand: integer) -> integer { return operand + operand; }');
});

test('renames a counted repeat index inside its loop', () => {
  const source = 'funcra f() { repeat 4 as index { print(index); } }';
  assert.equal(renamed(source, source.indexOf('as index') + 3, 'iteration'),
    'funcra f() { repeat 4 as iteration { print(iteration); } }');
});

test('renaming a shadowed symbol never mutates its sibling binding', () => {
  const source = 'funcra f() { bind x = 1; if true { bind x = 2; print(x); } print(x); }';
  const inner = renamed(source, source.indexOf('bind x = 2') + 5, 'inner');
  assert.ok(inner.includes('bind x = 1;'));
  assert.ok(inner.includes('bind inner = 2; print(inner);'));
  assert.ok(inner.endsWith('print(x); }'));
});

test('renaming an outer binding retains an inner shadowing name', () => {
  const source = 'funcra f() { bind x = 1; if true { bind x = 2; print(x); } print(x); }';
  const outer = renamed(source, source.indexOf('bind x = 1') + 5, 'outer');
  assert.ok(outer.includes('bind outer = 1;'));
  assert.ok(outer.includes('bind x = 2; print(x);'));
  assert.ok(outer.endsWith('print(outer); }'));
});

test('no rename can capture a function-local name already in use', () => {
  const source = 'funcra f() { bind x = 1; bind y = 2; print(x + y); }';
  assert.equal(plan(source, source.indexOf('bind x') + 5, 'y'), undefined);
});

test('an unrelated function does not receive changes', () => {
  const source = 'funcra a() { bind x = 1; print(x); }\nfuncra b() { bind x = 2; print(x); }';
  const result = renamed(source, source.indexOf('bind x') + 5, 'first');
  assert.ok(result.includes('funcra b() { bind x = 2; print(x); }'));
});

test('strings and comments are never rewritten', () => {
  const source = 'funcra f() {\nbind x = 1; // x x\nprint("x", x);\n}';
  const result = renamed(source, source.indexOf('bind x') + 5, 'value');
  assert.ok(result.includes('// x x'));
  assert.ok(result.includes('print("x", value);'));
});

test('record-field access remains unchanged', () => {
  const source = 'funcra f() { bind field = 1; obj.field; print(field); }';
  const result = renamed(source, source.indexOf('bind field') + 5, 'localField');
  assert.ok(result.includes('obj.field;'));
  assert.ok(result.includes('print(localField);'));
});

test('simple function calls are not treated as local bindings', () => {
  const source = 'funcra a() { b(); }\nfuncra b() {}';
  assert.equal(plan(source, source.indexOf('b();'), 'changed'), undefined);
});

test('top-level imported or exported symbols are out of scope', () => {
  const source = 'bind global = 3;\nfuncra f() { print(global); }';
  assert.equal(plan(source, source.indexOf('global'), 'something'), undefined);
});

test('invalid identifiers are rejected without editing', () => {
  const source = 'funcra f() { bind x = 2; print(x); }';
  for (const replacement of [
    '', '0bad', 'two words', 'x-y', 'src/name', 'привет',
    '.', '..', 'a\\b', '😀', 'a\nb', 'x\u0000y', 2, null, undefined,
    'x'.repeat(65)
  ]) {
    assert.equal(plan(source, source.indexOf('bind x') + 5, replacement), undefined);
  }
});

test('language reserved keywords cannot be introduced by a rename', () => {
  for (const keyword of ['bind', 'var', 'funcra', 'return', 'if', 'while',
    'true', 'false', 'new', 'record', 'variant', 'string', 'print', 'as', 'pub']) {
    assert.equal(validScarpLocalRenameName(keyword), false, keyword);
  }
});

test('ordinary ASCII identifiers and underscored names remain valid', () => {
  for (const value of ['result', '_value', 'camelCase', 'snake_case', 'X7']) {
    assert.equal(validScarpLocalRenameName(value), true, value);
  }
});

test('a requested no-op rename is rejected rather than emitting empty edits', () => {
  const source = 'funcra f() { bind x = 3; print(x); }';
  assert.equal(plan(source, source.indexOf('bind x') + 5, 'x'), undefined);
});

test('a potential new-name free identifier disables capture', () => {
  const source = 'funcra f() { bind x = 3; print(total); print(x); }';
  assert.equal(plan(source, source.indexOf('bind x') + 5, 'total'), undefined);
});

test('renaming cannot introduce a name that matches a callable within the same function', () => {
  const source = 'funcra f() { bind x = 3; something(); print(x); }';
  assert.equal(plan(source, source.indexOf('bind x') + 5, 'something'), undefined);
});

test('a source path context cannot authorize a local rename', () => {
  const source = 'funcra f() { bind x = 1; object.x; }';
  assert.equal(plan(source, source.indexOf('object.x') + 7, 'renamed'), undefined);
});

test('invalid cursor offsets never produce a rename', () => {
  const source = 'funcra f() { bind x = 1; }';
  for (const offset of [-1, NaN, Infinity, source.length, source.length + 1]) {
    assert.equal(plan(source, offset, 'renamed'), undefined);
  }
});

test('no unsafe rename from malformed unmatched source', () => {
  const source = 'funcra f() { bind x = 2;';
  assert.equal(plan(source, source.indexOf('x ='), 'changed'), undefined);
});

test('the rename edit budget rejects a partial document mutation', () => {
  const source = 'funcra f() { bind x = 2; print(x); print(x); }';
  assert.equal(plan(source, source.indexOf('bind x') + 5, 'changed', {
    maximumEdits: 2
  }), undefined);
});

test('invalid editor budget values are rejected', () => {
  const source = 'funcra f() { bind x = 2; print(x); }';
  for (const options of [
    { maximumTextLength: 1 }, { maximumEdits: 0 },
    { maximumIdentifierLength: -1 }, { maximumIdentifierLength: NaN }
  ]) {
    assert.equal(plan(source, source.indexOf('bind x') + 5, 'changed', options), undefined);
  }
});

test('all proposed replacement ranges are ordered and nonoverlapping', () => {
  const source = 'funcra f() { bind x = 2; print(x); print(x); }';
  const result = plan(source, source.indexOf('bind x') + 5, 'changed');
  assert.ok(result);
  let previous = 0;
  for (const edit of result.edits) {
    assert.ok(edit.start >= previous);
    assert.equal(source.slice(edit.start, edit.end), 'x');
    previous = edit.end;
  }
});

test('Unicode before the local name does not shift its UTF-16 edit offsets', () => {
  const source = 'funcra f() { print("😀"); bind n = 1; print(n); }';
  const result = plan(source, source.indexOf('bind n') + 5, 'result');
  assert.ok(result);
  assert.equal(result.edits[0].start, source.indexOf('n = 1'));
});

test('a structurally mismatched index fails closed', () => {
  const source = 'funcra f() { bind x = 2; print(x); }';
  const old = fixtureStructure('funcra f() { bind x = 3; print(x); }\n');
  assert.equal(scarpLocalRenamePlan(source, old, source.indexOf('bind x') + 5, 'changed'), undefined);
});

test('empty and comments-only files have no renameable local symbols', () => {
  for (const source of ['', '// bind x = 1', 'print("bind x = 1");']) {
    assert.equal(plan(source, 0, 'changed'), undefined);
  }
});
