import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildScarpImportGraph } from '../src/editorImportGraph';
import { catalogScarpProjects } from '../src/editorProjectCatalog';
import { formatScarpWorkspaceReport } from '../src/editorWorkspaceReport';

function graph() {
  return buildScarpImportGraph([
    { file: 'main.srp',
      source: 'import "math.srp" as math;\nimport "missing.srp" as missing;' },
    { file: 'math.srp', source: 'pub bind answer = 42;' }
  ]);
}
test('empty report is non-executing and records explicit structural limits', () => {
  const content = formatScarpWorkspaceReport(buildScarpImportGraph([]));
  assert.match(content, /^# Scarp workspace source report/);
  assert.match(content, /Indexed modules \| 0/);
  assert.match(content, /No indexed source modules/);
  assert.match(content, /not semantic diagnostics/);
  assert.match(content, /never executes/);
});
test('report includes source modules, references and missing imports', () => {
  const content = formatScarpWorkspaceReport(graph());
  assert.match(content, /main\.srp/);
  assert.match(content, /math\.srp/);
  assert.match(content, /missing-module/);
  assert.match(content, /## Source imports/);
  assert.match(content, /## Graph observations/);
});
test('report serializes ordinary exact alias and link metadata', () => {
  const content = formatScarpWorkspaceReport(graph());
  assert.ok(content.includes('| main.srp | math.srp | math |'));
});
test('inventory observations include byte count and skipped paths', () => {
  const content = formatScarpWorkspaceReport(graph(), {
    byteCount: 123,
    sources: [],
    issues: [{ file: 'bad.srp', reason: 'invalid-utf8' }]
  });
  assert.match(content, /Workspace input bytes \| 123/);
  assert.match(content, /invalid-utf8/);
  assert.match(content, /bad\.srp/);
});
test('recognized projects appear with modern and legacy formats', () => {
  const projects = catalogScarpProjects([
    {
      filename: 'app/scarp.project',
      content: 'project "app" {\nversion: "0.1.0"\nentry: "src/main.srp"\n' +
        'type: "application"\ndependencies {}\n}'
    },
    {
      filename: 'old/Scarp.project',
      content: 'scarp-project: 1\nname: old\nentry: src/main.srp\n'
    }
  ]);
  const text = formatScarpWorkspaceReport(graph(), undefined, projects);
  assert.match(text, /## Projects/);
  assert.match(text, /declarative-v2/);
  assert.match(text, /legacy-v1/);
  assert.match(text, /app\/src\/main\.srp/);
});
test('reported cycles preserve all members in stable order', () => {
  const cycle = buildScarpImportGraph([
    { file: 'a.srp', source: 'import "b.srp" as b;' },
    { file: 'b.srp', source: 'import "a.srp" as a;' }
  ]);
  const text = formatScarpWorkspaceReport(cycle);
  assert.match(text, /## Cyclic references/);
  assert.match(text, /a\.srp → b\.srp/);
  assert.match(text, /cycle/);
});
test('Markdown cells escape untrusted markup and command-like links', () => {
  const graphWithMarkup = buildScarpImportGraph([
    { file: 'unsafe[title].srp',
      source: 'import "missing|table.srp" as fake;' }
  ]);
  const text = formatScarpWorkspaceReport(graphWithMarkup, undefined, undefined, {
    title: 'Name <script> *bold*'
  });
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('\\<script\\>'));
  assert.ok(text.includes('unsafe\\[title\\].srp'));
  assert.ok(text.includes('missing\\|table.srp'));
});
test('invalid report limits cannot allocate arbitrary output', () => {
  for (const maxCharacters of [-1, 0, 1.5, Infinity, NaN, 10]) {
    const text = formatScarpWorkspaceReport(graph(), undefined, undefined,
      { maxCharacters });
    assert.match(text, /limit too small/);
    assert.ok(text.length < 120);
  }
});
test('bounded report truncation is explicit and does not exceed maximum characters', () => {
  const source = Array.from({ length: 80 }, (_, i) => ({
    file: 'source' + i + '.srp',
    source: 'import "missing' + i + '.srp" as missing;'
  }));
  const text = formatScarpWorkspaceReport(buildScarpImportGraph(source),
    undefined, undefined, { maxCharacters: 1024 });
  assert.ok(text.length <= 1024);
  assert.match(text, /truncated/);
  assert.ok(text.startsWith('# Scarp workspace source report'));
});
test('graph report result is deterministic regardless of input order', () => {
  const sources = [
    { file: 'z.srp', source: 'import "a.srp" as a;' },
    { file: 'a.srp', source: 'print(1);' },
    { file: 'b.srp', source: 'print(2);' }
  ];
  const a = formatScarpWorkspaceReport(buildScarpImportGraph(sources));
  const b = formatScarpWorkspaceReport(buildScarpImportGraph([...sources].reverse()));
  assert.equal(a, b);
});
test('very large names never produce an unbounded amount of source markup', () => {
  const graphWithLong = buildScarpImportGraph([
    { file: 'a'.repeat(490) + '.srp', source: 'print(1);' }
  ]);
  const text = formatScarpWorkspaceReport(graphWithLong);
  assert.ok(text.length < 20_000);
  assert.ok(text.includes('## Scope and limitations'));
});
test('reporting lexical issues never incorrectly claims compiler verification', () => {
  const text = formatScarpWorkspaceReport(graph());
  assert.match(text, /official Scarp compiler defines/);
  assert.ok(!text.includes('All project tests passed'));
});
