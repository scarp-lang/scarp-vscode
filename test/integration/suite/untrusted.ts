import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Runs in a separate VS Code instance with a fresh, untrusted workspace. */
export async function run(): Promise<void> {
  const workspace = process.env.SCARP_UNTRUSTED_WORKSPACE;
  const root = process.env.SCARP_UNTRUSTED_TEST_ROOT;
  assert.ok(workspace && root, 'Restricted Mode test environment is required');
  assert.equal(vscode.workspace.isTrusted, false,
    'Restricted Mode test must have workspace trust ENABLED and the folder UNTRUSTED');

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'Restricted Mode test requires an open workspace folder');
  assert.equal(folder.uri.fsPath, workspace);

  const extension = vscode.extensions.getExtension('ScarpLang.scarp');
  assert.ok(extension, 'Limited-support Scarp extension must be present in Restricted Mode');
  await extension.activate();

  const sourceUri = vscode.Uri.file(path.join(workspace, 'main.srp'));
  const source = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(source);
  assert.equal(source.languageId, 'scarp');
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', sourceUri);
  assert.ok(symbols?.some(item => item.name === 'answer'),
    'Read-only local Scarp Outline should remain available in Restricted Mode');

  const settings = vscode.workspace.getConfiguration('scarp');
  const previousCompiler = settings.inspect<string>('compilerPath')?.globalValue;
  const previousVerifyOnSave = settings.inspect<boolean>('verifyOnSave')?.globalValue;
  const marker = path.join(root, 'compiler-invoked');
  const fakeCompiler = path.join(root, 'scarp-probe');
  await fs.writeFile(fakeCompiler, [
    '#!/usr/bin/env node',
    'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "invoked");',
    'process.stdout.write("scarp 0.0.6-alpha.1\\n");'
  ].join('\n'), { mode: 0o755 });
  await fs.chmod(fakeCompiler, 0o755);

  try {
    await settings.update('compilerPath', fakeCompiler, vscode.ConfigurationTarget.Global);
    await settings.update('verifyOnSave', true, vscode.ConfigurationTarget.Global);
    const initialTerminals = vscode.window.terminals.length;

    // Hover help must remain a pure editor operation in Restricted Mode.
    // The fake compiler writes a marker if anything attempts to execute it.
    const hoverDoc = await vscode.workspace.openTextDocument({
      language: 'scarp',
      content: 'bind chosen = top_p([0.6, 0.4], 0.9);'
    });
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', hoverDoc.uri, new vscode.Position(0, 16));
    assert.ok(hovers?.length, 'Read-only Scarp builtin hover should work when untrusted');
    const markdown = (hovers ?? []).flatMap(item => item.contents)
      .map(item => typeof item === 'string' ? item : item.value).join('\n');
    assert.match(markdown, /v0\.0\.6-alpha\.5/);
    assert.match(markdown, /top_p\(probabilities: vector, mass: float\)/);
    assert.equal(fsSync.existsSync(marker), false,
      'Static builtin hover must never execute the configured compiler');

    // Signature help is also a read-only editor feature in Restricted Mode.
    const signatureDoc = await vscode.workspace.openTextDocument({
      language: 'scarp', content: 'bind chosen = top_p([0.6, 0.4], 0.9);'
    });
    const signatureSource = signatureDoc.getText();
    const argumentPosition = signatureSource.indexOf(', 0.9') + 1;
    const hint = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider', signatureDoc.uri,
      new vscode.Position(0, argumentPosition), ',');
    assert.ok(hint?.signatures.length, 'Builtin signatures should work without workspace trust');
    assert.match(hint.signatures[0].label, /^top_p\(/);
    assert.equal(hint.activeParameter, 1);
    assert.equal(fsSync.existsSync(marker), false,
      'Static signature help must never execute the configured compiler');

    // Commands must still reject direct invocation: hiding a menu item alone
    // is insufficient protection when extensions can call a command by ID.
    for (const command of [
      'scarp.runFile', 'scarp.checkFile', 'scarp.showVersion',
      'scarp.createProject', 'scarp.verifyProject', 'scarp.launchProject',
      'scarp.browseProjectModules', 'scarp.browseProjectSymbols'
    ]) {
      await vscode.commands.executeCommand(command, vscode.Uri.file(workspace));
    }

    const edit = new vscode.WorkspaceEdit();
    edit.insert(sourceUri, new vscode.Position(0, 0), '// untrusted workspace edit\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await source.save());
    // Allow the on-save debounce (300 ms) and any asynchronous probe to run.
    await new Promise(resolve => setTimeout(resolve, 800));

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider', sourceUri, new vscode.Position(1, 10));
    assert.equal(locations?.length ?? 0, 0,
      'Compiler-backed navigation must not run in Restricted Mode');
    assert.equal(fsSync.existsSync(marker), false,
      'Restricted Mode must never invoke a configured executable');
    assert.equal(vscode.window.terminals.length, initialTerminals,
      'Restricted Mode must not open a Scarp program terminal');
    assert.equal(vscode.languages.getDiagnostics(sourceUri).length, 0,
      'Restricted Mode must not invent verification diagnostics');

    console.log('Scarp Restricted Mode Extension Host integration checks passed');
  } finally {
    await settings.update('verifyOnSave', previousVerifyOnSave,
      vscode.ConfigurationTarget.Global);
    await settings.update('compilerPath', previousCompiler,
      vscode.ConfigurationTarget.Global);
  }
}
