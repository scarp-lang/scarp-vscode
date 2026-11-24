import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  catalogScarpProjects, projectEntryPath, type ScarpProjectCandidate,
  type ScarpProjectDescription
} from './editorProjectCatalog';
import { buildScarpProjectTree, scarpProjectChildren,
  scarpProjectParent, scarpProjectBreadcrumb } from './editorProjectTree';

const COMMAND = 'scarp.browseWorkspaceProjects';
const MAX_MANIFESTS = 256;
function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
async function chooseRoot(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file');
  const current = vscode.window.activeTextEditor?.document;
  const active = current && vscode.workspace.getWorkspaceFolder(current.uri);
  if (active?.uri.scheme === 'file') { return active; }
  if (folders.length === 1) { return folders[0]; }
  const chosen = await vscode.window.showQuickPick(
    folders.map(folder => ({
      label: folder.name, description: folder.uri.fsPath, folder
    })),
    { placeHolder: 'Choose a local Scarp workspace root',
      matchOnDescription: true }
  );
  return chosen?.folder;
}
async function readManifest(
  root: string, actualRoot: string, uri: vscode.Uri
): Promise<ScarpProjectCandidate | undefined> {
  if (uri.scheme !== 'file' || !within(root, uri.fsPath)) { return undefined; }
  try {
    const [realFile, stat] = await Promise.all([
      fs.realpath(uri.fsPath), fs.lstat(uri.fsPath)
    ]);
    if (!within(actualRoot, realFile) || !stat.isFile() ||
        stat.isSymbolicLink() || stat.size > 4096) { return undefined; }
    const bytes = await fs.readFile(uri.fsPath);
    if (bytes.length > 4096) { return undefined; }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { filename: relative(root, uri.fsPath), content };
  } catch { return undefined; }
}
async function safeOpen(
  root: string, relativeFilename: string
): Promise<void> {
  const filename = path.resolve(root, ...relativeFilename.split('/'));
  const [realRoot, realFile, stat] = await Promise.all([
    fs.realpath(root), fs.realpath(filename), fs.lstat(filename)
  ]);
  if (!within(realRoot, realFile) || !stat.isFile() ||
      stat.isSymbolicLink()) {
    throw new Error('The selected project file is no longer a safe local file.');
  }
  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(vscode.Uri.file(realFile)),
    { preview: false }
  );
}
async function browseSourceTree(
  workspaceRoot: string, project: ScarpProjectDescription
): Promise<void> {
  const projectRoot = path.resolve(workspaceRoot,
    ...project.root.split('/').filter(Boolean));
  const [realWorkspace, realProject] = await Promise.all([
    fs.realpath(workspaceRoot), fs.realpath(projectRoot)
  ]);
  if (!within(realWorkspace, realProject)) {
    throw new Error('Project root escapes the selected workspace.');
  }
  const entries = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(projectRoot), '**/*.srp'),
    '**/{.git,node_modules,target,dist,build}/**', 513
  );
  if (entries.length > 512) {
    throw new Error('Too many project source files; open a narrower source folder.');
  }
  const filenames = entries.map(uri =>
    relative(projectRoot, uri.fsPath));
  const tree = buildScarpProjectTree(filenames, { maximumFiles: 512 });
  let folder = '';
  while (vscode.workspace.isTrusted) {
    const children = scarpProjectChildren(tree, folder);
    const items: SourceTreeChoice[] = [
      ...(folder ? [{
        label: '$(arrow-left) Parent folder',
        description: scarpProjectParent(tree, folder) || '(project root)',
        target: '..', choice: 'back' as const
      }] : []),
      ...children.map(item => ({
        label: (item.kind === 'folder' ? '$(folder) ' : '$(file-code) ') + item.name,
        description: item.kind === 'folder'
          ? item.descendantSources + ' Scarp files' : item.path,
        target: item.path, choice: item.kind
      }))
    ];
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: scarpProjectBreadcrumb(tree, folder).join(' / ') +
        ' (' + tree.sourceCount + ' sources)'
    });
    if (!selected || !vscode.workspace.isTrusted) { return; }
    if (selected.choice === 'back') {
      folder = scarpProjectParent(tree, folder) || '';
      continue;
    }
    if (selected.choice === 'folder') {
      folder = selected.target;
      continue;
    }
    const relativeFile = project.root
      ? project.root + '/' + selected.target : selected.target;
    await safeOpen(workspaceRoot, relativeFile);
    return;
  }
}
interface SourceTreeChoice extends vscode.QuickPickItem {
  readonly target: string;
  readonly choice: 'back' | 'folder' | 'source';
}
interface ProjectActionChoice extends vscode.QuickPickItem {
  readonly choice: 'entry' | 'manifest' | 'tree';
}
interface ProjectQuickPick extends vscode.QuickPickItem {
  project: ScarpProjectDescription;
}
/**
 * Explicit, compiler-free explorer for nested Scarp projects.
 * No project is run, initialized, installed, modified or verified here.
 */
