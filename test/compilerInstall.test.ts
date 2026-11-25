import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync, deflateRawSync } from 'node:zlib';
import {
  supportedCompilerTarget, choosePublishedCompiler, verifyOfficialPackage,
  extractCompilerBinary, installOfficialCompiler, sha256, officialDownloadHeaders,
  type CompilerPackage, type OfficialReleaseAsset
} from '../src/compilerInstall';

const VERSION = '0.0.6-alpha.17';
const TARGET_WIN = 'x86_64-pc-windows-msvc';
const TARGET_LINUX = 'x86_64-unknown-linux-gnu';

function metadata(platform: 'win32' | 'linux', version = VERSION): CompilerPackage {
  const target = platform === 'win32' ? TARGET_WIN : TARGET_LINUX;
  const filename = 'scarp-' + version + '-' + target +
    (platform === 'win32' ? '.zip' : '.tar.gz');
  const assets = [filename, filename + '.sha256'].map(name => ({
    name, size: 4, digest: 'sha256:' + 'a'.repeat(64),
    browser_download_url: 'https://github.com/scarp-lang/scarp/releases/download/v' +
      version + '/' + name
  }));
  return {
    version, target, archive: assets[0], checksum: assets[1],
    packageRoot: 'scarp-' + version + '-' + target,
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


test('offline end-to-end installer validates, stages, reuses and never overwrites packages', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-offline-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = metadata('linux');
  const script = Buffer.from([
    '#!/usr/bin/env node',
    'if (process.argv[2] === "--version") {',
    '  process.stdout.write("scarp 0.0.6-alpha.17\\n");',
    '} else { process.exitCode = 2; }'
  ].join('\n') + '\n');
  const archive = tarMember(base.packageRoot + '/scarp', script);
  const checksum = Buffer.from(sha256(archive) + '  ' + base.archive.name + '\n');
  const bundle = {
    ...base,
    archive: {
      ...base.archive, digest: 'sha256:' + sha256(archive), size: archive.length
    },
    checksum: {
      ...base.checksum, digest: 'sha256:' + sha256(checksum), size: checksum.length
    }
  };
  const requests: string[] = [];
  const reader = async (url: string, maxBytes: number): Promise<Buffer> => {
    requests.push(url);
    const bytes = url === bundle.archive.browser_download_url ? archive : checksum;
    assert.ok(bytes.length <= maxBytes);
    return bytes;
  };
  const installed = await installOfficialCompiler(root, bundle, undefined, undefined, reader);
  assert.equal(installed.version, VERSION);
  assert.equal(installed.reused, false);
  assert.equal(installed.binary,
    path.join(root, 'compilers', bundle.packageRoot, 'scarp'));
  assert.deepEqual(requests, [
    bundle.archive.browser_download_url, bundle.checksum.browser_download_url
  ]);
  assert.deepEqual(await fs.readFile(installed.binary), script);

  const reused = await installOfficialCompiler(root, bundle, undefined, undefined,
    async () => assert.fail('A valid installed compiler must not be re-downloaded'));
  assert.equal(reused.reused, true);
  assert.equal(reused.binary, installed.binary);

  const badRoot = path.join(root, 'corrupt-test');
  await assert.rejects(installOfficialCompiler(badRoot, bundle, undefined, undefined,
    async (url: string) => url === bundle.archive.browser_download_url
      ? Buffer.from('corrupted') : checksum), /size or SHA-256/);
  assert.deepEqual(await fs.readdir(path.join(badRoot, 'compilers')), [],
    'failed verification must remove all staging directories');
  assert.equal(await fs.readFile(installed.binary, 'utf8'), script.toString());

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(installOfficialCompiler(path.join(root, 'cancelled'),
    bundle, controller.signal, undefined,
    async () => assert.fail('A pre-cancelled install must not download')), /cancelled/);
});


test('cancellation while downloading or verifying leaves no staged or selected executable', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-install-cancel-flight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = metadata('linux');
  const script = Buffer.from('#!/usr/bin/env node\nprocess.stdout.write("scarp ' +
    VERSION + '\\n");\n');
  const archive = tarMember(base.packageRoot + '/scarp', script);
  const checksum = Buffer.from(sha256(archive) + '  ' + base.archive.name + '\n');
  const bundle = {
    ...base,
    archive: { ...base.archive, size: archive.length, digest: 'sha256:' + sha256(archive) },
    checksum: { ...base.checksum, size: checksum.length, digest: 'sha256:' + sha256(checksum) }
  };
  for (const checkpoint of ['archive', 'checksum', 'before-version']) {
    const location = path.join(root, checkpoint);
    const controller = new AbortController();
    const requested: string[] = [];
    const reader = async (url: string): Promise<Buffer> => {
      requested.push(url);
      if (checkpoint === 'archive' && url === bundle.archive.browser_download_url) {
        controller.abort();
      }
      if (checkpoint === 'checksum' && url === bundle.checksum.browser_download_url) {
        controller.abort();
      }
      return url === bundle.archive.browser_download_url ? archive : checksum;
    };
    await assert.rejects(installOfficialCompiler(location, bundle, controller.signal,
      progress => {
        if (checkpoint === 'before-version' &&
            progress === 'Checking the compiler version before installation') {
          controller.abort();
        }
      }, reader), /cancelled/, checkpoint);
    const files = await fs.readdir(path.join(location, 'compilers'));
    assert.deepEqual(files, [], 'Cancelled ' + checkpoint + ' may not leave staging');
    assert.equal(requested.length, checkpoint === 'archive' ? 1 : 2);
  }
});

