import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  compilerAdvertisesImplicitExec, hasDefaultWorkspaceEntry, implicitExecArgv
} from '../src/defaultWorkspaceExec';

const alpha18Guide = `Usage: scarp exec [budget options] [--] [file.srp|project-directory]

Run the current project or a selected source file with the interpreter.
Without a path, use the current scarp.project/Scarp.project entrypoint, then
src/main.srp, then main.srp. No parent-directory or arbitrary-file search.
Terminal prompts and typed input work by default; no --interactive needed.
`;

test('only alpha.18-style compiler guide enables default workspace execution', () => {
  assert.equal(compilerAdvertisesImplicitExec(alpha18Guide), true);
  assert.equal(compilerAdvertisesImplicitExec(
    'Usage: scarp exec [budget options] [--] <file.srp>\n' +
    'Program-argument forwarding and project entrypoint execution are not supported.\n'), false);
  assert.equal(compilerAdvertisesImplicitExec(
    'Usage: scarp exec [budget options] [--] [file.srp|project-directory]\n'), false);
  assert.equal(compilerAdvertisesImplicitExec(
    alpha18Guide.replace('Usage: scarp exec', 'Usage: scarp run')), false);
  assert.equal(compilerAdvertisesImplicitExec(''), false);
});

test('recognizes exactly the official implicit entrypoint candidates', () => {
  for (const candidate of [
    'scarp.project', 'Scarp.project', path.join('src', 'main.srp'), 'main.srp'
  ]) {
    assert.equal(hasDefaultWorkspaceEntry(new Map([[candidate, 'fingerprint']])), true);
  }
  assert.equal(hasDefaultWorkspaceEntry(new Map()), false);
  assert.equal(hasDefaultWorkspaceEntry(new Map([
    [path.join('nested', 'main.srp'), 'fingerprint'],
    ['readme.md', 'fingerprint']
  ])), false, 'never search parent, nested or unrelated source files');
});

test('constructs no-path terminal argv without inventing input files or flags', () => {
  assert.deepEqual(implicitExecArgv(), ['exec']);
  assert.deepEqual(implicitExecArgv(['--max-steps', '200', '--max-input-reads', '5']),
    ['exec', '--max-steps', '200', '--max-input-reads', '5']);
});
