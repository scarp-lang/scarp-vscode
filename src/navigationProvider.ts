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
import {
  snapshotProjectDisk, sameProjectDisk, type ProjectDiskSnapshot
} from './projectDiskSnapshot';

interface NavigationSnapshot {
  index: NavigationIndex;
  root: string;
  sourceFile: string;
  disk: ProjectDiskSnapshot;
  requireManifest: boolean;
  compilerPath: string;
}

function configuredCompilerPath(): string {
  return vscode.workspace.getConfiguration('scarp').get<string>(
    'compilerPath', 'scarp').trim();
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
  const requireManifest = root === target;
  // Compiler navigation examines saved files. Never advertise a graph
  // compiled from disk while an editor has unsaved source changes in its root.
  if (dirtyScarpBuffers(root)) {
    return undefined;
  }
  let before: ProjectDiskSnapshot;
  try {
    // Capture all local source bytes, not just the active editor version.
    // A clean imported module can be rewritten during the compiler run.
    before = await snapshotProjectDisk(root, requireManifest);
  } catch (error) {
    output.appendLine('Scarp navigation source snapshot unavailable: ' + String(error));
    return undefined;
  }
  if (token.isCancellationRequested || document.version !== version ||
      document.isDirty) { return undefined; }
  const binary = configuredCompilerPath();
  if (!binary) { return undefined; }
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  let compilerChanged = false;
  const configuration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scarp.compilerPath')) {
      compilerChanged = true;
      controller.abort();
    }
  });
  if (token.isCancellationRequested) { controller.abort(); }
  let result;
  try {
    result = await executeProcess(binary, [
      'inspect', 'references', '--json', '--diagnostic-format=json', '--', target
    ], {
      cwd: root,
      timeoutMs: vscode.workspace.getConfiguration('scarp', document.uri)
        .get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 4 * 1024 * 1024,
      signal: controller.signal
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      output.appendLine('Scarp navigation unavailable: ' + String(error));
    }
    return undefined;
  } finally {
    cancellation.dispose();
    configuration.dispose();
  }
  if (compilerChanged || configuredCompilerPath() !== binary ||
      !vscode.workspace.isTrusted) { return undefined; }
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
    // Even a successful compiler index is stale when an external editor,
    // formatter or import changed bytes before it returned.
    const after = await snapshotProjectDisk(root, requireManifest);
    if (!sameProjectDisk(before, after) || token.isCancellationRequested ||
        document.version !== version || document.isDirty ||
        dirtyScarpBuffers(root) || !vscode.workspace.isTrusted ||
        compilerChanged || configuredCompilerPath() !== binary) {
      output.appendLine('Scarp navigation discarded: project source changed during inspection.');
      return undefined;
    }
    const canonicalRoot = await fs.realpath(root);
    const canonicalFile = await fs.realpath(document.uri.fsPath);
    const index = parseNavigationIndex(result.stdout, canonicalRoot);
    if (!index.files.includes(canonicalFile)) { return undefined; }
    return { index, root: canonicalRoot, sourceFile: canonicalFile,
      disk: after, requireManifest, compilerPath: binary };
  } catch (error) {
    output.appendLine('Scarp navigation returned unusable metadata: ' + String(error));
    return undefined;
  }
}

function dirtyScarpBuffers(root: string): boolean {
  return vscode.workspace.textDocuments.some(doc => doc.isDirty &&
    doc.uri.scheme === 'file' && isWithinProject(root, doc.uri.fsPath) &&
    (path.extname(doc.uri.fsPath).toLowerCase() === '.srp' ||
      path.basename(doc.uri.fsPath) === 'Scarp.project'));
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
  const open = new Map<string, {
    doc: vscode.TextDocument; lines: number[]; text: string
  }>();
  for (const span of spans) {
    if (token.isCancellationRequested || !vscode.workspace.isTrusted ||
        configuredCompilerPath() !== snapshot.compilerPath) { return []; }
    const filename = snapshot.index.files[span.source];
    if (!filename) { return []; }
    try {
      const canonical = await fs.realpath(filename);
      if (!isWithinProject(snapshot.root, canonical) ||
          path.extname(canonical).toLowerCase() !== '.srp') { return []; }
      let opened = open.get(canonical);
      if (!opened) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(canonical));
        if (doc.isDirty) { return []; }
        // A clean VS Code buffer can lag an external on-disk rewrite.
        const text = doc.getText();
        if (!Buffer.from(text, 'utf8').equals(await fs.readFile(canonical))) {
          return [];
        }
        const lines: number[] = [];
        let byte = 0;
        const segments = text.split('\n');
        for (let i = 0; i < segments.length; i++) {
          lines.push(byte);
          byte += Buffer.byteLength(segments[i], 'utf8') +
            (i < segments.length - 1 ? 1 : 0);
        }
        opened = { doc, lines, text };
        open.set(canonical, opened);
      }
      const { doc, lines } = opened;
      if (doc.isDirty || span.start.line > doc.lineCount ||
          span.end.line > doc.lineCount) { return []; }
      const beginLine = doc.lineAt(span.start.line - 1).text;
      const endLine = doc.lineAt(span.end.line - 1).text;
      // Reject coordinates that would otherwise clamp silently to line ends.
      if (span.start.column > Array.from(beginLine).length + 1 ||
          span.end.column > Array.from(endLine).length + 1) {
        return [];
      }
      const from = utf16OffsetForScalarColumn(beginLine, span.start.column);
      const to = utf16OffsetForScalarColumn(endLine, span.end.column);
      const startByte = lines[span.start.line - 1] +
        Buffer.byteLength(beginLine.slice(0, from), 'utf8');
      const endByte = lines[span.end.line - 1] +
        Buffer.byteLength(endLine.slice(0, to), 'utf8');
      if (startByte !== span.span[0] || endByte !== span.span[1]) {
        return [];
      }
      const begin = new vscode.Position(span.start.line - 1, from);
      const end = new vscode.Position(span.end.line - 1, to);
      locations.push(new vscode.Location(doc.uri, new vscode.Range(begin, end)));
    } catch {
      // A file may have disappeared or become a symlink during inspection.
      return [];
    }
  }
  // The time spent opening editor documents is part of the same snapshot
  // window: never publish reference positions after any source has changed.
  try {
    const current = await snapshotProjectDisk(snapshot.root, snapshot.requireManifest);
    if (!sameProjectDisk(snapshot.disk, current) ||
        dirtyScarpBuffers(snapshot.root) || !vscode.workspace.isTrusted ||
        configuredCompilerPath() !== snapshot.compilerPath) {
      return [];
    }
  } catch {
    return [];
  }
  return token.isCancellationRequested ? [] : locations;
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
