import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hasProjectWorkflow, validProjectName, projectArgv } from '../src/projectWorkflow';

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
