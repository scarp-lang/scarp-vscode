import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpSpanToEditorRange, type ScarpEditorDocument, type ScarpSourceSpan
} from '../src/diagnosticPresentation';

function document(...lines: string[]): ScarpEditorDocument {
  return { lineCount: lines.length, lineAt(index) { return { text: lines[index] }; } };
}
function span(
  line: number, column: number, endLine?: number, endColumn?: number
): ScarpSourceSpan {
  return { filename: 'main.srp', line, column, endLine, endColumn };
}

test('maps one-based compiler columns to zero-based editor positions', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('print(42);'), span(1, 7, 1, 9)), {
    start: { line: 0, character: 6 }, end: { line: 0, character: 8 }
  });
});

test('maps Unicode scalar offsets to UTF-16 without splitting surrogate pairs', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('😀a🚀z'), span(1, 3, 1, 4)), {
    start: { line: 0, character: 3 }, end: { line: 0, character: 5 }
  });
});

test('maps related notes spanning more than one line', () => {
  assert.deepEqual(scarpSpanToEditorRange(
    document('funcra example() {', '    print("😀");', '}'), span(1, 4, 3, 2)
  ), {
    start: { line: 0, character: 3 }, end: { line: 2, character: 1 }
  });
});

test('handles a missing end column with a one-character fallback', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('abc'), span(1, 2)), {
    start: { line: 0, character: 1 }, end: { line: 0, character: 2 }
  });
});

test('a location at EOF may retain a zero-width range', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('abc'), span(1, 4)), {
    start: { line: 0, character: 3 }, end: { line: 0, character: 3 }
  });
});

test('clamps a stale compiler line and column to the document bounds', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('a', '😀'), span(200, 500)), {
    start: { line: 1, character: 2 }, end: { line: 1, character: 2 }
  });
});

test('a backward same-line end never produces an inverted editor range', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('abcdef'), span(1, 5, 1, 1)), {
    start: { line: 0, character: 4 }, end: { line: 0, character: 5 }
  });
});

test('a backward multi-line end is clamped to the start line', () => {
  assert.deepEqual(scarpSpanToEditorRange(
    document('first', 'second', 'third'), span(3, 3, 1, 1)
  ), {
    start: { line: 2, character: 2 }, end: { line: 2, character: 3 }
  });
});

test('invalid line and column numbers never result in negative VS Code positions', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, 1.5]) {
    assert.equal(scarpSpanToEditorRange(document('valid'), span(value, 1)), undefined);
    assert.equal(scarpSpanToEditorRange(document('valid'), span(1, value)), undefined);
    assert.equal(scarpSpanToEditorRange(document('valid'), span(1, 1, value)), undefined);
    assert.equal(scarpSpanToEditorRange(document('valid'), span(1, 1, 1, value)), undefined);
  }
});

test('empty and malformed editor documents are handled without lineAt calls', () => {
  for (const count of [0, -1, NaN, Infinity, 2.5]) {
    const bad: ScarpEditorDocument = {
      lineCount: count,
      lineAt() { throw new Error('invalid document must not be accessed'); }
    };
    assert.equal(scarpSpanToEditorRange(bad, span(1, 1)), undefined);
  }
});

test('returned positions are immutable by the mapper across subsequent calls', () => {
  const source = document('first', '😀second');
  const first = scarpSpanToEditorRange(source, span(1, 1, 1, 3));
  const second = scarpSpanToEditorRange(source, span(2, 2, 2, 4));
  assert.deepEqual(first, {
    start: { line: 0, character: 0 }, end: { line: 0, character: 2 }
  });
  assert.deepEqual(second, {
    start: { line: 1, character: 2 }, end: { line: 1, character: 4 }
  });
});


test('equal start and end scalar coordinates highlight a character when available', () => {
  assert.deepEqual(scarpSpanToEditorRange(document('xyz'), span(1, 2, 1, 2)), {
    start: { line: 0, character: 1 }, end: { line: 0, character: 2 }
  });
});
