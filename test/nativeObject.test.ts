import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  exportNativeObject, nativeObjectAdvertised, nativeObjectArgv, parseNativeBudget,
  parseNativeObjectReport, readNativeSource, validNativeEntry, validNativeObjectHeader,
  NATIVE_SOURCE_LIMIT, type NativeObjectOptions, type NativeObjectRequest
} from '../src/nativeObject';

const checked: NativeObjectRequest = { mode: 'checked' };
const bounded: NativeObjectRequest = { mode: 'bounded', maxWork: 100 };
const entry: NativeObjectRequest = {
  mode: 'bounded-entry', entry: 'evaluate', maxWork: 1000, maxStackBytes: 512
};
const help = [
  'Usage:',
  '  scarp native-object [--json] x86_64-none checked <source.srp> -o <new-object>',
  '  scarp native-object [--json] x86_64-none bounded <max-work> <source.srp> -o <new-object>',
  '  scarp native-object [--json] x86_64-none bounded-entry <function> <max-work> <max-stack-bytes> <source.srp> -o <new-object>'
].join('\r\n');

function metadata(request: NativeObjectRequest): Record<string, unknown> {
  const symbol = request.mode === 'checked' ? 'scarp_checked_integer_function' :
    request.mode === 'bounded' ? 'scarp_bounded_integer_function' : 'scarp_bounded_integer_entry';
  return {
    schema_version: 1, target: 'x86_64-none', mode: request.mode, symbol,
    max_work: request.mode === 'checked' ? null : request.maxWork,
    integer_arguments: 8, call_stack_alignment: 16,
    callee_frame_bytes: 32, callee_stack_bytes: 40, stack_argument_bytes: 16,
    ...(request.mode === 'bounded-entry' ? {
      max_stack_bytes: request.maxStackBytes, peak_stack_bytes: 128, max_active_frames: 2
    } : {}),
    span_encoding: 'utf-8-bytes', failure_spans: [[0, 2], [4, 7]]
  };
}

function objectHeader(): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(1, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  return bytes;
}

test('native modes are probed by exact published command signatures', () => {
  for (const mode of ['checked', 'bounded', 'bounded-entry'] as const) {
    assert.equal(nativeObjectAdvertised(help, mode), true);
    assert.equal(nativeObjectAdvertised('Usage: scarp exec FILE', mode), false);
    assert.equal(nativeObjectAdvertised(help.replace(/x86_64-none/g, 'aarch64-none'), mode), false);
    assert.equal(nativeObjectAdvertised(help.replace(/--json/g, '--other'), mode), false);
  }
  assert.equal(nativeObjectAdvertised(help.replace('<function> ', ''), 'bounded-entry'), false);
});

test('unsigned budgets and entry identifiers reject signs, whitespace and option injection', () => {
  for (const [value, expected] of [['0', 0], ['1', 1], ['4294967295', 4294967295]] as const) {
    assert.equal(parseNativeBudget(value), expected);
  }
  for (const value of ['', '-1', '+1', '1.5', '1e3', ' 1', '1 ', '01', '4294967296',
    '999999999999999999999999', '0x10', '１', '1\n']) {
    assert.equal(parseNativeBudget(value), undefined, value);
  }
  for (const value of ['evaluate', '_entry', 'entry_1']) assert.ok(validNativeEntry(value));
  for (const value of ['', '1entry', '--help', 'a.b', 'a b', 'a\nb', 'é', 'a'.repeat(129)]) {
    assert.equal(validNativeEntry(value), false);
  }
});

test('argv retains spaces and metacharacters as individual arguments for all modes', () => {
  const source = path.resolve('source with spaces & punctuation.srp');
  const output = path.resolve('new object.o');
  const start = ['native-object', '--json', 'x86_64-none'];
  assert.deepEqual(nativeObjectArgv(checked, source, output),
    [...start, 'checked', source, '-o', output]);
  assert.deepEqual(nativeObjectArgv(bounded, source, output),
    [...start, 'bounded', '100', source, '-o', output]);
  assert.deepEqual(nativeObjectArgv(entry, source, output),
    [...start, 'bounded-entry', 'evaluate', '1000', '512', source, '-o', output]);
  for (const invalid of [
    { ...entry, entry: '--help' }, { ...entry, maxWork: -1 },
    { ...entry, maxStackBytes: 4294967296 }, { ...bounded, maxWork: 1.5 },
    { ...bounded, maxWork: NaN }
  ]) assert.throws(() => nativeObjectArgv(invalid, source, output));
  assert.throws(() => nativeObjectArgv(checked, 'relative.srp', output));
  assert.throws(() => nativeObjectArgv(checked, source, path.resolve('wrong.exe')));
});

