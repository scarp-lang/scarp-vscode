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

        // A compiler-path switch while navigation runs must cancel the old
        // subprocess and discard its index for both navigation entry points.
        for (const command of ['vscode.executeDefinitionProvider',
          'vscode.executeReferenceProvider']) {
          await fs.rm(navMarker);
          await settings.update('compilerPath', navCompiler,
            vscode.ConfigurationTarget.Global);
          const pending = vscode.commands.executeCommand<vscode.Location[]>(
            command, navUri, new vscode.Position(1, 8));
          await waitFor(() => fsSync.existsSync(navMarker) ? true : undefined,
            'Delayed navigation did not begin before the compiler-path change');
          await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
          const stale = await pending;
          assert.equal(stale?.length ?? 0, 0,
            command + ' must not publish references from a previous compiler');
        }
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

        // A compiler-path change during a delayed project verification must
        // invalidate its old result, even if none of the source files changed.
        await fs.rm(started);
        const switchedCompilerCheck = vscode.commands.executeCommand(
          'scarp.verifyProject', projectUri);
        await waitFor(() => fsSync.existsSync(started) ? true : undefined,
          'Compiler-switch project verification did not start');
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
        await switchedCompilerCheck;
        assert.ok(!vscode.languages.getDiagnostics(entryUri).some(
          diagnostic => diagnostic.message.includes('stale verification error')
        ), 'Project checks must discard results from the previous compiler');
      } finally {
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }
    } finally {
      await fs.rm(projectParent, { recursive: true, force: true });
    }

    // End-to-end: the published compiler reports a syntax error in an
    // imported source, and the extension must attach that error to the
    // imported file (not to the active entrypoint).
    const importParent = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-vscode-import-'));
    const importRoot = path.join(importParent, 'source files with spaces');
    const entryWithSpaces = vscode.Uri.file(path.join(importRoot, 'entry with spaces.srp'));
    const importedWithSpaces = vscode.Uri.file(path.join(importRoot, 'library with spaces.srp'));
    try {
      await fs.mkdir(importRoot);
      await fs.writeFile(entryWithSpaces.fsPath,
        'import "library with spaces.srp" as library;\nprint(library.answer);\n');
      await fs.writeFile(importedWithSpaces.fsPath, 'pub bind answer = ;\n');
      const importedEntry = await vscode.workspace.openTextDocument(entryWithSpaces);
      assert.equal(importedEntry.languageId, 'scarp');
      await vscode.window.showTextDocument(importedEntry);
      await vscode.commands.executeCommand('scarp.checkFile');
      const importedErrors = vscode.languages.getDiagnostics(importedWithSpaces);
      assert.ok(importedErrors.some(item =>
        item.source === 'Scarp' && item.severity === vscode.DiagnosticSeverity.Error),
      'The official compiler error must appear on the imported source in Problems');
      assert.equal(vscode.languages.getDiagnostics(entryWithSpaces).length, 0,
        'An imported-source error must not be misattributed to the entrypoint');

      // Missing compiler must never launch a terminal or overwrite the
      // most recent valid compiler diagnostics with invented success.
      const missingPath = path.join(importRoot, 'no-such-compiler');
      await settings.update('compilerPath', missingPath, vscode.ConfigurationTarget.Global);
      try {
        const beforeTerminals = vscode.window.terminals.length;
        await vscode.commands.executeCommand('scarp.checkFile');
        await vscode.commands.executeCommand('scarp.runFile');
        assert.equal(vscode.window.terminals.length, beforeTerminals,
          'Missing compiler must not launch a terminal');
        assert.deepEqual(vscode.languages.getDiagnostics(importedWithSpaces),
          importedErrors, 'Missing compiler must preserve last verified Problems');
      } finally {
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }

      // Repair the library, re-check through the real compiler, and ensure
      // previously owned imported Problems are removed.
      await fs.writeFile(importedWithSpaces.fsPath, 'pub bind answer = 42;\n');
      await vscode.window.showTextDocument(importedEntry);
      await vscode.commands.executeCommand('scarp.checkFile');
      assert.equal(vscode.languages.getDiagnostics(importedWithSpaces).length, 0,
        'Rechecking repaired imports must clear stale imported-file Problems');

      // Run a standalone file whose source *and imported module* paths contain
      // spaces; the command must supply an argv array, not shell interpolation.
      const startedInSpaces = new Promise<vscode.Terminal>((resolve, reject) => {
        const timer = setTimeout(() => {
          listener.dispose();
          reject(new Error('No Scarp terminal opened for a path with spaces'));
        }, 6000);
        const listener = vscode.window.onDidOpenTerminal(terminal => {
          if (terminal.name !== 'Scarp: entry with spaces.srp') { return; }
          clearTimeout(timer);
          listener.dispose();
          resolve(terminal);
        });
      });
      await vscode.commands.executeCommand('scarp.runFile');
      const spacedTerminal = await startedInSpaces;
      const options = spacedTerminal.creationOptions as vscode.TerminalOptions;
      assert.equal(options.shellPath, binary,
        'Scarp must launch the official compiler directly');
      const args = options.shellArgs;
      assert.ok(Array.isArray(args), 'Scarp must pass shell arguments as an argv array');
      assert.equal(args.at(-2), '--');
      assert.equal(args.at(-1), entryWithSpaces.fsPath);
      assert.equal(options.cwd, importRoot);
      await vscode.commands.executeCommand('scarp.stopProgram');
      await waitFor(() => vscode.window.terminals.includes(spacedTerminal) ? undefined : true,
        'Stop command did not close a source terminal with spaces');
    } finally {
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await fs.rm(importParent, { recursive: true, force: true });
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
    const unexpectedCheck = path.join(slowRoot, 'unexpected-check');
    const slowScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") {',
      '  fs.writeFileSync(' + JSON.stringify(versionMarker) + ', "started");',
      '  setTimeout(() => process.stdout.write("scarp 0.0.6-alpha.1\\n"), 650);',
      '} else if (["exec", "run", "launch"].includes(args[0])) {',
      '  fs.writeFileSync(' + JSON.stringify(unexpectedRun) + ', args.join(" "));',
      '  process.exitCode = 1;',
      '} else if (["verify", "check"].includes(args[0])) {',
      '  fs.writeFileSync(' + JSON.stringify(unexpectedCheck) + ', args.join(" "));',
      '  process.exitCode = 1;',
      '} else { process.exitCode = 1; }'
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

      // A compiler setting change must also cancel a pending Run, without
      // requiring Stop or letting the previous binary open a late terminal.
      await fs.rm(versionMarker);
      const switchedRun = vscode.commands.executeCommand('scarp.runFile');
      await waitFor(() => fsSync.existsSync(versionMarker) ? true : undefined,
        'Compiler-switch Run did not start probing the previous executable');
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await switchedRun;
      assert.equal(cancelledTerminals.length, 0,
        'Changing the compiler must prevent stale Run terminal startup');
      assert.equal(fsSync.existsSync(unexpectedRun), false,
        'The previous compiler must not execute the file after a setting change');

      // An old in-flight file verification must stop after its version probe,
      // not continue into the old compiler's verify/check action.
      await fs.rm(versionMarker);
      await settings.update('compilerPath', slowBinary, vscode.ConfigurationTarget.Global);
      const switchedCheck = vscode.commands.executeCommand('scarp.checkFile');
      await waitFor(() => fsSync.existsSync(versionMarker) ? true : undefined,
        'Compiler-switch file verification did not start probing');
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await switchedCheck;
      assert.equal(fsSync.existsSync(unexpectedCheck), false,
        'Stale verification must not proceed to the previous compiler');
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

      // With the *published* compiler, make rapid successive edits and saves.
      // The final saved file is invalid; only the newest version may populate
      // Problems, without opening a terminal or running program statements.
      for (const source of [
        'print("intermediate repair");\\n',
        'print("newest source is missing its semicolon")\\n'
      ]) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(autoUri, new vscode.Range(autoDocument.positionAt(0),
          autoDocument.positionAt(autoDocument.getText().length)), source);
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.ok(await autoDocument.save(), 'Rapid consecutive save must succeed');
      }
      await waitFor(() => vscode.languages.getDiagnostics(autoUri).some(
        item => item.source === 'Scarp' &&
          item.severity === vscode.DiagnosticSeverity.Error) ? true : undefined,
      'Latest rapidly saved file did not receive real compiler Problems');
      assert.equal(vscode.window.terminals.length, terminalsBeforeSave,
        'Rapid static checks must never launch a terminal');

      // End-to-end regression for the save queue: while an existing static
      // verify is blocked, save #2 expires into a rerun, then save #3 arrives
      // with a fresh debounce timer. Completing #1 must not reschedule #2
      // and cancel the newer #3 timer. The real VS Code save notification,
      // compiler process runner and diagnostic collection are all exercised.
      const raceUri = vscode.Uri.file(path.join(tempDir, 'save-race.srp'));
      const raceBinary = path.join(tempDir, 'save-race-compiler');
      const raceStarted = path.join(tempDir, 'save-race-started');
      const raceReleased = path.join(tempDir, 'save-race-released');
      const raceLog = path.join(tempDir, 'save-race-log');
      const latestError = {
        schema_version: 1, severity: 'error', code: 'E0004',
        message: 'newest saved source verified',
        primary: {
          path: raceUri.fsPath,
          start: { line: 2, column: 1 }, end: { line: 2, column: 2 }
        }, help: null
      };
      const raceScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'if (args[0] === "--version") {',
        '  console.log("scarp 0.0.6-alpha.1"); process.exit(0);',
        '}',
        'if (args[0] === "verify" && args[1] === "--help") {',
        '  console.log("Usage: scarp verify [OPTIONS]"); process.exit(0);',
        '}',
        'if (args[0] !== "verify") { process.exit(2); }',
        'const filename = args[args.length - 1];',
        'const content = fs.readFileSync(filename, "utf8");',
        'const stage = content.includes("stage-one") ? "one" :',
        '  content.includes("stage-two") ? "two" : "three";',
        'fs.appendFileSync(' + JSON.stringify(raceLog) + ', stage + "\n");',
        'if (stage === "one") {',
        '  fs.writeFileSync(' + JSON.stringify(raceStarted) + ', "ready");',
        '  const gate = setInterval(() => {',
        '    if (fs.existsSync(' + JSON.stringify(raceReleased) + ')) {',
        '      clearInterval(gate); process.exit(0);',
        '    }',
        '  }, 20);',
        '} else if (stage === "three") {',
        '  process.stderr.write(' + JSON.stringify(JSON.stringify(latestError)) + ');',
        '  process.exitCode = 1;',
        '}'
      ].join('\n');
      await fs.writeFile(raceBinary, raceScript, { mode: 0o755 });
      await fs.chmod(raceBinary, 0o755);
      await fs.writeFile(raceUri.fsPath, 'print("initial");\n');
      const raceDocument = await vscode.workspace.openTextDocument(raceUri);
      assert.equal(raceDocument.languageId, 'scarp');
      await vscode.window.showTextDocument(raceDocument);
      const saveRaceStage = async (stage: string): Promise<void> => {
        const replacement = new vscode.WorkspaceEdit();
        replacement.replace(raceUri, new vscode.Range(
          raceDocument.positionAt(0),
          raceDocument.positionAt(raceDocument.getText().length)
        ), '// stage-' + stage + '\nprint("source");\n');
        assert.ok(await vscode.workspace.applyEdit(replacement));
        assert.ok(await raceDocument.save(), 'Save ' + stage + ' should succeed');
      };
      await settings.update('compilerPath', raceBinary, vscode.ConfigurationTarget.Global);
      try {
        await saveRaceStage('one');
        await waitFor(() => fsSync.existsSync(raceStarted) ? true : undefined,
          'Blocked first static verification did not start');
        await saveRaceStage('two');
        // Save #2 must finish its 300-ms debounce *before* save #3 arrives.
        await new Promise(resolve => setTimeout(resolve, 450));
        await saveRaceStage('three');
        // Let the first CLI exit before save #3's timer expires.
        await fs.writeFile(raceReleased, 'go');
        await waitFor(() => vscode.languages.getDiagnostics(raceUri).some(
          item => item.source === 'Scarp' &&
            item.message.includes('newest saved source verified')) ? true : undefined,
        'Newest save was not verified after the older check completed');
        const stages = (await fs.readFile(raceLog, 'utf8')).trim().split(/\r?\n/);
        assert.deepEqual(stages, ['one', 'three'],
          'Older queued save must not supersede the newest VS Code save');
      } finally {
        await fs.writeFile(raceReleased, 'go');
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }

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
