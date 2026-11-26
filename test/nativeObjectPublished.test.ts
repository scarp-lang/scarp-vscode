import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeProcess } from '../src/cli';
import { exportNativeObject, nativeObjectAdvertised, type NativeObjectRequest } from '../src/nativeObject';

// Ordinary unit tests are offline. A separate CI job sets this only after
// checking out and building the exact published compiler revision.
const binary = process.env.SCARP_NATIVE_EXPORT_TEST_BINARY;

test('published alpha.2 compiler exports all three modes via the extension core', {
  skip: !binary
}, async () => {
  assert.ok(binary && path.isAbsolute(binary));
  const version = await executeProcess(binary, ['--version']);
  assert.equal(version.stdout.trim(), 'scarp 0.0.7-alpha.2');
  assert.equal(version.exitCode, 0);
  const guide = await executeProcess(binary, ['guide', 'native-object']);
  assert.equal(guide.exitCode, 0);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-native-published-'));
  try {
    const single = 'pure funcra evaluate(n: integer) -> integer { return n + 1; }\n';
    const graph = [
      'pure funcra evaluate(n: integer) -> integer { return twice(n) + 1; }',
      'pure funcra twice(n: integer) -> integer { return n * 2; }', ''
    ].join('\n');
    const cases: Array<{ request: NativeObjectRequest; source: string }> = [
      { request: { mode: 'checked' }, source: single },
      { request: { mode: 'bounded', maxWork: 1000 }, source: single },
      { request: { mode: 'bounded-entry', entry: 'evaluate', maxWork: 1000,
        maxStackBytes: 512 }, source: graph }
    ];
    for (const { request, source } of cases) {
      assert.ok(nativeObjectAdvertised(guide.stdout, request.mode));
      const destination = path.join(root, 'native ' + request.mode + '.o');
      const options = {
        binary, request, source: Buffer.from(source), destination,
        timeoutMs: 30000, stillCurrent: async () => true
      };
      const report = await exportNativeObject(options);
      assert.equal(report.mode, request.mode);
      assert.equal(report.integer_arguments, 1);
      assert.equal(report.target, 'x86_64-none');
      assert.equal(report.call_stack_alignment, 16);
      assert.equal(report.span_encoding, 'utf-8-bytes');
      if (request.mode === 'bounded-entry') {
        assert.equal(report.max_active_frames, 2);
        assert.equal(report.max_stack_bytes, 512);
      }
      const object = await fs.readFile(destination);
      assert.equal(object.readUInt16LE(16), 1);
      assert.equal(object.readUInt16LE(18), 62);
      await assert.rejects(exportNativeObject(options), /never overwritten/);
      assert.deepEqual(await fs.readFile(destination), object);
    }

    const invalidDestination = path.join(root, 'invalid.o');
    await assert.rejects(exportNativeObject({
      binary, source: Buffer.from('print(1);'), destination: invalidDestination,
      request: { mode: 'checked' }, timeoutMs: 30000, stillCurrent: async () => true
    }), /compilation failed/);
    assert.deepEqual((await fs.readdir(root)).sort(),
      ['native bounded-entry.o', 'native bounded.o', 'native checked.o']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
