import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Execute the real compiler directly, never through a shell. */
export function executeProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new Error('Invalid process timeout'));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(new Error('Invalid process output limit'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let byteCount = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    let forcedTermination: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (forcedTermination) { clearTimeout(forcedTermination); }
    };
    const finishError = (error: Error): void => {
      if (settled) { return; }
      settled = true;
      clearTimers();
      reject(error);
    };
    const terminate = (): void => {
      if (settled || forcedTermination) { return; }
      // A compiler (or wrapper script) may ignore SIGTERM. Bound the wait
      // before escalating, rather than leaving VS Code's command pending.
      child.kill('SIGTERM');
      forcedTermination = setTimeout(() => {
        if (!settled) { child.kill('SIGKILL'); }
      }, 250);
      forcedTermination.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const addOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      byteCount += chunk.length;
      if (byteCount > maxOutputBytes) {
        exceeded = true;
        terminate();
        return;
      }
      if (stream === 'stdout') { stdout += stdoutDecoder.write(chunk); }
      else { stderr += stderrDecoder.write(chunk); }
    };
    child.stdout.on('data', (chunk: Buffer) => addOutput('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => addOutput('stderr', chunk));
    child.on('error', finishError);
    child.on('close', (code, signal) => {
      if (settled) { return; }
      settled = true;
      clearTimers();
      if (timedOut) { reject(new Error('Scarp process timed out')); return; }
      if (exceeded) { reject(new Error('Scarp output exceeded the safety limit')); return; }
      // Data events can split UTF-8 code points across arbitrary pipe chunks.
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

export function compilerVersion(output: string): string | undefined {
  const match = /^scarp\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(output.trim());
  return match?.[1];
}

/** Prefer the official Scarp-first execution verb when the compiler advertises it.
 * Historical binaries that lack `guide exec` continue to use `run`.
 * Probe command support rather than guessing from unstable alpha version strings.
 */
export async function preferredExecutionVerb(executable: string): Promise<'exec' | 'run'> {
  try {
    const help = await executeProcess(executable, ['guide', 'exec'], {
      timeoutMs: 5000, maxOutputBytes: 32768
    });
    if (help.exitCode === 0 && /^Usage:\s*scarp exec\b/m.test(help.stdout)) {
      return 'exec';
    }
  } catch { /* Legacy compilers may not have `guide`; keep the old route. */ }
  return 'run';
}