test('ABI reports validate all published modes and reject inconsistent or hostile metadata', () => {
  for (const request of [checked, bounded, entry]) {
    const valid = metadata(request);
    assert.deepEqual(parseNativeObjectReport(JSON.stringify(valid), request, 7), valid);
    for (const patch of [
      { schema_version: 2 }, { target: 'arm64' }, { symbol: 'other' },
      { mode: 'other' }, { max_work: 4 }, { integer_arguments: 17 },
      { integer_arguments: 1.5 }, { call_stack_alignment: 8 },
      { callee_stack_bytes: 41 }, { callee_frame_bytes: -1 },
      { stack_argument_bytes: 0 }, { span_encoding: 'utf-16' },
      { failure_spans: [[4, 3]] }, { failure_spans: [[0, 8]] },
      { failure_spans: [[0, 1, 2]] }, { failure_spans: [['0', 1]] },
      { failure_spans: '0,1' }, { failure_spans: Array.from({ length: 65537 }, () => [0, 1]) }
    ]) assert.throws(() => parseNativeObjectReport(JSON.stringify({ ...valid, ...patch }), request, 7));
  }
  for (const patch of [
    { max_stack_bytes: 513 }, { peak_stack_bytes: 513 }, { max_active_frames: 0 }
  ]) assert.throws(() => parseNativeObjectReport(JSON.stringify({ ...metadata(entry), ...patch }), entry, 7));
  assert.throws(() => parseNativeObjectReport(JSON.stringify({ ...metadata(checked), max_stack_bytes: 5 }), checked, 7));
  for (const value of ['not JSON', 'null', '[]', '{}', ' '.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => parseNativeObjectReport(value, checked, 7));
  }
});

test('ELF identity rejects truncated, wrong architecture, executable and endian headers', () => {
  assert.ok(validNativeObjectHeader(objectHeader()));
  assert.equal(validNativeObjectHeader(objectHeader().subarray(0, 63)), false);
  for (const [offset, value] of [[0, 0], [4, 1], [5, 2], [6, 2], [16, 2],
    [18, 183], [20, 0], [52, 0]]) {
    const bytes = objectHeader();
    bytes[offset] = value;
    assert.equal(validNativeObjectHeader(bytes), false, String(offset));
  }
});

