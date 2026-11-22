import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { withHostDownloadRetry } from './downloadRetry';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  // Linux stress tests use POSIX executable signal-control fixtures.
  // Windows exercises the real native compiler and Extension Host in its
  // own shell-free suite (not an emulator or an omitted check).
  const suite = process.env.SCARP_TEST_SUITE;
  const windows = suite === 'windows';
  const published = suite === 'published';
  const alpha18 = suite === 'alpha18';
  if (suite && !windows && !published && !alpha18) {
    throw new Error('Unknown Scarp integration suite: ' + suite);
  }
  if (windows && process.platform !== 'win32') {
    throw new Error('The Windows integration suite requires Windows.');
  }
  const extensionTestsPath = path.resolve(__dirname,
    windows ? './suite/windows' : published ? './suite/publishedPackage' :
      alpha18 ? './suite/defaultEntry' : './suite/index');
  const compiler = process.env.SCARP_TEST_BINARY;
  if (!compiler || !path.isAbsolute(compiler)) {
    throw new Error('SCARP_TEST_BINARY must name an absolute official compiler path');
  }
  const vscodeExecutablePath = await withHostDownloadRetry(
    () => downloadAndUnzipVSCode('1.96.0'),
    attempt => console.warn(`Retrying VS Code test host download (attempt ${attempt}/3).`)
  );
  await runTests({
    vscodeExecutablePath,
    version: '1.96.0',
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      SCARP_TEST_BINARY: compiler,
      ...(process.env.SCARP_PUBLISHED_INSTALL_ROOT
        ? { SCARP_PUBLISHED_INSTALL_ROOT: process.env.SCARP_PUBLISHED_INSTALL_ROOT }
        : {})
    },
    launchArgs: [
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox',
      ...(alpha18 ? [path.join(extensionDevelopmentPath, 'test/fixtures/alpha18-workspace')] : [])
    ]
  });
}
void main().catch(error => {
  console.error('VS Code integration tests failed:', error);
  process.exitCode = 1;
});
