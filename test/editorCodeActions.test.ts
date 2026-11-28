import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpQuickFixes, type ScarpQuickFixContext, type ScarpQuickFixOptions
} from '../src/editorCodeActions';
import { fixtureStructure, applyEdits } from './editorFixture';

function action(
  source: string, code: string, message: string, cursor: number,
  opts: ScarpQuickFixOptions = {}
) {
  return scarpQuickFixes(source, fixtureStructure(source), [{
    code, message, range: { start: cursor, end: cursor }
  }], opts);
}
function fixed(source: string, code: string, message: string, cursor: number): string {
  const fixes = action(source, code, message, cursor);
  assert.equal(fixes.length, 1);
  return applyEdits(source, fixes);
}

test('E0005 migrates a simple top-level let binding to bind', () => {
  const source = 'let answer = 42;\nprint(answer);\n';
  assert.equal(fixed(source, 'E0005', 'obsolete let declaration', 0),
    'bind answer = 42;\nprint(answer);\n');
});

test('E0005 migrates a mutable legacy declaration to var', () => {
  const source = 'funcra f() {\n  let mut count = 0;\n  count += 1;\n}\n';
  const at = source.indexOf('let mut');
  assert.equal(fixed(source, 'E0005', 'legacy let mut', at),
    'funcra f() {\n  var count = 0;\n  count += 1;\n}\n');
});

test('only the declaration keyword is replaced', () => {
  const source = 'let x = 1; // let in comment\n';
  const fixes = action(source, 'E0005', 'let is not supported', 0);
  assert.deepEqual(fixes.map(f => [f.start, f.end, f.replacement]), [[0, 3, 'bind']]);
});

test('missing semicolon is placed after the final non-whitespace code character', () => {
  const source = 'bind x = 1\n';
  const at = source.length;
  assert.equal(fixed(source, 'E0004', "expected ';'", at), 'bind x = 1;\n');
});

test('semicolon insertion immediately before a closing block preserves whitespace', () => {
  const source = 'funcra f() {\n  return 5\n}\n';
  const at = source.indexOf('\n}', source.indexOf('return'));
  assert.equal(fixed(source, 'E0004', "expected ';'", at),
    'funcra f() {\n  return 5;\n}\n');
});

test('refuses mismatched diagnostic codes even when message resembles a fix', () => {
  const source = 'let x = 4;';
  assert.deepEqual(action(source, 'E0004', 'obsolete let declaration', 0), []);
  assert.deepEqual(action(source, 'E9999', 'obsolete let declaration', 0), []);
  assert.deepEqual(action(source, '', 'obsolete let declaration', 0), []);
});

test('does not auto-apply diagnostic repairs', () => {
  const source = 'let x = 4;';
  const fixes = action(source, 'E0005', 'legacy let declaration', 0);
  assert.equal(source, 'let x = 4;');
  assert.equal(fixes[0]?.kind, 'quickfix');
  assert.ok(fixes[0]?.detail);
});

test('missing expected semicolon message is intentionally strict', () => {
  const source = 'bind x = 3\n';
  assert.deepEqual(action(source, 'E0004', 'unexpected end of file', source.length), []);
  assert.deepEqual(action(source, 'E0004', "expected ')'", source.length), []);
  assert.deepEqual(action(source, 'E0004', 'expected expression', source.length), []);
});

test('won’t insert a semicolon after an existing terminator', () => {
  const source = 'bind x = 3;\n';
  assert.deepEqual(action(source, 'E0004', "expected ';'", source.length), []);
});

test('won’t insert a semicolon in an expression before its operand', () => {
  const source = 'bind x = 3 + 4\n';
  assert.deepEqual(action(source, 'E0004', "expected ';'", source.indexOf('4')), []);
});

test('won’t insert a semicolon in a comment or quoted string', () => {
  const cases = [
    'print("abc");',
    '// print(3);',
    'print("""abc\n xyz""");'
  ];
  for (const source of cases) {
    const cursor = source.includes('//') ? source.indexOf('print') : source.indexOf('abc') + 1;
    assert.deepEqual(action(source, 'E0004', "expected ';'", cursor), []);
  }
});

test('won’t transform text of a comment that mentions a declaration', () => {
  const source = '// let a = 1;\nbind x = 1;';
  assert.deepEqual(action(source, 'E0005', 'legacy let', source.indexOf('let')), []);
});