export function registerWorkspaceProjectExplorer(
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(COMMAND, async () => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'Trust the workspace before reading local Scarp project files.');
      return;
    }
    const folder = await chooseRoot();
    if (!folder) {
      void vscode.window.showInformationMessage(
        'Open a local workspace folder before browsing Scarp projects.');
      return;
    }
    const root = folder.uri.fsPath;
    const found = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Scarp: discovering workspace projects',
      cancellable: true
    }, async (_progress, token) => {
      const manifests = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/{scarp.project,Scarp.project}'),
        '**/{.git,node_modules,target,dist,build}/**',
        MAX_MANIFESTS + 1, token
      );
      if (token.isCancellationRequested || !vscode.workspace.isTrusted) {
        return undefined;
      }
      if (manifests.length > MAX_MANIFESTS) {
        throw new Error('More than 256 project manifests found; ' +
          'open a narrower workspace folder to browse.');
      }
      const rootReal = await fs.realpath(root);
      const candidates: ScarpProjectCandidate[] = [];
      for (const uri of manifests) {
        if (token.isCancellationRequested || !vscode.workspace.isTrusted) {
          return undefined;
        }
        const candidate = await readManifest(root, rootReal, uri);
        if (candidate) { candidates.push(candidate); }
      }
      return catalogScarpProjects(candidates);
    });
    if (!found || !vscode.workspace.isTrusted) { return; }
    output.appendLine('Scarp workspace project catalog: ' + root);
    output.appendLine('Valid preview entries: ' + found.projects.length +
      '; unsupported manifests: ' + found.issues.length);
    for (const issue of found.issues) {
      output.appendLine('Project preview: ' + issue.kind +
        ' ' + issue.manifest + ': ' + issue.detail);
    }
    if (!found.projects.length) {
      void vscode.window.showInformationMessage(
        'No supported Scarp project manifests found.');
      return;
    }
    const items: ProjectQuickPick[] = found.projects.map(project => ({
      label: project.root || '(workspace root)',
      description: project.name + ' · ' + project.kind,
      detail: project.entry + (project.version ? ' · v' + project.version : ''),
      project
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a nested Scarp project (' +
        found.projects.length + ' discovered)',
      matchOnDescription: true, matchOnDetail: true
    });
    if (!picked || !vscode.workspace.isTrusted) { return; }
    const project = picked.project;
    const actions: ProjectActionChoice[] = [
      { label: 'Open Project Entry', choice: 'entry',
        description: project.entry },
      { label: 'Open Project Manifest', choice: 'manifest',
        description: project.manifest },
      { label: 'Browse Project Source Tree', choice: 'tree',
        description: 'Navigate nested Scarp source folders without executing code' }
    ];
    const action = await vscode.window.showQuickPick(actions, {
      placeHolder: 'Choose a read-only navigation action for ' + project.name
    });
    if (!action || !vscode.workspace.isTrusted) { return; }
    if (action.choice === 'tree') {
      try { await browseSourceTree(root, project); }
      catch (error) {
        void vscode.window.showWarningMessage('Cannot browse Scarp source tree: ' +
          (error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    const selected = action.choice === 'manifest'
      ? project.manifest : projectEntryPath(project);
    if (!selected) {
      void vscode.window.showWarningMessage('Scarp project entry path is unsafe.');
      return;
    }
    try { await safeOpen(root, selected); }
    catch (error) {
      void vscode.window.showWarningMessage(
        'Scarp project file unavailable: ' +
        (error instanceof Error ? error.message : String(error)));
    }
  });
}
