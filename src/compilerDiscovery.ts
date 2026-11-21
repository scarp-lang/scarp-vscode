import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { compilerVersion, executeProcess } from './cli';

/**
 * An intentionally shallow search: never traverse a user's workspace, Downloads
 * folder, or entire drives. Source editing does not trigger discovery.
 */
export interface CompilerDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  signal?: AbortSignal;
}

export interface DiscoveredCompiler {
  readonly binary: string;
  readonly version: string;
}

const MAX_PATH_DIRECTORIES = 32;
const MAX_CANDIDATES = 64;
const MAX_EXECUTABLE_PROBES = 8;

function environmentValue(
  env: NodeJS.ProcessEnv, key: string, windows: boolean
): string | undefined {
  if (!windows) { return env[key]; }
  const entry = Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return entry?.[1];
}

/** Deterministic candidate paths, useful independently of any process execution. */
export function compilerDiscoveryCandidates(
  platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string
): readonly string[] {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const executable = windows ? 'scarp.exe' : 'scarp';
  const found: string[] = [];
  const seen = new Set<string>();

  const addDirectory = (directory: string | undefined, ...segments: string[]): void => {
    if (!directory || directory.length > 4096 || directory.includes('\0') ||
        !paths.isAbsolute(directory) || found.length >= MAX_CANDIDATES) { return; }
    const candidate = paths.join(directory, ...segments, executable);
    const key = windows ? candidate.toLowerCase() : candidate;
    if (!seen.has(key)) {
      seen.add(key);
      found.push(candidate);
    }
  };

  const rawPath = environmentValue(env, 'PATH', windows) ?? '';
  const directories = rawPath.split(windows ? ';' : ':').slice(0, MAX_PATH_DIRECTORIES);
  for (const raw of directories) {
    const directory = windows && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1) : raw;
    addDirectory(directory);
  }

  const cargoHome = environmentValue(env, 'CARGO_HOME', windows);
  addDirectory(cargoHome, 'bin');
  addDirectory(home, '.cargo', 'bin');

  if (windows) {
    const local = environmentValue(env, 'LOCALAPPDATA', true);
    const programFiles = environmentValue(env, 'ProgramFiles', true);
    addDirectory(local, 'Programs', 'Scarp');
    addDirectory(local, 'Scarp');
    addDirectory(programFiles, 'Scarp');
    addDirectory(programFiles, 'Scarp', 'bin');
    addDirectory(home, 'scoop', 'apps', 'scarp', 'current');
  } else {
    addDirectory(home, '.local', 'bin');
    addDirectory(home, '.local', 'share', 'scarp', 'bin');
    addDirectory('/usr/local', 'bin');
    addDirectory('/usr', 'bin');
    if (platform === 'darwin') {
      addDirectory('/opt/homebrew', 'bin');
      addDirectory('/Applications/Scarp', 'bin');
    } else {
      addDirectory('/opt/scarp', 'bin');
    }
  }
  return found;
}

function ensureActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) { throw new Error('Scarp compiler discovery cancelled'); }
}

/**
 * Probe only existing, executable, specifically named candidates.
 * An error, a lookalike program, or an unrecognized version is never accepted.
 * No shell, source compilation, downloads, or filesystem recursion is used.
 */
export async function discoverInstalledCompiler(
  options: CompilerDiscoveryOptions = {}
): Promise<DiscoveredCompiler | undefined> {
  const platform = options.platform ?? process.platform;
  const candidates = compilerDiscoveryCandidates(
    platform, options.env ?? process.env, options.home ?? os.homedir()
  );
  let probes = 0;
  for (const candidate of candidates) {
    ensureActive(options.signal);
    let stats;
    try { stats = await fs.stat(candidate); }
    catch { continue; }
    ensureActive(options.signal);
    if (!stats.isFile()) { continue; }
    if (platform !== 'win32') {
      try { await fs.access(candidate, constants.X_OK); }
      catch { continue; }
    }
    ensureActive(options.signal);
    if (++probes > MAX_EXECUTABLE_PROBES) { break; }
    try {
      const result = await executeProcess(candidate, ['--version'], {
        timeoutMs: 2500, maxOutputBytes: 16 * 1024, signal: options.signal
      });
      ensureActive(options.signal);
      const version = result.exitCode === 0 ? compilerVersion(result.stdout) : undefined;
      if (version) { return { binary: candidate, version }; }
    } catch {
      ensureActive(options.signal);
      // A stale installation or unrelated executable must not block later paths.
    }
  }
  ensureActive(options.signal);
  return undefined;
}

/**
 * An explicit user path always wins. Only the unresolved default command may
 * fall back to bounded discovery; malformed version output is never bypassed.
 */
export async function resolveConfiguredCompiler(
  executable: string,
  autoDiscover: boolean,
  signal?: AbortSignal,
  discovery?: Omit<CompilerDiscoveryOptions, 'signal'>
): Promise<DiscoveredCompiler> {
  if (!executable.trim()) {
    throw new Error('Set scarp.compilerPath to an executable.');
  }
  let result;
  try {
    result = await executeProcess(executable, ['--version'], {
      timeoutMs: 5000, maxOutputBytes: 65536, signal
    });
  } catch (error) {
    if (executable === 'scarp' && autoDiscover && !signal?.aborted &&
        (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const discovered = await discoverInstalledCompiler({ ...discovery, signal });
      if (discovered) { return discovered; }
      throw new Error(
        'Scarp compiler not found on PATH or in common installation locations. ' +
        'Install the official compiler or set scarp.compilerPath to its executable.'
      );
    }
    throw new Error('Scarp compiler not found at ' + executable + ': ' + String(error));
  }
  const version = result.exitCode === 0 ? compilerVersion(result.stdout) : undefined;
  if (!version) {
    throw new Error('Invalid Scarp --version response from ' + executable);
  }
  return { binary: executable, version };
}
