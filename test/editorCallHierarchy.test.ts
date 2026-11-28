import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpLocalCallGraph, scarpCallNodeAt, scarpIncomingCalls,
  scarpOutgoingCalls, type ScarpCallGraph
} from '../src/editorCallHierarchy';
import { fixtureStructure } from './editorFixture';

function graph(source: string): ScarpCallGraph {
  const result = scarpLocalCallGraph(source, fixtureStructure(source));
  assert.ok(result, 'The test fixture must have valid balanced punctuation');
  return result;
}
function edges(source: string, name: string) {
  const data = graph(source);
  const node = data.nodes.find(n => n.name === name);
  assert.ok(node, `Expected a function ${name}`);
  return {
    incoming: scarpIncomingCalls(data, node).map(e => [e.from.name, e.sites.length]),
    outgoing: scarpOutgoingCalls(data, node).map(e => [e.to.name, e.sites.length]),
    graph: data
  };
}

test('recognizes a function with explicit parameters and a return type', () => {
  const source = 'funcra square(value: integer) -> integer {\nreturn value * value;\n}\n';
  const index = graph(source);
  assert.equal(index.nodes.length, 1);
  assert.equal(index.nodes[0].name, 'square');
  assert.deepEqual(index.nodes[0].parameters, ['value']);
  assert.equal(index.nodes[0].pure, false);
  assert.equal(index.calls.length, 0);
  assert.deepEqual(index.rejected, []);
});

test('recognizes pure and public function modifiers', () => {
  const source = 'pub pure funcra double(value: integer) -> integer {\nreturn value * 2;\n}\n';
  const found = graph(source).nodes[0];
  assert.ok(found);
  assert.equal(found.public, true);
  assert.equal(found.pure, true);
  assert.equal(found.declarationRange.start, 0);
});

test('top-level calls are not misidentified as declared call graph nodes', () => {
  const source = 'funcra read() -> integer { return 1; }\nprint(read());\n';
  assert.equal(graph(source).nodes.length, 1);
  assert.equal(graph(source).calls.length, 0);
});

test('records ordinary direct calls and nested calls in a caller', () => {
  const source = 'funcra a() { b(c()); }\nfuncra b(x: integer) { print(x); }\nfuncra c() -> integer { return 3; }';
  const info = edges(source, 'a');
  assert.deepEqual(info.outgoing, [['b', 1], ['c', 1]]);
  assert.deepEqual(info.incoming, []);
});

test('groups repeated calls into one outgoing edge with multiple sites', () => {
  const source = 'funcra a() {\nb();\nb();\n}\nfuncra b() {\n}\n';
  const info = edges(source, 'a');
  assert.deepEqual(info.outgoing, [['b', 2]]);
  assert.equal(info.graph.calls[0].nameRange.start, source.indexOf('b();'));
  assert.equal(info.graph.calls[1].nameRange.start, source.lastIndexOf('b();'));
});

test('incoming edges aggregate call sites from independent callers', () => {
  const source = 'funcra a() { target(); target(); }\nfuncra b() { target(); }\nfuncra target() {}';
  assert.deepEqual(edges(source, 'target').incoming, [['a', 2], ['b', 1]]);
});

test('recursive functions include a self-edge', () => {
  const source = 'funcra recurse(n: integer) -> integer { return recurse(n - 1); }';
  assert.deepEqual(edges(source, 'recurse').outgoing, [['recurse', 1]]);
  assert.deepEqual(edges(source, 'recurse').incoming, [['recurse', 1]]);
});

test('mutually recursive functions are represented accurately', () => {
  const source = 'funcra even(n: integer) { odd(n); }\nfuncra odd(n: integer) { even(n); }';
  assert.deepEqual(edges(source, 'even').outgoing, [['odd', 1]]);
  assert.deepEqual(edges(source, 'even').incoming, [['odd', 1]]);
});

test('comments and quoted text do not introduce fake calls', () => {
  const source = 'funcra a() {\n// b();\nprint("b()");\n}\nfuncra b() {}';
  assert.deepEqual(graph(source).calls, []);
});

