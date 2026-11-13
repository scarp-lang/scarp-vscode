import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { withHostDownloadRetry } from './downloadRetry';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
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
    extensionTestsEnv: { SCARP_TEST_BINARY: compiler },
    launchArgs: [
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox'
    ]
  });
}
void main().catch(error => {
  console.error('VS Code integration tests failed:', error);
  process.exitCode = 1;
});
