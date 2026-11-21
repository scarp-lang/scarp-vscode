import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { executeProcess } from './cli';

const RELEASES_API = 'https://api.github.com/repos/scarp-lang/scarp/releases?per_page=10';
export const OFFICIAL_RELEASES_URL = 'https://github.com/scarp-lang/scarp/releases';
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 96 * 1024 * 1024;
const MAX_COMPILER_BYTES = 48 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  'api.github.com', 'github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com'
]);

export interface OfficialReleaseAsset {
  name: string;
  size: number;
  digest: string;
  browser_download_url: string;
}
export interface OfficialRelease {
  tag_name: string;
  draft: boolean;
  published_at: string | null;
  assets: OfficialReleaseAsset[];
}
export interface CompilerPackage {
  version: string;
  target: string;
  archive: OfficialReleaseAsset;
  checksum: OfficialReleaseAsset;
  packageRoot: string;
  binaryName: string;
}
export interface CompilerInstallation {
  binary: string;
  version: string;
  reused: boolean;
}
export type InstallerProgress = (step: string) => void;
/** Optional read seam for deterministic offline installer tests. */
export type OfficialResourceReader = (
  url: string, maxBytes: number, signal?: AbortSignal
) => Promise<Buffer>;

function fail(message: string): never {
  throw new Error('Scarp installer: ' + message);
}
function active(signal?: AbortSignal): void {
  if (signal?.aborted) { fail('cancelled'); }
}

export function supportedCompilerTarget(
  platform: NodeJS.Platform, architecture: string
): string | undefined {
  if (platform === 'win32' && architecture === 'x64') {
    return 'x86_64-pc-windows-msvc';
  }
  if (platform === 'linux' && architecture === 'x64') {
    return 'x86_64-unknown-linux-gnu';
  }
  if (platform === 'darwin' && architecture === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  return undefined;
}

function versionFromTag(tag: string): string | undefined {
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[0-9A-Za-z.-]*[0-9A-Za-z])?)?$/.test(tag)
    ? tag.slice(1) : undefined;
}

