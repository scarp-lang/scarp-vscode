import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hasProjectWorkflow, validProjectName, validProjectTestFilter, projectArgv, projectTestListArgv } from '../src/projectWorkflow';

const report = (extra: object = {}): string => JSON.stringify({
  schema_version: 1, version: '0.0.5-alpha.4',
  execution: 'interpreter', static_verify: true,
  project_workflow: true, ...extra
});

test('enables project integration only with real schema-v1 capability flag', () => {
  assert.equal(hasProjectWorkflow(report()), true);
  assert.equal(hasProjectWorkflow(report({ project_workflow: false })), false);
  assert.equal(hasProjectWorkflow(report({ project_workflow: 'true' })), false);
  assert.equal(hasProjectWorkflow(report({ schema_version: 2 })), false);
  assert.equal(hasProjectWorkflow(report({ static_verify: false })), false);
  assert.equal(hasProjectWorkflow(report({ execution: 'native' })), false);
  assert.equal(hasProjectWorkflow('scarp 0.0.5-alpha.4'), false);
  assert.equal(hasProjectWorkflow('{broken'), false);
  assert.equal(hasProjectWorkflow('{}'), false);
});

test('name validator allows Unicode but rejects traversal, separators and compiler-invalid names', () => {
  for (const name of ['hello-world', 'प्रोजेक्ट', 'a'.repeat(96)]) {
    assert.equal(validProjectName(name), true, name);
  }
  for (const name of ['', '.', '..', ' ../name ', '../escape', 'bad/name', 'bad\\name',
    'bad:name', 'trailing ', 'line\nbreak', 'a'.repeat(97)]) {
    assert.equal(validProjectName(name), false, name);
  }
  assert.equal(validProjectName('😀'.repeat(24)), true);
  assert.equal(validProjectName('😀'.repeat(25)), false);
});

test('builds argv without a shell or implicit ancestor discovery', () => {
  const directory = '/tmp/my project;$(id)';
  assert.deepEqual(projectArgv('create', directory), ['create', '--', directory]);
  assert.deepEqual(projectArgv('init', directory), ['init', '--', directory]);
  assert.deepEqual(projectArgv('verify', directory), [
    'verify', '--diagnostic-format=json', '--', directory
  ]);
  assert.deepEqual(projectArgv('test', directory), ['test', '--', directory]);
  assert.deepEqual(projectArgv('launch', directory, ['--max-steps', '99']), [
    'launch', '--max-steps', '99', '--', directory
  ]);
  assert.throws(() => projectArgv('verify', directory, ['--max-steps', '1']), /budgets/);
  assert.throws(() => projectArgv('create', directory, ['--max-steps', '1']), /budgets/);
  assert.throws(() => projectArgv('init', directory, ['--max-steps', '1']), /budgets/);
  assert.throws(() => projectArgv('test', directory, ['--max-steps', '1']), /budgets/);
  assert.throws(() => projectArgv('launch', ''), /required/);
});

test('accepts only bounded literal filename-substring filters', () => {
  for (const good of ['addition', 'test.srp', 'नमस्ते', 'a'.repeat(128), 'filter with spaces']) {
    assert.equal(validProjectTestFilter(good), true, good);
  }
  for (const bad of ['', '-all', '--help', '/', 'tests/add.srp', 'test\\\\bad',
    'bad:name', 'bad\\nname', 'bad\\rname', 'bad\\tname',
    String.fromCharCode(0), String.fromCharCode(127), 'a'.repeat(129),
    '😀'.repeat(33), null, undefined, 42, { filter: 'addition' }]) {
    assert.equal(validProjectTestFilter(bad), false, String(bad));
  }
  assert.equal(validProjectTestFilter('😀'.repeat(32)), true);
});

test('passes filtered test names as one literal argument, without a shell', () => {
  const directory = '/tmp/a project;$(id)';
  assert.deepEqual(projectArgv('test', directory, [], 'नमस्ते'), [
    'test', '--filter', 'नमस्ते', '--', directory
  ]);
  assert.deepEqual(projectArgv('test', directory, [], 'a test'), [
    'test', '--filter', 'a test', '--', directory
  ]);
  assert.deepEqual(projectArgv('test', directory), ['test', '--', directory]);
  assert.throws(() => projectArgv('test', directory, [], '--help'), /filter/);
  assert.throws(() => projectArgv('test', directory, [], 'tests/secret'), /filter/);
  assert.throws(() => projectArgv('test', directory, ['--max-steps', '1'], 'add'),
    /budgets/);
  for (const command of ['create', 'init', 'verify', 'launch'] as const) {
    assert.throws(() => projectArgv(command, directory, [], 'add'),
      /Only project test runs/);
  }
});

test('nonempty-suite guard is opt-in and does not change legacy test argv', () => {
  const root = '/tmp/scarp project;$(echo unsafe)';
  assert.deepEqual(projectArgv('test', root, [], undefined, false),
    ['test', '--', root]);
  assert.deepEqual(projectArgv('test', root, [], undefined, true),
    ['test', '--require-tests', '--', root]);
  assert.deepEqual(projectArgv('test', root, [], 'योग', true),
    ['test', '--require-tests', '--filter', 'योग', '--', root]);
  assert.deepEqual(projectArgv('test', root, [], 'math', false),
    ['test', '--filter', 'math', '--', root]);
  assert.throws(() => projectArgv('test', root, ['--max-steps', '1'], 'math', true),
    /budgets/);
  assert.throws(() => projectArgv('test', root, [], '-invalid', true),
    /filter/);
  assert.throws(() => projectArgv('test', root, [], undefined,
    'true' as unknown as boolean), /nonempty-suite guard/);
  for (const command of ['create', 'init', 'verify', 'launch'] as const) {
    assert.throws(() => projectArgv(command, root, [], undefined, true),
      /nonempty-suite guard/);
  }
});

test('read-only test listing builds a bounded literal substring filter argv', () => {
  const root = '/tmp/project with spaces;$(echo untouched)';
  assert.deepEqual(projectTestListArgv(root),
    ['test', '--json', '--list', '--', root]);
  for (const filter of ['add', 'नमस्ते', 'test.srp', 'a filter with spaces']) {
    assert.deepEqual(projectTestListArgv(root, filter),
      ['test', '--json', '--list', '--filter', filter, '--', root]);
  }
  assert.deepEqual(projectTestListArgv(root, '😀'.repeat(32)),
    ['test', '--json', '--list', '--filter', '😀'.repeat(32), '--', root]);
  for (const invalid of ['', '--help', 'tests/name.srp', 'a\\\\b', 'a:b',
    'a\\nb', 'a'.repeat(129), '😀'.repeat(33)]) {
    assert.throws(() => projectTestListArgv(root, invalid), /filter/);
  }
  assert.throws(() => projectTestListArgv(''), /directory is required/);
});