async function fixture(action: (root: string, options: NativeObjectOptions) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-export-test-'));
  const options: NativeObjectOptions = {
    binary: 'fixture-compiler', source: Buffer.from('0123456'), destination: path.join(root, 'new object.o'),
    request: checked, timeoutMs: 1000, stillCurrent: async () => true,
    run: async (binary, args, processOptions) => {
      assert.equal(binary, 'fixture-compiler');
      assert.equal(args[0], 'native-object');
      assert.equal(args[args.length - 2], '-o');
      const source = args[args.length - 3];
      assert.deepEqual(await fs.readFile(source), options.source);
      assert.equal(processOptions.cwd, undefined, 'Compiler lookup must retain the probe cwd');
      assert.ok(path.isAbsolute(source));
      assert.ok(path.isAbsolute(args[args.length - 1]));
      assert.equal(path.dirname(source), path.dirname(args[args.length - 1]));
      await fs.writeFile(args[args.length - 1], objectHeader(), { flag: 'wx' });
      return { stdout: JSON.stringify(metadata(options.request)), stderr: '', exitCode: 0, signal: null };
    }
  };
  try { await action(root, options); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('export publishes only a validated object and removes all private staging', async () => {
  await fixture(async (root, options) => {
    const report = await exportNativeObject(options);
    assert.equal(report.symbol, 'scarp_checked_integer_function');
    assert.deepEqual(await fs.readFile(options.destination), objectHeader());
    assert.deepEqual(await fs.readdir(root), ['new object.o']);
  });
});

test('existing outputs are rejected before the compiler, including directories', async () => {
  await fixture(async (root, options) => {
    await fs.writeFile(options.destination, 'existing');
    options.run = async () => { assert.fail('Compiler should not run'); };
    await assert.rejects(exportNativeObject(options), /never overwritten/);
    assert.equal(await fs.readFile(options.destination, 'utf8'), 'existing');
    await fs.rm(options.destination);
    await fs.mkdir(options.destination);
    await assert.rejects(exportNativeObject(options), /never overwritten/);
    assert.deepEqual(await fs.readdir(root), ['new object.o']);
  });
});

test('a competing writer after the initial check cannot be overwritten', async () => {
  await fixture(async (root, options) => {
    const run = options.run!;
    options.run = async (...args) => {
      const result = await run(...args);
      await fs.writeFile(options.destination, 'competitor');
      return result;
    };
    await assert.rejects(exportNativeObject(options));
    assert.equal(await fs.readFile(options.destination, 'utf8'), 'competitor');
    assert.deepEqual(await fs.readdir(root), ['new object.o']);
  });
});

test('failed, stale, cancelled and malformed compilation never publishes an object', async () => {
  for (const variant of ['failed', 'stale', 'cancelled', 'bad-report', 'bad-object'] as const) {
    await fixture(async (root, options) => {
      const run = options.run!;
      const controller = new AbortController();
      options.signal = controller.signal;
      options.run = async (...args) => {
        const result = await run(...args);
        if (variant === 'failed') return { ...result, exitCode: 1, stderr: 'compiler failure' };
        if (variant === 'stale') options.stillCurrent = async () => false;
        if (variant === 'cancelled') controller.abort();
        if (variant === 'bad-report') return { ...result, stdout: '{}' };
        if (variant === 'bad-object') await fs.writeFile(args[1][args[1].length - 1], 'not ELF');
        return result;
      };
      await assert.rejects(exportNativeObject(options), variant);
      assert.deepEqual(await fs.readdir(root), [], variant);
    });
  }
});

test('bounded source reads preserve raw bytes and refuse files above the frontend limit', async () => {
  await fixture(async (root) => {
    const source = path.join(root, 'source.srp');
    const raw = Buffer.from('\uFEFF// π\r\nprint(1);\r\n');
    await fs.writeFile(source, raw);
    assert.deepEqual(await readNativeSource(source), raw);
    await fs.writeFile(source, Buffer.alloc(NATIVE_SOURCE_LIMIT + 1));
    await assert.rejects(readNativeSource(source), /1 MiB/);
  });
});

test('a caller cannot mutate the captured source while export awaits revalidation', async () => {
  await fixture(async (root, options) => {
    const original = Buffer.from(options.source);
    const run = options.run!;
    let checked = false;
    options.stillCurrent = async () => {
      if (!checked) { checked = true; options.source.fill(0x78); }
      return true;
    };
    options.run = async (binary, args, processOptions) => {
      assert.deepEqual(await fs.readFile(args[args.length - 3]), original);
      // Restore only the fixture's expected bytes; the actual staged copy
      // must already contain the unmodified source.
      options.source = original;
      return run(binary, args, processOptions);
    };
    await exportNativeObject(options);
    assert.deepEqual(await fs.readdir(root), ['new object.o']);
  });
});

test('a cancellation before staging launches no compiler and creates no files', async () => {
  await fixture(async (root, options) => {
    const controller = new AbortController();
    controller.abort();
    options.signal = controller.signal;
    options.run = async () => { assert.fail('Cancelled export must not start a compiler'); };
    await assert.rejects(exportNativeObject(options), /cancelled/);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('a symlink destination is never followed or replaced', {
  skip: process.platform === 'win32'
}, async () => {
  await fixture(async (root, options) => {
    const target = path.join(root, 'protected.txt');
    await fs.writeFile(target, 'protected');
    await fs.symlink(target, options.destination);
    options.run = async () => { assert.fail('Compiler should not run for symlink output'); };
    await assert.rejects(exportNativeObject(options), /never overwritten/);
    assert.equal(await fs.readFile(target, 'utf8'), 'protected');
    assert.equal((await fs.lstat(options.destination)).isSymbolicLink(), true);
    // Dangling symlinks also occupy their destination and must not be replaced.
    await fs.unlink(target);
    await assert.rejects(exportNativeObject(options), /never overwritten/);
    assert.equal(await fs.readlink(options.destination), target);
  });
});

test('a compiler span splitting a UTF-8 scalar prevents object publication', async () => {
  await fixture(async (root, options) => {
    options.source = Buffer.from('aπ😀');
    const run = options.run!;
    options.run = async (...args) => {
      const result = await run(...args);
      return { ...result, stdout: JSON.stringify({
        ...metadata(options.request), failure_spans: [[1, 2]]
      }) };
    };
    await assert.rejects(exportNativeObject(options), /splits a UTF-8/);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('invalid UTF-8 source is rejected before the compiler or filesystem staging', async () => {
  await fixture(async (root, options) => {
    options.source = Buffer.from([0xc0, 0xaf]);
    options.run = async () => { assert.fail('Invalid UTF-8 must not start a compiler'); };
    await assert.rejects(exportNativeObject(options), /valid UTF-8/);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('a relative configured compiler keeps the same lookup context as its capability probe', async () => {
  await fixture(async (root, options) => {
    options.binary = path.join('.', 'toolchain', 'scarp');
    const compiler = options.binary;
    options.run = async (binary, args, processOptions) => {
      assert.equal(binary, compiler);
      assert.equal(processOptions.cwd, undefined);
      assert.ok(path.isAbsolute(args[args.length - 3]));
      assert.ok(path.isAbsolute(args[args.length - 1]));
      await fs.writeFile(args[args.length - 1], objectHeader(), { flag: 'wx' });
      return { stdout: JSON.stringify(metadata(options.request)), stderr: '', exitCode: 0, signal: null };
    };
    await exportNativeObject(options);
    assert.deepEqual(await fs.readdir(root), ['new object.o']);
  });
});