test('multiline raw string with apparent declarations cannot create phantom nodes', () => {
  const source = 'funcra a() { print("""\nfuncra fake() { b(); }\n"""); }\nfuncra b() {}';
  assert.deepEqual(graph(source).nodes.map(n => n.name), ['a', 'b']);
  assert.deepEqual(graph(source).calls, []);
});

test('method access is not guessed to be a free function', () => {
  const source = 'funcra f() { obj.step(); obj::step(); }\nfuncra step() {}';
  assert.deepEqual(graph(source).calls, []);
});

test('class/type creation is not a free function call', () => {
  const source = 'funcra f() { new Widget(); }\nfuncra Widget() {}';
  assert.deepEqual(graph(source).calls, []);
});

test('field-label-like contexts conservatively suppress name resolution', () => {
  const source = 'funcra f() { thing: value(); }\nfuncra thing() {}\nfuncra value() {}';
  const info = edges(source, 'f');
  assert.deepEqual(info.outgoing, []);
});

test('a same-name parameter suppresses a speculative edge', () => {
  const source = 'funcra a(b: func) { b(); }\nfuncra b() {}';
  assert.deepEqual(edges(source, 'a').outgoing, []);
});

test('a same-name local binding suppresses later speculative calls', () => {
  const source = 'funcra a() { bind b = identity; b(); }\nfuncra b() {}';
  assert.deepEqual(edges(source, 'a').outgoing, []);
});

test('a same-name variable does not suppress calls before its declaration', () => {
  const source = 'funcra a() { b(); bind b = 1; }\nfuncra b() {}';
  assert.deepEqual(edges(source, 'a').outgoing, [['b', 1]]);
});

test('local shadowing ends at the end of its nested block', () => {
  const source = 'funcra a() { if true { var b = fn; b(); } b(); }\nfuncra b() {}';
  assert.deepEqual(edges(source, 'a').outgoing, [['b', 1]]);
});

test('a repeat index can shadow a same-named callable only inside its loop', () => {
  const source = 'funcra a() { repeat 3 as b { b(); } b(); }\nfuncra b() {}';
  assert.deepEqual(edges(source, 'a').outgoing, [['b', 1]]);
});

test('unknown external or built-in function calls are omitted', () => {
  const source = 'funcra f() { print(3); external(); maths::add(1); }';
  assert.deepEqual(graph(source).calls, []);
});

test('duplicate local callable names are not arbitrarily resolved', () => {
  const source = 'funcra f() { go(); }\nfuncra go() {}\nfuncra go() {}';
  const result = graph(source);
  assert.deepEqual(result.rejected, ['go']);
  assert.deepEqual(result.calls, []);
});

test('function declaration order does not affect call graph resolution', () => {
  const source = 'funcra first() { next(); }\nfuncra next() { }';
  assert.deepEqual(edges(source, 'first').outgoing, [['next', 1]]);
});

test('a function with no parameters is recognized', () => {
  const source = 'funcra main() { print(1); }';
  assert.deepEqual(graph(source).nodes[0].parameters, []);
});

test('a generic callable declaration is recognized without type inference', () => {
  const source = 'funcra identity<T>(value: T) -> T { return value; }';
  const result = graph(source);
  assert.equal(result.nodes[0]?.name, 'identity');
  assert.deepEqual(result.nodes[0]?.parameters, ['value']);
});

test('same-file generic invocations can point to a known function', () => {
  const source = 'funcra main() { identity<integer>(1); }\nfuncra identity<T>(x: T) -> T { return x; }';
  assert.deepEqual(edges(source, 'main').outgoing, [['identity', 1]]);
});

test('an invalid generic header cannot be assigned a guessed declaration', () => {
  const source = 'funcra f<> (x: integer) { print(x); }';
  assert.equal(graph(source).nodes.length, 0);
});

test('disallows positional parameters without the published named type syntax', () => {
  const source = 'funcra f(x, y) { print(1); }';
  assert.equal(graph(source).nodes.length, 0);
});

test('ambiguous or malformed parameter headers do not create a graph node', () => {
  for (const source of [
    'funcra f(x: integer, x: integer) {}',
    'funcra f(x: integer, : integer) {}',
    'funcra f(1: integer) {}'
  ]) {
    assert.deepEqual(graph(source).nodes, [], source);
  }
});

