import { spawn } from 'node:child_process';

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
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let byteCount = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const addOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      byteCount += chunk.length;
      if (byteCount > maxOutputBytes) {
        exceeded = true;
        child.kill();
        return;
      }
      if (stream === 'stdout') { stdout += chunk.toString('utf8'); }
      else { stderr += chunk.toString('utf8'); }
    };
    child.stdout.on('data', (chunk: Buffer) => addOutput('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => addOutput('stderr', chunk));
    child.on('error', finishError);
    child.on('close', (code, signal) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (timedOut) { reject(new Error('Scarp process timed out')); return; }
      if (exceeded) { reject(new Error('Scarp output exceeded the safety limit')); return; }
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

export function compilerVersion(output: string): string | undefined {
  const match = /^scarp\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(output.trim());
  return match?.[1];
}
