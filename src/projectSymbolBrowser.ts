import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { executeProcess } from './cli';
import { utf16OffsetForScalarColumn } from './diagnostics';
import { isWithinProject } from './projectChangeTracker';
import { type SourceSpan, parseProjectSymbols } from './navigationIndex';
import { sameProjectDisk, snapshotProjectDisk } from './projectDiskSnapshot';

function hasUnsavedProjectSource(root: string): boolean {
  return vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' &&
    doc.isDirty && isWithinProject(root, doc.uri.fsPath) &&
    (path.extname(doc.uri.fsPath).toLowerCase() === '.srp' ||
      path.basename(doc.uri.fsPath) === 'Scarp.project'));
}

/**
 * Convert a compiler byte span to VS Code UTF-16 positions, checking the
 * exact byte offsets rather than accepting VS Code's clamped coordinates.
 */
function checkedEditorRange(
  document: vscode.TextDocument, location: SourceSpan
): vscode.Range | undefined {
  if (location.start.line > document.lineCount ||
      location.end.line > document.lineCount) { return undefined; }
  const before = document.lineAt(location.start.line - 1).text;
  const after = document.lineAt(location.end.line - 1).text;
  if (location.start.column > Array.from(before).length + 1 ||
      location.end.column > Array.from(after).length + 1) { return undefined; }
  const first = new vscode.Position(location.start.line - 1,
    utf16OffsetForScalarColumn(before, location.start.column));
  const last = new vscode.Position(location.end.line - 1,
    utf16OffsetForScalarColumn(after, location.end.column));
  const contents = document.getText();
  const startByte = Buffer.byteLength(contents.slice(0, document.offsetAt(first)), 'utf8');
  const endByte = Buffer.byteLength(contents.slice(0, document.offsetAt(last)), 'utf8');
  if (startByte !== location.span[0] || endByte !== location.span[1]) {
    return undefined;
  }
  return new vscode.Range(first, last);
}

/**
 * A user-invoked, project-local source browser; never runs statements or
 * starts background indexing. Compiler IDs never persist between invocations.
 */
export async function browseProjectSymbols(
  root: string, binary: string, output: vscode.OutputChannel, timeoutMs: number
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before browsing Scarp project symbols.');
  }
  if (hasUnsavedProjectSource(root)) {
    throw new Error('Save all open Scarp project sources before browsing symbols.');
  }
  const before = await snapshotProjectDisk(root);
  const result = await executeProcess(binary,
    ['inspect', 'symbols', '--json', '--diagnostic-format=json', '--', root], {
      cwd: root, timeoutMs, maxOutputBytes: 4 * 1024 * 1024
    });
  if (result.exitCode !== 0) {
    if (result.stderr) { output.append(result.stderr); }
    output.show(true);
    throw new Error('Project symbol browsing requires Scarp v0.0.6-alpha.1+ ' +
      'and a statically valid project. See Scarp output for details.');
  }
  const canonicalRoot = await fs.realpath(root);
  const inventory = parseProjectSymbols(result.stdout, canonicalRoot);
  const after = await snapshotProjectDisk(root);
  if (hasUnsavedProjectSource(root) || !sameProjectDisk(before, after)) {
    throw new Error('Project changed during symbol inspection. Save and try again.');
  }

  const declarations = inventory.symbols.filter(symbol =>
    symbol.location !== null && symbol.kind !== 'module');
  if (!declarations.length) {
    vscode.window.showInformationMessage('Scarp project has no indexed declarations.');
    return;
  }
  const limit = 5000;
  const items = declarations.slice(0, limit).map(symbol => {
    const location = symbol.location!;
    const filename = inventory.files[location.source];
    return {
      label: symbol.name,
      description: symbol.kind + ' · ' + path.relative(canonicalRoot, filename),
      detail: 'Line ' + location.start.line + ', column ' + location.start.column,
      filename, location
    };
  });
  if (declarations.length > limit) {
    output.appendLine('Scarp symbol browser shows the first ' + limit +
      ' of ' + declarations.length + ' declarations.');
  }
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Scarp: Browse Project Symbols',
    placeHolder: 'Search compiler-verified declarations in this Scarp project',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!chosen) { return; }

  // A Quick Pick may stay open while another process rewrites a source file.
  if (hasUnsavedProjectSource(root) ||
      !sameProjectDisk(after, await snapshotProjectDisk(root))) {
    throw new Error('Project sources changed while selecting a symbol. Try again.');
  }
  const canonicalFile = await fs.realpath(chosen.filename);
  if (!isWithinProject(canonicalRoot, canonicalFile) ||
      path.extname(canonicalFile).toLowerCase() !== '.srp' ||
      !(await fs.stat(canonicalFile)).isFile()) {
    throw new Error('Selected symbol source no longer belongs to the project.');
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(canonicalFile));
  if (document.isDirty ||
      !Buffer.from(document.getText(), 'utf8').equals(await fs.readFile(canonicalFile))) {
    throw new Error('Selected source differs from the saved compiler snapshot.');
  }
  const range = checkedEditorRange(document, chosen.location);
  if (!range) {
    throw new Error('Compiler symbol coordinates do not match the saved source.');
  }
  if (hasUnsavedProjectSource(root) ||
      !sameProjectDisk(after, await snapshotProjectDisk(root))) {
    throw new Error('Project sources changed before opening the symbol. Try again.');
  }
  await vscode.window.showTextDocument(document, { selection: range, preview: true });
  output.appendLine('Scarp symbol browser opened ' + chosen.label + ' in ' + canonicalFile);
}
