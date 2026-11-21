import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { gzipSync, deflateRawSync } from 'node:zlib';
import {
  supportedCompilerTarget, choosePublishedCompiler, verifyOfficialPackage,
  extractCompilerBinary, sha256, type CompilerPackage, type OfficialReleaseAsset
} from '../src/compilerInstall';

const VERSION = '0.0.6-alpha.17';
const TARGET_WIN = 'x86_64-pc-windows-msvc';
const TARGET_LINUX = 'x86_64-unknown-linux-gnu';

function metadata(platform: 'win32' | 'linux'): CompilerPackage {
  const target = platform === 'win32' ? TARGET_WIN : TARGET_LINUX;
  const filename = 'scarp-' + VERSION + '-' + target +
    (platform === 'win32' ? '.zip' : '.tar.gz');
  const assets = [filename, filename + '.sha256'].map(name => ({
    name, size: 4, digest: 'sha256:' + 'a'.repeat(64),
    browser_download_url: 'https://github.com/scarp-lang/scarp/releases/download/v' +
      VERSION + '/' + name
  }));
  return {
    version: VERSION, target, archive: assets[0], checksum: assets[1],
    packageRoot: 'scarp-' + VERSION + '-' + target,
    binaryName: platform === 'win32' ? 'scarp.exe' : 'scarp'
  };
}

function releaseAssets(bundle: CompilerPackage): OfficialReleaseAsset[] {
  return [bundle.archive, bundle.checksum];
}

test('selects only the matching official native compiler archive', () => {
  assert.equal(supportedCompilerTarget('win32', 'x64'), TARGET_WIN);
  assert.equal(supportedCompilerTarget('linux', 'x64'), TARGET_LINUX);
  assert.equal(supportedCompilerTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  for (const [os, arch] of [
    ['linux', 'arm64'], ['win32', 'arm64'], ['darwin', 'x64'], ['freebsd', 'x64']
  ]) {
    assert.equal(supportedCompilerTarget(os as NodeJS.Platform, arch), undefined);
    assert.throws(() => choosePublishedCompiler([], os as NodeJS.Platform, arch),
      /No official native package/);
  }
  const win = metadata('win32');
  const linux = metadata('linux');
  const items = [
    { tag_name: 'v9.9.9', draft: true, published_at: '2026-11-21',
      assets: releaseAssets(win) },
    { tag_name: 'v' + VERSION, draft: false, published_at: '2026-11-21',
      assets: [...releaseAssets(win), ...releaseAssets(linux)] }
  ];
  assert.equal(choosePublishedCompiler(items, 'win32', 'x64').archive.name,
    win.archive.name);
  assert.equal(choosePublishedCompiler(items, 'linux', 'x64').archive.name,
    linux.archive.name);
});

test('rejects spoofed GitHub hosts, wrong sizes, missing checksums and invalid release tags', () => {
  const base = metadata('win32');
  const release = (assets: OfficialReleaseAsset[], tag = 'v' + VERSION) =>
    [{ tag_name: tag, draft: false, published_at: '2026-11-21', assets }];
  const spoof = {
    ...base.archive,
    browser_download_url: 'https://evil.example/scarp.zip'
  };
  assert.throws(() => choosePublishedCompiler(release([spoof, base.checksum]),
    'win32', 'x64'), /unexpected official asset metadata/);
  assert.throws(() => choosePublishedCompiler(release([
    { ...base.archive, digest: 'sha256:bad' }, base.checksum
  ]), 'win32', 'x64'), /unexpected official asset metadata/);
  assert.throws(() => choosePublishedCompiler(release([
    { ...base.archive, size: 99_999_999 }, base.checksum
  ]), 'win32', 'x64'), /unexpected official asset metadata/);
  assert.throws(() => choosePublishedCompiler(release([base.archive]),
    'win32', 'x64'), /no published compiler package/);
  assert.throws(() => choosePublishedCompiler(release(releaseAssets(base),
    'v0.0.6-alpha.17/../evil'), 'win32', 'x64'),
    /no published compiler package/);
  assert.throws(() => choosePublishedCompiler({ releases: [] }, 'win32', 'x64'),
    /invalid official release catalogue/);
});

test('checks release asset hash, sidecar hash, names and exact byte sizes', () => {
  const original = metadata('win32');
  const archive = Buffer.from('actual native package');
  const checksum = Buffer.from(sha256(archive) + '  ' + original.archive.name + '\n');
  const bundle = {
    ...original,
    archive: {
      ...original.archive, size: archive.length, digest: 'sha256:' + sha256(archive)
    },
    checksum: {
      ...original.checksum, size: checksum.length, digest: 'sha256:' + sha256(checksum)
    }
  };
  assert.doesNotThrow(() => verifyOfficialPackage(bundle, archive, checksum));
  assert.throws(() => verifyOfficialPackage(bundle,
    Buffer.concat([archive, Buffer.from('x')]), checksum), /size or SHA-256/);
  assert.throws(() => verifyOfficialPackage(bundle, archive,
    Buffer.from(sha256(archive) + '  another.zip\n')), /size or SHA-256/);
  const badSidecar = Buffer.from('a'.repeat(64) + '  ' + original.archive.name + '\n');
  assert.throws(() => verifyOfficialPackage({
    ...bundle,
    checksum: { ...bundle.checksum,
      digest: 'sha256:' + sha256(badSidecar), size: badSidecar.length }
  }, archive, badSidecar), /checksum sidecar/);
});

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

function zipMember(member: string, contents: Buffer, flags = 0): Buffer {
  const filename = Buffer.from(member);
  const deflated = deflateRawSync(contents);
  const crc = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const directory = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + filename.length + deflated.length, 16);
  return Buffer.concat([local, filename, deflated, directory, end]);
}

function tarMember(member: string, contents: Buffer, type: string = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(member, 0, 100, 'ascii');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  const size = contents.length.toString(8).padStart(11, '0') + '\0';
  header.write(size, 124, 12, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  const pad = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, contents, pad, Buffer.alloc(1024)]));
}

test('extracts only the exact compiler binary from a Windows ZIP', () => {
  const bundle = metadata('win32');
  const member = bundle.packageRoot + '/scarp.exe';
  const expected = Buffer.from('MZ native Scarp test fixture');
  assert.deepEqual(extractCompilerBinary(zipMember(member, expected), bundle), expected);
  assert.throws(() => extractCompilerBinary(
    zipMember('../scarp.exe', expected), bundle), /missing compiler executable/);
  assert.throws(() => extractCompilerBinary(
    zipMember(member, expected, 1), bundle), /unsafe compiler ZIP member/);
  const corrupted = zipMember(member, expected);
  corrupted[30 + Buffer.byteLength(member) + 1] ^= 1;
  assert.throws(() => extractCompilerBinary(corrupted, bundle), /CRC|compression|directory|size/);
});

test('extracts only the exact compiler binary from a Linux tar.gz', () => {
  const bundle = metadata('linux');
  const member = bundle.packageRoot + '/scarp';
  const expected = Buffer.from('ELF native Scarp test fixture');
  assert.deepEqual(extractCompilerBinary(tarMember(member, expected), bundle), expected);
  assert.throws(() => extractCompilerBinary(tarMember('../scarp', expected), bundle),
    /missing compiler executable/);
  assert.throws(() => extractCompilerBinary(tarMember(member, expected, '2'), bundle),
    /unsafe compiler tar member/);
  assert.throws(() => extractCompilerBinary(Buffer.from('not gzip'), bundle),
    /invalid or oversized/);
});
