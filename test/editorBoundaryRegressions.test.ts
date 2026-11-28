import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fixtureStructure, applyEdits } from './editorFixture';
import { scarpIndentationEdits } from '../src/editorIndentation';
import { scarpQuickFixes } from '../src/editorCodeActions';
import { scarpLocalCallGraph, scarpIncomingCalls } from '../src/editorCallHierarchy';
import { scarpLocalBindings, scarpBindingAt, scarpBindingReferences } from '../src/editorLocalBindings';
import { scarpLocalRenamePlan } from '../src/editorLocalRename';
import { scarpDocumentHighlights } from '../src/editorDocumentHighlights';

function functionIndex(text: string) {
  const data = scarpLocalCallGraph(text, fixtureStructure(text));
  assert.ok(data);
  return data;
}
function rename(text: string, at: number, replacement: string) {
  return scarpLocalRenamePlan(text, fixtureStructure(text), at, replacement);
}

test('formatting never alters the exact contents of comments after indentation', () => {
  const source = [
    'funcra f() {',
    '// foo {} [ ] ; ;',
    '  // print("syntax") does not execute',
    'print(1);',
    '}'
  ].join('\n');
  const edits = scarpIndentationEdits(source, fixtureStructure(source));
  const result = applyEdits(source, edits);
  assert.ok(result.includes('// foo {} [ ] ; ;'));
  assert.ok(result.includes('// print("syntax") does not execute'));
});

test('formatting never inserts or removes newlines from a document', () => {
  const sources = [
    'funcra f() {\r\nprint(1);\r\n}\r\n',
    'funcra f() {\nprint(1);\n}\n',
    'funcra f() {\rprint(1);\r}\r',
    'funcra f() {\nprint("😀");\n}\n'
  ];
  for (const source of sources) {
    const result = applyEdits(source, scarpIndentationEdits(source, fixtureStructure(source)));
    const before = [...source].filter(c => c === '\n' || c === '\r').join('');
    const after = [...result].filter(c => c === '\n' || c === '\r').join('');
    assert.equal(after, before);
  }
});

test('format-range has no side effects on unrelated nested blocks', () => {
  const source = 'funcra f() {\nif true {\nprint(1);\n}\nif false {\nprint(2);\n}\n}\n';
  const start = source.indexOf('if false');
  const end = source.indexOf('\n}', start);
  const edits = scarpIndentationEdits(source, fixtureStructure(source), {
    range: { start, end }
  });
  assert.ok(edits.every(edit => edit.start >= start));
  const next = applyEdits(source, edits);
  assert.ok(next.includes('if true {\nprint(1);\n}'));
  assert.ok(next.includes('    if false {\n        print(2);'));
});

test('a malformed Unicode token sequence cannot create a quick fix', () => {
  const source = 'bind x = "😀 let x";';
  const parsed = fixtureStructure(source);
  for (const cursor of [source.indexOf('let'), source.indexOf('😀')]) {
    assert.deepEqual(scarpQuickFixes(source, parsed, [{
      code: 'E0005', message: 'legacy let', range: { start: cursor, end: cursor }
    }]), []);
  }
});

test('legacy mutable conversion changes only keyword tokens, not whitespace', () => {
  const source = 'funcra f() {\n  let   mut    count = 0;\n}\n';
  const offset = source.indexOf('let');
  const fixes = scarpQuickFixes(source, fixtureStructure(source), [{
    code: 'E0005', message: 'obsolete let mut', range: { start: offset, end: offset }
  }]);
  const result = applyEdits(source, fixes);
  assert.equal(result, 'funcra f() {\n  var    count = 0;\n}\n');
});

test('a compiler usage error without an exact fixable source code remains read-only', () => {
  const source = 'print(1);';
  for (const code of ['E0038', 'E0015', 'E0025', 'E0052', 'E0053', 'E0047']) {
    const actions = scarpQuickFixes(source, fixtureStructure(source), [{
      code, message: "expected ';' / obsolete let", range: { start: 0, end: 0 }
    }]);
    assert.deepEqual(actions, []);
  }
});

test('a source-local call graph excludes calls invoked through imported aliases', () => {
  const source = 'import "math.srp" as math;\nfuncra sum() { math.add(1); }\nfuncra add(x: integer) {}';
  assert.deepEqual(functionIndex(source).calls, []);
});

test('a function called from nested blocks still has a single caller', () => {
  const source = 'funcra outer() { if true { while true { target(); } } }\nfuncra target() {}';
  const graph = functionIndex(source);
  const target = graph.nodes.find(n => n.name === 'target');
  assert.ok(target);
  assert.deepEqual(scarpIncomingCalls(graph, target).map(e => e.from.name), ['outer']);
});

test('a function body never creates another top-level function from quoted source', () => {
  const source = 'funcra f() { print("funcra inner() {} "); }\nfuncra outer() {}';
  assert.deepEqual(functionIndex(source).nodes.map(n => n.name), ['f', 'outer']);
});

