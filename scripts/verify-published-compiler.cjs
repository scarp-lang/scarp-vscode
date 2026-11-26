'use strict';

/**
 * CI release-distribution gate: consume REAL published GitHub bytes through
 * the exact importer used by the extension setup wizard. This is intentionally
 * separate from source-build compatibility tests and publishes nothing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const {
  choosePublishedCompiler, installOfficialCompiler, readOfficialBytes
} = require('../dist/src/compilerInstall');

const run = promisify(execFile);
// Backward compatibility and the latest independently reviewed native assets.
// Normal setup never reads this CI-only selector.
const VERSION = process.env.SCARP_NATIVE_PACKAGE_VERSION || '0.0.6-alpha.17';
if (!['0.0.6-alpha.17', '0.0.6-alpha.19', '0.0.7-alpha.1', '0.0.7-alpha.2'].includes(VERSION)) {
  throw new Error('Unsupported CI native package version: ' + VERSION);
}
const TAG = 'v' + VERSION;
const OFFICIAL_RELEASE = 'https://api.github.com/repos/scarp-lang/scarp/releases/tags/' + TAG;

// Independently approved public release digests. Never rely solely on mutable
// API-provided digests for this immutable published-asset regression gate.
const PINNED_SHA256 = Object.freeze({
  '0.0.6-alpha.17': {
    'x86_64-pc-windows-msvc': {
      archive: 'fa05e57675799d881ebe33ccd54f6eb769825632904adf99cd08c940383134b5',
      checksum: '02484cc469dc3c74a004aabc957f5c62fa6929cb2328a8059737cdc91763b6e5'
    },
    'x86_64-unknown-linux-gnu': {
      archive: '50844eb6a7b144c8597b9e65b016a9b5ceda84a6c5f8d80cfd755fb24607520d',
      checksum: 'e6ba1a5325c1b2aae3757aa9e923e8f408be9c8839fc3a8544e2d6b2deda8188'
    },
    'aarch64-apple-darwin': {
      archive: 'be58f733bca2b329ba8b62454372c3b456658e467235ff72c1fad2b3472de401',
      checksum: 'f3d87c4dfdf207a99e4251be3bffd63322e1bb03a7500c57f49d37ae4c1e8b12'
    }
  },
  '0.0.6-alpha.19': {
    'x86_64-pc-windows-msvc': {
      archive: 'e00ec9bfd2447fc2c54ae8101933da3c6899251300711627115db5239e559023',
      checksum: 'd906ef909935996a3d3e407cb8077685b463aceec419bef22bb2e908961c4a4c'
    },
    'x86_64-unknown-linux-gnu': {
      archive: 'e9bfb14202c0bc33a6621d7d0545482280f0296531038b34e2215fe124c0366b',
      checksum: '179661830681a594b6f4c6eefe53024314d97ac225d7b09430def779797eb977'
    },
    'aarch64-apple-darwin': {
      archive: '5eb73cacc13b21f40e3448310b4f9e5582935250c833108d0493b02db7f65c96',
      checksum: 'c7bcc5393b44f13a69917ac8f92da6bf7c89599b12b07cf1526f24983dbc6dc4'
    }
  },
  '0.0.7-alpha.1': {
    'x86_64-pc-windows-msvc': {
      archive: '371eeabd1b35e9e3530ce44f13d90f376972b0650df9d41ce79a41c814875924',
      checksum: '458d2217de7f9b53473c8cf94ba182dbeefd17ad722ce3c684c5e612ff1593e6'
    },
    'x86_64-unknown-linux-gnu': {
      archive: 'f034432f46c12720b74ec303446fb46ecef483abdc942bcb9eaca41ea349cb5c',
      checksum: '84d072812c11d03008613451d7148ea1dc52ff9bf9a264dab0a781844875887a'
    },
    'aarch64-apple-darwin': {
      archive: '63697cb53224cf0a22a38a28ae7887b8c694979d54ee780dc0639f1057409909',
      checksum: 'c44502f63d73e79ec0780d028d17f2477147b5f163796d35704da591d23728ca'
    }
  },
  '0.0.7-alpha.2': {
    'x86_64-pc-windows-msvc': {
      archive: '5cddf9d831d6eb487b2142755b36b48f1cc598d8f6cfbca39332219fd2567849',
      checksum: 'da7b8f5522cf470af61d7d88175ef9e72ee28da99263cccae8927feb07e5f7af'
    },
    'x86_64-unknown-linux-gnu': {
      archive: '8397f2f096fe9598cb6e37c54024afdb80634e97bded8e1777812ab0f38cf0dc',
      checksum: '0eef068c84ed0fbb59f24081a1be5ce72bb562d34cc6c1e10fce554c4508555f'
    },
    'aarch64-apple-darwin': {
      archive: '08aa0b3d0f4b8458a016abce9d403a5cfd1bf19255954c276c79c033932d1ffe',
      checksum: 'd338b5c0d534850f26b0d0ec1415fa9e4ff1d0ed80ef47361c7c904e4438838d'
    }
  }
});

async function runCompiler(binary, args, cwd) {
  return run(binary, args, {
    timeout: 15000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    cwd
  });
}

async function main() {
  const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
  if (!path.isAbsolute(tempRoot)) {
    throw new Error('Expected an absolute temporary runner directory');
  }
  const root = path.join(tempRoot, 'scarp-published-package-ci');
  // GitHub Actions runs many parallel jobs; use only the job's read-only token
  // for API metadata to avoid unauthenticated 60-requests/hour rate limits.
  // The library never forwards this credential to asset download redirects.
  const metadata = await readOfficialBytes(
    OFFICIAL_RELEASE, 512 * 1024, undefined, process.env.GITHUB_TOKEN
  );
  const official = JSON.parse(metadata.toString('utf8'));
  assert.equal(official.tag_name, TAG, 'Release tag must match the exact pinned published version');
  assert.equal(official.draft, false, 'Never install draft release artifacts');
  assert.ok(official.published_at, 'The compiler release must be published');
  const bundle = choosePublishedCompiler([official], process.platform, process.arch);
  assert.equal(bundle.version, VERSION);
  const pin = PINNED_SHA256[VERSION][bundle.target];
  assert.ok(pin, 'Unsupported/incorrect native release target: ' + bundle.target);
  assert.equal(bundle.archive.digest, 'sha256:' + pin.archive,
    'Published archive digest differs from the independently pinned release');
  assert.equal(bundle.checksum.digest, 'sha256:' + pin.checksum,
    'Published checksum-sidecar digest differs from the independently pinned release');

  const status = [];
  const result = await installOfficialCompiler(
    root, bundle, undefined, message => {
      status.push(message);
      console.log('Scarp install:', message);
    }
  );
  assert.equal(result.version, VERSION);
  assert.equal(result.reused, false, 'First use must validate a real published download');
  const actualBinary = path.join(root, 'compilers', bundle.packageRoot, bundle.binaryName);
  assert.equal(result.binary, actualBinary);
  const info = await fs.lstat(actualBinary);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.ok(info.size > 100_000 && info.size <= 48 * 1024 * 1024);
  assert.ok(status.includes('Verifying published SHA-256 hashes'),
    'Installer must check published content hashes before installing');
  assert.ok(status.includes('Checking the compiler version before installation'),
    'Installer must validate the executable before making it available');

  const version = await runCompiler(actualBinary, ['--version']);
  assert.equal(version.stdout.trim(), 'scarp ' + VERSION);
  assert.equal(version.stderr, '');

  const source = path.resolve('test', 'fixtures', 'hello.srp');
  const check = await runCompiler(actualBinary,
    ['verify', '--diagnostic-format=json', '--', source]);
  assert.equal(check.stdout, '', 'Official package verification must remain static');
  assert.equal(check.stderr, '');
  const execution = await runCompiler(actualBinary, ['exec', '--', source]);
  assert.equal(execution.stdout, 'Hello from Scarp!\n');
  assert.equal(execution.stderr, '');

  if (VERSION === '0.0.7-alpha.1' || VERSION === '0.0.7-alpha.2') {
    const workspace = await fs.mkdtemp(path.join(tempRoot, 'scarp-native-contract-'));
    try {
      const filename = path.join(workspace, 'new series.srp');
      await fs.writeFile(filename, [
        'bind first = [array: 12, 18];',
        'bind joined = array_concat(first, [array: 24]);',
        'print(first);',
        'print(joined);',
        'print(integer_gcd(24, 36, 60), integer_hcf(24, 36, 60), integer_lcm(4, 6, 10));',
        'print(0.1d + 0.2d);',
        ''
      ].join('\n'), 'utf8');
      const verified = await runCompiler(actualBinary, ['verify', '--', filename]);
      assert.equal(verified.stdout, '');
      assert.equal(verified.stderr, '');
      const executed = await runCompiler(actualBinary, ['exec', '--', filename]);
      assert.equal(executed.stdout.replace(/\r\n/g, '\n'),
        '[array: 12, 18]\n[array: 12, 18, 24]\n12 12 60\n0.3\n');
      assert.equal(executed.stderr, '');

      const project = path.join(workspace, 'new project');
      await runCompiler(actualBinary, ['init', project]);
      assert.ok((await fs.stat(path.join(project, 'scarp.project'))).isFile());
      const names = await fs.readdir(project);
      assert.ok(!names.includes('Scarp.project'), 'The new project must use the lowercase filename');
      // Real default-entry execution from a path with spaces on every host.
      const entry = await runCompiler(actualBinary, ['exec'], project);
      assert.equal(entry.stdout.replace(/\r\n/g, '\n'), 'Hello from Scarp!\n');
      assert.equal(entry.stderr, '');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // Alpha.2 ships a cross-host ELF64 emitter, not a native program runner.
  // Test the published CLI with a new destination and reject overwrite.
  if (VERSION === '0.0.7-alpha.2') {
    const workspace = await fs.mkdtemp(path.join(tempRoot, 'scarp-native-object-'));
    try {
      const source = path.join(workspace, 'native calls.srp');
      const output = path.join(workspace, 'native calls.o');
      await fs.writeFile(source, [
        'pure funcra evaluate(n: integer) -> integer { return twice(n) + 1; }',
        'pure funcra twice(n: integer) -> integer { return n * 2; }',
        ''
      ].join('\n'), 'utf8');
      const args = ['native-object', '--json', 'x86_64-none', 'bounded-entry',
        'evaluate', '1000', '512', source, '-o', output];
      const emitted = await runCompiler(actualBinary, args);
      assert.equal(emitted.stderr, '');
      const metadata = JSON.parse(emitted.stdout);
      assert.equal(metadata.schema_version, 1);
      assert.equal(metadata.target, 'x86_64-none');
      assert.equal(metadata.mode, 'bounded-entry');
      assert.equal(metadata.max_work, 1000);
      assert.equal(metadata.max_stack_bytes, 512);
      assert.equal(metadata.integer_arguments, 1);
      assert.equal(metadata.span_encoding, 'utf-8-bytes');
      assert.ok(Number.isSafeInteger(metadata.peak_stack_bytes) &&
        metadata.peak_stack_bytes > 0 && metadata.peak_stack_bytes <= 512);
      assert.equal(metadata.max_active_frames, 2);
      const object = await fs.readFile(output);
      assert.ok(object.length >= 64);
      assert.deepEqual([...object.subarray(0, 7)], [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
      assert.equal(object.readUInt16LE(16), 1, 'Expected ET_REL, not an executable');
      assert.equal(object.readUInt16LE(18), 62, 'Expected EM_X86_64 on every package host');
      await assert.rejects(runCompiler(actualBinary, args), error =>
        error.code === 1 && error.stdout === '');
      assert.deepEqual(await fs.readFile(output), object, 'Existing object must not change');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // A second explicit install must reuse a valid existing executable and
  // never fetch another archive. The offline reuse test asserts this as well.
  const reused = await installOfficialCompiler(
    root, bundle, undefined, undefined,
    async () => { throw new Error('Unexpected GitHub request during validated package reuse'); }
  );
  assert.equal(reused.binary, actualBinary);
  assert.equal(reused.reused, true);
  assert.deepEqual(await fs.readdir(path.join(root, 'compilers')), [bundle.packageRoot],
    'Installer must not leave behind staging directories');

  // The next CI step launches a REAL VS Code Extension Host against precisely
  // these downloaded-and-verified bytes, not a compiler rebuilt from source.
  if (process.env.GITHUB_ENV) {
    await fs.appendFile(process.env.GITHUB_ENV,
      'SCARP_TEST_BINARY=' + actualBinary + '\n' +
      'SCARP_PUBLISHED_INSTALL_ROOT=' + root + '\n' +
      'SCARP_PUBLISHED_VERSION=' + VERSION + '\n', 'utf8');
  }
  console.log('Official Scarp native package verified:', actualBinary);
  console.log('Host:', process.platform, process.arch, '| Version:', VERSION);
}

main().catch(error => {
  console.error('Pinned published Scarp package regression failed:', error);
  process.exitCode = 1;
});
