import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
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
  const previousVerifyOnSave = settings.inspect<boolean>('verifyOnSave')?.globalValue;
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
    assert.ok(vscode.languages.getDiagnostics(invalidUri).length > 0,
      'Checking a valid file must not erase an unrelated file diagnostic');

    const otherUri = vscode.Uri.file(path.resolve(__dirname, '../../../../test/fixtures/invalid_second.srp'));
    const other = await vscode.workspace.openTextDocument(otherUri);
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand('scarp.checkFile');
    assert.ok(vscode.languages.getDiagnostics(otherUri).some(d => d.source === 'Scarp'),
      'Second invalid source should have compiler diagnostics');
    assert.ok(vscode.languages.getDiagnostics(invalidUri).some(d => d.source === 'Scarp'),
      'Second verification must preserve the first source diagnostics');

    // A source edit invalidates only the corresponding verification's Problems.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(invalidUri, new vscode.Position(0, 0), '// edited after verification\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'Expected VS Code edit to succeed');
    assert.equal(vscode.languages.getDiagnostics(invalidUri).length, 0,
      'Editing a source must clear its stale diagnostics');
    assert.ok(vscode.languages.getDiagnostics(otherUri).length > 0,
      'Editing one source must not erase other sources diagnostics');

    // Restore the original test document in memory, without saving the fixture.
    const undo = new vscode.WorkspaceEdit();
    undo.delete(invalidUri, new vscode.Range(0, 0, 1, 0));
    assert.ok(await vscode.workspace.applyEdit(undo), 'Expected in-memory test cleanup to succeed');
    await vscode.window.showTextDocument(hello);

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

    // Verify on save is opt-in; use a temporary document rather than
    // modifying the checked-in fixtures, and exercise the real compiler.
    assert.equal(settings.get<boolean>('verifyOnSave', false), false,
      'Automatic verification must be disabled by default');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-vscode-save-'));
    const autoUri = vscode.Uri.file(path.join(tempDir, 'auto-invalid.srp'));
    try {
      await fs.writeFile(autoUri.fsPath, 'print("ok");\n');
      const autoDocument = await vscode.workspace.openTextDocument(autoUri);
      assert.equal(autoDocument.languageId, 'scarp');
      await vscode.window.showTextDocument(autoDocument);
      await settings.update('verifyOnSave', true, vscode.ConfigurationTarget.Global);
      const terminalsBeforeSave = vscode.window.terminals.length;
      const autoEdit = new vscode.WorkspaceEdit();
      autoEdit.replace(autoUri, new vscode.Range(0, 0, 0, autoDocument.lineAt(0).text.length),
        'print("missing semicolon")');
      assert.ok(await vscode.workspace.applyEdit(autoEdit));
      assert.ok(await autoDocument.save(), 'Temporary source should save successfully');
      await waitFor(() => vscode.languages.getDiagnostics(autoUri).some(
        diagnostic => diagnostic.source === 'Scarp' &&
          diagnostic.severity === vscode.DiagnosticSeverity.Error) ? true : undefined,
      'Verify on save did not report a real Scarp compiler diagnostic');
      assert.equal(vscode.window.terminals.length, terminalsBeforeSave,
        'Static verify on save must not launch a Scarp run terminal');

      // Simulate an older compiler with no static verification. Its
      // evaluating check command would create a marker if invoked.
      const legacyBinary = path.join(tempDir, 'legacy-scarp');
      const probe = path.join(tempDir, 'version-probed');
      const executed = path.join(tempDir, 'legacy-check-executed');
      const legacyScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") {',
        '  fs.writeFileSync(' + JSON.stringify(probe) + ', "probed");',
        '  console.log("scarp 0.0.4"); process.exit(0);',
        '}',
        'if (args[0] === "verify") { process.exit(2); }',
        'if (args[0] === "check") {',
        '  fs.writeFileSync(' + JSON.stringify(executed) + ', "executed");',
        '  process.exit(0);',
        '}',
        'process.exit(2);'
      ].join('\\n');
      await fs.writeFile(legacyBinary, legacyScript, { mode: 0o755 });
      await fs.chmod(legacyBinary, 0o755);
      await settings.update('compilerPath', legacyBinary, vscode.ConfigurationTarget.Global);
      const legacyEdit = new vscode.WorkspaceEdit();
      legacyEdit.insert(autoUri, new vscode.Position(0, 0), '// another save\\n');
      assert.ok(await vscode.workspace.applyEdit(legacyEdit));
      assert.ok(await autoDocument.save(), 'Legacy source save should succeed');
      await waitFor(() => fsSync.existsSync(probe) ? true : undefined,
        'Automatic save verification did not probe the legacy compiler');
      // The probe completes after --version, so leave enough time for --help.
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(fsSync.existsSync(executed), false,
        'On-save checks must never execute the legacy evaluating check route');
      await settings.update('verifyOnSave', false, vscode.ConfigurationTarget.Global);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    console.log('Scarp Extension Host integration checks passed');
  } finally {
    await settings.update('verifyOnSave', previousVerifyOnSave, vscode.ConfigurationTarget.Global);
    await settings.update('compilerPath', previous, vscode.ConfigurationTarget.Global);
  }
}
