import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

const runExecutable = promisify(execFile);

/**
 * A real VS Code Extension Host test against the published, checksum-verified
 * archive installed earlier in this workflow. No mocked compiler, shell,
 * source build, or interactive Quick Pick automation is involved.
 */
export async function run(): Promise<void> {
  const binary = process.env.SCARP_TEST_BINARY;
  const installRoot = process.env.SCARP_PUBLISHED_INSTALL_ROOT;
  const publishedVersion = process.env.SCARP_PUBLISHED_VERSION;
  assert.match(publishedVersion || '', /^(?:0\.0\.6-alpha\.(?:17|19)|0\.0\.7-alpha\.[12])$/,
    'The native installer must export the exact independently pinned version');
  assert.ok(binary && path.isAbsolute(binary), 'Verified official compiler path is required');
  assert.ok(installRoot && path.isAbsolute(installRoot),
    'Official package installation root must be explicitly provided');
  assert.equal(path.basename(binary), process.platform === 'win32' ? 'scarp.exe' : 'scarp');
  assert.ok(binary.startsWith(path.join(installRoot, 'compilers') + path.sep),
    'The compiler must come from the verified native installer output');

  const nativeVersion = await runExecutable(binary, ['--version'], {
    timeout: 10000, windowsHide: true
  });
  assert.equal(nativeVersion.stdout.trim(), 'scarp ' + publishedVersion);
  assert.equal(nativeVersion.stderr, '');

  const extension = vscode.extensions.getExtension('ScarpLang.scarp');
  assert.ok(extension, 'Expected the Scarp extension in the actual Extension Host');
  await extension.activate();
  assert.equal(vscode.workspace.isTrusted, true,
    'Normal official-package integration runs in a trusted test host');
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'scarp.runFile', 'scarp.checkFile', 'scarp.showVersion',
    'scarp.setupCompiler', 'scarp.manageCompiler', 'scarp.stopProgram'
  ]) {
    assert.ok(commands.includes(command), 'Missing command: ' + command);
  }

  const initialInstallTree = (await fs.readdir(path.join(installRoot, 'compilers'))).sort();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-release-host-'));
  const helloUri = vscode.Uri.file(path.join(tempRoot, 'published release hello.srp'));
  const invalidUri = vscode.Uri.file(path.join(tempRoot, 'published release invalid.srp'));
  const settings = vscode.workspace.getConfiguration('scarp');
  const oldPath = settings.inspect<string>('compilerPath')?.globalValue;
  const initialTerminals = vscode.window.terminals.length;

  try {
    await fs.writeFile(helloUri.fsPath, 'print("Hello from Scarp!");\n', 'utf8');
    await fs.writeFile(invalidUri.fsPath, 'bind = 1;\n', 'utf8');
    await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
    const document = await vscode.workspace.openTextDocument(helloUri);
    await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(document.languageId, 'scarp');

    // Real compiler resolution via the public command; the version response
    // must agree with the archive already checked and executed in CI.
    await vscode.commands.executeCommand('scarp.showVersion');

    // Published native CLI static verify must be reflected by the editor's
    // actual Problems collection without executing the source.
    await vscode.commands.executeCommand('scarp.checkFile', helloUri);
    assert.equal(vscode.languages.getDiagnostics(helloUri).length, 0,
      'Published compiler must successfully verify a correct Scarp file');
    const bad = await vscode.workspace.openTextDocument(invalidUri);
    await vscode.window.showTextDocument(bad, { preview: false });
    await vscode.commands.executeCommand('scarp.checkFile', invalidUri);
    assert.ok(vscode.languages.getDiagnostics(invalidUri).some(
      item => item.source === 'Scarp' && item.severity === vscode.DiagnosticSeverity.Error
    ), 'Published compiler errors must appear as true Problems diagnostics');

    if (publishedVersion === '0.0.7-alpha.1' || publishedVersion === '0.0.7-alpha.2') {
      const featureUri = vscode.Uri.file(path.join(tempRoot, 'new series features.srp'));
      const featureSource = [
        'bind joined = array_concat([array: 12, 18], [array: 24]);',
        'print(joined, integer_hcf(24, 36, 60));',
        ''
      ].join('\n');
      await fs.writeFile(featureUri.fsPath, featureSource, 'utf8');
      const featureDoc = await vscode.workspace.openTextDocument(featureUri);
      await vscode.window.showTextDocument(featureDoc, { preview: false });
      await vscode.commands.executeCommand('scarp.checkFile', featureUri);
      assert.equal(vscode.languages.getDiagnostics(featureUri).length, 0);
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', featureUri,
        new vscode.Position(0, featureDoc.lineAt(0).text.indexOf('array_concat') + 2));
      assert.ok(hover?.some(item => item.contents.some(content =>
        (typeof content === 'string' ? content : content.value).includes('v0.0.7-alpha.1'))));
      // Use a distinct URI for the negative fixture so the host does not race
      // disk-to-buffer reload of the previous document.
      const wrongUri = vscode.Uri.file(path.join(tempRoot, 'wrong arity.srp'));
      await fs.writeFile(wrongUri.fsPath, 'print(integer_hcf(1));\n', 'utf8');
      const wrong = await vscode.workspace.openTextDocument(wrongUri);
      await vscode.window.showTextDocument(wrong, { preview: false });
      await vscode.commands.executeCommand('scarp.checkFile', wrongUri);
      assert.ok(vscode.languages.getDiagnostics(wrongUri).some(item =>
        item.source === 'Scarp' && item.severity === vscode.DiagnosticSeverity.Error));
    }

    // A fast-running native program may exit before we inspect the terminal
    // collection. Capture its real VS Code open event rather than racing exit.
    let sawRunTerminal = false;
    const opened = vscode.window.onDidOpenTerminal(terminal => {
      if (terminal.name === 'Scarp: published release hello.srp') {
        sawRunTerminal = true;
      }
    });
    try {
      await vscode.commands.executeCommand('scarp.runFile', helloUri);
      assert.ok(sawRunTerminal || vscode.window.terminals.some(t => t.name ===
        'Scarp: published release hello.srp'),
      'Run must launch a terminal for the selected file with the official compiler');
      await vscode.commands.executeCommand('scarp.stopProgram');
      for (let retry = 0; retry < 30 &&
        vscode.window.terminals.length > initialTerminals; retry++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(vscode.window.terminals.length <= initialTerminals,
        'Stop must dispose of extension-owned launch terminals');
    } finally { opened.dispose(); }

    // View/Run/Verify must never start the explicit compiler installer.
    assert.deepEqual((await fs.readdir(path.join(installRoot, 'compilers'))).sort(),
      initialInstallTree, 'Ordinary source actions must not install new native packages');
    assert.deepEqual(await fs.readFile(helloUri.fsPath, 'utf8'),
      'print("Hello from Scarp!");\n', 'Extension must not rewrite the source');
    console.log('Real published-native Scarp Extension Host smoke checks passed on',
      process.platform, process.arch);
  } finally {
    await settings.update('compilerPath', oldPath, vscode.ConfigurationTarget.Global);
    await fs.rm(tempRoot, {
      recursive: true, force: true, maxRetries: 12, retryDelay: 100
    });
  }
}
