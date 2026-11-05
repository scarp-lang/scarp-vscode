import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { parseNavigationIndex, referencesFor, symbolAt } from '../src/navigationIndex';

const root = path.resolve('fixtures', 'navigation');
const source = path.join(root, 'src', 'main.srp');
const library = path.join(root, 'src', 'library.srp');

function payload(): Record<string, unknown> {
  return {
    schema_version: 1, kind: 'scarp.references',
    span_encoding: 'utf-8-bytes', column_encoding: 'unicode-scalar',
    position_base: 1,
    files: [{ id: 0, path: source }, { id: 1, path: library }],
    symbols: [
      { id: 0, name: 'root', kind: 'module', location: {
        source: 0, span: [0, 0], start: { line: 1, column: 1 },
        end: { line: 1, column: 1 }
      } },
      { id: 1, name: 'count', kind: 'binding', location: {
        source: 1, span: [5, 10], start: { line: 1, column: 6 },
        end: { line: 1, column: 11 }
      } },
      { id: 2, name: 'print', kind: 'builtin', location: null }
    ],
    references: [
      { target: 1, kind: 'read', location: {
        source: 0, span: [12, 17], start: { line: 2, column: 3 },
        end: { line: 2, column: 8 }
      } },
      { target: 1, kind: 'read', location: {
        source: 0, span: [20, 25], start: { line: 3, column: 4 },
        end: { line: 3, column: 9 }
      } },
      { target: 2, kind: 'call', location: {
        source: 0, span: [30, 35], start: { line: 4, column: 1 },
        end: { line: 4, column: 6 }
      } }
    ]
  };
}

test('finds cross-file definitions and references using file-local UTF-8 byte offsets', () => {
  const index = parseNavigationIndex(JSON.stringify(payload()), root);
  const symbol = symbolAt(index, source, 13);
  assert.equal(symbol?.name, 'count');
  assert.equal(symbol?.location?.source, 1);
  assert.equal(symbolAt(index, library, 7)?.id, 1);
  assert.equal(symbolAt(index, source, 17), undefined, 'end-exclusive spans');
  assert.equal(symbolAt(index, source, 30)?.location, null, 'builtin has no definition');
  assert.equal(referencesFor(index, symbol!, false).length, 2);
  const all = referencesFor(index, symbol!, true);
  assert.equal(all.length, 3);
  assert.equal(all[0].source, 1);
  assert.equal(symbolAt(index, source, 0)?.kind, 'module');
  assert.equal(symbolAt(index, source, -1), undefined);
});

test('rejects wrong kind, schema, encoding and invalid source/target IDs', () => {
  const variants: Array<(input: Record<string, unknown>) => void> = [
    p => { p.kind = 'scarp.symbols'; },
    p => { p.schema_version = 2; },
    p => { p.span_encoding = 'utf-16'; },
    p => { p.column_encoding = 'utf-8'; },
    p => { p.position_base = 0; },
    p => { p.files = [{ id: 1, path: source }]; },
    p => { p.files = [{ id: 0, path: '../outside.srp' }]; },
    p => { p.files = [{ id: 0, path: path.resolve('outside.srp') }]; },
    p => { p.files = [{ id: 0, path: source }, { id: 1, path: source }]; },
    p => { (p.symbols as Array<{ id: number }>)[1].id = 99; },
    p => { (p.symbols as Array<{ location: { source: number } }>)[1].location.source = 3; },
    p => { (p.references as Array<{ target: number }>)[0].target = 99; },
    p => { (p.references as Array<{ location: { span: number[] } }>)[0].location.span = [17, 12]; },
    p => { (p.references as Array<{ location: { start: { column: number } } }>)[0].location.start.column = 0; },
    p => { (p.references as Array<{ location: { end: { line: number } } }>)[0].location.end.line = 0; }
  ];
  for (const change of variants) {
    const altered = payload();
    change(altered);
    assert.throws(() => parseNavigationIndex(JSON.stringify(altered), root),
      /Invalid or unsupported Scarp references schema/);
  }
  assert.throws(() => parseNavigationIndex('{invalid', root),
    /Invalid or unsupported Scarp references schema/);
});

test('rejects inventories beyond safe bounded limits', () => {
  const large = payload();
  large.references = Array(65537).fill((large.references as unknown[])[0]);
  assert.throws(() => parseNavigationIndex(JSON.stringify(large), root),
    /Invalid or unsupported Scarp references schema/);
});
