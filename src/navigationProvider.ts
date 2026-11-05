import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { executeProcess } from './cli';
import { isWithinProject } from './projectChangeTracker';
import {
  parseNavigationIndex, referencesFor, symbolAt,
  type NavigationIndex, type SourceSpan
} from './navigationIndex';
import { utf16OffsetForScalarColumn } from './diagnostics';

interface NavigationSnapshot {
  index: NavigationIndex;
  root: string;
  sourceFile: string;
}

/** Infer at most the explicitly opened VS Code workspace root, not ancestors. */
async function sourceScope(uri: vscode.Uri): Promise<{ root: string; target: string }> {
  const filename = uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder?.uri.scheme === 'file' &&
      isWithinProject(folder.uri.fsPath, filename)) {
    const root = folder.uri.fsPath;
    try {
      const stat = await fs.lstat(path.join(root, 'Scarp.project'));
      if (stat.isFile() && !stat.isSymbolicLink()) {
        return { root, target: root };
      }
    } catch { /* An ordinary standalone file need not have a manifest. */ }
  }
  return { root: path.dirname(filename), target: filename };
}

async function inspect(
  document: vscode.TextDocument, output: vscode.OutputChannel,
  token: vscode.CancellationToken
): Promise<NavigationSnapshot | undefined> {
  if (!vscode.workspace.isTrusted || token.isCancellationRequested ||
      document.uri.scheme !== 'file' || document.isDirty ||
      path.extname(document.uri.fsPath).toLowerCase() !== '.srp') {
    return undefined;
  }
  const version = document.version;
  const { root, target } = await sourceScope(document.uri);
  // Compiler navigation examines saved files. Never advertise a graph
  // compiled from disk while an editor has unsaved source changes in its root.
  if (vscode.workspace.textDocuments.some(doc => doc.isDirty &&
      doc.uri.scheme === 'file' && isWithinProject(root, doc.uri.fsPath) &&
      (path.extname(doc.uri.fsPath).toLowerCase() === '.srp' ||
        path.basename(doc.uri.fsPath) === 'Scarp.project'))) {
    return undefined;
  }
  const binary = vscode.workspace.getConfiguration('scarp').get<string>(
    'compilerPath', 'scarp').trim();
  if (!binary) { return undefined; }
  let result;
  try {
    result = await executeProcess(binary, [
      'inspect', 'references', '--json', '--diagnostic-format=json', '--', target
    ], {
      cwd: root,
      timeoutMs: vscode.workspace.getConfiguration('scarp', document.uri)
        .get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 4 * 1024 * 1024
    });
  } catch (error) {
    output.appendLine('Scarp navigation unavailable: ' + String(error));
    return undefined;
  }
  if (result.exitCode !== 0) {
    // Unsupported older alpha compilers and invalid source files intentionally
    // fall back to the existing local Outline without pretending to resolve.
    output.appendLine('Scarp static navigation unavailable or source invalid. ' +
      'Compiler v0.0.6-alpha.1+ is required. ' + result.stderr.slice(0, 4096));
    return undefined;
  }
  if (token.isCancellationRequested || document.version !== version ||
      document.isDirty) { return undefined; }
  try {
    const canonicalRoot = await fs.realpath(root);
    const canonicalFile = await fs.realpath(document.uri.fsPath);
    const index = parseNavigationIndex(result.stdout, canonicalRoot);
    if (!index.files.includes(canonicalFile)) { return undefined; }
    return { index, root: canonicalRoot, sourceFile: canonicalFile };
  } catch (error) {
    output.appendLine('Scarp navigation returned unusable metadata: ' + String(error));
    return undefined;
  }
}

function byteOffset(document: vscode.TextDocument, position: vscode.Position): number {
  // VS Code positions are UTF-16; compiler index spans are local UTF-8 bytes.
  return Buffer.byteLength(document.getText().slice(0, document.offsetAt(position)), 'utf8');
}

async function toLocations(
  snapshot: NavigationSnapshot, spans: SourceSpan[],
  token: vscode.CancellationToken
): Promise<vscode.Location[]> {
  const locations: vscode.Location[] = [];
  const open = new Map<string, vscode.TextDocument>();
  for (const span of spans) {
    if (token.isCancellationRequested) { return []; }
    const filename = snapshot.index.files[span.source];
    if (!filename) { return []; }
    try {
      const canonical = await fs.realpath(filename);
      if (!isWithinProject(snapshot.root, canonical) ||
          path.extname(canonical).toLowerCase() !== '.srp') { return []; }
      let doc = open.get(canonical);
      if (!doc) {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(canonical));
        open.set(canonical, doc);
      }
      if (doc.isDirty || span.start.line > doc.lineCount ||
          span.end.line > doc.lineCount) { return []; }
      const beginLine = doc.lineAt(span.start.line - 1).text;
      const endLine = doc.lineAt(span.end.line - 1).text;
      const from = utf16OffsetForScalarColumn(beginLine, span.start.column);
      const to = utf16OffsetForScalarColumn(endLine, span.end.column);
      if (from > beginLine.length || to > endLine.length) { return []; }
      const begin = new vscode.Position(span.start.line - 1, from);
      const end = new vscode.Position(span.end.line - 1, to);
      locations.push(new vscode.Location(doc.uri, new vscode.Range(begin, end)));
    } catch {
      // A file may have disappeared or become a symlink during inspection.
      return [];
    }
  }
  return locations;
}

/**
 * These providers invoke the compiler only on explicit navigation requests.
 * No persistent index, server, auto-execution or cross-edit symbol IDs.
 */
export function registerCompilerNavigation(
  output: vscode.OutputChannel
): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = [{ language: 'scarp', scheme: 'file' }];
  return [
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        const snapshot = await inspect(document, output, token);
        if (!snapshot || token.isCancellationRequested) { return undefined; }
        const symbol = symbolAt(snapshot.index, snapshot.sourceFile,
          byteOffset(document, position));
        if (!symbol?.location) { return undefined; }
        return (await toLocations(snapshot, [symbol.location], token))[0];
      }
    }),
    vscode.languages.registerReferenceProvider(selector, {
      async provideReferences(document, position, context, token) {
        const snapshot = await inspect(document, output, token);
        if (!snapshot || token.isCancellationRequested) { return []; }
        const symbol = symbolAt(snapshot.index, snapshot.sourceFile,
          byteOffset(document, position));
        if (!symbol) { return []; }
        return toLocations(snapshot,
          referencesFor(snapshot.index, symbol, context.includeDeclaration), token);
      }
    })
  ];
}
