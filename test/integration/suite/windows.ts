import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { preferredExecutionVerb } from '../../../src/cli';
import { parseBrowsableProjectModules } from '../../../src/projectModules';
import { parseNavigationIndex, symbolAt } from '../../../src/navigationIndex';

const runCompiler = promisify(execFile);

/**
 * Real Windows Extension Host compatibility run.
 *
 * The full Linux stress suite includes intentionally uncooperative POSIX
 * executable scripts (signal cancellation and shell wrappers). Windows
 * cannot spawn those shebang-only test fixtures with shell:false. Rather
 * than disabling the Windows host gate or switching to a shell, exercise
 * the published native compiler, editor providers, diagnostics, project
 * workflow and module inventory using genuine Windows executable paths.
 */
export async function run(): Promise<void> {
  assert.equal(process.platform, 'win32', 'Use the Windows compatibility suite on Windows.');
  const binary = process.env.SCARP_TEST_BINARY;
  assert.ok(binary && path.isAbsolute(binary), 'Official compiler must be an absolute path');
  assert.equal(await preferredExecutionVerb(binary), 'exec');
  const extension = vscode.extensions.getExtension('ScarpLang.scarp');
  assert.ok(extension, 'Scarp VS Code extension was not loaded');
  await extension.activate();
  assert.ok((await vscode.languages.getLanguages()).includes('scarp'));

  const available = await vscode.commands.getCommands(true);
  for (const command of [
    'scarp.checkFile', 'scarp.runFile', 'scarp.showVersion',
    'scarp.verifyProject', 'scarp.browseProjectModules',
    'scarp.runFileInteractive', 'scarp.launchProjectInteractive',
    'scarp.listProjectTests', 'scarp.explainDiagnostic'
  ]) {
    assert.ok(available.includes(command), 'Missing Scarp command ' + command);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scarp-win-host-'));
  const sourceUri = vscode.Uri.file(path.join(tempRoot, 'typed structures with spaces.srp'));
  const badUri = vscode.Uri.file(path.join(tempRoot, 'invalid.srp'));
  const source = [
    'record Task { title: string }',
    'variant Submission {',
    '    Accepted(record Task),',
    '    Rejected(string),',
    '}',
    'pure funcra submit(title: string) -> variant Submission {',
    '    if title == "" { return new Submission::Rejected("empty"); }',
    '    return new Submission::Accepted(new Task { title: title });',
    '}',
    'funcra present(outcome: variant Submission) -> unit {',
    '    match on outcome {',
    '        case Rejected(message) { print(message); }',
    '        case Accepted(task) { print("Saved", task->title); }',
    '    }',
    '}',
    'present(submit("Ready"));'
  ].join('\n') + '\n';

  const settings = vscode.workspace.getConfiguration('scarp', sourceUri);
  const priorCompiler = settings.inspect<string>('compilerPath')?.globalValue;
  try {
    await fs.writeFile(sourceUri.fsPath, source, 'utf8');
    await fs.writeFile(badUri.fsPath, 'bind = 1;\n', 'utf8');
    await settings.update('compilerPath', binary, vscode.ConfigurationTarget.Global);

    const document = await vscode.workspace.openTextDocument(sourceUri);
    assert.equal(document.languageId, 'scarp');
    const outline = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', document.uri);
    assert.ok(outline, 'Scarp document symbols must be registered');
    assert.deepEqual(outline.map(symbol => symbol.name), [
      'Task', 'Submission', 'submit', 'present'
    ]);
    assert.deepEqual(outline.map(symbol => symbol.kind), [
      vscode.SymbolKind.Struct, vscode.SymbolKind.Enum,
      vscode.SymbolKind.Function, vscode.SymbolKind.Function
    ]);
    assert.equal(outline[0].selectionRange.start.line, 0);
    assert.equal(outline[1].selectionRange.start.line, 1);

    // Compiler-free, bounded editor providers should work with published
    // collection functions while source execution remains explicit.
    const hoverSource = 'bind size = map_len([map: "a": 1]);';
    const hoverDocument = await vscode.workspace.openTextDocument({
      language: 'scarp', content: hoverSource
    });
    const position = new vscode.Position(0, hoverSource.indexOf('map_len') + 3);
    const hovered = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider', hoverDocument.uri, position);
    assert.ok(hovered?.length, 'Published map_len hover must be available');
    const help = hovered.flatMap(item => item.contents)
      .map(item => typeof item === 'string' ? item : item.value).join('\n');
    assert.match(help, /map_len\(/);
    assert.match(help, /v0\.0\.6-alpha\.12/);

    const completionText = 'bind changed = map_g';
    const completionDoc = await vscode.workspace.openTextDocument({
      language: 'scarp', content: completionText
    });
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', completionDoc.uri,
      new vscode.Position(0, completionText.length));
    assert.ok(completion?.items.some(item => item.label === 'map_get_or'),
      'Versioned map completion must be registered');

    const signature = 'bind changed = map_set(values, "a", ';
    const signatureDoc = await vscode.workspace.openTextDocument({
      language: 'scarp', content: signature
    });
    const hint = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider', signatureDoc.uri,
      new vscode.Position(0, signature.length), ',');
    assert.ok(hint?.signatures.length, 'map_set signature help is missing');
    assert.equal(hint.signatures[0].parameters.length, 3,
      'Generic map<K, V> commas must not separate function parameters');
    assert.equal(hint.activeParameter, 2);

    // The exact pinned published compiler, not an extension evaluator, verifies and
    // executes the same on-disk source as the editor.
    const staticCheck = await runCompiler(binary, ['verify', '--', sourceUri.fsPath], {
      cwd: tempRoot, timeout: 15_000, maxBuffer: 1024 * 1024
    });
    assert.equal(staticCheck.stderr, '');
    const execution = await runCompiler(binary, ['exec', '--', sourceUri.fsPath], {
      cwd: tempRoot, timeout: 15_000, maxBuffer: 1024 * 1024
    });
    assert.equal(execution.stdout.replace(/\r\n/g, '\n'), 'Saved Ready\n');

    await vscode.commands.executeCommand('scarp.checkFile', sourceUri);
    assert.equal(vscode.languages.getDiagnostics(sourceUri).length, 0,
      'Valid structured Scarp source should have no Problems');
    await vscode.commands.executeCommand('scarp.checkFile', badUri);
    const diagnostics = vscode.languages.getDiagnostics(badUri);
    assert.ok(diagnostics.some(item => item.severity === vscode.DiagnosticSeverity.Error),
      'The compiler should report real static errors to Problems');

    // Module schema v5 is generated by the published compiler and its
    // Windows-canonical paths must stay rooted in this selected source tree.
    const modulesResult = await runCompiler(binary,
      ['modules', '--json', '--', sourceUri.fsPath], {
        cwd: tempRoot, timeout: 15_000, maxBuffer: 4 * 1024 * 1024
      });
    const inventory = JSON.parse(modulesResult.stdout);
    assert.equal(inventory.schema_version, 5);
    const canonicalRoot = await fs.realpath(tempRoot);
    let modules;
    try {
      modules = parseBrowsableProjectModules(modulesResult.stdout, canonicalRoot);
    } catch (error) {
      // Make genuine filesystem-identity regressions diagnosable in CI.
      // Only test-temp paths and versioned compiler module labels are shown.
      const paths = Array.isArray(inventory.modules)
        ? inventory.modules.map((entry: { path?: string }) => entry.path)
        : [];
      throw new Error('Windows compiler module path mismatch: ' +
        String(error) + '; root=' + JSON.stringify(canonicalRoot) +
        '; compiler paths=' + JSON.stringify(paths));
    }
    assert.equal(modules.length, 1);
    assert.equal(modules[0].isEntry, true);
    assert.equal(path.resolve(modules[0].filename),
      path.resolve(await fs.realpath(sourceUri.fsPath)));
    assert.ok(modules[0].publicSymbols === 0);

    // Windows Rust compiler canonical paths may use the \\?\ namespace.
    // Ensure both the raw inspect parser and actual VS Code navigation
    // resolve to the ordinary saved source path without weakening containment.
    const navigationUri = vscode.Uri.file(path.join(tempRoot, 'navigation with spaces.srp'));
    const navigationSource = 'bind answer = 42;\nprint(answer);\n';
    await fs.writeFile(navigationUri.fsPath, navigationSource, 'utf8');
    const navigationDocument = await vscode.workspace.openTextDocument(navigationUri);
    // Match the existing Linux provider integration: the source must stay
    // owned by a visible editor throughout the asynchronous CLI request.
    await vscode.window.showTextDocument(navigationDocument);
    const referencesJson = await runCompiler(binary,
      ['inspect', 'references', '--json', '--diagnostic-format=json', '--',
        navigationUri.fsPath], {
        cwd: tempRoot, timeout: 15_000, maxBuffer: 4 * 1024 * 1024
      });
    const navigationIndex = parseNavigationIndex(referencesJson.stdout, canonicalRoot);
    const canonicalNavigationFile = await fs.realpath(navigationUri.fsPath);
    assert.ok(navigationIndex.files.includes(canonicalNavigationFile),
      'Native Windows compiler navigation paths must map to VS Code filenames');
    const useOffset = navigationSource.indexOf('answer', navigationSource.indexOf('print('));
    const cursor = navigationDocument.positionAt(useOffset + 2);
    const selected = symbolAt(navigationIndex, canonicalNavigationFile,
      Buffer.byteLength(navigationSource.slice(0, useOffset + 2), 'utf8'));
    assert.equal(selected?.name, 'answer');
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider', navigationUri, cursor);
    assert.ok(definitions?.some(item =>
      path.resolve(item.uri.fsPath) === path.resolve(navigationUri.fsPath) &&
      item.range.start.line === 0 && item.range.start.character === 5),
      'Go to Definition must resolve actual compiler symbols on Windows; ' +
      JSON.stringify({
        definitions, rawDeclaration: selected?.location,
        documentLanguage: navigationDocument.languageId,
        workspaceTrusted: vscode.workspace.isTrusted,
        documentDirty: navigationDocument.isDirty,
        configuredCompiler: settings.get<string>('compilerPath'),
        expectedFile: navigationUri.fsPath, indexFiles: navigationIndex.files
      }));
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider', navigationUri, cursor);
    assert.ok(references?.some(item =>
      path.resolve(item.uri.fsPath) === path.resolve(navigationUri.fsPath) &&
      item.range.start.line === 1 && item.range.start.character === 6),
      'Find References must locate the saved source use on Windows');

    // One real Windows project initialization and static editor command,
    // with a directory containing spaces (no POSIX test wrappers).
    const projectRoot = path.join(tempRoot, 'project with spaces');
    await runCompiler(binary, ['create', '--', projectRoot], {
      cwd: tempRoot, timeout: 15_000, maxBuffer: 1024 * 1024
    });
    const entryUri = vscode.Uri.file(path.join(projectRoot, 'src', 'main.srp'));
    await vscode.workspace.openTextDocument(entryUri);
    await vscode.commands.executeCommand('scarp.verifyProject', vscode.Uri.file(projectRoot));
    assert.equal(vscode.languages.getDiagnostics(entryUri).length, 0,
      'Published project verification should work in Windows Extension Host');
  } finally {
    await settings.update('compilerPath', priorCompiler, vscode.ConfigurationTarget.Global);
    // VS Code file watchers briefly retain handles after a document closes.
    // Retry transient Windows OS locks, but fail on persistent problems.
    await fs.rm(tempRoot, {
      recursive: true, force: true, maxRetries: 12, retryDelay: 100
    });
  }
}