export function choosePublishedCompiler(
  releases: unknown, platform: NodeJS.Platform, architecture: string
): CompilerPackage {
  const target = supportedCompilerTarget(platform, architecture);
  if (!target) {
    return fail('No official native package for ' + platform + '/' + architecture +
      '. Use the source build instructions from the compiler repository.');
  }
  if (!Array.isArray(releases) || releases.length > 10) {
    return fail('invalid official release catalogue');
  }
  // GitHub returns releases newest first. Only an actual published release,
  // never a draft, is eligible for installation.
  for (const item of releases) {
    if (!item || typeof item !== 'object') { continue; }
    const release = item as Partial<OfficialRelease>;
    const version = typeof release.tag_name === 'string'
      ? versionFromTag(release.tag_name) : undefined;
    if (!version || release.draft !== false || !release.published_at ||
        !Array.isArray(release.assets)) { continue; }
    const filename = 'scarp-' + version + '-' + target +
      (platform === 'win32' ? '.zip' : '.tar.gz');
    const asset = release.assets.find(x => x.name === filename);
    const checksum = release.assets.find(x => x.name === filename + '.sha256');
    if (!asset || !checksum) { continue; }
    for (const entry of [asset, checksum]) {
      const expected = OFFICIAL_RELEASES_URL + '/download/' +
        release.tag_name + '/' + entry.name;
      if (entry.browser_download_url !== expected ||
          !/^sha256:[a-f0-9]{64}$/.test(entry.digest) ||
          !Number.isSafeInteger(entry.size) || entry.size < 1 ||
          entry.size > MAX_DOWNLOAD_BYTES) {
        return fail('unexpected official asset metadata: ' + entry.name);
      }
    }
    if (checksum.size > 512) { return fail('checksum file is unexpectedly large'); }
    return {
      version, target, archive: asset, checksum,
      packageRoot: 'scarp-' + version + '-' + target,
      binaryName: platform === 'win32' ? 'scarp.exe' : 'scarp'
    };
  }
  return fail('no published compiler package for ' + target);
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyOfficialPackage(
  bundle: CompilerPackage, archive: Buffer, checksum: Buffer
): void {
  const archiveHash = sha256(archive);
  const checksumHash = sha256(checksum);
  if (archive.length !== bundle.archive.size ||
      checksum.length !== bundle.checksum.size ||
      'sha256:' + archiveHash !== bundle.archive.digest ||
      'sha256:' + checksumHash !== bundle.checksum.digest) {
    fail('download size or SHA-256 does not match the published GitHub release');
  }
  const line = checksum.toString('utf8').trimEnd();
  if (line !== archiveHash + '  ' + bundle.archive.name) {
    fail('the official checksum sidecar does not match the downloaded archive');
  }
}

/** A single explicitly named member is read; archive paths are never extracted to disk. */
export function extractCompilerBinary(
  archive: Buffer, bundle: CompilerPackage
): Buffer {
  const member = bundle.packageRoot + '/' + bundle.binaryName;
  const result = bundle.binaryName === 'scarp.exe'
    ? extractZipMember(archive, member)
    : extractTarGzMember(archive, member);
  if (result.length === 0 || result.length > MAX_COMPILER_BYTES) {
    return fail('invalid compiler binary size');
  }
  return result;
}

function extractTarGzMember(archive: Buffer, member: string): Buffer {
  let bytes: Buffer;
  try { bytes = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch { return fail('invalid or oversized official tar.gz archive'); }
  let offset = 0;
  let found: Buffer | undefined;
  let entries = 0;
  while (offset + 512 <= bytes.length) {
    if (++entries > 8192) { return fail('too many tar entries'); }
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) { break; }
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const prefix = header.subarray(345, 500).toString('utf8').split('\0')[0];
    const fullName = prefix ? prefix + '/' + name : name;
    const octal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(octal)) { return fail('invalid tar member size'); }
    const size = parseInt(octal, 8);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || start + size > bytes.length) {
      return fail('truncated tar member');
    }
    if (fullName === member) {
      if (found || ![0, 48].includes(header[156]) || size > MAX_COMPILER_BYTES) {
        return fail('ambiguous or unsafe compiler tar member');
      }
      found = Buffer.from(bytes.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return found ?? fail('missing compiler executable in tar.gz package');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractZipMember(bytes: Buffer, member: string): Buffer {
  // The central directory, not attacker-controlled local headers, locates
  // the one expected file. Reject ZIP64, encrypted entries and duplicates.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); --i) {
    if (bytes.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0) { return fail('missing ZIP central directory'); }
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (entries > 8192 || directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff ||
      directoryOffset + directorySize > end) {
    return fail('invalid ZIP directory boundaries');
  }
  let offset = directoryOffset;
  let found: Buffer | undefined;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) {
      return fail('invalid ZIP member directory');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const plainSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) { return fail('truncated ZIP directory'); }
    const filename = bytes.subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    offset = next;
    if (filename !== member) { continue; }
    if (found || (flags & 1) || ![0, 8].includes(method) ||
        plainSize === 0xffffffff || compressedSize === 0xffffffff ||
        compressedSize > MAX_DOWNLOAD_BYTES ||
        plainSize > MAX_COMPILER_BYTES ||
        localOffset + 30 > directoryOffset ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      return fail('ambiguous or unsafe compiler ZIP member');
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLen = bytes.readUInt16LE(localOffset + 26);
    const localExtraLen = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (localFlags !== flags || localMethod !== method ||
        bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen)
          .toString('utf8') !== member ||
        dataStart + compressedSize > directoryOffset) {
      return fail('mismatched ZIP local header');
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    try {
      found = method === 8
        ? inflateRawSync(compressed, { maxOutputLength: MAX_COMPILER_BYTES })
        : Buffer.from(compressed);
    } catch { return fail('invalid ZIP member compression'); }
    if (found.length !== plainSize || crc32(found) !== checksum) {
      return fail('invalid ZIP member size or CRC');
    }
  }
  if (offset !== directoryOffset + directorySize) {
    return fail('mismatched ZIP central directory size');
  }
  return found ?? fail('missing compiler executable in ZIP package');
}

/**
 * Only HTTPS on strictly allowed GitHub download domains, with explicit
 * redirect handling. Bounded response bytes, timeouts and cancellation.
 * Never accept externally supplied arbitrary download URLs.
 */
export async function readOfficialBytes(
  address: string, maxBytes: number, signal?: AbortSignal
): Promise<Buffer> {
  active(signal);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    let target = address;
    for (let redirect = 0; redirect < 5; redirect++) {
      active(signal);
      const url = new URL(target);
      if (url.protocol !== 'https:' || url.username || url.password ||
          url.port || !ALLOWED_HOSTS.has(url.hostname)) {
        return fail('download redirect left the official GitHub asset hosts');
      }
      const response = await fetch(url, {
        signal: controller.signal, redirect: 'manual',
        headers: {
          'User-Agent': 'ScarpLang-scarp-vscode',
          'Accept': url.hostname === 'api.github.com'
            ? 'application/vnd.github+json' : 'application/octet-stream'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) { return fail('download redirect has no location'); }
        target = new URL(location, target).href;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        return fail('GitHub download failed (HTTP ' + response.status + ')');
      }
      const length = response.headers.get('content-length');
      if (length && Number(length) > maxBytes) {
        return fail('download exceeds the allowed size');
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body) {
        active(signal);
        const bytes = Buffer.from(chunk);
        received += bytes.length;
        if (received > maxBytes) { return fail('download exceeds the allowed size'); }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, received);
    }
    return fail('too many GitHub asset redirects');
  } catch (error) {
    if (signal?.aborted) { return fail('cancelled'); }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchCurrentCompilerPackage(
  platform = process.platform, architecture = process.arch,
  signal?: AbortSignal
): Promise<CompilerPackage> {
  if (!supportedCompilerTarget(platform, architecture)) {
    return choosePublishedCompiler([], platform, architecture);
  }
  const raw = await readOfficialBytes(RELEASES_API, 512 * 1024, signal);
  let releases: unknown;
  try { releases = JSON.parse(raw.toString('utf8')); }
  catch { return fail('official release catalogue is not valid JSON'); }
  return choosePublishedCompiler(releases, platform, architecture);
}

async function validInstalledBinary(binary: string, version: string): Promise<boolean> {
  try {
    const check = await executeProcess(binary, ['--version'], {
      timeoutMs: 5000, maxOutputBytes: 8192
    });
    return check.exitCode === 0 && check.stdout.trim() === 'scarp ' + version;
  } catch { return false; }
}

/**
 * Downloads are entirely opt-in, and a successful version check is required
 * before the caller may update scarp.compilerPath. Failures clean staging data.
 */
export async function installOfficialCompiler(
  destinationRoot: string, bundle: CompilerPackage,
  signal?: AbortSignal, report?: InstallerProgress,
  readBytes: OfficialResourceReader = readOfficialBytes
): Promise<CompilerInstallation> {
  active(signal);
  if (!path.isAbsolute(destinationRoot)) { return fail('installation directory must be absolute'); }
  const root = path.join(destinationRoot, 'compilers');
  await fs.mkdir(root, { recursive: true });
  const finalDir = path.join(root, bundle.packageRoot);
  const finalBinary = path.join(finalDir, bundle.binaryName);
  if (await validInstalledBinary(finalBinary, bundle.version)) {
    return { binary: finalBinary, version: bundle.version, reused: true };
  }
  // Never overwrite a corrupted or manually modified prior installation.
  try {
    await fs.lstat(finalDir);
    return fail('an existing installation failed validation: ' + finalDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
  }
  const stage = await fs.mkdtemp(path.join(root, '.staging-'));
  try {
    report?.('Downloading official compiler archive');
    const archive = await readBytes(bundle.archive.browser_download_url,
      MAX_DOWNLOAD_BYTES, signal);
    active(signal);
    report?.('Downloading official SHA-256 checksum');
    const checksum = await readBytes(bundle.checksum.browser_download_url, 512, signal);
    active(signal);
    report?.('Verifying published SHA-256 hashes');
    verifyOfficialPackage(bundle, archive, checksum);
    active(signal);
    report?.('Extracting the exact packaged executable');
    const contents = extractCompilerBinary(archive, bundle);
    active(signal);
    const staged = path.join(stage, bundle.binaryName);
    await fs.writeFile(staged, contents, { flag: 'wx', mode: 0o755 });
    if (bundle.binaryName !== 'scarp.exe') {
      await fs.chmod(staged, 0o755);
    }
    active(signal);
    report?.('Checking the compiler version before installation');
    if (!await validInstalledBinary(staged, bundle.version)) {
      return fail('downloaded executable failed official version validation');
    }
    active(signal);
    // The target is a fresh, versioned folder. Never mutate source workspaces.
    await fs.rename(stage, finalDir);
    report?.('Compiler installed and validated');
    return { binary: finalBinary, version: bundle.version, reused: false };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
