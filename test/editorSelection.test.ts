import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanScarpStructure } from '../src/editorStructure';
import { scarpSelectionRanges, scarpSelectionRangesFromStructure } from '../src/editorSelection';

function values(source: string, offset: number): string[] {
  return scarpSelectionRanges(source, offset)
    .map(span => source.slice(span.start, span.end));
}
test('expanding a nested scalar selects enclosing groups and file', () => {
  const source = 'print((1, 2));';
  const selection = values(source, source.indexOf('1'));
  assert.equal(selection[0], '1');
  assert.ok(selection.includes('1, 2'));
  assert.ok(selection.includes('(1, 2)'));
  assert.equal(selection[selection.length - 1], source);
});
test('quoted Unicode strings expand through content and quotes', () => {
  const source = 'print("नमस्ते 😀");';
  const selection = values(source, source.indexOf('नमस्ते') + 2);
  assert.equal(selection[0], 'नमस्ते 😀');
  assert.equal(selection[1], '"नमस्ते 😀"');
});
test('import paths expand through declarations', () => {
  const source = 'import "math/vector.srp" as m;';
  const selection = values(source, source.indexOf('vector'));
  assert.ok(selection.includes('math/vector.srp'));
  assert.ok(selection.includes(source));
});
test('selection ancestors are strict, monotone and never cross', () => {
  const source = '// #region x\nfuncra f() {\n print((1, 2));\n}\n// #endregion';
  const spans = scarpSelectionRanges(source, source.indexOf('1'));
  for (let i = 1; i < spans.length; i++) {
    const inner = spans[i - 1], outer = spans[i];
    assert.ok(outer.start <= inner.start && outer.end >= inner.end);
    assert.ok(outer.start < inner.start || outer.end > inner.end);
  }
});
test('document-end cursor gets a valid enclosing source range', () => {
  const source = 'bind a = 1;\n';
  const spans = scarpSelectionRanges(source, source.length);
  assert.ok(spans.length);
  assert.deepEqual(spans[spans.length - 1], { start: 0, end: source.length });
});
test('malformed bounds and request options remain fail-closed', () => {
  assert.deepEqual(scarpSelectionRanges('('.repeat(300), 2), []);
  assert.deepEqual(scarpSelectionRanges(' '.repeat(2_000_001), 4), []);
  assert.deepEqual(scarpSelectionRanges('bind a = 1;', -1), []);
  assert.deepEqual(scarpSelectionRanges('bind a = 1;', 100), []);
  assert.deepEqual(scarpSelectionRanges('print(1)', 6, { maxRanges: 0 }), []);
  assert.equal(scarpSelectionRanges('print(1)', 6, { maxRanges: 1 }).length, 1);
});
test('same immutable source snapshot yields stable ranges at every position', () => {
  const source = 'bind t = (1, [array: 2, 3]);';
  const parsed = scanScarpStructure(source);
  assert.ok(parsed);
  for (let i = 0; i <= source.length; i++) {
    const a = scarpSelectionRangesFromStructure(source, parsed, i);
    const b = scarpSelectionRangesFromStructure(source, parsed, i);
    assert.deepEqual(a, b);
  }
});
test('CRLF visible line selection excludes terminating newline', () => {
  const source = 'bind a = 1;\r\nbind b = 2;\r\n';
  const selection = values(source, source.indexOf('b ='));
  assert.ok(selection.includes('bind b = 2;'));
});
test('comments do not create fake string or function selections', () => {
  const source = '// print("fake");';
  const selection = values(source, source.indexOf('fake'));
  assert.ok(selection.includes(source));
  assert.ok(!selection.includes('"fake"'));
});