test('cancellation interrupts staged --version and cleans the temporary executable', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-cancel-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = metadata('linux');
  const script = Buffer.from([
    '#!/usr/bin/env node',
    'setTimeout(() => process.stdout.write("scarp 0.0.6-alpha.17\\n"), 8000);'
  ].join('\n') + '\n');
  const archive = tarMember(base.packageRoot + '/scarp', script);
  const checksum = Buffer.from(sha256(archive) + '  ' + base.archive.name + '\n');
  const bundle = {
    ...base,
    archive: { ...base.archive, digest: 'sha256:' + sha256(archive), size: archive.length },
    checksum: { ...base.checksum, digest: 'sha256:' + sha256(checksum), size: checksum.length }
  };
  const controller = new AbortController();
  await assert.rejects(installOfficialCompiler(root, bundle, controller.signal,
    message => {
      if (message === 'Checking the compiler version before installation') {
        setTimeout(() => controller.abort(), 120);
      }
    }, async url => url === bundle.archive.browser_download_url ? archive : checksum),
  /cancelled/, 'Cancelling during executable validation must not be reported as corrupted');
  assert.deepEqual(await fs.readdir(path.join(root, 'compilers')), [],
    'No staging or installed binary is left behind after cancel');
});

test('cancelled validation of an existing binary must preserve it without reporting corruption', {
  skip: process.platform === 'win32'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-cancel-reuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = metadata('linux');
  const destination = path.join(root, 'compilers', base.packageRoot);
  await fs.mkdir(destination, { recursive: true });
  const executable = path.join(destination, 'scarp');
  await fs.writeFile(executable, '#!/usr/bin/env node\n' +
    'setTimeout(() => process.stdout.write("scarp 0.0.6-alpha.17\\n"), 8000);\n',
  { mode: 0o755 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(installOfficialCompiler(root, base, controller.signal, undefined,
    async () => assert.fail('Reuse check should never download before validation')),
  /cancelled/);
  assert.ok((await fs.stat(executable)).isFile());
  assert.deepEqual(await fs.readdir(path.join(root, 'compilers')), [base.packageRoot],
    'Existing version directories must not be removed on cancellation');
});

test('CI-only GitHub API authentication never reaches asset or redirect hosts', () => {
  const token = 'ghs_fixture-token_not-real';
  const api = officialDownloadHeaders('api.github.com', token);
  assert.equal(api.Authorization, 'Bearer ' + token);
  assert.equal(api.Accept, 'application/vnd.github+json');
  for (const hostname of [
    'github.com', 'release-assets.githubusercontent.com',
    'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
    'evil-api.github.com'
  ]) {
    const headers = officialDownloadHeaders(hostname, token);
    assert.equal(headers.Authorization, undefined, hostname);
    assert.equal(headers.Accept, 'application/octet-stream');
  }
  assert.equal(officialDownloadHeaders('api.github.com').Authorization, undefined,
    'Normal extension requests must remain unauthenticated by default');
});

test('official catalogue selects the highest complete host version rather than publication order', () => {
  const versions = ['0.0.6-alpha.20', '0.0.7-alpha.1', '0.0.6-alpha.99',
    '0.0.7-alpha.10', '0.0.7-alpha.2'];
  const releases = versions.map(version => ({
    tag_name: 'v' + version, draft: false, published_at: '2026-11-25',
    assets: releaseAssets(metadata('win32', version))
  }));
  for (const catalogue of [releases, [...releases].reverse(), [...releases.slice(2), ...releases.slice(0, 2)]]) {
    assert.equal(choosePublishedCompiler(catalogue, 'win32', 'x64').version, '0.0.7-alpha.10');
  }
  assert.deepEqual(releases.map(item => item.tag_name), versions.map(v => 'v' + v),
    'Selection must not mutate release metadata');
  const noWindows = {
    tag_name: 'v0.0.8-alpha.1', draft: false, published_at: '2026-11-25',
    assets: releaseAssets(metadata('linux', '0.0.8-alpha.1'))
  };
  assert.equal(choosePublishedCompiler([noWindows, ...releases], 'win32', 'x64').version,
    '0.0.7-alpha.10');
  assert.equal(choosePublishedCompiler([noWindows, ...releases], 'linux', 'x64').version,
    '0.0.8-alpha.1');
  const stable = { tag_name: 'v0.0.7', draft: false, published_at: '2026-11-25',
    assets: releaseAssets(metadata('win32', '0.0.7')) };
  assert.equal(choosePublishedCompiler([...releases, stable], 'win32', 'x64').version, '0.0.7');
});

test('newest complete package fails closed on ambiguity or invalid metadata', () => {
  const makeRelease = (version: string) => ({
    tag_name: 'v' + version, draft: false, published_at: '2026-11-25',
    assets: releaseAssets(metadata('win32', version))
  });
  const old = makeRelease('0.0.6-alpha.20');
  const latest = makeRelease('0.0.7-alpha.1');
  const invalid = { ...latest, assets: [{ ...latest.assets[0], digest: 'invalid' }, latest.assets[1]] };
  assert.throws(() => choosePublishedCompiler([old, invalid], 'win32', 'x64'),
    /unexpected official asset metadata/);
  assert.throws(() => choosePublishedCompiler([old, { ...latest, assets: [...latest.assets, latest.assets[0]] }],
    'win32', 'x64'), /ambiguous official asset metadata/);
  assert.throws(() => choosePublishedCompiler([latest, latest], 'win32', 'x64'),
    /ambiguous official release tag/);
  for (const version of ['0.0.7-alpha.01', '0.0.7-alpha..1', '00.0.7-alpha.1',
    '9007199254740992.0.0']) {
    assert.equal(choosePublishedCompiler([makeRelease(version), old], 'win32', 'x64').version,
      '0.0.6-alpha.20');
  }
  const missingChecksum = { ...latest, assets: [latest.assets[0]] };
  assert.equal(choosePublishedCompiler([missingChecksum, old], 'win32', 'x64').version,
    '0.0.6-alpha.20');
  assert.equal(choosePublishedCompiler([{ ...latest, draft: true }, old], 'win32', 'x64').version,
    '0.0.6-alpha.20');
});
