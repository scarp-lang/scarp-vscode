import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Real published alpha.18 compiler + real VS Code Extension Host.
 * Launches an explicit workspace whose only entry is src/main.srp.
 */
export async function run(): Promise<void> {
  const compiler = process.env.SCARP_TEST_BINARY;
  assert.ok(compiler && path.isAbsolute(compiler),
    'An absolute official alpha.18 compiler is required');
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace && workspace.uri.scheme === 'file',
    'The default-entry host suite requires an opened local workspace root');
  assert.equal(path.basename(workspace.uri.fsPath), 'alpha18-workspace');
  assert.equal(vscode.workspace.isTrusted, true);

  const extension = vscode.extensions.getExtension('ScarpLang.scarp');
  assert.ok(extension, 'Scarp extension must load in its own Extension Host');
  await extension.activate();
  assert.ok((await vscode.commands.getCommands(true)).includes('scarp.runWorkspaceEntry'));

  const settings = vscode.workspace.getConfiguration('scarp');
  const previousCompiler = settings.inspect<string>('compilerPath')?.globalValue;
  const opened: vscode.Terminal[] = [];
  const listener = vscode.window.onDidOpenTerminal(terminal => opened.push(terminal));
  try {
    await settings.update('compilerPath', compiler, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('scarp.runWorkspaceEntry', workspace.uri);
    let terminal: vscode.Terminal | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      terminal = opened.find(item => item.name.startsWith('Scarp Entry: '));
      if (terminal) { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(terminal, 'The command must actually open a default-entry terminal');
    const options = terminal.creationOptions;
    assert.ok('shellPath' in options, 'Default entry must launch a real shell-free executable');
    assert.equal(options.shellPath, compiler);
    assert.deepEqual(options.shellArgs, ['exec'],
      'No filename, --input-file, --interactive or trailing -- may be forwarded');
    assert.equal(options.cwd, workspace.uri.fsPath);

    await vscode.commands.executeCommand('scarp.stopProgram');
  } finally {
    listener.dispose();
    await vscode.commands.executeCommand('scarp.stopProgram');
    await settings.update('compilerPath', previousCompiler, vscode.ConfigurationTarget.Global);
  }
}