test('won’t transform a literal that embeds old keyword spelling', () => {
  const source = 'print("let y = 5");';
  assert.deepEqual(action(source, 'E0005', 'legacy let', source.indexOf('let')), []);
});

test('legacy let requires a complete identifier and declaration shape', () => {
  for (const source of [
    'let = 4;', 'let 123 = 4;', 'let _ = 3;', 'let foo;', 'let foo + 4;',
    'let mut = 4;', 'let mut 4 = 4;', 'let\nfoo = 4;'
  ]) {
    assert.deepEqual(action(source, 'E0005', 'legacy let', 0), [], source);
  }
});

test('legacy let won’t guess statement forms after an expression', () => {
  const source = 'print(1) let x = 3;';
  assert.deepEqual(action(source, 'E0005', 'legacy let', source.indexOf('let')), []);
});

test('E0005 without let in the compiler message produces no quick fix', () => {
  const source = 'let x = 42;';
  assert.deepEqual(action(source, 'E0005', 'unknown statement', 0), []);
});

test('user-controlled code action budget is honored', () => {
  const source = 'let a = 1;\nlet b = 2;\n';
  const diagnostics: ScarpQuickFixContext[] = [0, source.indexOf('let b')].map(start => ({
    code: 'E0005', message: 'legacy let declaration', range: { start, end: start }
  }));
  assert.equal(scarpQuickFixes(source, fixtureStructure(source), diagnostics).length, 2);
  assert.equal(scarpQuickFixes(source, fixtureStructure(source), diagnostics, {
    maximumActions: 1
  }).length, 1);
});

test('duplicate diagnostics produce one edit and one menu entry', () => {
  const source = 'let a = 3;';
  const diag: ScarpQuickFixContext = {
    code: 'E0005', message: 'obsolete let', range: { start: 0, end: 0 }
  };
  assert.equal(scarpQuickFixes(source, fixtureStructure(source), [diag, diag]).length, 1);
});

test('invalid reported coordinates cannot produce edits', () => {
  const source = 'let a = 3;';
  const parsed = fixtureStructure(source);
  for (const range of [
    { start: -1, end: 0 }, { start: 9, end: 0 },
    { start: source.length + 1, end: source.length + 2 },
    { start: Infinity, end: Infinity }, { start: NaN, end: NaN }
  ]) {
    assert.deepEqual(scarpQuickFixes(source, parsed, [{
      code: 'E0005', message: 'obsolete let', range
    }]), []);
  }
});

test('malformed upper limits fail closed rather than silently using a default', () => {
  const source = 'let a = 3;';
  for (const opts of [
    { maximumDocumentLength: -1 }, { maximumDocumentLength: NaN },
    { maximumActions: 0 }, { maximumActions: 1.2 }
  ]) {
    assert.deepEqual(action(source, 'E0005', 'legacy let', 0, opts), []);
  }
});

test('too-large documents do not undergo editor-only action analysis', () => {
  const source = 'let a = 3;';
  assert.deepEqual(action(source, 'E0005', 'legacy let', 0, {
    maximumDocumentLength: 5
  }), []);
});

test('a stored structure from another text version cannot supply editor fixes', () => {
  const source = 'let a = 3;';
  const old = fixtureStructure('let a = 42;');
  assert.deepEqual(scarpQuickFixes(source, old, [{
    code: 'E0005', message: 'legacy let', range: { start: 0, end: 0 }
  }]), []);
});

test('unknown future compiler diagnostics do not trigger speculative edits', () => {
  const source = 'let foo = 1;';
  for (const code of ['E0005X', 'E9999', 'E1234', 'W0005', null, undefined]) {
    assert.deepEqual(scarpQuickFixes(source, fixtureStructure(source), [{
      code, message: 'legacy let', range: { start: 0, end: 0 }
    }]), []);
  }
});

test('fix positions remain UTF-16 offsets after multibyte text', () => {
  const source = 'print("😀");\nlet x = 1;';
  const at = source.indexOf('let');
  const fixes = action(source, 'E0005', 'obsolete let', at);
  assert.equal(fixes.length, 1);
  assert.deepEqual([fixes[0].start, fixes[0].end], [at, at + 3]);
});

test('reapplying a completed quick fix does not offer a duplicate', () => {
  const source = 'let x = 1;';
  const transformed = fixed(source, 'E0005', 'obsolete let', 0);
  assert.deepEqual(action(transformed, 'E0005', 'obsolete let', 0), []);
});