test('nested blocks without a local binding cannot resolve a function-wide phantom', () => {
  const source = 'funcra f() { if true { bind inner = 3; } print(inner); }';
  const index = scarpLocalBindings(source, fixtureStructure(source));
  assert.ok(index);
  assert.equal(index.bindings.length, 1);
  assert.equal(scarpBindingReferences(index, index.bindings[0]).length, 1);
  assert.equal(scarpBindingAt(index, source.indexOf('print(inner)') + 6), undefined);
});

test('a local reference cannot escape through another function parameter', () => {
  const source = 'funcra a(value: integer) { print(value); }\nfuncra b(value: integer) { print(value); }';
  const parsed = fixtureStructure(source);
  const index = scarpLocalBindings(source, parsed);
  assert.ok(index);
  assert.equal(index.bindings.length, 2);
  assert.equal(scarpBindingReferences(index, index.bindings[0]).length, 2);
  assert.equal(scarpBindingReferences(index, index.bindings[1]).length, 2);
});

test('proposed rename replacements must remain complete source tokens', () => {
  const source = 'funcra f() { bind a = 1; print(a); }';
  for (const invalid of ['some token', '.member', '1broken', 'for-each',
    'path/name', 'path\\name', '#tag']) {
    assert.equal(rename(source, source.indexOf('bind a') + 5, invalid), undefined);
  }
});

test('a rename from a string is never redirected to a matching declaration', () => {
  const source = 'funcra f() { bind name = 3; print("name"); print(name); }';
  assert.equal(rename(source, source.indexOf('"name"') + 1, 'other'), undefined);
});

test('a member name equal to the renamed local is not modified', () => {
  const source = 'funcra f() { bind name = 3; item.name; print(name); }';
  const result = rename(source, source.indexOf('bind name') + 5, 'localName');
  assert.ok(result);
  assert.equal(result.edits.length, 2);
  const output = applyEdits(source, result.edits);
  assert.ok(output.includes('item.name;'));
  assert.ok(output.includes('print(localName);'));
});

test('read-only highlights never choose names inside comments or string contents', () => {
  const source = 'funcra a() { bind n = 1; print("n"); // n\nprint(n); }';
  const structure = fixtureStructure(source);
  const graph = scarpLocalCallGraph(source, structure);
  const locals = scarpLocalBindings(source, structure);
  for (const at of [source.indexOf('"n"') + 1, source.indexOf('// n') + 3]) {
    assert.deepEqual(scarpDocumentHighlights(graph, locals, at), []);
  }
});

test('source-token order cannot be assumed when ranges are inconsistent', () => {
  const source = 'funcra f() { bind n = 1; print(n); }';
  const parsed = fixtureStructure(source);
  const first = parsed.tokens[0];
  const corrupted = { ...parsed, tokens: [
    { ...first, span: { start: 10, end: 15 } }, ...parsed.tokens.slice(1)
  ] };
  assert.equal(scarpLocalCallGraph(source, corrupted), undefined);
});

test('repeated local syntax analysis does not change a Scarp project entrypoint', () => {
  const source = 'funcra main() { var total = 0; repeat 5 as i { total += i; } print(total); }';
  const parsed = fixtureStructure(source);
  const originalSource = source;
  const snapshot = JSON.stringify(parsed);
  for (let iteration = 0; iteration < 15; iteration++) {
    scarpLocalCallGraph(source, parsed);
    scarpLocalBindings(source, parsed);
    scarpIndentationEdits(source, parsed);
  }
  assert.equal(source, originalSource);
  assert.equal(JSON.stringify(parsed), snapshot);
});

test('a constrained source snapshot cannot produce partial call hierarchy hints', () => {
  const source = 'funcra a() { b(); c(); }\nfuncra b() {}\nfuncra c() {}';
  assert.equal(scarpLocalCallGraph(source, fixtureStructure(source), {
    maximumFunctions: 1
  }), undefined);
});

test('unknown structures never cause user-code execution during a quick-fix request', () => {
  const source = 'let a = 1;';
  const parsed = fixtureStructure(source);
  const weird = { ...parsed, length: parsed.length - 5 };
  const actions = scarpQuickFixes(source, weird, [{
    code: 'E0005', message: 'legacy let', range: { start: 0, end: 0 }
  }]);
  assert.deepEqual(actions, []);
});

test('local binding references cannot escape into a sibling document snapshot', () => {
  const first = 'funcra f() { bind x = 1; print(x); }';
  const second = 'funcra f() { bind y = 2; print(y); }';
  const one = scarpLocalBindings(first, fixtureStructure(first));
  const two = scarpLocalBindings(second, fixtureStructure(second));
  assert.ok(one && two);
  assert.equal(scarpBindingReferences(two, one.bindings[0]).length, 0);
});
