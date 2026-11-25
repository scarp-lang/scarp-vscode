import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpSourceCompletions, SOURCE_COMPLETION_LIMIT } from '../src/sourceCompletion';
import { scarpCompletionPrefixAt } from '../src/builtinCompletion';

const names = (source: string, prefix: string) =>
  scarpSourceCompletions(source, prefix).map(item => item.name);

test('completed declarations in unsaved text are discoverable with accurate kinds and offsets', () => {
  const source = 'print("🙂");\nbind total_count = 1;\nvar total_value = 2;\nprint(';
  const result = scarpSourceCompletions(source, 'total_');
  assert.deepEqual(result.map(x => [x.name, x.kind]), [
    ['total_count', 'constant'], ['total_value', 'variable']
  ]);
  for (const item of result) assert.equal(source.slice(item.declaration, item.declaration + item.name.length), item.name);
  assert.deepEqual(names('bind total_count = ', 'total_'), []);
  assert.deepEqual(names('bind total_count: integer ', 'total_'), []);
  assert.deepEqual(names('bind total_count = ; print(', 'total_'), []);
});

test('nested lexical blocks discard siblings and prefer the nearest matching name', () => {
  const source = [
    'bind local_outer = 1;',
    'if true { bind local_closed = 2; }',
    'if true { bind local_outer = 3; var local_inner = 4; print('
  ].join('\n');
  const result = scarpSourceCompletions(source, 'local_');
  assert.deepEqual(result.map(x => x.name), ['local_outer', 'local_inner']);
  assert.equal(result[0].declaration, source.lastIndexOf('local_outer'));
  assert.deepEqual(names(source + '1); } print(', 'local_'), ['local_outer']);
});

test('typed parameters, recursion, completed functions and imports are distinct candidates', () => {
  const source = [
    'import "math.srp" as math_module;',
    'pure funcra calculate_sum(first_value: array<integer, 2>, second_value: map<string, integer>) -> integer {',
    '  bind local_result = 2;',
    '  print('
  ].join('\n');
  assert.deepEqual(names(source, 'first_'), ['first_value']);
  assert.deepEqual(names(source, 'second_'), ['second_value']);
  assert.deepEqual(names(source, 'calculate_'), ['calculate_sum']);
  assert.deepEqual(names(source, 'math_'), ['math_module']);
  assert.deepEqual(names(source, 'local_'), ['local_result']);
  const after = source + '1); return 1; } print(';
  assert.deepEqual(names(after, 'first_'), []);
  assert.deepEqual(names(after, 'local_'), []);
  assert.deepEqual(names(after, 'calculate_'), ['calculate_sum']);
});

test('a nested callable never invents outer local captures', () => {
  const source = 'funcra outer_func(outer_param: integer) -> integer { ' +
    'bind outer_local = 1; pure funcra inner_func(inner_param: integer) -> integer { print(';
  assert.deepEqual(names(source, 'outer_'), ['outer_func']);
  assert.deepEqual(names(source, 'inner_'), ['inner_func', 'inner_param']);
});

test('lexical completion refuses comments, strings, declarations and qualified names', () => {
  for (const [line, preceding] of [
    ['// total_', ''], ['print("total_', ''], ['bind total_', ''],
    ['total_', 'module. // note\n'], ['total_', 'funcra\n'], ['Type::total_', '']
  ]) assert.equal(scarpCompletionPrefixAt(line, line.length, preceding), undefined);
  const line = 'print(total_old);';
  const range = scarpCompletionPrefixAt(line, 'print(total_'.length);
  assert.deepEqual(range, { start: 6, end: 15, prefix: 'total_' });
  assert.deepEqual(names('bind total_value = 2; // comment ', 'total_'), []);
  assert.deepEqual(names('bind total_value = 2; print("unfinished ', 'total_'), []);
});

test('malformed scope, unsupported headers and size limits fail closed', () => {
  assert.deepEqual(names('bind total_count = 1; ] print(', 'total_'), []);
  assert.deepEqual(names('funcra total_func(param: integer', 'total_'), []);
  assert.deepEqual(names(' '.repeat(SOURCE_COMPLETION_LIMIT + 1), 'total_'), []);
  assert.deepEqual(names('('.repeat(129), 'total_'), []);
  assert.deepEqual(names('bind total_count = 1; print(', 't'), []);
  const many = Array.from({ length: 150 }, (_, i) => 'bind many_' + i + ' = 1;').join('\n');
  assert.equal(names(many + ' print(', 'many_').length, 100);
});
