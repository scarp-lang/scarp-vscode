import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { executeProcess, type ProcessOptions, type ProcessResult } from './cli';

export type NativeObjectRequest =
  | { mode: 'checked' }
  | { mode: 'bounded'; maxWork: number }
  | { mode: 'bounded-entry'; entry: string; maxWork: number; maxStackBytes: number };

const TARGET = 'x86_64-none';
const U32_MAX = 4294967295;
export const NATIVE_SOURCE_LIMIT = 1024 * 1024;
const OBJECT_LIMIT = 32 * 1024 * 1024;
const REPORT_LIMIT = 1024 * 1024;
const SYMBOLS = {
  checked: 'scarp_checked_integer_function',
  bounded: 'scarp_bounded_integer_function',
  'bounded-entry': 'scarp_bounded_integer_entry'
} as const;

export function parseNativeBudget(value: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return undefined;
  const number = Number(value);
  return number <= U32_MAX ? number : undefined;
}

export function validNativeEntry(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

function isBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= U32_MAX;
}

/** Exact published alpha.2 guide; version strings alone never authorize emission. */
export function nativeObjectAdvertised(help: string, mode: NativeObjectRequest['mode']): boolean {
  return help.split(/\r?\n/).some(line => {
    const prefix = 'scarp native-object [--json] x86_64-none ' + mode + ' ';
    const tail = mode === 'checked' ? '<source.srp> -o <new-object>' :
      mode === 'bounded' ? '<max-work> <source.srp> -o <new-object>' :
        '<function> <max-work> <max-stack-bytes> <source.srp> -o <new-object>';
    return line.trim() === prefix + tail;
  });
}

export function nativeObjectArgv(
  request: NativeObjectRequest, source: string, output: string
): string[] {
  if (!path.isAbsolute(source) || !path.isAbsolute(output) ||
      source.includes('\0') || output.includes('\0') ||
      path.extname(source).toLowerCase() !== '.srp' ||
      path.extname(output).toLowerCase() !== '.o') {
    throw new Error('Native object emission needs absolute .srp and .o paths.');
  }
  const args = ['native-object', '--json', TARGET, request.mode];
  if (request.mode === 'bounded-entry') {
    if (!validNativeEntry(request.entry) || !isBudget(request.maxStackBytes)) {
      throw new Error('Invalid native entry function or stack budget.');
    }
    args.push(request.entry);
  }
  if (request.mode !== 'checked') {
    if (!isBudget(request.maxWork)) throw new Error('Invalid native work budget.');
    args.push(String(request.maxWork));
  }
  if (request.mode === 'bounded-entry') args.push(String(request.maxStackBytes));
  return [...args, source, '-o', output];
}

export interface NativeObjectReport {
  schema_version: 1;
  target: typeof TARGET;
  mode: NativeObjectRequest['mode'];
  symbol: string;
  max_work: number | null;
  integer_arguments: number;
  call_stack_alignment: number;
  callee_frame_bytes: number;
  callee_stack_bytes: number;
  stack_argument_bytes: number;
  max_stack_bytes?: number;
  peak_stack_bytes?: number;
  max_active_frames?: number;
  span_encoding: 'utf-8-bytes';
  failure_spans: Array<[number, number]>;
}

function invalidReport(): never {
  throw new Error('Unrecognized or inconsistent Scarp native object metadata.');
}

/** Validate the published schema, requested mode and bounded byte spans. */
export function parseNativeObjectReport(
  raw: string, request: NativeObjectRequest, sourceBytes: number
): NativeObjectReport {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 ||
      sourceBytes > NATIVE_SOURCE_LIMIT || Buffer.byteLength(raw) > REPORT_LIMIT) {
    return invalidReport();
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return invalidReport(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalidReport();
  const r = data as Record<string, unknown>;
  const expectedWork = request.mode === 'checked' ? null : request.maxWork;
  if (r.schema_version !== 1 || r.target !== TARGET || r.mode !== request.mode ||
      r.symbol !== SYMBOLS[request.mode] || r.max_work !== expectedWork ||
      r.span_encoding !== 'utf-8-bytes' || r.call_stack_alignment !== 16 ||
      !isBudget(r.integer_arguments) || r.integer_arguments > 16 ||
      !isBudget(r.callee_frame_bytes) || !isBudget(r.callee_stack_bytes) ||
      !isBudget(r.stack_argument_bytes) ||
      r.callee_stack_bytes !== r.callee_frame_bytes + 8 ||
      r.stack_argument_bytes !== Math.max(0, r.integer_arguments - 6) * 8 ||
      !Array.isArray(r.failure_spans) || r.failure_spans.length > 65536) return invalidReport();
  if (request.mode === 'bounded-entry') {
    if (r.max_stack_bytes !== request.maxStackBytes || !isBudget(r.peak_stack_bytes) ||
        r.peak_stack_bytes > request.maxStackBytes ||
        !isBudget(r.max_active_frames) || r.max_active_frames < 1) return invalidReport();
  } else if ('max_stack_bytes' in r || 'peak_stack_bytes' in r ||
      'max_active_frames' in r) return invalidReport();
  for (const span of r.failure_spans) {
    if (!Array.isArray(span) || span.length !== 2 ||
        !isBudget(span[0]) || !isBudget(span[1]) ||
        span[0] > span[1] || span[1] > sourceBytes) return invalidReport();
  }
  return r as unknown as NativeObjectReport;
}

/** Verify ELF64 little-endian relocatable x86-64 identity, not executable code. */
export function validNativeObjectHeader(header: Buffer): boolean {
  return header.length >= 64 &&
    header.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])) &&
    header.readUInt16LE(16) === 1 && header.readUInt16LE(18) === 62 &&
    header.readUInt32LE(20) === 1 && header.readUInt16LE(52) === 64;
}

