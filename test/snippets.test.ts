import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
interface Snippet { prefix: string; body: string[]; description: string; }
const snippets = JSON.parse(fs.readFileSync(
  path.join(root, 'snippets/scarp.code-snippets'), 'utf8'
)) as Record<string, Snippet>;

test('registers 31 bounded Scarp snippets with unique prefixes', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.contributes.snippets, [
    { language: 'scarp', path: './snippets/scarp.code-snippets' },
    { language: 'scarp-project', path: './snippets/scarp-project.code-snippets' }
  ]);
  assert.equal(Object.keys(snippets).length, 31);
  const prefixes = new Set<string>();
  for (const [name, snippet] of Object.entries(snippets)) {
    assert.ok(name.startsWith('Scarp: '));
    assert.match(snippet.prefix, /^s[a-z]+$/);
    assert.ok(!prefixes.has(snippet.prefix), 'Duplicate snippet prefix');
    prefixes.add(snippet.prefix);
    assert.ok(snippet.description.length >= 25);
    assert.ok(Array.isArray(snippet.body) && snippet.body.length > 0);
    assert.ok(snippet.body.every(line => typeof line === 'string' && line.length < 200));
    assert.ok(snippet.body.join('\n').length < 2000);
    assert.ok(snippet.body.includes('$0'), 'Missing final cursor stop');
  }
});

