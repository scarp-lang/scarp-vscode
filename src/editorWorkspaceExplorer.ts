import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildScarpImportGraph } from './editorImportGraph';
import { collectScarpWorkspaceSources } from './editorWorkspaceInventory';

const MAX_FILES = 512;
function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function chooseRoot(): Promise<vscode.WorkspaceFolder | undefined> {
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file');
  if (!roots.length) { return undefined; }
  const document = vscode.window.activeTextEditor?.document;
  const active = document && vscode.workspace.getWorkspaceFolder(document.uri);
  if (active?.uri.scheme === 'file') { return active; }
  if (roots.length === 1) { return roots[0]; }
  const item = await vscode.window.showQuickPick(
    roots.map(root => ({
      label: root.name, description: root.uri.fsPath, root
    })),
    { placeHolder: 'Choose a local Scarp workspace root', matchOnDescription: true }
  );
  return item?.root;
}
interface ModuleItem extends vscode.QuickPickItem {
  readonly filename: string;
}
/**
 * Explicit, read-only local Scarp module explorer. Never invokes compiler,
 * executes Scarp source or follows symlinks outside the selected root.
 */
export function registerWorkspaceImportExplorer(
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('scarp.browseWorkspaceImports', async () => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'Trust the workspace before inspecting local Scarp source files.');
      return;
    }
    const root = await chooseRoot();
    if (!root) {
      void vscode.window.showInformationMessage(
        'Open a local workspace folder before inspecting Scarp imports.');
      return;
    }
    const directory = root.uri.fsPath;
    const snapshot = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Scarp: inspect local workspace imports',
      cancellable: true
    }, async (_progress, token) => {
      const cancellation = new AbortController();
      const subscription = token.onCancellationRequested(() => cancellation.abort());
      try {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(root, '**/*.srp'),
          '**/{.git,node_modules,dist,target,build}/**', MAX_FILES + 1, token
        );
        if (token.isCancellationRequested || !vscode.workspace.isTrusted) {
          return undefined;
        }
        if (files.length > MAX_FILES) {
          throw new Error('More than 512 Scarp source files discovered. ' +
            'Open a narrower workspace folder before browsing.');
        }
        const inventory = await collectScarpWorkspaceSources(
          directory, files.map(uri => uri.fsPath),
          { maxFiles: MAX_FILES, maxFileBytes: 1_000_000,
            maxTotalBytes: 16_000_000, signal: cancellation.signal }
        );
        if (token.isCancellationRequested || !vscode.workspace.isTrusted) {
          return undefined;
        }
        return { inventory, graph: buildScarpImportGraph(inventory.sources) };
      } finally {
        subscription.dispose();
      }
    });
    if (!snapshot || !vscode.workspace.isTrusted) { return; }
    const { graph, inventory } = snapshot;
    output.appendLine('Local Scarp workspace imports: ' + directory);
    output.appendLine('Modules ' + graph.nodes.length +
      '; edges ' + graph.edges.length + '; cycles ' +
      graph.cycles.length + '; bytes ' + inventory.byteCount);
    for (const issue of inventory.issues) {
      output.appendLine('Source: ' + issue.reason + ' ' + issue.file);
    }
    for (const issue of graph.issues) {
      output.appendLine('Graph: ' + issue.kind + ' in ' + issue.file +
        ' - ' + issue.message);
    }
    if (!graph.nodes.length) {
      void vscode.window.showInformationMessage('No readable local Scarp modules found.');
      return;
    }
    const items: ModuleItem[] = graph.nodes.map(node => {
      const warnings = graph.issues.filter(issue => issue.file === node.file).length;
      return {
        label: node.file,
        description: node.imports.length + ' imports; ' +
          node.importedBy.length + ' imported by',
        detail: warnings ? warnings + ' local graph warnings' :
          'Local Scarp module, import depth ' + node.depth,
        filename: node.file
      };
    });
    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: 'Choose a Scarp source (' + graph.nodes.length +
        ' modules, ' + graph.issues.length + ' warnings)',
      matchOnDescription: true, matchOnDetail: true
    });
    if (!chosen || !vscode.workspace.isTrusted) { return; }
    const target = path.resolve(directory, ...chosen.filename.split('/'));
    try {
      const [realRoot, realTarget, stat] = await Promise.all([
        fs.realpath(directory), fs.realpath(target), fs.lstat(target)
      ]);
      if (!within(realRoot, realTarget) || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Selected module is no longer a safe local source file.');
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(realTarget));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      void vscode.window.showWarningMessage('Scarp module unavailable: ' +
        (error instanceof Error ? error.message : String(error)));
    }
  });
}