/** Read at most the frontend limit plus one byte, even if the file grows. */
export async function readNativeSource(filename: string): Promise<Buffer> {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > NATIVE_SOURCE_LIMIT) {
      throw new Error('Native emission requires a regular Scarp source of at most 1 MiB.');
    }
    const bytes = Buffer.alloc(NATIVE_SOURCE_LIMIT + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > NATIVE_SOURCE_LIMIT) throw new Error('Native source exceeds 1 MiB.');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export interface NativeObjectOptions {
  binary: string;
  source: Buffer;
  destination: string;
  request: NativeObjectRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called after asynchronous compilation and before publishing. */
  stillCurrent: () => Promise<boolean>;
  onCompilerError?: (stderr: string) => void;
  onCleanupError?: (error: unknown) => void;
  run?: (binary: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;
}

async function requireNewDestination(filename: string): Promise<void> {
  try { await fs.lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Choose a new .o filename; existing paths are never overwritten.');
}

/**
 * Compile a frozen source copy in a private sibling staging directory. Validate
 * both the report and the object before a no-overwrite hard-link publication.
 * A stale/cancelled operation can leave no final object through this function.
 * Never link into a program, launch native code, or modify the original source.
 */
export async function exportNativeObject(options: NativeObjectOptions): Promise<NativeObjectReport> {
  const { binary, destination, request, timeoutMs, signal } = options;
  if (!path.isAbsolute(destination) || path.extname(destination).toLowerCase() !== '.o' ||
      destination.includes('\0') || options.source.length > NATIVE_SOURCE_LIMIT) {
    throw new Error('Invalid native object output or source size.');
  }
  // Own the exact source bytes before the first await, even when an embedding
  // caller later mutates its Buffer. The report and staged file share this copy.
  const sourceBytes = Buffer.from(options.source);
  const ensureCurrent = async (): Promise<void> => {
    if (signal?.aborted || !await options.stillCurrent() || signal?.aborted) {
      throw new Error('Native object export cancelled or source/configuration changed.');
    }
  };
  await ensureCurrent();
  const parent = await fs.realpath(path.dirname(destination));
  const output = path.join(parent, path.basename(destination));
  await requireNewDestination(output);
  const staging = await fs.mkdtemp(path.join(parent, '.scarp-native-'));
  try {
    const source = path.join(staging, 'source.srp');
    const object = path.join(staging, 'result.o');
    await fs.writeFile(source, sourceBytes, { flag: 'wx', mode: 0o600 });
    const argv = nativeObjectArgv(request, source, object);
    await ensureCurrent();
    const result = await (options.run ?? executeProcess)(binary, argv, {
      cwd: staging, timeoutMs, maxOutputBytes: REPORT_LIMIT, signal
    });
    if (result.exitCode !== 0 || result.signal !== null || result.stderr.trim()) {
      options.onCompilerError?.(result.stderr);
      throw new Error('Scarp native object compilation failed. See the Scarp output.');
    }
    const report = parseNativeObjectReport(result.stdout, request, sourceBytes.length);
    const stat = await fs.lstat(object);
    if (!stat.isFile() || stat.size < 64 || stat.size > OBJECT_LIMIT) {
      throw new Error('Scarp did not produce a bounded regular ELF object.');
    }
    const handle = await fs.open(object, 'r');
    try {
      const header = Buffer.alloc(64);
      const read = await handle.read(header, 0, 64, 0);
      if (read.bytesRead !== 64 || !validNativeObjectHeader(header)) {
        throw new Error('Scarp output is not an x86-64 ELF64 relocatable object.');
      }
    } finally { await handle.close(); }
    if (await fs.realpath(path.dirname(destination)) !== parent) {
      throw new Error('Native object destination directory changed.');
    }
    await ensureCurrent();
    // This link is the commit point. It cannot replace any existing file,
    // directory or symlink, including a competing output created after lstat.
    await fs.link(object, output);
    return report;
  } finally {
    try { await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { options.onCleanupError?.(error); }
  }
}
