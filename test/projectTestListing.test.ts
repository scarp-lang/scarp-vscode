import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseListedProjectTests } from '../src/projectTestListing';

const report = (paths: string[], extra: object = {}): string => JSON.stringify({
  schema_version: 1, mode: 'list',
  discovered: paths.length, passed: 0, failed: 0,
  tests: paths.map(path => ({ path, status: 'discovered' })), ...extra
});

test('accepts empty suites and discovered Unicode test filenames', () => {
  assert.deepEqual(parseListedProjectTests(report([])), []);
  assert.deepEqual(parseListedProjectTests(report(['tests/add.srp', 'tests/नमस्ते.srp'])),
    ['tests/add.srp', 'tests/नमस्ते.srp']);
});

test('rejects misleading reports and tests with executable statuses', () => {
  for (const bad of [
    '{}', '{broken', '[]', 'null', report([], { schema_version: 2 }),
    report([], { mode: 'run' }), report([], { passed: 1 }),
    report([], { failed: 1 }), report([], { discovered: -1 }),
    report([], { discovered: 1 }), report([], { discovered: 1.5 }),
    report([], { tests: {} }), report([], { tests: [{ path: 'tests/x.srp', status: 'passed' }] }),
    report(Array.from({ length: 65 }, (_, i) => 'tests/' + i + '.srp'))
  ]) {
    assert.throws(() => parseListedProjectTests(bad), /test listing JSON/);
  }
});

test('rejects path traversal, unsafe characters, duplicate and nested tests', () => {
  for (const value of [
    '../secret.srp', '/etc/passwd.srp', 'src/main.srp',
    'tests/../secret.srp', 'tests/deeper/case.srp', 'tests\\bad.srp',
    'tests/bad:case.srp', 'tests/bad\ncase.srp', 'tests/bad\u0000case.srp',
    'tests/hello.txt', 'tests/.srp'.replace('.srp', '.txt'),
    'tests/' + 'x'.repeat(513) + '.srp'
  ]) {
    assert.throws(() => parseListedProjectTests(report([value])), /test listing JSON/, value);
  }
  assert.throws(() => parseListedProjectTests(report(['tests/a.srp', 'tests/a.srp'])),
    /test listing JSON/);
});
