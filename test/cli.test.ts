import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeProcess, compilerVersion, preferredExecutionVerb } from '../src/cli';

test('parses actual compiler version format', () => {
  assert.equal(compilerVersion('scarp 0.0.5-alpha.2\n'), '0.0.5-alpha.2');
  assert.equal(compilerVersion('node v22.0.0'), undefined);
});
test('passes file paths with spaces without a shell', async () => {
  const result = await executeProcess(process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', 'file with spaces;$(id).srp']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'file with spaces;$(id).srp');
});
test('captures stderr and nonzero exit', async () => {
  const result = await executeProcess(process.execPath,
    ['-e', 'process.stderr.write("bad");process.exit(2)']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, 'bad');
});
test('rejects missing executables', async () => {
  await assert.rejects(executeProcess('scarp-not-installed-391722', []), /ENOENT/);
});
test('terminates long-running checks', async () => {
  await assert.rejects(
    executeProcess(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], { timeoutMs: 100 }),
    /timed out/
  );
});

test('decodes Unicode correctly across split stdout/stderr UTF-8 chunks', async () => {
  const script = [
    'process.stdout.write(Buffer.from([0xf0, 0x9f]));',
    'process.stderr.write(Buffer.from([0xe2]));',
    'setTimeout(() => {',
    '  process.stdout.write(Buffer.from([0x98, 0x80]));',
    '  process.stderr.write(Buffer.from([0x82, 0xac]));',
    '}, 40);'
  ].join('\n');
  const result = await executeProcess(process.execPath, ['-e', script]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '😀');
  assert.equal(result.stderr, '€');
});

test('falls back to legacy run when Scarp-first guide is missing', async () => {
  assert.equal(await preferredExecutionVerb(process.execPath), 'run');
});