test('documents minimum compiler version and noninteractive input behavior', () => {
  for (const [name, snippet] of Object.entries(snippets)) {
    if (name.includes('(alpha.6)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.6\+/);
    }
    if (name.includes('(alpha.7)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.7\+/);
    }
    if (name.includes('(alpha.9)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.9\+/);
    }
    if (name.includes('(alpha.11)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.11\+/);
    }
    if (name.includes('(alpha.12)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.12\+/);
    }
    if (name.includes('(alpha.17)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.17\+/);
    }
    if (name.includes('(alpha.20)')) {
      assert.match(snippet.description, /v0\.0\.6-alpha\.20\+/);
    }
    if (name.includes('(v0.0.7-alpha.1)')) {
      assert.match(snippet.description, /v0\.0\.7-alpha\.1\+/);
      assert.match(snippet.description, /interpreter only/);
    }
  }
  assert.match(snippets['Scarp: Read redirected input (alpha.6)'].description,
    /no interactive prompt/);
  assert.match(snippets['Scarp: Read redirected input (alpha.6)'].body.join('\n'),
    /redirected UTF-8 stdin/);
});

test('alpha.7 conditional-value snippet uses an interpreter expression with a final else', () => {
  const snippet = snippets['Scarp: Conditional value (alpha.7)'];
  assert.equal(snippet.prefix, 'sconditional');
  const body = snippet.body.join('\n');
  assert.ok(body.includes(' = if ${1} >= ${4:60} {'));
  assert.ok(body.includes('} else {'));
  assert.ok(body.includes('print(${3});'));
  assert.match(snippet.description, /interpreter only/);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /verify-snippets\.cjs.*scarp" 6/);
  assert.match(ci, /verify-snippets\.cjs.*scarp" 7/);
});

test('alpha.9 BigInt starter uses explicit decimal and integer conversions', () => {
  const snippet = snippets['Scarp: Exact signed bigint (alpha.9)'];
  assert.equal(snippet.prefix, 'sbigint');
  const body = snippet.body.join('\n');
  assert.ok(body.includes(': bigint = bigint("'));
  assert.ok(body.includes('bigint_from_integer('));
  assert.ok(body.includes('print(${3});'));
  assert.match(snippet.description, /interpreter only/);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /verify-snippets\.cjs.*scarp" 9/);
});


test('alpha.11 exact decimal snippets are typed, opt-in and compiler-gated', () => {
  const arithmetic = snippets['Scarp: Exact decimal (alpha.11)'];
  assert.equal(arithmetic.prefix, 'sdecimal');
  const arithmeticBody = arithmetic.body.join('\n');
  assert.match(arithmeticBody, /: decimal = decimal\(/);
  assert.match(arithmeticBody, /decimal_format\(/);
  assert.match(arithmeticBody, /half_even/);
  assert.match(arithmetic.description, /interpreter only/);

  const interactive = snippets['Scarp: Interactive decimal input (alpha.11)'];
  assert.equal(interactive.prefix, 'sinputdecimal');
  const interactiveBody = interactive.body.join('\n');
  assert.match(interactiveBody, /input_decimal\(/);
  assert.match(interactiveBody, /--interactive/);
  assert.match(interactive.description, /explicit interactive execution/);

  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /verify-snippets\.cjs.*scarp" 11/);
});

test('alpha.12 immutable list/map snippets use snapshots and pinned compiler checks', () => {
  const list = snippets['Scarp: Immutable typed list (alpha.12)'];
  assert.equal(list.prefix, 'slist');
  assert.match(list.body.join('\n'), /list<integer>/);
  assert.match(list.body.join('\n'), /list_push\(/);
  const map = snippets['Scarp: Immutable typed map (alpha.12)'];
  assert.equal(map.prefix, 'smap');
  assert.match(map.body.join('\n'), /map<string, integer>/);
  assert.match(map.body.join('\n'), /map_set\(/);
  assert.match(map.body.join('\n'), /map_get_or\(/);
  for (const snippet of [list, map]) {
    assert.match(snippet.description, /interpreter only/);
    assert.match(snippet.description, /immutable/);
  }
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /verify-snippets\.cjs.*scarp" 12/);
  assert.match(ci, /a1f9c2fc1c6bc8f3e04878d30d658bb38fab441d/);
  assert.match(ci, /e755fda37cdaeed29434e848cb5dd41f2f2e7eb2/);
});


test('alpha.12 nominal types, checked variants and explicit propagation snippets are released compiler gated', () => {
  const expected: Record<string, string[]> = {
    srecord: ['record ', 'new ', '->'],
    svariant: ['variant ', 'match on ', 'case Success(', 'case Failure'],
    soption: ['option<integer>', 'case Some(', 'case None'],
    sresult: ['result<integer, string>', 'case Ok(', 'case Err('],
    spropagate: ['option<integer>', 'value?;', 'return new option']
  };
  for (const [prefix, required] of Object.entries(expected)) {
    const item = Object.values(snippets).find(x => x.prefix === prefix);
    assert.ok(item, prefix);
    const body = item.body.join('\n');
    for (const token of required) {
      assert.ok(body.includes(token), prefix + ' missing ' + token);
    }
    assert.match(item.description, /v0\.0\.6-alpha\.12\+/);
    assert.match(item.description, /interpreter only/);
  }
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /verify-snippets\.cjs.*scarp" 12/);
  for (const example of [
    'typed_submission', 'typed_propagation', 'variant_validation',
    'app_state', 'boolean_match', 'scalar_literal_match'
  ]) {
    assert.ok(ci.includes(example), example + ' needs official compiler verification');
  }
});


test('alpha.17 array traversal and interactive Boolean snippets use real published calls', () => {
  const array = snippets['Scarp: Fixed array traversal (alpha.17)'];
  assert.equal(array.prefix, 'sarraywalk');
  assert.match(array.body.join('\n'), /repeat array_len\(/);
  assert.match(array.body.join('\n'), /array_get_or\(/);
  const booleanInput = snippets['Scarp: Interactive Boolean input (alpha.17)'];
  assert.equal(booleanInput.prefix, 'sinputbool');
  assert.match(booleanInput.body.join('\n'), /input_boolean\(/);
  assert.match(booleanInput.body.join('\n'), /--interactive/);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /verify-snippets\.cjs "\$binary" 17/);
  assert.match(ci, /7831a37939965f557ce746e1d86bf82d3d629f74/);
});

test('alpha.20 snippets describe exact decimals and persistent tuple replacement', () => {
  const exact = snippets['Scarp: Exact decimal literal (alpha.20)'];
  assert.equal(exact.prefix, 'sdecimalliteral');
  assert.ok(exact.body.join('\n').includes('${2:0.1}d + ${3:0.2}d'));
  assert.match(exact.description, /interpreter only/);
  const tuple = snippets['Scarp: Mutable tuple replacement (alpha.20)'];
  assert.equal(tuple.prefix, 'stuplereplace');
  assert.ok(tuple.body.join('\n').includes('${1}[0] = ${5:50};'));
  assert.ok(tuple.body.join('\n').includes('bind ${4:before} = ${1};'));
  assert.match(tuple.description, /fresh tuple snapshot/);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(ci.includes('verify-snippets.cjs "$binary" 20'));
});

test('new series snippets show fixed arrays, integer reductions and vector softplus', () => {
  const array = snippets['Scarp: Fixed array concatenation (v0.0.7-alpha.1)'];
  assert.equal(array.prefix, 'sarrayconcat');
  assert.match(array.body.join('\n'), /array_concat\(/);
  assert.match(array.description, /persistent snapshots/);
  const integer = snippets['Scarp: Variadic integer reductions (v0.0.7-alpha.1)'];
  assert.equal(integer.prefix, 'sintegerreduce');
  for (const name of ['integer_gcd', 'integer_hcf', 'integer_lcm']) {
    assert.ok(integer.body.some(line => line.includes(name + '(')));
  }
  assert.match(integer.description, /1,024/);
  const softplus = snippets['Scarp: Vector softplus (v0.0.7-alpha.1)'];
  assert.equal(softplus.prefix, 'ssoftplus');
  assert.match(softplus.body.join('\n'), /: vector = softplus\(/);
});

