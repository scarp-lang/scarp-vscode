import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/untrusted');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-untrusted-host-'));
  const workspace = path.join(root, 'untrusted workspace');
  const userDataDir = path.join(root, 'fresh-user-data');
  try {
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'main.srp'), 'pub bind answer = 42;\n');
    await runTests({
      version: '1.96.0',
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: {
        SCARP_UNTRUSTED_WORKSPACE: workspace,
        SCARP_UNTRUSTED_TEST_ROOT: root
      },
      launchArgs: [
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
        '--user-data-dir', userDataDir,
        workspace
      ]
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error('VS Code Restricted Mode integration tests failed:', error);
  process.exitCode = 1;
});
