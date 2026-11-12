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

  // Prove actual editor command behavior, not just language-configuration JSON.
  // VS Code's default Ctrl+/ (Cmd+/ on macOS) invokes this built-in command.
  const commentDoc = await vscode.workspace.openTextDocument({
    language: 'scarp',
    content: 'bind answer = 7;\n'
  });
  const commentEditor = await vscode.window.showTextDocument(commentDoc, {
    preview: false, preserveFocus: false
  });
  commentEditor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('editor.action.commentLine');
  assert.match(commentDoc.getText(), /^\/\/\s*bind answer = 7;\n$/,
    'Toggle Line Comment must insert the official Scarp // syntax');
  await vscode.commands.executeCommand('editor.action.commentLine');
  assert.equal(commentDoc.getText(), 'bind answer = 7;\n',
    'Toggling line comment twice must restore the original Scarp source');

  // CodeLens stays opt-in, local-only and non-executing until the user
  // selects a command. VS Code must preserve each lens's file URI.
  const lensDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-code-lens-'));
  const lensUri = vscode.Uri.file(path.join(lensDir, 'source with spaces.srp'));
  await fs.writeFile(lensUri.fsPath, 'bind answer = 7;\n');
  const lensDoc = await vscode.workspace.openTextDocument(lensUri);
  const lensConfig = vscode.workspace.getConfiguration('scarp', lensUri);
  const priorLenses = lensConfig.inspect<boolean>('showFileActionsCodeLens')?.globalValue;
  try {
    await lensConfig.update('showFileActionsCodeLens', false,
      vscode.ConfigurationTarget.Global);
    const hidden = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', lensDoc.uri, 10);
    assert.equal(hidden?.length ?? 0, 0,
      'Opt-out must avoid cluttering a Scarp document with file actions');

    await lensConfig.update('showFileActionsCodeLens', true,
      vscode.ConfigurationTarget.Global);
    const visible = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', lensDoc.uri, 10);
    assert.deepEqual(visible?.map(lens => lens.command?.command),
      ['scarp.runFile', 'scarp.checkFile']);
    for (const lens of visible ?? []) {
      assert.equal(lens.range.start.line, 0);
      assert.equal(lens.command?.arguments?.length, 1);
      assert.equal((lens.command?.arguments?.[0] as vscode.Uri).toString(),
        lensUri.toString(), 'Each file action must target its own source URI');
    }
  } finally {
    await lensConfig.update('showFileActionsCodeLens', priorLenses,
      vscode.ConfigurationTarget.Global);
    await fs.rm(lensDir, { recursive: true, force: true });
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

  // Real VS Code hover API: pure source help, no compiler process and no
  // suggestion that the extension implements scientific operations itself.
  const hoverDoc = await vscode.workspace.openTextDocument({
    language: 'scarp',
    content: [
      'bind chosen = top_p([0.5, 0.5], 0.9);',
      '// pearson_correlation(x, y)',
      'print("top_p([1.0], 1.0)");',
      'bind rho = pearson_correlation([1.0,2.0], [2.0,3.0]);'
    ].join('\n')
  });
  const hoverResults = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', hoverDoc.uri, new vscode.Position(0, 16));
  assert.ok(hoverResults?.length, 'Scarp builtin help must be registered');
  const helpText = hoverResults.flatMap(item => item.contents)
    .map(item => typeof item === 'string' ? item : item.value).join('\n');
  assert.match(helpText, /top_p\(probabilities: vector, mass: float\)/);
  assert.match(helpText, /v0\.0\.6-alpha\.5/);
  assert.equal(hoverResults[0].range?.start.character, 14);
  for (const position of [new vscode.Position(1, 8), new vscode.Position(2, 10)]) {
    const noHover = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', hoverDoc.uri, position);
    assert.ok(!noHover?.some(item => item.contents.some(value =>
      (typeof value === 'string' ? value : value.value).includes('top_p(probabilities:'))),
    'Comments and strings must not present builtin help');
  }

  // Signature Help is a live VS Code provider (not an internal test-only
  // helper). It tracks nested calls and selects the correct active argument.
  const signatureSource = 'bind scores = top_p(softmax_temp([0.2, 0.8], 0.5), 0.9);';
  const signatureDoc = await vscode.workspace.openTextDocument({
    language: 'scarp', content: signatureSource
  });
  const innerPosition = signatureSource.indexOf(', 0.5') + 1;
  const innerHint = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    'vscode.executeSignatureHelpProvider', signatureDoc.uri,
    new vscode.Position(0, innerPosition), ',');
  assert.ok(innerHint?.signatures.length, 'Scarp signature help must be registered');
  assert.match(innerHint.signatures[0].label, /^softmax_temp\(/);
  assert.equal(innerHint.activeParameter, 1);
  const outerPosition = signatureSource.indexOf(', 0.9') + 1;
  const outerHint = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    'vscode.executeSignatureHelpProvider', signatureDoc.uri,
    new vscode.Position(0, outerPosition), ',');
  assert.ok(outerHint?.signatures.length);
  assert.match(outerHint.signatures[0].label, /^top_p\(/);
  assert.equal(outerHint.activeParameter, 1);
  assert.equal(outerHint.signatures[0].parameters.length, 2);
  const nonBuiltin = await vscode.workspace.openTextDocument({
    language: 'scarp', content: 'funcra top_p('
  });
  const declarationHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    'vscode.executeSignatureHelpProvider', nonBuiltin.uri, new vscode.Position(0, 'funcra top_p('.length), '(');
  assert.ok(!declarationHelp?.signatures.length,
    'Signature help must not treat user declarations as builtin calls');

  // Real VS Code completion API: static published names only, without CLI
  // capability probes or user-code evaluation.
  const completionText = 'bind name = text_re';
  const completionDoc = await vscode.workspace.openTextDocument({
    language: 'scarp', content: completionText
  });
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', completionDoc.uri,
    new vscode.Position(0, completionText.length));
  const textReplace = completions?.items.find(item => item.label === 'text_replace');
  assert.ok(textReplace, 'Scarp builtin completion must be registered');
  assert.equal(textReplace.kind, vscode.CompletionItemKind.Function);
  assert.match(textReplace.detail ?? '', /Scarp v0\.0\.6-alpha\.6/);
  const declaredText = 'funcra text_re';
  const declaredDoc = await vscode.workspace.openTextDocument({
    language: 'scarp', content: declaredText
  });
  const declaredItems = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', declaredDoc.uri,
    new vscode.Position(0, declaredText.length));
  assert.ok(!declaredItems?.items.some(item => item.label === 'text_replace'),
    'Declaration names must not suggest builtin function names');

  const settings = vscode.workspace.getConfiguration('scarp');
  const previous = settings.inspect<string>('compilerPath')?.globalValue;
  const previousVerifyOnSave = settings.inspect<boolean>('verifyOnSave')?.globalValue;
  await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
  try {
    // An explicit URI must win over the active editor. This regression uses
    // the real official compiler instead of mocking the selected file.
    const explicitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-explicit-file-'));
    try {
      const brokenUri = vscode.Uri.file(path.join(explicitRoot, 'broken.srp'));
      const selectedUri = vscode.Uri.file(path.join(explicitRoot, 'selected.srp'));
      await fs.writeFile(brokenUri.fsPath, 'bind = 1;\n');
      await fs.writeFile(selectedUri.fsPath, 'bind selected = 2;\n');
      const selectedDoc = await vscode.workspace.openTextDocument(selectedUri);
      await vscode.window.showTextDocument(selectedDoc, { preview: false });
      await vscode.commands.executeCommand('scarp.checkFile', brokenUri);
      const broken = vscode.languages.getDiagnostics(brokenUri);
      assert.ok(broken.length > 0,
        'Verify action must inspect the supplied URI, not the active editor');
      assert.equal(vscode.languages.getDiagnostics(selectedUri).length, 0,
        'An unrelated active editor must not receive diagnostics from the supplied source');
    } finally {
      await fs.rm(explicitRoot, { recursive: true, force: true });
    }

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

      // A source buffer change must terminate obsolete navigation promptly,
      // including a compiler that ignores SIGTERM. Different source roots
      // must remain independent and still produce correct navigation.
      const cancellableNav = path.join(projectParent, 'stubborn-navigation-compiler');
      const navigationPid = path.join(projectParent, 'navigation-inspection-pid');
      const navigationGate = path.join(projectParent, 'navigation-inspection-release');
      const unrelatedNavUri = vscode.Uri.file(
        path.join(projectParent, 'independent-navigation.srp'));
      const stubbornNavigationScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const argv = process.argv.slice(2);',
        'if (argv[0] !== "inspect" || argv[1] !== "references") process.exit(2);',
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(' + JSON.stringify(navigationPid) + ', String(process.pid));',
        'const gate = setInterval(() => {',
        '  if (!fs.existsSync(' + JSON.stringify(navigationGate) + ')) return;',
        '  clearInterval(gate);',
        '  process.stdout.write(' + JSON.stringify(JSON.stringify(navIndex)) + ');',
        '}, 20);'
      ].join('\n');
      await fs.writeFile(cancellableNav, stubbornNavigationScript, { mode: 0o755 });
      await fs.chmod(cancellableNav, 0o755);
      await fs.writeFile(unrelatedNavUri.fsPath, 'print("not part of navigation");\n');
      await settings.update('compilerPath', cancellableNav,
        vscode.ConfigurationTarget.Global);
      try {
        for (const [command, changedUri] of [
          ['vscode.executeDefinitionProvider', vscode.Uri.file(navImport)],
          ['vscode.executeReferenceProvider', navUri]
        ] as const) {
          await fs.rm(navigationPid, { force: true });
          await fs.rm(navigationGate, { force: true });
          const pending = vscode.commands.executeCommand<vscode.Location[]>(
            command, navUri, new vscode.Position(1, 8));
          await waitFor(() => fsSync.existsSync(navigationPid) ? true : undefined,
            'Static navigation did not start the stubborn compiler process');
          const pid = Number(await fs.readFile(navigationPid, 'utf8'));
          const modified = await vscode.workspace.openTextDocument(changedUri);
          const change = new vscode.WorkspaceEdit();
          change.insert(changedUri, modified.positionAt(modified.getText().length),
            '// editor edit invalidates compiler navigation\n');
          const changedAt = Date.now();
          assert.ok(await vscode.workspace.applyEdit(change),
            'Editor must change project source during a running inspection');
          const result = await pending;
          assert.equal(result?.length ?? 0, 0,
            command + ': source edit must not publish stale results');
          assert.ok(Date.now() - changedAt < 3000,
            command + ': source edit must stop the old compiler promptly');
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
            command + ': SIGTERM-resistant navigation process must be killed');
          assert.ok(await modified.save(), 'Save navigation source for next test');
        }

        // An unrelated editor change must NOT abort a navigation request;
        // release the compiler normally and verify that it returns the symbol.
        await fs.rm(navigationPid, { force: true });
        await fs.rm(navigationGate, { force: true });
        const pending = vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', navUri, new vscode.Position(1, 8));
        await waitFor(() => fsSync.existsSync(navigationPid) ? true : undefined,
          'Unrelated-edit navigation did not start the compiler');
        const independent = await vscode.workspace.openTextDocument(unrelatedNavUri);
        const editOther = new vscode.WorkspaceEdit();
        editOther.insert(unrelatedNavUri,
          independent.positionAt(independent.getText().length),
          '// independent editor edit\n');
        assert.ok(await vscode.workspace.applyEdit(editOther));
        assert.ok(await independent.save());
        await fs.writeFile(navigationGate, 'complete');
        const fresh = await pending;
        assert.ok(fresh?.some(item => item.uri.fsPath === navSource &&
          item.range.start.line === 0 && item.range.start.character === 5),
        'Editing another directory must not abort a valid definition lookup');
      } finally {
        await fs.writeFile(navigationGate, 'complete');
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

      // Project Launch must not start a terminal for a snapshot that becomes
      // obsolete while Scarp's version or project-capability probe is running.
      // Also detect unobserved external disk rewrites, and retain independence
      // from VS Code edits made in a separate project.
      const launchRoot = path.join(projectParent, 'isolated launch race');
      const launchUri = vscode.Uri.file(launchRoot);
      const launchEntry = vscode.Uri.file(path.join(launchRoot, 'src', 'main.srp'));
      const launchManifest = vscode.Uri.file(path.join(launchRoot, 'Scarp.project'));
      const unrelatedLaunchUri = vscode.Uri.file(
        path.join(projectParent, 'unrelated-launch-source.srp'));
      const launchBinary = path.join(projectParent, 'blocked-project-launch-compiler');
      const launchPhase = path.join(projectParent, 'project-launch-phase');
      const launchPid = path.join(projectParent, 'project-launch-probe-pid');
      const launchRelease = path.join(projectParent, 'project-launch-probe-release');
      const launchExecuted = path.join(projectParent, 'project-launch-executed');
      await fs.mkdir(path.join(launchRoot, 'src'), { recursive: true });
      await fs.writeFile(launchManifest.fsPath,
        'scarp-project: 1\nname: launch-race\nentry: src/main.srp\n');
      await fs.writeFile(launchEntry.fsPath, 'print("original project");\n');
      await fs.writeFile(unrelatedLaunchUri.fsPath, 'print("other project");\n');
      const launchEntryDocument = await vscode.workspace.openTextDocument(launchEntry);
      const launchManifestDocument = await vscode.workspace.openTextDocument(launchManifest);
      const blockedLaunchScript = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'const phase = fs.readFileSync(' + JSON.stringify(launchPhase) + ', "utf8");',
        'if (args[0] === "launch") {',
        '  fs.writeFileSync(' + JSON.stringify(launchExecuted) + ', "launched");',
        '  process.exit(0);',
        '}',
        'if (args[0] === "--version" && phase !== "source") {',
        '  console.log("scarp 0.0.6-alpha.1"); process.exit(0);',
        '}',
        'if (args[0] === "diagnose" && phase === "source") {',
        '  console.log(JSON.stringify({schema_version:1, version:"0.0.6-alpha.1", execution:"interpreter", static_verify:true, project_workflow:true}));',
        '  process.exit(0);',
        '}',
        'if (!["--version", "diagnose"].includes(args[0])) process.exit(2);',
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(' + JSON.stringify(launchPid) + ', String(process.pid));',
        'const gate = setInterval(() => {',
        '  if (!fs.existsSync(' + JSON.stringify(launchRelease) + ')) return;',
        '  clearInterval(gate);',
        '  if (args[0] === "--version") console.log("scarp 0.0.6-alpha.1");',
        '  else console.log(JSON.stringify({schema_version:1, version:"0.0.6-alpha.1", execution:"interpreter", static_verify:true, project_workflow:true}));',
        '}, 20);'
      ].join('\n');
      await fs.writeFile(launchBinary, blockedLaunchScript, { mode: 0o755 });
      await fs.chmod(launchBinary, 0o755);
      const observedLaunchTerminals: vscode.Terminal[] = [];
      const projectLaunchObserver = vscode.window.onDidOpenTerminal(terminal => {
        if (terminal.name === 'Scarp Project: isolated launch race') {
          observedLaunchTerminals.push(terminal);
        }
      });
      await settings.update('compilerPath', launchBinary, vscode.ConfigurationTarget.Global);
      try {
        for (const stage of ['source', 'manifest', 'external', 'stop', 'unrelated']) {
          await fs.writeFile(launchPhase, stage);
          await fs.rm(launchPid, { force: true });
          await fs.rm(launchRelease, { force: true });
          const openedBefore = observedLaunchTerminals.length;
          const pending = vscode.commands.executeCommand('scarp.launchProject', launchUri);
          await waitFor(() => fsSync.existsSync(launchPid) ? true : undefined,
            stage + ': launch did not enter the blocked compiler probe');
          const pid = Number(await fs.readFile(launchPid, 'utf8'));
          const changedAt = Date.now();
          if (stage === 'source' || stage === 'manifest') {
            const file = stage === 'source' ? launchEntry : launchManifest;
            const document = stage === 'source'
              ? launchEntryDocument : launchManifestDocument;
            const change = new vscode.WorkspaceEdit();
            change.insert(file, document.positionAt(document.getText().length),
              '\n// changed inside VS Code during launch\n');
            assert.ok(await vscode.workspace.applyEdit(change));
          } else if (stage === 'external') {
            // This source was not opened in VS Code; the on-disk checksum is
            // the only way to notice its rewrite during capability detection.
            await fs.writeFile(path.join(launchRoot, 'src', 'external.srp'),
              'print("changed on disk during project launch");\n');
            await fs.writeFile(launchRelease, 'complete');
          } else if (stage === 'stop') {
            await vscode.commands.executeCommand('scarp.stopProgram');
          } else {
            const independent = await vscode.workspace.openTextDocument(unrelatedLaunchUri);
            const change = new vscode.WorkspaceEdit();
            change.insert(unrelatedLaunchUri,
              independent.positionAt(independent.getText().length),
              '// changed in another folder\n');
            assert.ok(await vscode.workspace.applyEdit(change));
            assert.ok(await independent.save());
            await fs.writeFile(launchRelease, 'complete');
          }
          await pending;
          if (stage === 'source' || stage === 'manifest' || stage === 'stop') {
            assert.ok(Date.now() - changedAt < 3000,
              stage + ': obsolete project startup must not wait for compiler timeout');
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
              stage + ': SIGTERM-resistant project probe should be killed');
          }
          if (stage === 'unrelated') {
            await waitFor(() => observedLaunchTerminals.length > openedBefore
              ? true : undefined, 'Unrelated editor edit stopped a valid project launch');
            await vscode.commands.executeCommand('scarp.stopProgram');
          } else {
            assert.equal(observedLaunchTerminals.length, openedBefore,
              stage + ': stale project must never open a Run terminal');
          }
          if (stage === 'source') { assert.ok(await launchEntryDocument.save()); }
          if (stage === 'manifest') { assert.ok(await launchManifestDocument.save()); }
        }
        // An unsaved project source is not the on-disk program. Reject it
        // before launching any compiler process or terminal.
        await fs.rm(launchPid, { force: true });
        const unsaved = new vscode.WorkspaceEdit();
        unsaved.insert(launchEntry,
          launchEntryDocument.positionAt(launchEntryDocument.getText().length),
          '// unsaved local edit\n');
        assert.ok(await vscode.workspace.applyEdit(unsaved));
        const terminalCount = observedLaunchTerminals.length;
        await vscode.commands.executeCommand('scarp.launchProject', launchUri);
        assert.equal(observedLaunchTerminals.length, terminalCount,
          'Unsaved project source must never start a terminal');
        assert.equal(fsSync.existsSync(launchPid), false,
          'Unsaved project source should be rejected before compiler probing');
        assert.ok(await launchEntryDocument.save());
      } finally {
        projectLaunchObserver.dispose();
        await fs.writeFile(launchRelease, 'complete');
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
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

        // Project verification must also terminate the old compiler itself,
        // including one that refuses SIGTERM. A source edit cancels only its
        // project; a compiler switch cancels all outdated compiler checks.
        // Preserve previously completed standalone Problems in both cases.
        const independentUri = vscode.Uri.file(path.join(projectParent, 'independent-invalid.srp'));
        await fs.writeFile(independentUri.fsPath, 'print("missing semicolon")\n');
        const independentDocument = await vscode.workspace.openTextDocument(independentUri);
        await vscode.window.showTextDocument(independentDocument);
        await vscode.commands.executeCommand('scarp.checkFile');
        const independentProblems = vscode.languages.getDiagnostics(independentUri)
          .map(item => item.message);
        assert.ok(independentProblems.length > 0,
          'The pinned compiler must report independent Problems before cancellation');

        const stubbornBinary = path.join(projectParent, 'stubborn-project-scarp');
        const stubbornMarker = path.join(projectParent, 'stubborn-project-pid');
        const stubbornScript = [
          '#!/usr/bin/env node',
          'const fs = require("node:fs");',
          'const args = process.argv.slice(2);',
          'if (args[0] === "--version") {',
          '  process.stdout.write("scarp 0.0.6-alpha.1\\n"); process.exit(0);',
          '}',
          'if (args[0] === "diagnose") {',
          '  process.stdout.write(JSON.stringify({schema_version:1,',
          '    version:"0.0.6-alpha.1", execution:"interpreter",',
          '    static_verify:true, project_workflow:true}));',
          '  process.exit(0);',
          '}',
          'if (args[0] !== "verify") { process.exit(2); }',
          'process.on("SIGTERM", () => {});',
          'fs.writeFileSync(' + JSON.stringify(stubbornMarker) + ', String(process.pid));',
          'setInterval(() => {}, 1000);'
        ].join('\n');
        await fs.writeFile(stubbornBinary, stubbornScript, { mode: 0o755 });
        await fs.chmod(stubbornBinary, 0o755);
        for (const reason of ['source edit', 'compiler switch']) {
          await fs.rm(stubbornMarker, { force: true });
          await settings.update('compilerPath', stubbornBinary,
            vscode.ConfigurationTarget.Global);
          const pending = vscode.commands.executeCommand('scarp.verifyProject', projectUri);
          await waitFor(() => fsSync.existsSync(stubbornMarker) ? true : undefined,
            'Project verification did not reach the stubborn compiler');
          const pid = Number(await fs.readFile(stubbornMarker, 'utf8'));
          const cancelledAt = Date.now();
          if (reason === 'source edit') {
            const changed = new vscode.WorkspaceEdit();
            changed.insert(entryUri, new vscode.Position(0, 0), '// edited while verifying\n');
            assert.ok(await vscode.workspace.applyEdit(changed));
          } else {
            await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
          }
          await pending;
          assert.ok(Date.now() - cancelledAt < 3000,
            reason + ': obsolete project verification should end before timeout');
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
            reason + ': SIGTERM-resistant project compiler must be stopped');
          assert.deepEqual(vscode.languages.getDiagnostics(independentUri)
            .map(item => item.message), independentProblems,
          reason + ': completed standalone Problems must remain unchanged');
          assert.ok(!vscode.languages.getDiagnostics(entryUri).some(
            item => item.message.includes('stale verification error')),
          reason + ': obsolete project diagnostics must not be published');
          if (entryDocument.isDirty) {
            assert.ok(await entryDocument.save(),
              'Source must be saved before the next project check');
          }
        }
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

    // Standalone checks must not publish compiler output produced from a
    // different saved file version when an external tool rewrites source.
    // The editor may not emit a document-version change for external edits.
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-check-external-'));
    const externalUri = vscode.Uri.file(path.join(externalRoot, 'verified.srp'));
    const siblingPath = path.join(externalRoot, 'sibling.srp');
    const externalBinary = path.join(externalRoot, 'delayed-verify');
    const checkMode = path.join(externalRoot, 'check-mode');
    const checkStarted = path.join(externalRoot, 'check-started');
    const checkReleased = path.join(externalRoot, 'check-release');
    const externalScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") {',
      '  console.log("scarp 0.0.6-alpha.1"); process.exit(0);',
      '}',
      'if (args[0] === "verify" && args[1] === "--help") {',
      '  console.log("Usage: scarp verify [OPTIONS]"); process.exit(0);',
      '}',
      'if (args[0] !== "verify") process.exit(2);',
      'const mode = fs.readFileSync(' + JSON.stringify(checkMode) + ', "utf8");',
      'const diagnostic = { schema_version:1, severity:"error", code:"E0004",',
      '  message: mode === "initial" ? "initial checked source" :',
      '    mode === "external" ? "stale source result" : "fresh verified source",',
      '  primary: { path:' + JSON.stringify(externalUri.fsPath) + ',',
      '    start:{line:1,column:1}, end:{line:1,column:2} }, help:null };',
      'const report = () => {',
      '  process.stderr.write(JSON.stringify(diagnostic)); process.exit(1);',
      '};',
      'if (mode === "external" || mode === "sibling") {',
      '  fs.writeFileSync(' + JSON.stringify(checkStarted) + ', "started");',
      '  const timer = setInterval(() => {',
      '    if (fs.existsSync(' + JSON.stringify(checkReleased) + ')) {',
      '      clearInterval(timer); report();',
      '    }',
      '  }, 20);',
      '} else report();'
    ].join('\n');
    try {
      await fs.writeFile(externalBinary, externalScript, { mode: 0o755 });
      await fs.chmod(externalBinary, 0o755);
      await fs.writeFile(externalUri.fsPath, 'print("original saved source");\n');
      await fs.writeFile(siblingPath, 'pub bind other = 1;\n');
      const source = await vscode.workspace.openTextDocument(externalUri);
      await vscode.window.showTextDocument(source);
      await settings.update('compilerPath', externalBinary, vscode.ConfigurationTarget.Global);
      await fs.writeFile(checkMode, 'initial');
      await vscode.commands.executeCommand('scarp.checkFile');
      assert.ok(vscode.languages.getDiagnostics(externalUri).some(d =>
        d.message.includes('initial checked source')),
      'A completed static check must first establish an authoritative diagnostic');

      await fs.writeFile(checkMode, 'external');
      const obsolete = vscode.commands.executeCommand('scarp.checkFile');
      await waitFor(() => fsSync.existsSync(checkStarted) ? true : undefined,
        'External source freshness check did not begin');
      // External disk edit: unlike WorkspaceEdit, this may leave the editor
      // version unchanged. No stale compiler result is permitted either way.
      await fs.writeFile(externalUri.fsPath, 'print("externally changed source");\n');
      await fs.writeFile(checkReleased, 'go');
      await obsolete;
      assert.ok(!vscode.languages.getDiagnostics(externalUri).some(d =>
        d.message.includes('stale source result')),
      'Disk rewrite must suppress obsolete compiler diagnostics');

      // Revert/reload external changes instead of overwriting them. VS Code
      // intentionally rejects saving a stale buffer ("File Modified Since").
      // The next check must work once the editor adopts the updated disk source.
      await vscode.window.showTextDocument(source);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      const refreshedSource = await vscode.workspace.openTextDocument(externalUri);
      await vscode.window.showTextDocument(refreshedSource);
      assert.equal(refreshedSource.getText(), 'print("externally changed source");\n',
        'The editor must load the external source bytes before re-verifying');
      await fs.writeFile(checkMode, 'final');
      await vscode.commands.executeCommand('scarp.checkFile');
      assert.ok(vscode.languages.getDiagnostics(externalUri).some(d =>
        d.message.includes('fresh verified source')),
      'Rechecking the current saved disk source must publish fresh Problems');

      // A sibling file not part of this standalone entrypoint should not
      // invalidate a file-only fingerprint or block a normal check.
      await fs.rm(checkStarted, { force: true });
      await fs.rm(checkReleased, { force: true });
      await fs.writeFile(checkMode, 'sibling');
      const independent = vscode.commands.executeCommand('scarp.checkFile');
      await waitFor(() => fsSync.existsSync(checkStarted) ? true : undefined,
        'Independent file verification did not begin');
      await fs.writeFile(siblingPath, 'pub bind other = 2;\n');
      await fs.writeFile(checkReleased, 'go');
      await independent;
      assert.ok(vscode.languages.getDiagnostics(externalUri).some(d =>
        d.message.includes('fresh verified source')),
      'Unrelated sibling source rewrite must not invalidate standalone verification');
    } finally {
      await fs.writeFile(checkReleased, 'go');
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await fs.rm(externalRoot, { recursive: true, force: true });
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

    // A pending Run Current File must never launch an old saved version after
    // the user edits its buffer during the version or execution-verb probe.
    // Cancel its actual compiler process, including a stubborn SIGTERM child.
    // Stop must likewise terminate a still-pending file Run probe.
    const startupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-vscode-run-stale-'));
    const startupUri = vscode.Uri.file(path.join(startupRoot, 'edited-before-run.srp'));
    const startupBinary = path.join(startupRoot, 'stubborn-run-probe');
    const blockVersion = path.join(startupRoot, 'hang-version');
    const versionPidFile = path.join(startupRoot, 'version-pid');
    const guidePidFile = path.join(startupRoot, 'guide-pid');
    const unexpectedStartup = path.join(startupRoot, 'unexpected-execution');
    const startupScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version" && !fs.existsSync('
        + JSON.stringify(blockVersion) + ')) {',
      '  console.log("scarp 0.0.6-alpha.1"); process.exit(0);',
      '}',
      'if (args[0] === "exec" || args[0] === "run") {',
      '  fs.writeFileSync(' + JSON.stringify(unexpectedStartup) + ', "executed");',
      '  process.exit(1);',
      '}',
      'process.on("SIGTERM", () => {});',
      'if (args[0] === "--version") {',
      '  fs.writeFileSync(' + JSON.stringify(versionPidFile) + ', String(process.pid));',
      '} else if (args[0] === "guide" && args[1] === "exec") {',
      '  fs.writeFileSync(' + JSON.stringify(guidePidFile) + ', String(process.pid));',
      '} else { process.exit(2); }',
      'setInterval(() => {}, 1000);'
    ].join('\n');
    const observedStartups: vscode.Terminal[] = [];
    const startupObserver = vscode.window.onDidOpenTerminal(terminal => {
      if (terminal.name === 'Scarp: edited-before-run.srp') {
        observedStartups.push(terminal);
      }
    });
    try {
      await fs.writeFile(startupBinary, startupScript, { mode: 0o755 });
      await fs.chmod(startupBinary, 0o755);
      await fs.writeFile(startupUri.fsPath, 'print("original saved source");\n');
      const startupDoc = await vscode.workspace.openTextDocument(startupUri);
      await vscode.window.showTextDocument(startupDoc);
      await settings.update('compilerPath', startupBinary, vscode.ConfigurationTarget.Global);
      for (const stage of ['version', 'guide', 'stop']) {
        if (startupDoc.isDirty) { assert.ok(await startupDoc.save()); }
        await fs.rm(versionPidFile, { force: true });
        await fs.rm(guidePidFile, { force: true });
        if (stage === 'guide') { await fs.rm(blockVersion, { force: true }); }
        else { await fs.writeFile(blockVersion, 'yes'); }
        const pidFile = stage === 'guide' ? guidePidFile : versionPidFile;
        const pending = vscode.commands.executeCommand('scarp.runFile');
        await waitFor(() => fsSync.existsSync(pidFile) ? true : undefined,
          'File Run did not reach the delayed ' + stage + ' compiler probe');
        const pid = Number(await fs.readFile(pidFile, 'utf8'));
        const cancelledAt = Date.now();
        if (stage === 'stop') {
          await vscode.commands.executeCommand('scarp.stopProgram');
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(startupUri, new vscode.Position(0, 0),
            '// unsaved source change during ' + stage + ' probe\n');
          assert.ok(await vscode.workspace.applyEdit(edit));
          assert.equal(startupDoc.isDirty, true,
            'Test must change the editor buffer without saving');
        }
        await pending;
        assert.ok(Date.now() - cancelledAt < 3000,
          stage + ': cancelled Run startup must not wait for compiler timeout');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
          stage + ': obsolete compiler probe must be terminated');
        assert.equal(observedStartups.length, 0,
          stage + ': canceled Run must never open a stale source terminal');
        assert.equal(fsSync.existsSync(unexpectedStartup), false,
          stage + ': canceled Run must not execute Scarp source');
      }
    } finally {
      startupObserver.dispose();
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await fs.rm(startupRoot, { recursive: true, force: true });
    }

    // File Run must not open a terminal for an old saved input when an
    // external tool rewrites that file during either compiler probe. The
    // document can remain clean, with an unchanged editor version.
    const diskRunRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-disk-run-race-'));
    const diskRunUri = vscode.Uri.file(path.join(diskRunRoot, 'disk-run.srp'));
    const diskRunSibling = path.join(diskRunRoot, 'independent.srp');
    const diskRunBinary = path.join(diskRunRoot, 'disk-run-compiler');
    const diskRunPhase = path.join(diskRunRoot, 'phase');
    const diskRunStarted = path.join(diskRunRoot, 'probe-started');
    const diskRunRelease = path.join(diskRunRoot, 'probe-release');
    const diskRunExecuted = path.join(diskRunRoot, 'execution-started');
    const diskRunScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'const phase = fs.readFileSync(' + JSON.stringify(diskRunPhase) + ', "utf8");',
      'if (args[0] === "exec" || args[0] === "run") {',
      '  fs.writeFileSync(' + JSON.stringify(diskRunExecuted) + ', "executed");',
      '  process.exit(0);',
      '}',
      'const version = args[0] === "--version";',
      'const guide = args[0] === "guide" && args[1] === "exec";',
      'if (!version && !guide) process.exit(2);',
      'const finish = () => {',
      '  console.log(version ? "scarp 0.0.6-alpha.2" : "Usage: scarp exec [OPTIONS]");',
      '  process.exit(0);',
      '};',
      'if ((phase === "version" && version) ||',
      '    ((phase === "guide" || phase === "sibling") && guide)) {',
      '  fs.writeFileSync(' + JSON.stringify(diskRunStarted) + ', "started");',
      '  const poll = setInterval(() => {',
      '    if (!fs.existsSync(' + JSON.stringify(diskRunRelease) + ')) return;',
      '    clearInterval(poll); finish();',
      '  }, 20);',
      '} else finish();'
    ].join('\n');
    const diskRunTerminals: vscode.Terminal[] = [];
    const diskRunObserver = vscode.window.onDidOpenTerminal(terminal => {
      if (terminal.name === 'Scarp: disk-run.srp') {
        diskRunTerminals.push(terminal);
      }
    });
    try {
      await fs.writeFile(diskRunBinary, diskRunScript, { mode: 0o755 });
      await fs.chmod(diskRunBinary, 0o755);
      await fs.writeFile(diskRunUri.fsPath, 'print("original");\n');
      await fs.writeFile(diskRunSibling, 'pub bind unrelated = 1;\n');
      const diskRunDocument = await vscode.workspace.openTextDocument(diskRunUri);
      await vscode.window.showTextDocument(diskRunDocument);
      await settings.update('compilerPath', diskRunBinary,
        vscode.ConfigurationTarget.Global);
      for (const phase of ['version', 'guide', 'sibling']) {
        // Each probe phase is independent. After the previous external write,
        // reload the saved bytes rather than attempting another Run from a
        // potentially stale editor buffer ("File Modified Since").
        await vscode.window.showTextDocument(diskRunDocument);
        if (phase !== 'version') {
          await vscode.commands.executeCommand('workbench.action.files.revert');
          assert.equal(diskRunDocument.getText(),
            await fs.readFile(diskRunUri.fsPath, 'utf8'),
            'Reload external source before exercising the next Run probe');
        }
        await fs.writeFile(diskRunPhase, phase);
        await fs.rm(diskRunStarted, { force: true });
        await fs.rm(diskRunRelease, { force: true });
        const openedBefore = diskRunTerminals.length;
        const pending = vscode.commands.executeCommand('scarp.runFile');
        await waitFor(() => fsSync.existsSync(diskRunStarted) ? true : undefined,
          phase + ': Run did not start its delayed compiler probe');
        if (phase === 'sibling') {
          await fs.writeFile(diskRunSibling, 'pub bind unrelated = 2;\n');
        } else {
          await fs.writeFile(diskRunUri.fsPath,
            'print("external change during ' + phase + '");\n');
        }
        await fs.writeFile(diskRunRelease, 'go');
        await pending;
        if (phase !== 'sibling') {
          assert.equal(diskRunTerminals.length, openedBefore,
            phase + ': externally rewritten Scarp source cannot launch');
          assert.equal(fsSync.existsSync(diskRunExecuted), false,
            phase + ': stale Scarp source must never be executed');
        } else {
          await waitFor(() => diskRunTerminals.length > openedBefore
            ? true : undefined,
          'An unrelated sibling rewrite must not cancel a valid file Run');
          await vscode.commands.executeCommand('scarp.stopProgram');
        }
      }
    } finally {
      await fs.writeFile(diskRunRelease, 'go');
      diskRunObserver.dispose();
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await fs.rm(diskRunRoot, { recursive: true, force: true });
    }

    // Cancelling a stale manual file check must actually terminate only its
    // compiler subprocess, not wait for the configured timeout or erase other
    // files' completed Problems. Also cancel on an in-editor source edit.
    const cancelRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-vscode-check-cancel-'));
    const cancelUri = vscode.Uri.file(path.join(cancelRoot, 'cancellable.srp'));
    const cancelBinary = path.join(cancelRoot, 'stubborn-scarp');
    const checkMarker = path.join(cancelRoot, 'active-check-pid');
    const otherBefore = vscode.languages.getDiagnostics(otherUri).map(item => item.message);
    assert.ok(otherBefore.length > 0, 'Expected independent completed compiler Problems');
    try {
      await fs.writeFile(cancelUri.fsPath, 'print("valid");\n');
      const cancelDoc = await vscode.workspace.openTextDocument(cancelUri);
      await vscode.window.showTextDocument(cancelDoc);
      const cancelScript = [
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
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(' + JSON.stringify(checkMarker) + ', String(process.pid));',
        'setInterval(() => {}, 1000);'
      ].join('\n');
      await fs.writeFile(cancelBinary, cancelScript, { mode: 0o755 });
      await fs.chmod(cancelBinary, 0o755);
      for (const cause of ['compiler switch', 'source edit']) {
        await settings.update('compilerPath', cancelBinary, vscode.ConfigurationTarget.Global);
        const pending = vscode.commands.executeCommand('scarp.checkFile');
        await waitFor(() => fsSync.existsSync(checkMarker) ? true : undefined,
          'Stubborn file verification did not reach static compiler invocation');
        const pid = Number(await fs.readFile(checkMarker, 'utf8'));
        const cancelledAt = Date.now();
        if (cause === 'compiler switch') {
          await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
        } else {
          const updated = new vscode.WorkspaceEdit();
          updated.insert(cancelUri, new vscode.Position(0, 0), '// edit during check\n');
          assert.ok(await vscode.workspace.applyEdit(updated));
        }
        await pending;
        assert.ok(Date.now() - cancelledAt < 3000,
          cause + ': obsolete compiler must stop before its configured timeout');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
          cause + ': stubborn compiler must no longer be running');
        assert.deepEqual(vscode.languages.getDiagnostics(otherUri).map(item => item.message),
          otherBefore, 'Cancelling one file must preserve unrelated Problems');
        assert.equal(vscode.languages.getDiagnostics(cancelUri).length, 0,
          'Cancelled file checks must not publish bogus Problems');
        await fs.rm(checkMarker);
      }
    } finally {
      await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      await fs.rm(cancelRoot, { recursive: true, force: true });
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
        'print("intermediate repair");\n',
        'print("newest source is missing its semicolon")\n'
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

      // End-to-end regression for the save queue: three saves while a slow
      // compiler check is active must ultimately report only the newest
      // source's Problems. Since edits now cancel stale checks immediately,
      // save #2 may run if #1 has already stopped before save #3 arrives.
      // The isolated DebouncedSerialTasks unit test still proves the strict
      // [one, three] ordering when the first worker remains active.
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
        'fs.appendFileSync(' + JSON.stringify(raceLog) + ', stage + "\\n");',
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
        assert.equal(stages[0], 'one',
          'The first verification must start before later saves');
        assert.equal(stages.at(-1), 'three',
          'No obsolete verification may start after the newest save');
        assert.equal(stages.filter(stage => stage === 'three').length, 1,
          'The newest saved version should be verified exactly once');
        assert.ok(stages.every(stage => ['one', 'two', 'three'].includes(stage)),
          'Only the expected three saved versions may be compiled');
      } finally {
        await fs.writeFile(raceReleased, 'go');
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
      }

      // Switching the resource-scoped opt-in off must terminate only a
      // running *automatic* check. A manually invoked verification remains
      // active across the same setting toggle and can still publish Problems.
      const toggleUri = vscode.Uri.file(path.join(tempDir, 'toggle-check.srp'));
      const toggleBinary = path.join(tempDir, 'toggle-scarp');
      const toggleMarker = path.join(tempDir, 'toggle-compiler-pid');
      const toggleReleased = path.join(tempDir, 'toggle-released');
      const toggleDiagnostic = {
        schema_version: 1, severity: 'error', code: 'E0004',
        message: 'explicit verification survived disabled automatic checks',
        primary: {
          path: toggleUri.fsPath,
          start: { line: 1, column: 1 }, end: { line: 1, column: 2 }
        }, help: null
      };
      const toggleScript = [
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
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(' + JSON.stringify(toggleMarker) + ', String(process.pid));',
        'const check = setInterval(() => {',
        '  if (!fs.existsSync(' + JSON.stringify(toggleReleased) + ')) { return; }',
        '  clearInterval(check);',
        '  process.stderr.write(' + JSON.stringify(JSON.stringify(toggleDiagnostic)) + ');',
        '  process.exit(1);',
        '}, 20);'
      ].join('\n');
      await fs.writeFile(toggleBinary, toggleScript, { mode: 0o755 });
      await fs.chmod(toggleBinary, 0o755);
      await fs.writeFile(toggleUri.fsPath, 'print("initial");\n');
      const toggleDoc = await vscode.workspace.openTextDocument(toggleUri);
      await vscode.window.showTextDocument(toggleDoc);
      await settings.update('compilerPath', toggleBinary, vscode.ConfigurationTarget.Global);
      try {
        await settings.update('verifyOnSave', true, vscode.ConfigurationTarget.Global);
        const changed = new vscode.WorkspaceEdit();
        changed.insert(toggleUri, new vscode.Position(0, 0), '// auto check started\n');
        assert.ok(await vscode.workspace.applyEdit(changed));
        assert.ok(await toggleDoc.save());
        await waitFor(() => fsSync.existsSync(toggleMarker) ? true : undefined,
          'Verify-on-save process did not begin before disabling the option');
        const automaticPid = Number(await fs.readFile(toggleMarker, 'utf8'));
        const disabledAt = Date.now();
        await settings.update('verifyOnSave', false, vscode.ConfigurationTarget.Global);
        await waitFor(() => {
          try { process.kill(automaticPid, 0); return undefined; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return true; }
            throw error;
          }
        }, 'Disabling verify on save did not stop its compiler subprocess');
        assert.ok(Date.now() - disabledAt < 3000,
          'Disabling automatic checks must cancel work before the CLI timeout');
        assert.equal(vscode.languages.getDiagnostics(toggleUri).length, 0,
          'An automatic verification canceled by settings cannot publish Problems');

        // No save is needed for a manual check. Disabling the automatic
        // setting again must *not* abort this explicitly requested process.
        await fs.rm(toggleMarker);
        const pendingManual = vscode.commands.executeCommand('scarp.checkFile');
        await waitFor(() => fsSync.existsSync(toggleMarker) ? true : undefined,
          'Manual check did not reach the independent compiler subprocess');
        const manualPid = Number(await fs.readFile(toggleMarker, 'utf8'));
        await settings.update('verifyOnSave', true, vscode.ConfigurationTarget.Global);
        await settings.update('verifyOnSave', false, vscode.ConfigurationTarget.Global);
        assert.doesNotThrow(() => process.kill(manualPid, 0),
          'Disabling verify on save must not stop an explicit manual check');
        await fs.writeFile(toggleReleased, 'go');
        await pendingManual;
        assert.ok(vscode.languages.getDiagnostics(toggleUri).some(item =>
          item.source === 'Scarp' &&
          item.message.includes('explicit verification survived disabled automatic checks')),
        'Manual verification must publish its result even when auto-checks are off');
      } finally {
        await fs.writeFile(toggleReleased, 'go');
        await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);
        await settings.update('verifyOnSave', true, vscode.ConfigurationTarget.Global);
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