test('discards a function declaration when its body is missing', () => {
  const source = 'funcra f(x: integer) -> integer;';
  assert.deepEqual(graph(source).nodes, []);
});

test('rejects a structurally invalid file rather than building a partial graph', () => {
  for (const source of [
    'funcra f() { print(1);',
    'funcra f() { print(1); } }',
    'funcra f() { print(1; }'
  ]) {
    assert.equal(scarpLocalCallGraph(source, fixtureStructure(source)), undefined);
  }
});

test('the cursor resolver selects only exact declaration names', () => {
  const source = 'funcra alpha() {}\nfuncra beta() {}';
  const data = graph(source);
  const begin = source.indexOf('alpha');
  assert.equal(scarpCallNodeAt(data, begin)?.name, 'alpha');
  assert.equal(scarpCallNodeAt(data, begin + 2)?.name, 'alpha');
  assert.equal(scarpCallNodeAt(data, source.indexOf('funcra')), undefined);
  assert.equal(scarpCallNodeAt(data, -1), undefined);
});

test('function ranges use stable UTF-16 source offsets after Unicode text', () => {
  const source = 'print("😀");\nfuncra f() { }';
  const found = graph(source).nodes[0];
  assert.equal(found.nameRange.start, source.indexOf('f()'));
});

test('call ranges include complete parentheses and nested arguments', () => {
  const source = 'funcra a() { b(3, (4 + 5)); }\nfuncra b(x: integer, y: integer) {}';
  const site = graph(source).calls[0];
  assert.equal(source.slice(site.callRange.start, site.callRange.end), 'b(3, (4 + 5))');
});

test('overlapping callers never produce duplicate call sites', () => {
  const source = 'funcra a() { b(); }\nfuncra b() { c(); }\nfuncra c() {}';
  const data = graph(source);
  assert.deepEqual(data.calls.map(c => [c.caller, c.callee]), [['a', 'b'], ['b', 'c']]);
});

test('a call on the same line as a string keeps its exact source offset', () => {
  const source = 'funcra a() { print("b()"); b(); }\nfuncra b() {}';
  assert.equal(source.slice(graph(source).calls[0].nameRange.start,
    graph(source).calls[0].nameRange.end), 'b');
});

test('resource limits fail closed for large or expensive sources', () => {
  const source = 'funcra a() { b(); }\nfuncra b() {}';
  const structure = fixtureStructure(source);
  for (const options of [
    { maximumSourceLength: 8 },
    { maximumTokens: 5 },
    { maximumFunctions: 1 },
    { maximumCalls: 0 },
    { maximumHeaderTokens: 2 }
  ]) {
    const result = scarpLocalCallGraph(source, structure, options);
    if (options.maximumCalls === 0 || options.maximumSourceLength ||
        options.maximumTokens || options.maximumFunctions) assert.equal(result, undefined);
    else assert.equal(result?.nodes.length, 0);
  }
});

test('call count budget cannot produce a misleading partial graph', () => {
  const source = 'funcra a() { b(); b(); }\nfuncra b() {}';
  assert.equal(scarpLocalCallGraph(source, fixtureStructure(source), {
    maximumCalls: 1
  }), undefined);
});

test('max source and token budgets require safe integers', () => {
  const source = 'funcra a() {}';
  for (const options of [
    { maximumSourceLength: NaN }, { maximumTokens: -5 },
    { maximumFunctions: Infinity }, { maximumHeaderTokens: 1.7 }
  ]) {
    assert.equal(scarpLocalCallGraph(source, fixtureStructure(source), options), undefined);
  }
});

test('repeated graph reads do not mutate or reorder the original graph', () => {
  const source = 'funcra a() { b(); c(); }\nfuncra b() {}\nfuncra c() {}';
  const data = graph(source);
  const before = JSON.stringify(data);
  const a = data.nodes[0];
  assert.ok(a);
  assert.equal(scarpOutgoingCalls(data, a).length, 2);
  assert.equal(scarpOutgoingCalls(data, a).length, 2);
  assert.equal(JSON.stringify(data), before);
});

test('empty files produce empty graphs, never fictitious functions', () => {
  assert.deepEqual(graph(''), { nodes: [], calls: [], rejected: [] });
});
