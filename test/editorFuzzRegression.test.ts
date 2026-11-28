import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scarpIndentationEdits, applyScarpIndentationEdits } from '../src/editorIndentation';
import { scarpLocalCallGraph, scarpIncomingCalls, scarpOutgoingCalls } from '../src/editorCallHierarchy';
import { scarpLocalBindings } from '../src/editorLocalBindings';
import { scarpDocumentHighlights } from '../src/editorDocumentHighlights';
import { scarpLocalRenamePlan } from '../src/editorLocalRename';
import { scarpQuickFixes } from '../src/editorCodeActions';
import { ScarpEditorAnalysisCache } from '../src/editorAnalysisCache';
import { fixtureStructure } from './editorFixture';

/** A tiny deterministic generator, deliberately without external dependencies. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
function integer(rng: () => number, from: number, until: number): number {
  return from + Math.floor(rng() * (until - from + 1));
}
function indentation(rng: () => number, depth: number): string {
  const amount = integer(rng, 0, depth * 4 + 6);
  return amount % 5 === 0 ? '\t'.repeat(Math.floor(amount / 4)) : ' '.repeat(amount);
}
function sampleProgram(seed: number): string {
  const rng = random(seed);
  const eol = seed % 2 ? '\n' : '\r\n';
  const lines = ['funcra main() {'];
  let depth = 1;
  const body = integer(rng, 10, 60);
  for (let i = 0; i < body; i++) {
    const choice = integer(rng, 0, 9);
    const indent = indentation(rng, depth);
    if (choice <= 1 && depth < 5) {
      lines.push(indent + 'if true {');
      depth++;
    } else if (choice === 2 && depth > 1) {
      depth--;
      lines.push(indent + '}');
    } else if (choice === 3) {
      lines.push(indent + '// comment with braces {} and source-looking code');
    } else if (choice === 4) {
      lines.push(indent + 'print("{ tokens } \\"escaped\\"", ' + i + ');');
    } else if (choice === 5) {
      lines.push(indent + 'print("😀 हिन्दी 漢字");');
    } else if (choice === 6) {
      lines.push(indent + 'print(""" raw { \n); } \n""");');
    } else {
      lines.push(indent + 'print(' + i + ');');
    }
  }
  while (depth-- > 0) lines.push(indentation(rng, depth) + '}');
  return lines.join(eol) + eol;
}
function formatted(source: string, tabSize = 4): string {
  const structure = fixtureStructure(source);
  const edits = scarpIndentationEdits(source, structure, { tabSize });
  const result = applyScarpIndentationEdits(source, edits);
  assert.notEqual(result, undefined);
  return result!;
}
function stripLeading(line: string): string {
  return line.replace(/^[ \t]*/, '');
}

test('seeded nested programs preserve all nonindentation source bytes', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const source = sampleProgram(seed);
    const result = formatted(source);
    const before = source.split(/\r?\n/).map(stripLeading);
    const after = result.split(/\r?\n/).map(stripLeading);
    assert.deepEqual(after, before, `unexpected semantic edit for seed ${seed}`);
  }
});

test('seeded nested programs are idempotent with their own structure', () => {
  for (let seed = 101; seed <= 200; seed++) {
    const once = formatted(sampleProgram(seed), (seed % 5) + 2);
    const twice = formatted(once, (seed % 5) + 2);
    assert.equal(twice, once, `non-idempotent seed ${seed}`);
  }
});

test('seeded formatter output never switches a document line-ending convention', () => {
  for (let seed = 201; seed <= 250; seed++) {
    const input = sampleProgram(seed);
    const result = formatted(input);
    assert.equal(input.includes('\r\n'), result.includes('\r\n'));
    const count = (value: string, pattern: RegExp) => [...value.matchAll(pattern)].length;
    assert.equal(count(input, /\r\n/g), count(result, /\r\n/g));
    assert.equal(count(input, /(?<!\r)\n/g), count(result, /(?<!\r)\n/g));
  }
});

test('triple-quoted multiline strings survive formatter changes exactly', () => {
  for (let seed = 301; seed <= 340; seed++) {
    const rng = random(seed);
    const content = Array.from({ length: 8 }, () =>
      ['}', '{', ')', '[', '// comment', 'emoji😀', '     '] [integer(rng, 0, 6)])
      .join('\n');
    const source = `funcra f() {\nprint("""\n${content}\n""");\n}\n`;
    const formattedText = formatted(source);
    assert.ok(formattedText.includes(content), `raw string altered for seed ${seed}`);
  }
});

test('random invalid delimiter suffixes cause whole-source formatting rejection', () => {
  const suffixes = [')', ']', '}', '(', '[', '{', '(()', '[)', '{]'];
  for (const suffix of suffixes) {
    const source = 'funcra f() {\nprint(1);\n}\n' + suffix;
    const parsed = fixtureStructure(source);
    assert.deepEqual(scarpIndentationEdits(source, parsed), [], suffix);
  }
});

