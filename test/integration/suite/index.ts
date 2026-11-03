import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const value = read();
    if (value !== undefined) { return value; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

/** Runs inside the real VS Code Extension Host, not a Node.js mock. */
export async function run(): Promise<void> {
  const binary = process.env.SCARP_TEST_BINARY;
  assert.ok(binary, 'SCARP_TEST_BINARY is required');

  const extension = vscode.extensions.getExtension('ScarpLang.scarp');
  assert.ok(extension, 'Official Scarp extension must be installed in Extension Host');
  await extension.activate();

  const languages = await vscode.languages.getLanguages();
  assert.ok(languages.includes('scarp'), 'Scarp language registration is missing');

  const commands = await vscode.commands.getCommands(true);
  for (const name of ['scarp.runFile', 'scarp.checkFile', 'scarp.showVersion',
    'scarp.stopProgram', 'scarp.showOutput']) {
    assert.ok(commands.includes(name), 'Missing command: ' + name);
  }

  const settings = vscode.workspace.getConfiguration('scarp');
  const previous = settings.inspect<string>('compilerPath')?.globalValue;
  await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
  try {
    const invalidUri = vscode.Uri.file(path.resolve(__dirname, '../../../../test/fixtures/invalid.srp'));
    const invalid = await vscode.workspace.openTextDocument(invalidUri);
    assert.equal(invalid.languageId, 'scarp');
    await vscode.window.showTextDocument(invalid);
    await vscode.commands.executeCommand('scarp.checkFile');
    const errors = vscode.languages.getDiagnostics(invalidUri);
    assert.ok(errors.some(d => d.source === 'Scarp' &&
      d.severity === vscode.DiagnosticSeverity.Error),
      'Expected a real compiler error in the Problems collection');

    // Current compiler's verify command must not execute this expression.
    // Legacy evaluating check would report an arithmetic failure here.
    const staticUri = vscode.Uri.file(path.resolve(__dirname, '../../../../test/fixtures/static_only.srp'));
    const staticOnly = await vscode.workspace.openTextDocument(staticUri);
    await vscode.window.showTextDocument(staticOnly);
    await vscode.commands.executeCommand('scarp.checkFile');
    assert.equal(vscode.languages.getDiagnostics(staticUri).length, 0,
      'Static-only verification must not evaluate the division expression');

    const helloUri = vscode.Uri.file(path.resolve(__dirname, '../../../../test/fixtures/hello.srp'));
    const hello = await vscode.workspace.openTextDocument(helloUri);
    await vscode.window.showTextDocument(hello);
    await vscode.commands.executeCommand('scarp.checkFile');
    assert.equal(vscode.languages.getDiagnostics(invalidUri).length, 0,
      'Old diagnostics must be cleared after a successful check');

    const opened = new Promise<vscode.Terminal>((resolve, reject) => {
      const timer = setTimeout(() => { disposable.dispose(); reject(new Error('No Scarp terminal opened')); }, 6000);
      const disposable = vscode.window.onDidOpenTerminal(terminal => {
        if (!terminal.name.startsWith('Scarp:')) { return; }
        clearTimeout(timer);
        disposable.dispose();
        resolve(terminal);
      });
    });
    await vscode.commands.executeCommand('scarp.runFile');
    const terminal = await opened;
    assert.match(terminal.name, /^Scarp: hello\.srp$/);
    await vscode.commands.executeCommand('scarp.stopProgram');
    await waitFor(() => vscode.window.terminals.includes(terminal) ? undefined : true,
      'Stop command did not close the Scarp terminal');

    console.log('Scarp Extension Host integration checks passed');
  } finally {
    await settings.update('compilerPath', previous, vscode.ConfigurationTarget.Global);
  }
}
