import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanScarpStructure, scarpPositionAt } from '../src/editorStructure';
import { scarpFolds } from '../src/editorFolding';
import { scarpSelectionRanges } from '../src/editorSelection';
import { ScarpStructureCache } from '../src/editorStructureCache';
import { scarpSourceMetrics } from '../src/editorStructuralMetrics';

function generator(seed: number) {
  let current = seed >>> 0;
  return (max: number) => {
    current = (Math.imul(current, 1664525) + 1013904223) >>> 0;
    return current % max;
  };
}
const open = ['(', '[', '{'];
const close = [')', ']', '}'];
function nested(depth: number, seed: number): string {
  const next = generator(seed);
  const kinds: number[] = [];
  for (let i = 0; i < depth; i++) { kinds.push(next(3)); }
  let result = 'value';
  for (let i = depth - 1; i >= 0; i--) {
    result = open[kinds[i]] + '\n' + result + '\n' + close[kinds[i]];
  }
  return result;
}
test('generated valid delimiter trees always have matching UTF-16 bracket spans', () => {
  for (let seed = 0; seed < 24; seed++) {
    for (const depth of [1, 2, 3, 5, 8, 13, 21, 32]) {
      const source = nested(depth, seed);
      const parsed = scanScarpStructure(source);
      assert.ok(parsed);
      assert.equal(parsed.pairs.length, depth);
      for (const pair of parsed.pairs) {
        const kind = open.indexOf(pair.kind);
        assert.equal(source[pair.open.start], open[kind]);
        assert.equal(source[pair.close.start], close[kind]);
        assert.equal(pair.open.end, pair.open.start + 1);
        assert.equal(pair.close.end, pair.close.start + 1);
        assert.ok(pair.span.start <= pair.inner.start);
        assert.ok(pair.inner.end <= pair.span.end);
      }
    }
  }
});
test('generated nesting obeys the hard depth limit instead of overflowing', () => {
  for (const seed of [1, 3, 5, 15, 42, 101]) {
    assert.ok(scanScarpStructure(nested(100, seed)));
    assert.equal(scanScarpStructure(nested(257, seed)), undefined);
  }
});
test('generated valid fold intervals always lie within physical source lines', () => {
  for (let seed = 1; seed < 50; seed++) {
    const source = nested(seed % 20 + 1, seed);
    const parsed = scanScarpStructure(source);
    assert.ok(parsed);
    const folds = scarpFolds(source);
    for (const fold of folds) {
      assert.ok(fold.start >= 0, 'fold cannot start before document');
      assert.ok(fold.end >= fold.start, 'fold cannot reverse');
      assert.ok(fold.end < parsed.lines.length, 'fold cannot leave the document');
      assert.ok(fold.startOffset >= 0);
      assert.ok(fold.endOffset <= source.length);
    }
  }
});
test('generated selection ranges strictly contain the original cursor', () => {
  for (let seed = 0; seed < 45; seed++) {
    const source = nested(seed % 12 + 1, seed + 1);
    const cursor = source.indexOf('value') + 2;
    const ranges = scarpSelectionRanges(source, cursor);
    assert.ok(ranges.length > 0);
    for (let i = 0; i < ranges.length; i++) {
      assert.ok(ranges[i].start <= cursor);
      assert.ok(ranges[i].end >= cursor);
      if (i) {
        assert.ok(ranges[i].start <= ranges[i - 1].start);
        assert.ok(ranges[i].end >= ranges[i - 1].end);
      }
    }
  }
});
test('quoted fake nesting never contributes to bracket depth', () => {
  for (let seed = 0; seed < 64; seed++) {
    const next = generator(seed);
    const fake = Array.from({ length: 30 }, () => {
      const pair = next(3);
      return open[pair] + close[pair];
    }).join('');
    const source = 'print("' + fake + '");';
    const parsed = scanScarpStructure(source);
    assert.ok(parsed);
    assert.equal(parsed.pairs.length, 1);
    assert.equal(parsed.pairs[0].kind, '(');
    assert.equal(parsed.strings.length, 1);
  }
});
test('comment-only pseudo-imports cannot enter structural references', () => {
  const next = generator(209);
  for (let i = 0; i < 70; i++) {
    const filename = 'module' + next(1000) + '.srp';
    const source = '// import "' + filename + '" as fake;\nprint(1);';
    assert.deepEqual(scanScarpStructure(source)?.imports, []);
  }
});
test('generated Unicode prefixes retain exact VS Code UTF-16 source offsets', () => {
  const unicode = ['😀', 'नमस्ते', 'a', 'é', '𝄞', '猫'];
  const next = generator(17);
  for (let i = 0; i < 80; i++) {
    const prefix = unicode[next(unicode.length)] + '\r\n';
    const source = prefix + 'print(1);';
    const parsed = scanScarpStructure(source);
    assert.ok(parsed);
    assert.deepEqual(scarpPositionAt(parsed, source.indexOf('print')),
      { line: 1, character: 0 });
  }
});
test('cache source revisions invalidate structural data on every edit', () => {
  const cache = new ScarpStructureCache({ maximumEntries: 8 });
  for (let version = 1; version <= 100; version++) {
    const result = cache.get('example.srp', version,
      'print(' + version + ');');
    assert.ok(result);
    assert.ok(result.tokens.some(t => t.text === String(version)));
    assert.equal(cache.stats().entries, 1);
  }
  assert.equal(cache.stats().misses, 100);
});
test('generated structural metrics are independent of comment delimiter count', () => {
  const next = generator(99);
  for (let i = 0; i < 80; i++) {
    const fake = Array.from({ length: 20 }, () => open[next(3)]).join('');
    const source = '// ' + fake + '\nprint(1);';
    const metrics = scarpSourceMetrics(source);
    assert.ok(metrics);
    assert.equal(metrics.commentOnlyLines, 1);
    assert.equal(metrics.maximumDelimiterDepth, 1);
  }
});
test('large source snapshots cannot produce unbounded folding or selection results', () => {
  const source = Array.from({ length: 1000 }, (_, i) =>
    'funcra generated_' + i + '() {\n  print(1);\n}').join('\n');
  assert.ok(scanScarpStructure(source));
  assert.ok(scarpFolds(source, { maximumRanges: 50 }).length <= 50);
  assert.ok(scarpSelectionRanges(source, source.indexOf('print(1)')).length <= 48);
});
test('one pathological malformed document does not poison later source scans', () => {
  const cache = new ScarpStructureCache();
  assert.equal(cache.get('bad.srp', 1, '('.repeat(1000)), undefined);
  const clean = cache.get('good.srp', 1, 'print(1);');
  assert.ok(clean);
  assert.equal(clean.pairs.length, 1);
});
test('scanner refuses adversarial token counts without allocating an unbounded index', () => {
  const source = 'a '.repeat(150_000);
  assert.equal(scanScarpStructure(source), undefined);
  const smaller = 'a '.repeat(1000);
  assert.equal(scanScarpStructure(smaller)?.tokens.length, 1000);
});
