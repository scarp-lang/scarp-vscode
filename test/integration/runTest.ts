import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const compiler = process.env.SCARP_TEST_BINARY;
  if (!compiler || !path.isAbsolute(compiler)) {
    throw new Error('SCARP_TEST_BINARY must name an absolute official compiler path');
  }
  await runTests({
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
