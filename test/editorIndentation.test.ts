import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scarpIndentationEdits, applyScarpIndentationEdits
} from '../src/editorIndentation';
import { fixtureStructure, applyEdits } from './editorFixture';

function formatted(input: string, opts: Parameters<typeof scarpIndentationEdits>[2] = {}): string {
  const edits = scarpIndentationEdits(input, fixtureStructure(input), opts);
  const result = applyScarpIndentationEdits(input, edits);
  assert.notEqual(result, undefined);
  assert.equal(result, applyEdits(input, edits));
  return result!;
}

test('indents nested file-scope functions and all statement blocks', () => {
  const input = 'funcra example() {\nif true {\nprint(1);\n} else {\nrepeat 2 as n {\nprint(n);\n}\n}\n}\n';
  assert.equal(formatted(input),
    'funcra example() {\n    if true {\n        print(1);\n    } else {\n        repeat 2 as n {\n            print(n);\n        }\n    }\n}\n');
});

test('retains raw and escaped string contents byte for byte', () => {
  const input = 'funcra run() {\n  print("{ unbalanced }");\n  print("\\\" }");\n  print("""\\nraw { literal\n  } token\n  """);\nprint(2);\n}\n';
  const result = formatted(input);
  assert.match(result, /^funcra run\(\) \{\n    print/m);
  assert.ok(result.includes('raw { literal\n  } token\n  """'));
  assert.ok(result.includes('    print(2);'));
});

test('preserves CRLF and never normalizes line endings or token spacing', () => {
  const input = 'funcra calc( x : integer ) {\r\nif x > 0 {\r\n  return x;\r\n}\r\nreturn 0;\r\n}\r\n';
  const result = formatted(input, { tabSize: 2 });
  assert.equal(result, 'funcra calc( x : integer ) {\r\n  if x > 0 {\r\n    return x;\r\n  }\r\n  return 0;\r\n}\r\n');
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
});

test('tab indentation uses exactly one tab per nesting level', () => {
  const source = 'funcra a() {\nrepeat 2 as i {\nprint(i);\n}\n}\n';
  assert.equal(formatted(source, { insertSpaces: false }),
    'funcra a() {\n\trepeat 2 as i {\n\t\tprint(i);\n\t}\n}\n');
});

test('handles nested array and tuple continuations without rewriting content', () => {
  const source = 'funcra f() {\nbind item = [\n1,\n(\n2,\n3\n)\n];\n}\n';
  assert.equal(formatted(source, { tabSize: 2 }),
    'funcra f() {\n  bind item = [\n    1,\n    (\n      2,\n      3\n    )\n  ];\n}\n');
});

test('continuation indentation can be disabled without disabling block indentation', () => {
  const source = 'funcra f() {\nprint(\n1\n);\n}\n';
  const result = formatted(source, { tabSize: 2, continuationIndent: false });
  assert.equal(result, 'funcra f() {\n  print(\n  1\n  );\n}\n');
});

test('comments and braces within comments do not alter subsequent levels', () => {
  const source = 'funcra f() {\n// braces { } ( [] }\nprint(1);\n}\n';
  assert.equal(formatted(source),
    'funcra f() {\n    // braces { } ( [] }\n    print(1);\n}\n');
});

test('whole-line raw content in a multiline literal cannot be indented', () => {
  const source = 'funcra f() {\nprint("""\n  { program-looking text\n nested ( )\n""");\nprint(3);\n}\n';
  const result = formatted(source);
  assert.ok(result.includes('\n  { program-looking text\n nested ( )\n""");\n'));
  assert.ok(result.includes('\n    print(3);\n'));
});

test('does not shift delimiters on lines inside multiline literals', () => {
  const source = 'funcra f() {\nprint("""abc\n]\n{}\nxyz""");\n}\n';
  assert.ok(formatted(source).includes('abc\n]\n{}\nxyz'));
});

test('the formatter is idempotent over representative valid programs', () => {
  for (const source of [
    'var count = 0;\nwhile count < 10 {\ncount += 1;\n}\n',
    'funcra f(x: integer) -> integer {\nif x > 5 {\nreturn x;\n}\nreturn 0;\n}\n',
    'record Record {\nname: string,\nvalue: integer\n}\n',
    'bind a = (\n  1,\n  2,\n);\n',
    'funcra f() {\n// #region one\nprint("hi");\n// #endregion\n}\n'
  ]) {
    const first = formatted(source);
    assert.equal(formatted(first), first);
  }
});

test('a selected range touches only intersecting logical lines', () => {
  const source = 'funcra f() {\nprint(1);\nif true {\nprint(2);\n}\n}\n';
  const start = source.indexOf('if true');
  const end = source.indexOf('\n}', start);
  const result = formatted(source, { range: { start, end }, tabSize: 2 });
  assert.equal(result, 'funcra f() {\nprint(1);\n  if true {\n    print(2);\n}\n}\n');
});

test('cursor range formats a line without touching its siblings', () => {
  const source = 'funcra f() {\nprint(1);\nprint(2);\n}\n';
  const cursor = source.indexOf('print(1)') + 2;
  assert.equal(formatted(source, { range: { start: cursor, end: cursor } }),
    'funcra f() {\n    print(1);\nprint(2);\n}\n');
});

test('supports empty lines when explicitly requested', () => {
  const input = 'funcra f() {\n\nprint(1);\n}\n';
  assert.equal(formatted(input), 'funcra f() {\n\n    print(1);\n}\n');
  assert.equal(formatted(input, { indentEmptyLines: true }),
    'funcra f() {\n    \n    print(1);\n}\n');
});

test('does not remove trailing spaces by default', () => {
  const input = 'funcra f() {\nprint(1);   \n}\n';
  assert.equal(formatted(input), 'funcra f() {\n    print(1);   \n}\n');
  assert.equal(formatted(input, { trimTrailingWhitespace: true }),
    'funcra f() {\n    print(1);\n}\n');
});

test('does not change comment trailing spaces even in trim mode', () => {
  const input = 'funcra f() {\n// comment   \n}\n';
  assert.equal(formatted(input, { trimTrailingWhitespace: true }),
    'funcra f() {\n    // comment   \n}\n');
});

test('invalid structure lengths fail closed', () => {
  const text = 'funcra f() {\nprint(1);\n}\n';
  const parsed = fixtureStructure(text);
  assert.deepEqual(scarpIndentationEdits(text, { ...parsed, length: text.length + 1 }), []);
});

test('unbalanced and mismatched braces fail closed', () => {
  for (const source of ['funcra f() {\nprint(1);\n', 'funcra f() {\nprint(1);\n]]}\n',
    'funcra f() {\nprint(1);\n}}\n']) {
    assert.deepEqual(scarpIndentationEdits(source, fixtureStructure(source)), []);
  }
});

test('resource bounds cap document length and edit count', () => {
  const source = 'funcra f() {\nprint(1);\nprint(2);\n}\n';
  assert.deepEqual(scarpIndentationEdits(source, fixtureStructure(source), {
    maximumSourceLength: 10
  }), []);
  assert.deepEqual(scarpIndentationEdits(source, fixtureStructure(source), {
    maximumEdits: 1
  }), []);
  assert.deepEqual(scarpIndentationEdits(source, fixtureStructure(source), {
    tabSize: 0
  }), []);
});

test('bad range inputs never produce speculative edits', () => {
  const source = 'funcra f() {\nprint(1);\n}\n';
  for (const bad of [
    { start: -1, end: 0 }, { start: 10, end: 3 },
    { start: 0, end: source.length + 1 },
    { start: NaN, end: 2 }
  ]) {
    assert.deepEqual(scarpIndentationEdits(source, fixtureStructure(source), {
      range: bad
    }), []);
  }
});

test('combining marks, emoji and other Unicode do not corrupt offsets', () => {
  const source = 'funcra f() {\nprint("🦊 é 漢字");\n}\n';
  assert.equal(formatted(source), 'funcra f() {\n    print("🦊 é 漢字");\n}\n');
});

test('empty document and whitespace-only files need no editing', () => {
  for (const source of ['', '  ', '\n\n', '\r\n']) {
    assert.equal(formatted(source), source);
  }
});

test('repeated prefixes are replaced at exact UTF-16 ranges', () => {
  const source = 'funcra f() {\n   print(1);\n   print(2);\n}\n';
  const edits = scarpIndentationEdits(source, fixtureStructure(source), { tabSize: 2 });
  assert.deepEqual(edits.map(e => e.replacement), ['  ', '  ']);
  assert.equal(formatted(source, { tabSize: 2 }),
    'funcra f() {\n  print(1);\n  print(2);\n}\n');
});

test('applying invalid overlapping edits fails without partial modifications', () => {
  assert.equal(applyScarpIndentationEdits('123456', [
    { start: 0, end: 3, replacement: '' },
    { start: 2, end: 4, replacement: '' }
  ]), undefined);
});
