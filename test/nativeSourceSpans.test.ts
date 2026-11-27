import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatNativeSpanPreview, nativeSpanPositions } from '../src/nativeSourceSpans';

test('maps ASCII byte offsets and keeps report index order, including duplicate endpoints', () => {
  const spans = nativeSpanPositions(Buffer.from('ab\ncd'), [[3, 5], [0, 2], [2, 2], [3, 5]]);
  assert.deepEqual(spans.map(s => [s.id, s.start, s.end]), [
    [0, { line: 2, column: 1 }, { line: 2, column: 3 }],
    [1, { line: 1, column: 1 }, { line: 1, column: 3 }],
    [2, { line: 1, column: 3 }, { line: 1, column: 3 }],
    [3, { line: 2, column: 1 }, { line: 2, column: 3 }]
  ]);
});

test('maps multibyte and supplementary Unicode to UTF-16 columns', () => {
  const source = Buffer.from('aπ😀b');
  const spans = nativeSpanPositions(source, [[1, 3], [3, 7], [7, 8]]);
  assert.deepEqual(spans.map(s => [s.start.column, s.end.column]), [[2, 3], [3, 5], [5, 6]]);
  for (const range of [[2, 3], [3, 4], [5, 7], [6, 8]] as const) {
    assert.throws(() => nativeSpanPositions(source, [range]), /splits a UTF-8/);
  }
});

test('leading BOM retains byte offsets but does not consume a visible editor column', () => {
  const spans = nativeSpanPositions(Buffer.from('\uFEFFx\uFEFFy'), [[0, 3], [3, 4], [4, 7], [7, 8]]);
  assert.deepEqual(spans.map(s => [s.start.column, s.end.column]),
    [[1, 1], [1, 2], [2, 3], [3, 4]]);
});

test('CRLF maps as a single newline; standalone CR and LF end lines independently', () => {
  const source = Buffer.from('a\r\nb\rc\nd');
  const spans = nativeSpanPositions(source, [[1, 2], [2, 3], [3, 4], [4, 5], [6, 7], [7, 8]]);
  assert.deepEqual(spans.map(s => [s.start.line, s.start.column, s.end.line, s.end.column]), [
    [1, 2, 1, 2], [1, 2, 2, 1], [2, 1, 2, 2],
    [2, 2, 3, 1], [3, 2, 4, 1], [4, 1, 4, 2]
  ]);
});

test('invalid UTF-8, malformed ranges and excessive work fail closed', () => {
  assert.throws(() => nativeSpanPositions(Buffer.from([0xff]), [[0, 1]]), /valid UTF-8/);
  for (const span of [[-1, 1], [2, 1], [0, 3], [0.5, 1], [0, Infinity], [NaN, 1]] as const) {
    assert.throws(() => nativeSpanPositions(Buffer.from('ab'), [span]), /byte range/);
  }
  assert.throws(() => nativeSpanPositions(Buffer.alloc(1024 * 1024 + 1), []), /size limit/);
  const tooMany = Array.from({ length: 65537 }, () => [0, 0] as const);
  assert.throws(() => nativeSpanPositions(Buffer.alloc(0), tooMany), /size limit/);
});

test('empty source, EOF, zero-length and unsorted spans are valid', () => {
  assert.deepEqual(nativeSpanPositions(Buffer.alloc(0), []), []);
  assert.deepEqual(nativeSpanPositions(Buffer.alloc(0), [[0, 0]])[0].end, { line: 1, column: 1 });
  const spans = nativeSpanPositions(Buffer.from('x\n'), [[2, 2], [0, 1], [1, 2]]);
  assert.deepEqual(spans[0].start, { line: 2, column: 1 });
  assert.deepEqual(spans[2].end, { line: 2, column: 1 });
});

test('preview preserves span identifiers and bounds human-readable output', () => {
  const spans = nativeSpanPositions(Buffer.from('abc'), Array.from({ length: 80 }, () => [0, 3] as const));
  const preview = formatNativeSpanPreview(spans);
  assert.match(preview, /#0 bytes \[0, 3\) → 1:1–1:4/);
  assert.match(preview, /#63 bytes/);
  assert.doesNotMatch(preview, /#64 bytes/);
  assert.match(preview, /16 additional spans/);
  assert.equal(formatNativeSpanPreview([]), 'No native failure spans reported.');
});

test('many repeated endpoints are mapped once with deterministic results', () => {
  const source = Buffer.from('π'.repeat(32768) + '\n');
  const spans = nativeSpanPositions(source, Array.from({ length: 65536 }, () => [0, source.length] as const));
  assert.equal(spans.length, 65536);
  assert.deepEqual(spans[65535].end, { line: 2, column: 1 });
  assert.equal(spans[65535].id, 65535);
});
