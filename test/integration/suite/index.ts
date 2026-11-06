import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { preferredExecutionVerb } from '../../../src/cli';
import { parseBrowsableProjectModules } from '../../../src/projectModules';
import { parseProjectSymbols } from '../../../src/navigationIndex';

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
  assert.equal(await preferredExecutionVerb(binary), 'exec',
    'Pinned Scarp compiler should expose the canonical exec guide');

  const extension = vscode.extensions.getExtension('ScarpLang.scarp');
  assert.ok(extension, 'Official Scarp extension must be installed in Extension Host');
  await extension.activate();

  const languages = await vscode.languages.getLanguages();
  assert.ok(languages.includes('scarp'), 'Scarp language registration is missing');

  const commands = await vscode.commands.getCommands(true);
  for (const name of ['scarp.runFile', 'scarp.checkFile', 'scarp.showVersion',
    'scarp.stopProgram', 'scarp.showOutput', 'scarp.createProject',
    'scarp.verifyProject', 'scarp.browseProjectModules',
    'scarp.browseProjectSymbols', 'scarp.launchProject']) {
    assert.ok(commands.includes(name), 'Missing command: ' + name);
  }

  // Exercise the actual VS Code Outline and "Go to Symbol in Editor" API.
  // Navigation is local and does not require a compiler, file access or trust.
  const symbolDoc = await vscode.workspace.openTextDocument({
    language: 'scarp',
    content: [
      'import "modules/linear.srp" as linear;',
      'pub bind base = 4;',
      'pub pure funcra compute(value: integer) -> integer',
      'needs value > 0;',
      '{',
      '  bind inside = value;',
      '  return inside;',
      '}',
      'print("funcra ghost() -> unit {}");'
    ].join('\n')
  });
  const outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', symbolDoc.uri);
  assert.ok(outline, 'Scarp Outline provider must return document symbols');
  assert.deepEqual(outline.map(symbol => symbol.name), ['linear', 'base', 'compute']);
  assert.deepEqual(outline.map(symbol => symbol.kind), [
    vscode.SymbolKind.Namespace, vscode.SymbolKind.Constant, vscode.SymbolKind.Function
  ]);
  assert.equal(outline[2].selectionRange.start.line, 2);
  assert.equal(outline[2].range.end.line, 7);

  const settings = vscode.workspace.getConfiguration('scarp');
  const previous = settings.inspect<string>('compilerPath')?.globalValue;
  const previousVerifyOnSave = settings.inspect<boolean>('verifyOnSave')?.globalValue;
  await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
  try {
    // End-to-end integration with the official alpha.4 Scarp project workflow.
    const projectParent = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-vscode-project-'));
    const projectPath = path.join(projectParent, 'project with spaces');
    const projectUri = vscode.Uri.file(projectPath);
    try {
      await promisify(execFile)(binary, ['create', '--', projectPath], { timeout: 10000 });
      const manifest = await fs.readFile(path.join(projectPath, 'Scarp.project'), 'utf8');
      assert.match(manifest, /scarp-project: 1/);
      const entryUri = vscode.Uri.file(path.join(projectPath, 'src', 'main.srp'));
      const entryDocument = await vscode.workspace.openTextDocument(entryUri);
      await vscode.commands.executeCommand('scarp.verifyProject', projectUri);
      assert.equal(vscode.languages.getDiagnostics(entryUri).length, 0,
        'Valid Scarp project must pass static verification');

      // Alpha.5 exposes project-scoped, non-executing module graph inspection.
      // This tests the actual released compiler contract, not an invented UI.
      const inspected = await promisify(execFile)(
        binary, ['inspect', 'modules', '--json', '--', projectPath],
        { timeout: 10000, maxBuffer: 1024 * 1024 }
      );
      const graph = JSON.parse(inspected.stdout) as {
        schema_version: number;
        entry: number;
        modules: Array<{ id: number; path: string }>;
      };
      assert.equal(graph.schema_version, 1);
      assert.equal(graph.entry, 0);
      const browsable = parseBrowsableProjectModules(inspected.stdout,
        await fs.realpath(projectPath));
      assert.ok(browsable.length >= 1 && browsable[0].isEntry);
      assert.equal(browsable[0].filename, await fs.realpath(entryUri.fsPath));

      // Regression: module browsing must discard an otherwise valid inventory
      // if a separate on-disk .srp changes during the compiler inspection.
      // The CLI wrapper delegates all commands to the real official compiler,
      // but holds the module JSON long enough for an external source rewrite.
      const moduleMarker = path.join(projectParent, 'module-inspect-started');
      const delayedModuleCompiler = path.join(projectParent, 'delayed-module-scarp');
      const delayedModuleScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const { spawnSync } = require("node:child_process");',
        'const argv = process.argv.slice(2);',
        'const result = spawnSync(' + JSON.stringify(binary) + ', argv,',
        '  { cwd: process.cwd(), encoding: "utf8", timeout: 12000 });',
        'if (result.error) { console.error(result.error); process.exit(1); }',
        'if (argv[0] === "inspect" && argv[1] === "modules") {',
        '  fs.writeFileSync(' + JSON.stringify(moduleMarker) + ', "started");',
        '  setTimeout(() => {',
        '    process.stdout.write(result.stdout || "");',
        '    process.stderr.write(result.stderr || "");',
        '    process.exitCode = result.status ?? 1;',
        '  }, 500);',
        '} else {',
        '  process.stdout.write(result.stdout || "");',
        '  process.stderr.write(result.stderr || "");',
        '  process.exitCode = result.status ?? 1;',
        '}'
      ].join('\n');
      await fs.writeFile(delayedModuleCompiler, delayedModuleScript, { mode: 0o755 });
      await fs.chmod(delayedModuleCompiler, 0o755);
      await settings.update('compilerPath', delayedModuleCompiler,
        vscode.ConfigurationTarget.Global);
      try {
        const extraSource = path.join(projectPath, 'external-module-test.srp');
        await fs.writeFile(extraSource, 'pub bind answer = 1;\n');
        const pending = vscode.commands.executeCommand(
          'scarp.browseProjectModules', projectUri);
        await waitFor(() => fsSync.existsSync(moduleMarker) ? true : undefined,
          'Delayed compiler module inspection did not begin');
        await fs.writeFile(extraSource, 'pub bind answer = 2;\n');
        let deadline: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error(
                'Stale module inventory unexpectedly opened a Quick Pick')), 5000);
            })
          ]);
        } finally {
          if (deadline) { clearTimeout(deadline); }
        }
      } finally {
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }

      // v0.0.6-alpha.1 provides a real cross-file symbol index. Exercise
      // Go to Definition and References through VS Code, not a mock server.
      const navigationUri = vscode.Uri.file(path.join(projectPath, 'navigation.srp'));
      await fs.writeFile(navigationUri.fsPath, 'bind answer = 41;\nprint(answer + 1);\n');
      const navigationDoc = await vscode.workspace.openTextDocument(navigationUri);
      await vscode.window.showTextDocument(navigationDoc);
      const rawSymbols = await promisify(execFile)(
        binary, ['inspect', 'symbols', '--json', '--', navigationUri.fsPath],
        { timeout: 10000, maxBuffer: 1024 * 1024 }
      );
      const symbolInventory = parseProjectSymbols(
        rawSymbols.stdout, await fs.realpath(projectPath));
      assert.ok(symbolInventory.symbols.some(symbol =>
        symbol.kind === 'binding' && symbol.name === 'answer' && symbol.location),
      'Published Scarp alpha.1 must return concrete symbol locations');
      const usePosition = new vscode.Position(1, 8);
      const definition = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider', navigationUri, usePosition);
      assert.ok(definition?.some(item => item.uri.fsPath === navigationUri.fsPath &&
        item.range.start.line === 0 && item.range.start.character === 5),
      'Compiler navigation should resolve the actual Scarp binding');
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', navigationUri, usePosition);
      assert.ok(references?.some(item => item.uri.fsPath === navigationUri.fsPath &&
        item.range.start.line === 1 && item.range.start.character === 6),
      'Compiler references should include the source use site');
      assert.ok(graph.modules.length >= 1 && graph.modules[0].id === 0,
        'Official compiler alpha.5 must inspect a project directory');

      // Navigation must reject a compiler index if a different on-disk source
      // changes before the CLI responds. That file is never opened in VS Code.
      const navRoot = path.join(projectParent, 'standalone navigation');
      await fs.mkdir(navRoot);
      const navSource = path.join(navRoot, 'main.srp');
      const navImport = path.join(navRoot, 'lib.srp');
      await fs.writeFile(navSource, 'bind item = 1;\nprint(item);\n');
      await fs.writeFile(navImport, 'pub bind answer = 1;\n');
      const navUri = vscode.Uri.file(navSource);
      await vscode.workspace.openTextDocument(navUri);
      const navMarker = path.join(projectParent, 'navigation-inspection-started');
      const navCompiler = path.join(projectParent, 'delayed-navigation');
      const declaration = {
        source: 0, span: [5, 9],
        start: { line: 1, column: 6 }, end: { line: 1, column: 10 }
      };
      const reference = {
        source: 0, span: [21, 25],
        start: { line: 2, column: 7 }, end: { line: 2, column: 11 }
      };
      const navIndex = {
        schema_version: 1, kind: 'scarp.references',
        span_encoding: 'utf-8-bytes',
        column_encoding: 'unicode-scalar', position_base: 1,
        files: [{ id: 0, path: navSource }],
        symbols: [{ id: 0, name: 'item', kind: 'binding', owner: null,
          public: false, mutable: false, target_module: null,
          location: declaration }],
        references: [{ target: 0, kind: 'read', location: reference }]
      };
      const navScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const argv = process.argv.slice(2);',
        'if (argv[0] !== "inspect" || argv[1] !== "references") process.exit(2);',
        'fs.writeFileSync(' + JSON.stringify(navMarker) + ', "started");',
        'setTimeout(() => { process.stdout.write(' +
          JSON.stringify(JSON.stringify(navIndex)) + '); }, 350);'
      ].join('\n');
      await fs.writeFile(navCompiler, navScript, { mode: 0o755 });
      await fs.chmod(navCompiler, 0o755);
      await settings.update('compilerPath', navCompiler, vscode.ConfigurationTarget.Global);
      try {
        const currentNavigation = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', navUri, new vscode.Position(1, 8));
        assert.ok(currentNavigation?.some(item =>
          item.uri.fsPath === navSource && item.range.start.line === 0 &&
          item.range.start.character === 5),
        'Unchanged standalone source should resolve compiler navigation');

        await fs.rm(navMarker);
        const pendingNavigation = vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', navUri, new vscode.Position(1, 8));
        await waitFor(() => fsSync.existsSync(navMarker) ? true : undefined,
          'Delayed navigation inspection did not start');
        await fs.writeFile(navImport, 'pub bind answer = 2;\n');
        const staleNavigation = await pendingNavigation;
        assert.equal(staleNavigation?.length ?? 0, 0,
          'External rewrite of another source must suppress stale definition results');
      } finally {
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }
      const projectTerminalOpened = new Promise<vscode.Terminal>((resolve, reject) => {
        const timer = setTimeout(() => {
          disposable.dispose();
          reject(new Error('Scarp project launch did not open a terminal'));
        }, 10000);
        const disposable = vscode.window.onDidOpenTerminal(terminal => {
          if (!terminal.name.startsWith('Scarp Project:')) { return; }
          clearTimeout(timer);
          disposable.dispose();
          resolve(terminal);
        });
      });
      // The compiler probe yields; a second Launch must not bypass the guard.
      const projectTerminals: vscode.Terminal[] = [];
      const projectObserver = vscode.window.onDidOpenTerminal(terminal => {
        if (terminal.name === 'Scarp Project: project with spaces') {
          projectTerminals.push(terminal);
        }
      });
      try {
        await Promise.all([
          vscode.commands.executeCommand('scarp.launchProject', projectUri),
          vscode.commands.executeCommand('scarp.launchProject', projectUri)
        ]);
        const projectTerminal = await projectTerminalOpened;
        assert.equal(projectTerminal.name, 'Scarp Project: project with spaces');
        assert.equal(projectTerminals.length, 1,
          'Concurrent project launches must open only one terminal');
        await vscode.commands.executeCommand('scarp.stopProgram');
        await waitFor(() => vscode.window.terminals.includes(projectTerminal) ? undefined : true,
          'Stop command must terminate the project terminal');
      } finally {
        projectObserver.dispose();
      }

      const broken = new vscode.WorkspaceEdit();
      broken.replace(entryUri, new vscode.Range(
        0, 0, 0, entryDocument.lineAt(0).text.length
      ), 'print("missing semicolon")');
      assert.ok(await vscode.workspace.applyEdit(broken));
      assert.ok(await entryDocument.save());
      await vscode.commands.executeCommand('scarp.verifyProject', projectUri);
      assert.ok(vscode.languages.getDiagnostics(entryUri).some(
        diagnostic => diagnostic.source === 'Scarp'
          && diagnostic.severity === vscode.DiagnosticSeverity.Error
      ), 'Invalid Scarp project entrypoint must report real compiler Problems');

      // A source created directly on disk *after* verification must invalidate
      // previously published Problems. The file was never opened by VS Code.
      const watchedExternal = path.join(projectPath, 'src', 'watched-external.srp');
      await fs.writeFile(watchedExternal, 'print("new source");\n');
      await waitFor(() => vscode.languages.getDiagnostics(entryUri).length === 0
        ? true : undefined, 'External file creation did not clear stale project Problems');
      // A new manual verification restores the broken entrypoint's real error.
      await vscode.commands.executeCommand('scarp.verifyProject', projectUri);
      assert.ok(vscode.languages.getDiagnostics(entryUri).some(d => d.source === 'Scarp'),
        'Reverification must repopulate project Problems');

      // Manual reconciliation uses the same bounded snapshot comparison as
      // focus return. It must never execute source or modify the project.
      await fs.writeFile(watchedExternal, 'print("modified outside VS Code");\n');
      await vscode.commands.executeCommand('scarp.reconcileProjects');
      await waitFor(() => vscode.languages.getDiagnostics(entryUri).length === 0
        ? true : undefined, 'Manual reconciliation did not invalidate changed project Problems');
      await vscode.commands.executeCommand('scarp.verifyProject', projectUri);
      assert.ok(vscode.languages.getDiagnostics(entryUri).some(d => d.source === 'Scarp'),
        'Manual project re-verification must recover the compiler diagnostics');

      // Editing a previously clean file must clear old project-level Problems
      // even when the compiler error was located in a different source file.
      const cleanUri = vscode.Uri.file(path.join(projectPath, 'src', 'unrelated.srp'));
      await fs.writeFile(cleanUri.fsPath, '// clean module\n');
      const cleanDocument = await vscode.workspace.openTextDocument(cleanUri);
      const cleanEdit = new vscode.WorkspaceEdit();
      cleanEdit.insert(cleanUri, new vscode.Position(0, 0), '// edited in VS Code\n');
      assert.ok(await vscode.workspace.applyEdit(cleanEdit));
      assert.ok(await cleanDocument.save());
      assert.equal(vscode.languages.getDiagnostics(entryUri).length, 0,
        'Editing a clean project file must invalidate its previous project Problems');

      // A delayed verification must not publish errors from an older source
      // snapshot (the compiler reads disk while VS Code edits continue).
      const repaired = new vscode.WorkspaceEdit();
      repaired.replace(entryUri, new vscode.Range(
        entryDocument.positionAt(0), entryDocument.positionAt(entryDocument.getText().length)
      ), 'print("Hello from Scarp!");\n');
      assert.ok(await vscode.workspace.applyEdit(repaired));
      assert.ok(await entryDocument.save());
      assert.equal(vscode.languages.getDiagnostics(entryUri).length, 0,
        'Editing the source should invalidate previous project diagnostics');

      const started = path.join(projectParent, 'slow-verify-started');
      const delayedBinary = path.join(projectParent, 'slow-scarp');
      const staleDiagnostic = {
        schema_version: 1, severity: 'error', code: 'E0004',
        message: 'stale verification error',
        primary: {
          path: entryUri.fsPath,
          start: { line: 1, column: 1 }, end: { line: 1, column: 2 }
        },
        help: null
      };
      const delayedScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const argv = process.argv.slice(2);',
        'if (argv[0] === "--version") {',
        '  process.stdout.write("scarp 0.0.5-alpha.4\\n");',
        '  process.exit(0);',
        '}',
        'if (argv[0] === "diagnose") {',
        '  process.stdout.write(JSON.stringify({schema_version:1, version:"0.0.5-alpha.4",',
        '    execution:"interpreter", static_verify:true, project_workflow:true}));',
        '  process.exit(0);',
        '}',
        'if (argv[0] === "verify") {',
        '  fs.writeFileSync(' + JSON.stringify(started) + ', "started");',
        '  setTimeout(() => {',
        '    process.stderr.write(' + JSON.stringify(JSON.stringify(staleDiagnostic)) + ');',
        '    process.exitCode = 1;',
        '  }, 450);',
        '} else { process.exit(2); }'
      ].join('\n');
      await fs.writeFile(delayedBinary, delayedScript, { mode: 0o755 });
      await fs.chmod(delayedBinary, 0o755);
      await settings.update('compilerPath', delayedBinary, vscode.ConfigurationTarget.Global);
      try {
        const staleSourceCheck = vscode.commands.executeCommand('scarp.verifyProject', projectUri);
        await waitFor(() => fsSync.existsSync(started) ? true : undefined,
          'Delayed project verification did not start');
        const changedSource = new vscode.WorkspaceEdit();
        changedSource.insert(entryUri, new vscode.Position(0, 0), '// changed in editor\n');
        assert.ok(await vscode.workspace.applyEdit(changedSource));
        assert.ok(await entryDocument.save());
        await staleSourceCheck;
        assert.ok(!vscode.languages.getDiagnostics(entryUri).some(
          diagnostic => diagnostic.message.includes('stale verification error')
        ), 'A source edit must suppress outdated compiler diagnostics');

        await fs.rm(started);
        const staleManifestCheck = vscode.commands.executeCommand('scarp.verifyProject', projectUri);
        await waitFor(() => fsSync.existsSync(started) ? true : undefined,
          'Delayed manifest verification did not start');
        const manifestUri = vscode.Uri.file(path.join(projectPath, 'Scarp.project'));
        const manifestDocument = await vscode.workspace.openTextDocument(manifestUri);
        const changedManifest = new vscode.WorkspaceEdit();
        changedManifest.insert(manifestUri,
          manifestDocument.positionAt(manifestDocument.getText().length), '\n');
        assert.ok(await vscode.workspace.applyEdit(changedManifest));
        assert.ok(await manifestDocument.save());
        await staleManifestCheck;
        assert.ok(!vscode.languages.getDiagnostics(entryUri).some(
          diagnostic => diagnostic.message.includes('stale verification error')
        ), 'A manifest edit must suppress outdated compiler diagnostics');

        // An external tool can create or rewrite source files without opening
        // them in VS Code. The disk snapshot must reject that stale run too.
        await fs.rm(started);
        const diskCheck = vscode.commands.executeCommand('scarp.verifyProject', projectUri);
        await waitFor(() => fsSync.existsSync(started) ? true : undefined,
          'Delayed external-disk verification did not start');
        const externalUri = path.join(projectPath, 'src', 'added-externally.srp');
        await fs.writeFile(externalUri, 'print("external source");\n');
        await diskCheck;
        assert.ok(!vscode.languages.getDiagnostics(entryUri).some(
          diagnostic => diagnostic.message.includes('stale verification error')
        ), 'External disk creation must suppress outdated project diagnostics');

        await fs.rm(started);
        const rewriteCheck = vscode.commands.executeCommand('scarp.verifyProject', projectUri);
        await waitFor(() => fsSync.existsSync(started) ? true : undefined,
          'Delayed external source rewrite verification did not start');
        await fs.writeFile(externalUri, 'print("changed externally after snapshot");\n');
        await rewriteCheck;
        assert.ok(!vscode.languages.getDiagnostics(entryUri).some(
          diagnostic => diagnostic.message.includes('stale verification error')
        ), 'External disk rewrites must suppress outdated project diagnostics');
      } finally {
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }
    } finally {
      await fs.rm(projectParent, { recursive: true, force: true });
    }

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
    const fileTerminals: vscode.Terminal[] = [];
    const fileObserver = vscode.window.onDidOpenTerminal(terminal => {
      if (terminal.name === 'Scarp: hello.srp') { fileTerminals.push(terminal); }
    });
    try {
      await Promise.all([
        vscode.commands.executeCommand('scarp.runFile'),
        vscode.commands.executeCommand('scarp.runFile')
      ]);
      const terminal = await opened;
      assert.match(terminal.name, /^Scarp: hello\.srp$/);
      assert.equal(fileTerminals.length, 1,
        'Concurrent file runs must open only one terminal');
      await vscode.commands.executeCommand('scarp.stopProgram');
      await waitFor(() => vscode.window.terminals.includes(terminal) ? undefined : true,
        'Stop command did not close the Scarp terminal');
    } finally {
      fileObserver.dispose();
    }

    // Stop must cancel an in-flight compiler probe, not allow a late terminal.
    const slowRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-vscode-start-'));
    const slowBinary = path.join(slowRoot, 'slow-version-scarp');
    const versionMarker = path.join(slowRoot, 'version-started');
    const unexpectedRun = path.join(slowRoot, 'unexpected-run');
    const slowScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") {',
      '  fs.writeFileSync(' + JSON.stringify(versionMarker) + ', "started");',
      '  setTimeout(() => process.stdout.write("scarp 0.0.6-alpha.1\\n"), 650);',
      '} else {',
      '  fs.writeFileSync(' + JSON.stringify(unexpectedRun) + ', args.join(" "));',
      '  process.exitCode = 1;',
      '}'
    ].join('\n');
    const cancelledTerminals: vscode.Terminal[] = [];
    const pendingObserver = vscode.window.onDidOpenTerminal(terminal => {
      if (terminal.name === 'Scarp: hello.srp') { cancelledTerminals.push(terminal); }
    });
    try {
      await fs.writeFile(slowBinary, slowScript, { mode: 0o755 });
      await fs.chmod(slowBinary, 0o755);
      await settings.update('compilerPath', slowBinary, vscode.ConfigurationTarget.Global);
      const pendingRun = vscode.commands.executeCommand('scarp.runFile');
      await waitFor(() => fsSync.existsSync(versionMarker) ? true : undefined,
        'Delayed compiler version probe did not begin');
      await vscode.commands.executeCommand('scarp.stopProgram');
      await pendingRun;
      assert.equal(cancelledTerminals.length, 0,
        'Stop during startup must prevent a late Run terminal');
      assert.equal(fsSync.existsSync(unexpectedRun), false,
        'Cancelled startup must not execute the source file');
    } finally {
      pendingObserver.dispose();
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await fs.rm(slowRoot, { recursive: true, force: true });
    }

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
      const helpProbe = path.join(tempDir, 'static-verify-probed');
      const executed = path.join(tempDir, 'legacy-check-executed');
      const legacyScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") {',
        '  fs.writeFileSync(' + JSON.stringify(probe) + ', "probed");',
        '  console.log("scarp 0.0.4"); process.exit(0);',
        '}',
        'if (args[0] === "verify") {',
        '  fs.writeFileSync(' + JSON.stringify(helpProbe) + ', "probed");',
        '  process.exit(2);',
        '}',
        'if (args[0] === "check") {',
        '  fs.writeFileSync(' + JSON.stringify(executed) + ', "executed");',
        '  process.exit(0);',
        '}',
        'process.exit(2);'
      ].join('\n');
      await fs.writeFile(legacyBinary, legacyScript, { mode: 0o755 });
      await fs.chmod(legacyBinary, 0o755);
      await settings.update('compilerPath', legacyBinary, vscode.ConfigurationTarget.Global);
      const legacyEdit = new vscode.WorkspaceEdit();
      legacyEdit.insert(autoUri, new vscode.Position(0, 0), '// another save\n');
      assert.ok(await vscode.workspace.applyEdit(legacyEdit));
      assert.ok(await autoDocument.save(), 'Legacy source save should succeed');
      await waitFor(() => fsSync.existsSync(probe) ? true : undefined,
        'Automatic save verification did not probe the legacy compiler');
      await waitFor(() => fsSync.existsSync(helpProbe) ? true : undefined,
        'Automatic save verification did not probe static capability');
      // Allow a command spawned after capability detection to become visible.
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
