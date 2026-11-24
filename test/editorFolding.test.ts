import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanScarpStructure } from '../src/editorStructure';
import { scarpFolds, scarpFoldsFromStructure } from '../src/editorFolding';

test('multiline functions and nested blocks fold at real lines', () => {
  const text = 'funcra f() {\n if true {\n  print(1);\n }\n}';
  assert.deepEqual(scarpFolds(text).map(f => [f.start, f.end]),
    [[0, 4], [1, 3]]);
});
test('one-line expressions are not folded', () => {
  assert.deepEqual(scarpFolds('funcra f() { print(1); }'), []);
});
test('nested region markers and braces produce independent folds', () => {
  const source = '// #region fold\nfuncra f() {\n print(1);\n}\n// #endregion';
  const folds = scarpFolds(source);
  assert.ok(folds.some(f => f.kind === 'region' && f.start === 0 && f.end === 4));
  assert.ok(folds.some(f => f.kind === 'structure' && f.start === 1 && f.end === 3));
});
test('array and grouped expressions support multiline folding', () => {
  const text = 'bind x = [array:\n  (1,\n   2)\n];';
  assert.deepEqual(scarpFolds(text).map(f => [f.start, f.end]),
    [[0, 3], [1, 2]]);
});
test('comment folds require adjacent whole-line comments', () => {
  const text = '// a\n// b\nbind x = 1; // inline\n// c\n// d';
  assert.deepEqual(scarpFolds(text).filter(f => f.kind === 'comment')
    .map(f => [f.start, f.end]), [[0, 1], [3, 4]]);
});
test('complete consecutive imports create one local import fold', () => {
  const text = 'import "a.srp" as a;\nimport "b.srp" as b;\n\nbind x = 1;';
  assert.deepEqual(scarpFolds(text).filter(f => f.kind === 'imports')
    .map(f => [f.start, f.end]), [[0, 1]]);
});
test('folding feature gates and count bounds work independently', () => {
  const src = '// #region v\n// a\n// b\nfuncra f() {\n print(1);\n}\n// #endregion';
  assert.deepEqual(scarpFolds(src, {
    foldRegions: false, foldComments: false, foldBraces: false,
    foldBrackets: false, foldParens: false, foldImports: false
  }), []);
  assert.equal(scarpFolds(src, { maximumRanges: 1 }).length, 1);
  assert.deepEqual(scarpFolds(src, { maximumRanges: 0 }), []);
  assert.deepEqual(scarpFolds(src, { minimumLines: 100 }), []);
});
test('CRLF and blank trailing source lines do not inflate the closing line', () => {
  const src = 'funcra f() {\r\n print(1);\r\n}\r\n';
  assert.deepEqual(scarpFolds(src).map(f => [f.start, f.end]), [[0, 2]]);
});
test('invalid snapshots and excessive source length fail closed', () => {
  const src = 'funcra f() {\n print(1);\n}';
  const parsed = scanScarpStructure(src);
  assert.ok(parsed);
  assert.deepEqual(scarpFoldsFromStructure(src + 'x', parsed), []);
  assert.deepEqual(scarpFolds(' '.repeat(2_000_001)), []);
});
test('repeated sections retain deterministic order and no duplicate intervals', () => {
  const src = Array.from({ length: 30 }, (_, i) =>
    '// #region ' + i + '\nfuncra f_' + i +
    '() {\n print(1);\n}\n// #endregion').join('\n');
  const folds = scarpFolds(src);
  assert.equal(folds.filter(f => f.kind === 'region').length, 30);
  assert.equal(new Set(folds.map(f => f.start + ':' + f.end)).size, folds.length);
});
