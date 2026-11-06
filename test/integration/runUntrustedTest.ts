import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/untrusted');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-untrusted-host-'));
  const workspace = path.join(root, 'untrusted workspace');
  const userDataDir = path.join(root, 'fresh-user-data');
  const extensionsDir = path.join(root, 'extensions');
  try {
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'main.srp'), 'pub bind answer = 42;\n');
    const vscodeExecutable = await downloadAndUnzipVSCode('1.96.0');

    // @vscode/test-electron's runTests ALWAYS injects
    // --disable-workspace-trust. Use its official downloader but launch VS Code
    // directly so Restricted Mode is genuinely active in this separate test.
    const args = [
      workspace,
      '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates',
      '--skip-welcome', '--skip-release-notes', '--no-cached-data',
      '--disable-extensions',
      '--user-data-dir', userDataDir,
      '--extensions-dir', extensionsDir,
      '--extensionDevelopmentPath=' + extensionDevelopmentPath,
      '--extensionTestsPath=' + extensionTestsPath
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(vscodeExecutable, args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          SCARP_UNTRUSTED_WORKSPACE: workspace,
          SCARP_UNTRUSTED_TEST_ROOT: root
        }
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) { resolve(); }
        else { reject(new Error('Restricted Mode VS Code exited ' +
          (signal ? 'with signal ' + signal : 'with code ' + String(code)))); }
      });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error('VS Code Restricted Mode integration tests failed:', error);
  process.exitCode = 1;
});
