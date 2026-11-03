import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiagnosticOwners } from '../src/problemOwners';

test('verifying a second entry point preserves unrelated Problems', () => {
  const owners = new DiagnosticOwners<string>();
  assert.deepEqual([...owners.replace('first', new Map([['first', ['E0001']]]))], [
    ['first', ['E0001']]
  ]);
  assert.deepEqual([...owners.replace('second', new Map([['second', ['E0002']]]))], [
    ['second', ['E0002']]
  ]);
  assert.deepEqual([...owners.replace('first', new Map())], [['first', []]]);
  // Second verification still owns its diagnostic.
  assert.deepEqual([...owners.invalidateChanged('second')], [['second', []]]);
});

test('shared imported file diagnostics survive replacement of one owner', () => {
  const owners = new DiagnosticOwners<string>();
  owners.replace('one', new Map([['imported', ['from one']]]));
  assert.deepEqual(
    [...owners.replace('two', new Map([['imported', ['from two']]]))],
    [['imported', ['from one', 'from two']]]
  );
  assert.deepEqual([...owners.replace('one', new Map())], [
    ['imported', ['from two']]
  ]);
});

test('editing one document only clears the verification it invalidates', () => {
  const owners = new DiagnosticOwners<string>();
  owners.replace('one', new Map([
    ['one', ['one error']],
    ['lib', ['imported error']]
  ]));
  owners.replace('two', new Map([['two', ['two error']]]));
  assert.deepEqual([...owners.invalidateChanged('one')], [
    ['one', []],
    ['lib', []]
  ]);
  assert.deepEqual([...owners.invalidateChanged('two')], [['two', []]]);
});

test('editing a shared imported error keeps unrelated roots intact', () => {
  const owners = new DiagnosticOwners<string>();
  owners.replace('a', new Map([['lib', ['from a']]]));
  owners.replace('b', new Map([['lib', ['from b']]]));
  owners.replace('c', new Map([['c', ['unrelated']]]));
  assert.deepEqual([...owners.invalidateChanged('lib')], [['lib', []]]);
  assert.deepEqual([...owners.replace('c', new Map())], [['c', []]]);
});
