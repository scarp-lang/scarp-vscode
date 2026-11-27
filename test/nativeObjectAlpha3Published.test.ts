import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeProcess } from '../src/cli';
import {
  exportNativeObject, nativeObjectAdvertised, nativeObjectArgv,
  parseNativeObjectReport, validNativeObjectHeader, type NativeObjectRequest
} from '../src/nativeObject';
import { nativeSpanPositions } from '../src/nativeSourceSpans';

// Only the dedicated qualification workflow supplies these paths. Ordinary
// tests stay offline and never fetch or execute a compiler automatically.
const binary = process.env.SCARP_NATIVE_ALPHA3_BINARY;
const aggregateFixture = process.env.SCARP_NATIVE_ALPHA3_AGGREGATE;
const genericSource = [
  '// UTF-8 π 😀',
  'pure funcra identity<T>(value: T) -> T { return value; }',
  'pure funcra square<T: Numeric>(value: T) -> T { return identity(value * value); }',
  'pure funcra entry(value: integer) -> integer {',
  '  return square(value) + identity::<integer>(7);',
  '}', ''
].join('\r\n');

test('published alpha.3 native export preserves generic and aggregate object bytes and metadata', {
  skip: !binary
}, async () => {
  assert.ok(binary && path.isAbsolute(binary));
  assert.ok(aggregateFixture && path.isAbsolute(aggregateFixture));
  const version = await executeProcess(binary, ['--version']);
  assert.equal(version.exitCode, 0);
  assert.equal(version.stdout.trim(), 'scarp 0.0.7-alpha.3');
  const guide = await executeProcess(binary, ['guide', 'native-object']);
  assert.equal(guide.exitCode, 0);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-native-alpha3-'));
  try {
    const aggregate = await fs.readFile(aggregateFixture);
    const generic = Buffer.from(genericSource);
    const cases: Array<{
      name: string; source: Buffer; request: NativeObjectRequest; arguments: number;
    }> = [
      { name: 'generic', source: generic, request: {
        mode: 'bounded-entry', entry: 'entry', maxWork: 1000, maxStackBytes: 4096
      }, arguments: 1 },
      { name: 'aggregate', source: aggregate, request: {
        mode: 'bounded-entry', entry: 'entry', maxWork: 1000, maxStackBytes: 4096
      }, arguments: 2 }
    ];
    for (const item of cases) {
      assert.ok(nativeObjectAdvertised(guide.stdout, item.request.mode));
      const sourceFile = path.join(root, item.name + ' source.srp');
      const direct = path.join(root, item.name + ' direct.o');
      const destination = path.join(root, item.name + ' editor.o');
      await fs.writeFile(sourceFile, item.source);
      const cli = await executeProcess(binary,
        nativeObjectArgv(item.request, sourceFile, direct),
        { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
      assert.equal(cli.exitCode, 0, cli.stderr);
      assert.equal(cli.stderr.trim(), '');
      const directReport = parseNativeObjectReport(cli.stdout, item.request, item.source.length);
      const options = {
        binary, source: item.source, destination, request: item.request,
        timeoutMs: 30000, stillCurrent: async () => true
      };
      const report = await exportNativeObject(options);
      assert.deepEqual(report, directReport);
      const bytes = await fs.readFile(destination);
      assert.ok(validNativeObjectHeader(bytes.subarray(0, 64)));
      assert.deepEqual(bytes, await fs.readFile(direct));
      assert.equal(report.integer_arguments, item.arguments);
      assert.ok(report.failure_spans.length > 0);
      const positions = nativeSpanPositions(item.source, report.failure_spans);
      assert.equal(positions.length, report.failure_spans.length);
      if (item.name === 'generic') {
        assert.ok(report.failure_spans.some(([start, end]) =>
          item.source.subarray(start, end).toString('utf8') === '*'));
        assert.ok(report.max_active_frames && report.max_active_frames >= 2);
      }

      assert.ok(item.request.mode === 'bounded-entry');
      const peak = report.peak_stack_bytes;
      assert.ok(peak && peak <= item.request.maxStackBytes);
      const exact = await exportNativeObject({
        ...options, destination: path.join(root, item.name + ' exact.o'),
        request: { ...item.request, maxStackBytes: peak }
      });
      assert.equal(exact.peak_stack_bytes, peak);
      assert.deepEqual(await fs.readFile(path.join(root, item.name + ' exact.o')), bytes);
      const rejected = path.join(root, item.name + ' rejected.o');
      await assert.rejects(exportNativeObject({
        ...options, destination: rejected, request: { ...item.request, maxStackBytes: peak - 1 }
      }), /compilation failed/);
      await assert.rejects(fs.lstat(rejected), { code: 'ENOENT' });
      await assert.rejects(exportNativeObject(options), /never overwritten/);
      assert.deepEqual(await fs.readFile(destination), bytes);
    }

    const genericEntry = path.join(root, 'unspecialized.o');
    await assert.rejects(exportNativeObject({
      binary, source: generic, destination: genericEntry,
      request: { mode: 'bounded-entry', entry: 'identity', maxWork: 1000, maxStackBytes: 4096 },
      timeoutMs: 30000, stillCurrent: async () => true
    }), /compilation failed/);
    await assert.rejects(fs.lstat(genericEntry), { code: 'ENOENT' });
    assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('.scarp-native-')),
      'Success and failure must both clean staging directories');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