test('many same-file functions have deterministic incoming and outgoing call edges', () => {
  const count = 150;
  const source = Array.from({ length: count }, (_, i) =>
    `funcra f${i}() { ${i + 1 < count ? `f${i + 1}();` : 'print(1);'} }`).join('\n');
  const parsed = fixtureStructure(source);
  const graph = scarpLocalCallGraph(source, parsed);
  assert.ok(graph);
  assert.equal(graph.nodes.length, count);
  assert.equal(graph.calls.length, count - 1);
  for (let i = 0; i < count; i++) {
    const node = graph.nodes[i];
    const incoming = scarpIncomingCalls(graph, node);
    const outgoing = scarpOutgoingCalls(graph, node);
    assert.equal(incoming.length, i === 0 ? 0 : 1);
    assert.equal(outgoing.length, i === count - 1 ? 0 : 1);
  }
});

test('high repetition of the same call is grouped without losing source ranges', () => {
  const repetitions = 250;
  const source = `funcra a() { ${'b(); '.repeat(repetitions)} }\nfuncra b() {}`;
  const graph = scarpLocalCallGraph(source, fixtureStructure(source));
  assert.ok(graph);
  assert.equal(graph.calls.length, repetitions);
  const edge = scarpOutgoingCalls(graph, graph.nodes[0]);
  assert.equal(edge[0].sites.length, repetitions);
  assert.ok(edge[0].sites.every(s => source.slice(s.nameRange.start, s.nameRange.end) === 'b'));
});

test('large collections of independent local names stay within their functions', () => {
  const count = 70;
  const source = Array.from({ length: count }, (_, i) =>
    `funcra f${i}() { bind x = ${i}; print(x); }`).join('\n');
  const parsed = fixtureStructure(source);
  const locals = scarpLocalBindings(source, parsed);
  assert.ok(locals);
  assert.equal(locals.bindings.length, count);
  assert.equal(locals.references.length, count * 2);
  for (let i = 0; i < count; i++) {
    assert.equal(locals.bindings[i].functionName, `f${i}`);
  }
});

test('a scoped rename never changes another same-named local in a second function', () => {
  const count = 25;
  const source = Array.from({ length: count }, (_, i) =>
    `funcra f${i}() { bind item = ${i}; print(item); }`).join('\n');
  const selected = source.indexOf('bind item') + 5;
  const result = scarpLocalRenamePlan(source, fixtureStructure(source), selected, 'chosen');
  assert.ok(result);
  assert.equal(result.edits.length, 2);
  assert.ok(result.edits.every(edit => edit.start < source.indexOf('funcra f1')));
});

test('large local indexes keep document highlights within a single function', () => {
  const count = 50;
  const source = Array.from({ length: count }, (_, i) =>
    `funcra f${i}() { var value = ${i}; value += 1; print(value); }`).join('\n');
  const structure = fixtureStructure(source);
  const graph = scarpLocalCallGraph(source, structure);
  const locals = scarpLocalBindings(source, structure);
  const selected = source.indexOf('var value') + 4;
  const items = scarpDocumentHighlights(graph, locals, selected);
  assert.equal(items.length, 3);
  assert.ok(items.every(item => item.span.start < source.indexOf('funcra f1')));
});

test('unknown diagnostic codes cannot become mutation proposals under fuzzed coordinates', () => {
  const source = 'let value = 3;\nprint(value);';
  const parsed = fixtureStructure(source);
  const rng = random(123);
  for (let i = 0; i < 500; i++) {
    const start = integer(rng, 0, source.length);
    const code = i % 2 ? 'E1234' : 'W0005';
    assert.deepEqual(scarpQuickFixes(source, parsed, [{
      code, message: 'legacy let declaration', range: { start, end: start }
    }]), []);
  }
});

test('cache eviction and recomputation are deterministic under repeated edits', () => {
  const cache = new ScarpEditorAnalysisCache({ maximumEntries: 3 });
  const rng = random(444);
  for (let i = 0; i < 200; i++) {
    const version = integer(rng, 1, 100);
    const document = `file:///workspace/${integer(rng, 0, 7)}.srp`;
    const source = `funcra a() { print(${version}); }`;
    const graph = cache.graph(document, version, source, fixtureStructure(source));
    assert.equal(graph?.nodes.length, 1);
    assert.ok(cache.stats().entries <= 3);
  }
});

test('differential line-prefix fuzz never changes literal or body tokens', () => {
  const source = [
    'funcra compute() {',
    '  var total = 0;',
    '  repeat 5 as i {',
    '    total += i;',
    '  }',
    '  print(total);',
    '}'
  ];
  const rng = random(919);
  for (let iteration = 0; iteration < 100; iteration++) {
    const fuzzed = source.map((line, i) =>
      (i === 0 ? '' : indentation(rng, integer(rng, 0, 7))) + line.trimStart()).join('\n');
    const result = formatted(fuzzed);
    assert.deepEqual(result.split('\n').map(stripLeading),
      source.map(stripLeading));
  }
});

test('read-only analysis has no effect on source ownership or source identity', () => {
  const source = sampleProgram(511);
  const parsed = fixtureStructure(source);
  const state = JSON.stringify(parsed);
  const original = source;
  scarpLocalCallGraph(source, parsed);
  scarpLocalBindings(source, parsed);
  scarpQuickFixes(source, parsed, []);
  assert.equal(JSON.stringify(parsed), state);
  assert.equal(source, original);
});
