import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { watch as nativeWatch, type FSWatcher } from 'node:fs';
import * as vscode from 'vscode';
import { compilerVersion, executeProcess, preferredExecutionVerb } from './cli';
import { parseDiagnostics, utf16OffsetForScalarColumn } from './diagnostics';
import { BUDGET_SETTINGS, BudgetSettings, budgetArguments } from './settings';
import { DiagnosticOwners } from './problemOwners';
import { DebouncedSerialTasks } from './saveVerification';
import { scanScarpSymbols, ScarpSymbolKind } from './documentSymbols';
import { hasProjectWorkflow, projectArgv, validProjectName } from './projectWorkflow';
import { isWithinProject, ProjectChangeTracker } from './projectChangeTracker';
import { snapshotProjectDisk, sameProjectDisk, type ProjectDiskSnapshot } from './projectDiskSnapshot';
import { ProjectWatchRegistry } from './projectWatchRegistry';
import { parseBrowsableProjectModules } from './projectModules';
import { registerCompilerNavigation } from './navigationProvider';
import { browseProjectSymbols } from './projectSymbolBrowser';

const running = new Map<string, vscode.Terminal>();
// Reserve a filename/root before the first await so simultaneous commands
// cannot start multiple terminals. Stop also invalidates pending launches.
const pendingStarts = new Map<string, { cancelled: boolean }>();
let stopGeneration = 0;
// Discard in-flight results if scarp.compilerPath changes.
// Previous verified Problems remain until the user checks again.
let compilerRevision = 0;
const checks = new Map<string, Promise<void>>();
const verifiedVersions = new Map<string, number>();
const projectChanges = new ProjectChangeTracker();
const activeProjectChecks = new Set<string>();
const config = () => vscode.workspace.getConfiguration('scarp');

function budgets(): string[] {
  const values = {} as BudgetSettings;
  for (const [key] of BUDGET_SETTINGS) { values[key] = config().get<number>(key); }
  return budgetArguments(values);
}
function selectedFile(): vscode.TextDocument {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== 'file' || path.extname(doc.uri.fsPath).toLowerCase() !== '.srp') {
    throw new Error('Open a Scarp .srp source file first.');
  }
  if (!vscode.workspace.isTrusted) { throw new Error('Trust the workspace before running Scarp.'); }
  return doc;
}
async function ensureSaved(doc: vscode.TextDocument): Promise<void> {
  if (doc.isDirty && !(await doc.save())) { throw new Error('Save the source file first.'); }
}
async function validateCompiler(): Promise<{ binary: string; version: string }> {
  const binary = config().get<string>('compilerPath', 'scarp').trim();
  if (!binary) { throw new Error('Set scarp.compilerPath to an executable.'); }
  let result;
  try {
    result = await executeProcess(binary, ['--version'], { timeoutMs: 5000, maxOutputBytes: 65536 });
  } catch (error) {
    throw new Error('Scarp compiler not found at ' + binary + ': ' + String(error));
  }
  const version = result.exitCode === 0 ? compilerVersion(result.stdout) : undefined;
  if (!version) { throw new Error('Invalid Scarp --version response from ' + binary); }
  return { binary, version };
}
/**
 * Probe a compiler capability instead of guessing from its version string.
 * Alpha.3 introduces a non-executing verify route. Older releases use check,
 * which may evaluate code; we document this important distinction.
 */
async function supportsStaticVerify(binary: string): Promise<boolean> {
  try {
    const result = await executeProcess(binary, ['verify', '--help'], {
      timeoutMs: 5000,
      maxOutputBytes: 32768
    });
    return result.exitCode === 0 && /Usage:\s*scarp verify\b/.test(result.stdout);
  } catch {
    return false;
  }
}

function applyProblems(
  collection: vscode.DiagnosticCollection, updates: ReadonlyMap<string, readonly vscode.Diagnostic[]>
): void {
  for (const [key, items] of updates) {
    if (items.length) { collection.set(vscode.Uri.parse(key), [...items]); }
    else { collection.delete(vscode.Uri.parse(key)); }
  }
}

async function showProblems(
  doc: vscode.TextDocument, stderr: string, collection: vscode.DiagnosticCollection,
  owners: DiagnosticOwners<vscode.Diagnostic>, expectedVersion: number,
  isCurrent: () => boolean | Promise<boolean> = () => true
): Promise<number | undefined> {
  const groups = new Map<string, vscode.Diagnostic[]>();
  for (const entry of parseDiagnostics(stderr)) {
    const resolved = path.isAbsolute(entry.filename)
      ? entry.filename : path.resolve(path.dirname(doc.uri.fsPath), entry.filename);
    const uri = vscode.Uri.file(resolved);
    let source: vscode.TextDocument;
    try { source = await vscode.workspace.openTextDocument(uri); }
    catch { continue; }
    const line = Math.min(entry.line - 1, Math.max(source.lineCount - 1, 0));
    const text = source.lineAt(line).text;
    const column = Math.min(utf16OffsetForScalarColumn(text, entry.column), text.length);
    const endLine = Math.min((entry.endLine ?? entry.line) - 1, Math.max(source.lineCount - 1, 0));
    const endText = source.lineAt(endLine).text;
    const endColumn = entry.endColumn === undefined
      ? Math.min(column + 1, text.length)
      : Math.min(utf16OffsetForScalarColumn(endText, entry.endColumn), endText.length);
    const end = endLine > line || (endLine === line && endColumn > column)
      ? new vscode.Position(endLine, endColumn)
      : new vscode.Position(line, Math.min(column + 1, text.length));
    const range = new vscode.Range(new vscode.Position(line, column), end);
    const severity = entry.severity === 'warning'
      ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
    const diagnostic = new vscode.Diagnostic(range,
      entry.help ? entry.message + '\nHelp: ' + entry.help : entry.message, severity);
    diagnostic.source = 'Scarp';
    if (entry.code) { diagnostic.code = entry.code; }
    const key = uri.toString();
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  }
  // The source may have changed while the external compiler was checking it.
  // Never overwrite current Problems with diagnostics from a stale snapshot.
  if (doc.version !== expectedVersion || !(await isCurrent())) { return undefined; }
  applyProblems(collection, owners.replace(doc.uri.toString(), groups));
  return [...groups.values()].reduce((sum, items) => sum + items.length, 0);
}
type VerificationMode = 'manual' | 'save';

async function check(
  doc: vscode.TextDocument, output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection, owners: DiagnosticOwners<vscode.Diagnostic>,
  mode: VerificationMode = 'manual', requestedVersion?: number
): Promise<void> {
  const filename = doc.uri.fsPath;
  const revision = compilerRevision;
  if (mode === 'manual' && checks.has(filename)) {
    throw new Error('Scarp is already checking this file.');
  }
  if (mode === 'save') {
    // A manual check can trigger a save, and a new save can arrive during a
    // compiler run. Serialize and only verify the newest saved document.
    while (checks.has(filename)) {
      try { await checks.get(filename); }
      catch { /* The previous check is handled by its own caller. */ }
    }
    if (!vscode.workspace.isTrusted || doc.isDirty ||
        doc.version !== requestedVersion ||
        verifiedVersions.get(filename) === requestedVersion ||
        !vscode.workspace.getConfiguration('scarp', doc.uri).get<boolean>('verifyOnSave', false)) {
      return;
    }
  }

  const work = (async () => {
    if (mode === 'manual') { await ensureSaved(doc); }
    if (revision !== compilerRevision) { return; }
    const expectedVersion = doc.version;
    const { binary, version } = await validateCompiler();
    if (revision !== compilerRevision) { return; }
    const staticVerify = await supportsStaticVerify(binary);
    if (revision !== compilerRevision) { return; }
    if (mode === 'save' && !staticVerify) {
      // Never run the older evaluating check automatically on an editor save.
      output.appendLine('Scarp verify on save skipped: installed compiler does not support static verify.');
      return;
    }
    if (mode === 'manual') { output.clear(); }
    output.appendLine('Scarp ' + version + (staticVerify
      ? ' — static verify ' : ' — legacy evaluating check ') + filename);
    const argumentsForCheck = staticVerify
      ? ['verify', '--diagnostic-format=json', '--', filename]
      : ['check', ...budgets(), '--', filename];
    const result = await executeProcess(binary, argumentsForCheck, {
      cwd: path.dirname(filename),
      timeoutMs: vscode.workspace.getConfiguration('scarp', doc.uri)
        .get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 1024 * 1024
    });
    if (result.stdout) { output.append(result.stdout); }
    if (result.stderr) { output.append(result.stderr); }
    const count = await showProblems(doc, result.stderr, diagnostics, owners,
      expectedVersion, () => revision === compilerRevision);
    if (count === undefined) {
      output.appendLine(revision !== compilerRevision
        ? 'Scarp compiler changed during file verification; previous result discarded.'
        : 'Document changed during verification; outdated diagnostics discarded.');
      return;
    }
    verifiedVersions.set(filename, expectedVersion);
    if (mode === 'save') {
      output.appendLine(result.exitCode === 0
        ? 'Scarp static verification on save passed.'
        : 'Scarp static verification on save found ' + count + ' diagnostic(s).');
      return;
    }
    if (result.exitCode === 0) {
      vscode.window.showInformationMessage(staticVerify
        ? 'Scarp static verification passed.' : 'Scarp legacy check passed.');
    } else {
      output.show(true);
      vscode.window.showErrorMessage('Scarp check exited ' + String(result.exitCode)
        + '. ' + count + ' diagnostic(s); see Scarp output.');
    }
  })();
  checks.set(filename, work);
  try {
    await work;
  } finally {
    if (checks.get(filename) === work) { checks.delete(filename); }
  }
}
/** Never assume project support from a version string or from the old evaluating check. */
async function validateProjectCompiler(): Promise<{ binary: string; version: string }> {
  const compiler = await validateCompiler();
  const result = await executeProcess(compiler.binary, ['diagnose', '--json'], {
    timeoutMs: 5000, maxOutputBytes: 65536
  });
  if (result.exitCode !== 0 || !hasProjectWorkflow(result.stdout)) {
    throw new Error(
      'Project commands require the official Scarp v0.0.5-alpha.4+ compiler with project_workflow support. '
      + 'Update the compiler or adjust scarp.compilerPath.'
    );
  }
  return compiler;
}

/** Select only an explicit workspace root, never search for parent manifests. */
async function projectDirectory(provided?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before using Scarp project commands.');
  }
  let uri = provided;
  if (!uri) {
    const folder = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select the Scarp project folder containing Scarp.project'
    });
    uri = folder?.uri;
  }
  if (!uri) { return undefined; }
  if (uri.scheme !== 'file') {
    throw new Error('Scarp projects require a local filesystem directory.');
  }
  let directory: vscode.FileStat;
  try { directory = await vscode.workspace.fs.stat(uri); }
  catch { throw new Error('Selected Scarp project directory does not exist.'); }
  if ((directory.type & vscode.FileType.Directory) === 0) {
    throw new Error('Select a Scarp project directory, not an individual file.');
  }
  const manifest = vscode.Uri.joinPath(uri, 'Scarp.project');
  try {
    const stat = await vscode.workspace.fs.stat(manifest);
    if ((stat.type & vscode.FileType.File) === 0) { throw new Error('invalid'); }
  } catch {
    throw new Error('The selected folder has no Scarp.project file. '
      + 'Open an existing Scarp project root or create a project first.');
  }
  return uri;
}

async function verifyProject(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection, owners: DiagnosticOwners<vscode.Diagnostic>,
  projectMonitors: ProjectWatchRegistry, onSourceChanged: (filename: string) => void
): Promise<void> {
  const directory = await projectDirectory(explicit);
  if (!directory) { return; }
  const key = directory.fsPath;
  const revision = compilerRevision;
  if (activeProjectChecks.has(key)) {
    throw new Error('Scarp is already verifying this project.');
  }
  // Start watching before asynchronous compiler work so source edits cannot
  // turn an old verification into fresh Problems.
  activeProjectChecks.add(key);
  const watch = projectChanges.watch(key);
  try {
    const manifest = vscode.Uri.joinPath(directory, 'Scarp.project');
    const doc = await vscode.workspace.openTextDocument(manifest);
    // The real compiler reads saved files from disk, not unsaved editor buffers.
    const dirty = vscode.workspace.textDocuments.find(source =>
      source.uri.scheme === 'file' && source.isDirty &&
      isWithinProject(key, source.uri.fsPath) &&
      (path.extname(source.uri.fsPath).toLowerCase() === '.srp' ||
        path.basename(source.uri.fsPath) === 'Scarp.project')
    );
    if (dirty) {
      throw new Error('Save open Scarp project files before verifying: ' + dirty.uri.fsPath);
    }
    const manifestVersion = doc.version;
    let acceptedSnapshot: ProjectDiskSnapshot | undefined;
    // Capture the actual on-disk source tree before compiler work begins.
    // VS Code editor events alone cannot see another process rewriting a file.
    const diskBefore = await snapshotProjectDisk(key);
    if (revision !== compilerRevision) { return; }
    const { binary, version } = await validateProjectCompiler();
    if (revision !== compilerRevision) { return; }
    output.clear();
    output.appendLine('Scarp ' + version + ' — static verify project ' + key);
    const result = await executeProcess(binary, projectArgv('verify', key), {
      cwd: key,
      timeoutMs: config().get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 1024 * 1024
    });
    if (result.stdout) { output.append(result.stdout); }
    if (result.stderr) { output.append(result.stderr); }
    const count = await showProblems(doc, result.stderr, diagnostics, owners,
      manifestVersion, async () => {
        if (revision !== compilerRevision || !watch.isCurrent()) { return false; }
        try {
          const diskAfter = await snapshotProjectDisk(key);
          const unchanged = sameProjectDisk(diskBefore, diskAfter) &&
            watch.isCurrent() && revision === compilerRevision;
          if (unchanged) { acceptedSnapshot = diskAfter; }
          return unchanged;
        } catch (error) {
          output.appendLine('Scarp project disk snapshot could not be validated: ' + String(error));
          return false;
        }
      });
    if (count === undefined) {
      if (revision !== compilerRevision) {
        // This attempt never became authoritative. Preserve completed project
        // diagnostics and their file watchers, just as for standalone checks.
        output.appendLine('Scarp compiler changed during project verification; '
          + 'previous result discarded.');
        return;
      }
      // A source edit or disk rewrite invalidates previously verified Problems.
      projectMonitors.stopRoot(key);
      projectChanges.forgetCompleted(key);
      applyProblems(diagnostics, owners.replace(manifest.toString(), new Map()));
      output.appendLine('Project changed during verification; outdated diagnostics discarded. '
        + 'Save your changes and verify again.');
      return;
    }
    // Future in-editor edits anywhere in this project invalidate this root's
    // compiler snapshot, even if the edited file itself had no Problems.
    if (!acceptedSnapshot) {
      throw new Error('Project snapshot was not retained after verification.');
    }
    projectChanges.completedVerification(key, manifest.toString());
    try {
      // Only verified explicit roots are watched; no implicit workspace scan.
      projectMonitors.track(key, manifest.toString(), onSourceChanged, acceptedSnapshot);
    } catch (error) {
      // If a watcher could not be established, do not retain unmonitored
      // diagnostic ownership indefinitely.
      projectChanges.forgetCompleted(key);
      applyProblems(diagnostics, owners.replace(manifest.toString(), new Map()));
      output.appendLine('Scarp project monitoring unavailable: ' + String(error));
    }
    if (result.exitCode === 0) {
      vscode.window.showInformationMessage('Scarp project static verification passed.');
    } else {
      output.show(true);
      vscode.window.showErrorMessage('Scarp project verification failed (exit '
        + String(result.exitCode) + ', ' + String(count) + ' located diagnostic(s)). '
        + 'See Scarp output for manifest or unlocated errors.');
    }
  } finally {
    watch.dispose();
    activeProjectChecks.delete(key);
  }
}


/**
 * Read the published alpha.5 module graph without running project statements.
 * A trusted, explicit root is required. The compiler reads the filesystem:
 * reject unsaved buffers and discard source inventories when disk changes
 * during inspection, Quick Pick selection or opening the target document.
 */
function unsavedProjectInput(root: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(source =>
    source.uri.scheme === 'file' && source.isDirty &&
    isWithinProject(root, source.uri.fsPath) &&
    (path.extname(source.uri.fsPath).toLowerCase() === '.srp' ||
      path.basename(source.uri.fsPath) === 'Scarp.project')
  );
}
async function browseProjectModules(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel
): Promise<void> {
  const directory = await projectDirectory(explicit);
  if (!directory) { return; }
  const root = directory.fsPath;
  const unsaved = unsavedProjectInput(root);
  if (unsaved) {
    throw new Error('Save open Scarp project files before browsing modules: ' +
      unsaved.uri.fsPath);
  }

  // Include compiler capability detection in the consistency window:
  // the project must be unchanged throughout the entire static lookup.
  const before = await snapshotProjectDisk(root);
  const { binary, version } = await validateProjectCompiler();
  const result = await executeProcess(binary,
    ['inspect', 'modules', '--json', '--diagnostic-format=json', '--', root], {
      cwd: root,
      timeoutMs: config().get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 2 * 1024 * 1024
    });
  if (result.exitCode !== 0) {
    output.appendLine('Scarp ' + version + ' — module inspection failed for ' + root);
    if (result.stderr) { output.append(result.stderr); }
    output.show(true);
    throw new Error('Project module browsing requires Scarp v0.0.5-alpha.5+ ' +
      'and a statically valid project. See Scarp output for compiler diagnostics.');
  }
  const after = await snapshotProjectDisk(root);
  if (!sameProjectDisk(before, after) || unsavedProjectInput(root)) {
    throw new Error('Scarp project changed during module inspection. Save files and retry.');
  }
  const canonicalRoot = await fs.realpath(root);
  const modules = parseBrowsableProjectModules(result.stdout, canonicalRoot);
  const selected = await vscode.window.showQuickPick(modules.map(module => ({
    label: module.displayPath,
    description: module.isEntry ? 'Entry module' : undefined,
    detail: module.importCount + ' import(s), ' + module.publicSymbols +
      ' public symbol(s)',
    filename: module.filename
  })), {
    title: 'Scarp: Browse Project Modules',
    placeHolder: 'Select a statically inspected source module to open'
  });
  if (!selected) { return; }
  if (unsavedProjectInput(root) ||
      !sameProjectDisk(after, await snapshotProjectDisk(root))) {
    throw new Error('Scarp project changed while choosing a module. Retry inspection.');
  }

  // Re-resolve after the user chooses: a symlink might have changed between
  // the compiler's snapshot, opening the picker and selecting a file.
  const canonicalFile = await fs.realpath(selected.filename);
  if (!isWithinProject(canonicalRoot, canonicalFile) ||
      path.extname(canonicalFile).toLowerCase() !== '.srp' ||
      !(await fs.stat(canonicalFile)).isFile()) {
    throw new Error('Selected Scarp module no longer resolves to a project source file.');
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(canonicalFile));
  // A clean VS Code buffer can lag an external filesystem rewrite.
  if (document.isDirty ||
      !Buffer.from(document.getText(), 'utf8').equals(await fs.readFile(canonicalFile))) {
    throw new Error('Selected Scarp module differs from the saved compiler snapshot.');
  }
  if (unsavedProjectInput(root) ||
      !sameProjectDisk(after, await snapshotProjectDisk(root))) {
    throw new Error('Scarp project changed before opening the selected module. Retry.');
  }
  await vscode.window.showTextDocument(document, { preview: true });
  output.appendLine('Scarp ' + version + ' — opened project module ' + canonicalFile);
}

async function launchProject(explicit: vscode.Uri | undefined,
  output: vscode.OutputChannel): Promise<void> {
  // Stop can be pressed while the workspace folder picker is still open.
  const generation = stopGeneration;
  const revision = compilerRevision;
  const directory = await projectDirectory(explicit);
  if (!directory || generation !== stopGeneration || revision !== compilerRevision) { return; }
  const key = directory.fsPath;
  if (running.has(key) || pendingStarts.has(key)) {
    running.get(key)?.show();
    throw new Error('Scarp is already running or starting this project. Stop it before relaunching.');
  }
  const pending = { cancelled: false };
  pendingStarts.set(key, pending);
  try {
    const { binary, version } = await validateProjectCompiler();
    if (pending.cancelled || generation !== stopGeneration ||
        revision !== compilerRevision) {
      output.appendLine('Scarp project launch cancelled before terminal startup.');
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: 'Scarp Project: ' + path.basename(key),
      shellPath: binary,
      shellArgs: projectArgv('launch', key, budgets()),
      cwd: key
    });
    running.set(key, terminal);
    output.appendLine('Scarp ' + version + ' — launch project ' + key);
    terminal.show();
  } catch (error) {
    // A Stop that overlaps compiler capability detection wins over startup.
    if (!pending.cancelled && generation === stopGeneration &&
        revision === compilerRevision) { throw error; }
  } finally {
    if (pendingStarts.get(key) === pending) { pendingStarts.delete(key); }
  }
}

async function createProject(output: vscode.OutputChannel): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before creating a Scarp project.');
  }
  const parent = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select an existing workspace folder as the parent of the NEW Scarp project'
  });
  if (!parent) { return; }
  if (parent.uri.scheme !== 'file') {
    throw new Error('Scarp project creation requires a local workspace folder.');
  }
  const name = await vscode.window.showInputBox({
    title: 'Create Scarp Project',
    prompt: 'Name for a new subfolder (existing destinations are never overwritten)',
    placeHolder: 'hello-world',
    validateInput: text => validProjectName(text) ? undefined
      : 'Use one folder name (1–96 UTF-8 bytes), without separators, colons or control characters.'
  });
  if (name === undefined) { return; }
  if (!validProjectName(name)) { throw new Error('Invalid Scarp project folder name.'); }
  const destination = path.join(parent.uri.fsPath, name);
  const { binary, version } = await validateProjectCompiler();
  const result = await executeProcess(binary, projectArgv('create', destination), {
    cwd: parent.uri.fsPath, timeoutMs: 30000, maxOutputBytes: 65536
  });
  if (result.stdout) { output.append(result.stdout); }
  if (result.stderr) { output.append(result.stderr); }
  if (result.exitCode !== 0) {
    output.show(true);
    throw new Error('Scarp project creation failed. The compiler will not overwrite '
      + 'an existing directory. See Scarp output.');
  }
  output.appendLine('Created Scarp ' + version + ' project ' + destination);
  const choice = await vscode.window.showInformationMessage(
    'Created Scarp project ' + name + '.', 'Open Project'
  );
  if (choice === 'Open Project') {
    await vscode.commands.executeCommand('vscode.openFolder',
      vscode.Uri.file(destination), { forceNewWindow: true });
  }
}

async function run(doc: vscode.TextDocument, output: vscode.OutputChannel): Promise<void> {
  const filename = doc.uri.fsPath;
  const generation = stopGeneration;
  const revision = compilerRevision;
  if (running.has(filename) || pendingStarts.has(filename)) {
    running.get(filename)?.show();
    throw new Error('Scarp is already running or starting this file. Stop it before running again.');
  }
  const pending = { cancelled: false };
  pendingStarts.set(filename, pending);
  try {
    await ensureSaved(doc);
    if (pending.cancelled || generation !== stopGeneration ||
        revision !== compilerRevision) {
      output.appendLine('Scarp file run cancelled before compiler detection.');
      return;
    }
    const { binary, version } = await validateCompiler();
    if (pending.cancelled || generation !== stopGeneration ||
        revision !== compilerRevision) {
      output.appendLine('Scarp file run cancelled during compiler detection.');
      return;
    }
    const command = await preferredExecutionVerb(binary);
    if (pending.cancelled || generation !== stopGeneration ||
        revision !== compilerRevision) {
      output.appendLine('Scarp file run cancelled before terminal startup.');
      return;
    }
    // VS Code launches the compiler directly as the terminal process.
    // shellArgs are argv entries, not interpolated source text.
    const terminal = vscode.window.createTerminal({
      name: 'Scarp: ' + path.basename(filename),
      shellPath: binary,
      shellArgs: [command, ...budgets(), '--', filename],
      cwd: path.dirname(filename)
    });
    running.set(filename, terminal);
    output.appendLine('Scarp ' + version + ' — ' + command + ' ' + filename);
    terminal.show();
  } catch (error) {
    if (!pending.cancelled && generation === stopGeneration &&
        revision === compilerRevision) { throw error; }
  } finally {
    if (pendingStarts.get(filename) === pending) { pendingStarts.delete(filename); }
  }
}
function stop(): void {
  const count = running.size;
  const pendingCount = pendingStarts.size;
  stopGeneration++;
  for (const pending of pendingStarts.values()) { pending.cancelled = true; }
  for (const terminal of running.values()) { terminal.dispose(); }
  running.clear();
  vscode.window.showInformationMessage(count || pendingCount
    ? 'Stopped ' + count + ' Scarp terminal(s); cancelled ' + pendingCount + ' pending start(s).'
    : 'No Scarp program is running.');
}

async function safe(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    // Keep command completion awaitable for callers and Extension Host tests.
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Scarp');
  const diagnostics = vscode.languages.createDiagnosticCollection('scarp');
  const owners = new DiagnosticOwners<vscode.Diagnostic>();
  const projectMonitors = new ProjectWatchRegistry(
    (root, pattern, changed) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), pattern)
      );
      const subscriptions = [
        watcher.onDidCreate(uri => changed(uri.fsPath)),
        watcher.onDidChange(uri => changed(uri.fsPath)),
        watcher.onDidDelete(uri => changed(uri.fsPath))
      ];
      // VS Code's recursive watchers can omit out-of-workspace events on
      // some editor/OS combinations. Also use one bounded native recursive
      // subscription per verified project as a best-effort fallback.
      let native: FSWatcher | undefined;
      if (pattern === '**/*.srp') {
        try {
          native = nativeWatch(root, { recursive: true }, (event, filename) => {
            const relative = filename?.toString();
            // A folder rename can invalidate imported files even when its
            // own name does not have a .srp extension.
            if (!relative || path.extname(relative).toLowerCase() === '.srp' ||
                relative === 'Scarp.project' ||
                (event === 'rename' && !path.extname(relative))) {
              changed(path.join(root, relative || 'Scarp.project'));
            }
          });
          native.on('error', error => {
            output.appendLine('Scarp native project watch error: ' + String(error));
            changed(path.join(root, 'Scarp.project'));
          });
        } catch (error) {
          output.appendLine('Scarp native project watch unavailable: ' + String(error));
        }
      }
      return { dispose() {
        native?.close();
        subscriptions.forEach(subscription => subscription.dispose());
        watcher.dispose();
      } };
    },
    (root, owner) => {
      projectChanges.forgetCompleted(root);
      applyProblems(diagnostics, owners.replace(owner, new Map()));
    }
  );
  const invalidateProject = (filename: string): void => {
    for (const owner of projectChanges.changed(filename)) {
      projectMonitors.stopOwner(owner);
      applyProblems(diagnostics, owners.replace(owner, new Map()));
    }
  };
  const reconcileVerifiedProjects = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) { return; }
    const invalidated = await projectMonitors.reconcile();
    if (invalidated) {
      output.appendLine('Scarp: cleared diagnostics from ' + invalidated +
        ' changed project(s). Re-run Verify Project to refresh Problems.');
    }
  };
  const saveVerifier = new DebouncedSerialTasks<{ doc: vscode.TextDocument; version: number }>(
    300,
    async (_key, request) => {
      const doc = request.doc;
      if (doc.isClosed || doc.uri.scheme !== 'file' ||
          path.extname(doc.uri.fsPath).toLowerCase() !== '.srp') { return; }
      await check(doc, output, diagnostics, owners, 'save', request.version);
    },
    error => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine('Scarp verify on save failed: ' + message);
    }
  );
  const kinds: Record<ScarpSymbolKind, vscode.SymbolKind> = {
    function: vscode.SymbolKind.Function,
    constant: vscode.SymbolKind.Constant,
    variable: vscode.SymbolKind.Variable,
    import: vscode.SymbolKind.Namespace
  };
  const navigation = vscode.languages.registerDocumentSymbolProvider(
    { language: 'scarp' },
    {
      provideDocumentSymbols(document, token): vscode.DocumentSymbol[] {
        if (token.isCancellationRequested) { return []; }
        return scanScarpSymbols(document.getText()).map(item => new vscode.DocumentSymbol(
          item.name, item.detail, kinds[item.kind],
          new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
          new vscode.Range(document.positionAt(item.selectionStart),
            document.positionAt(item.selectionEnd))
        ));
      }
    },
    { label: 'Scarp declarations' }
  );
  context.subscriptions.push(output, diagnostics, saveVerifier, navigation, projectMonitors,
    ...registerCompilerNavigation(output),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        void reconcileVerifiedProjects().catch(error =>
          output.appendLine('Scarp project reconciliation error: ' + String(error))
        );
      }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!vscode.workspace.isTrusted || doc.uri.scheme !== 'file' ||
          doc.languageId !== 'scarp' ||
          path.extname(doc.uri.fsPath).toLowerCase() !== '.srp' ||
          !vscode.workspace.getConfiguration('scarp', doc.uri)
            .get<boolean>('verifyOnSave', false)) { return; }
      saveVerifier.request(doc.uri.toString(), { doc, version: doc.version });
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length === 0) { return; }
      if (event.document.uri.scheme === 'file') {
        // Scarp.project is normally not assigned the 'scarp' language ID.
        // A file with no previous errors can still invalidate the project.
        invalidateProject(event.document.uri.fsPath);
      }
      if (event.document.languageId !== 'scarp') { return; }
      verifiedVersions.delete(event.document.uri.fsPath);
      applyProblems(diagnostics, owners.invalidateChanged(event.document.uri.toString()));
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      verifiedVersions.delete(doc.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scarp.compilerPath')) {
        // A delayed probe/check from the previous executable must never
        // publish new Problems or open a terminal after this setting changes.
        compilerRevision++;
        for (const pending of pendingStarts.values()) { pending.cancelled = true; }
        output.appendLine('Scarp compiler changed; in-flight results and pending launches invalidated.');
      }
      if (event.affectsConfiguration('scarp.compilerPath') ||
          event.affectsConfiguration('scarp.verifyOnSave')) {
        verifiedVersions.clear();
      }
    }),
    vscode.commands.registerCommand('scarp.createProject',
      (): Promise<void> => safe(async () => createProject(output))),
    vscode.commands.registerCommand('scarp.verifyProject',
      (uri?: vscode.Uri): Promise<void> => safe(async () => verifyProject(
        uri, output, diagnostics, owners, projectMonitors, invalidateProject))),
    vscode.commands.registerCommand('scarp.reconcileProjects',
      (): Promise<void> => safe(reconcileVerifiedProjects)),
    vscode.commands.registerCommand('scarp.browseProjectModules',
      (uri?: vscode.Uri): Promise<void> => safe(async () => browseProjectModules(uri, output))),
    vscode.commands.registerCommand('scarp.browseProjectSymbols',
      (uri?: vscode.Uri): Promise<void> => safe(async () => {
        const directory = await projectDirectory(uri);
        if (!directory) { return; }
        const { binary } = await validateProjectCompiler();
        await browseProjectSymbols(directory.fsPath, binary, output,
          config().get<number>('checkTimeoutMs', 30000));
      })),
    vscode.commands.registerCommand('scarp.launchProject',
      (uri?: vscode.Uri): Promise<void> => safe(async () => launchProject(uri, output))),
    vscode.commands.registerCommand('scarp.runFile', () => safe(async () => run(selectedFile(), output))),
    vscode.commands.registerCommand('scarp.checkFile', (): Promise<void> => safe(async () => check(selectedFile(), output, diagnostics, owners))),
    vscode.commands.registerCommand('scarp.showVersion', () => safe(async () => {
      if (!vscode.workspace.isTrusted) { throw new Error('Trust the workspace before invoking the compiler.'); }
      const { binary, version } = await validateCompiler();
      vscode.window.showInformationMessage('Scarp ' + version + ' (' + binary + ')');
    })),
    vscode.commands.registerCommand('scarp.stopProgram', stop),
    vscode.commands.registerCommand('scarp.showOutput', () => output.show(true)),
    vscode.window.onDidCloseTerminal(terminal => {
      for (const [file, active] of running) {
        if (terminal === active) { running.delete(file); }
      }
    })
  );
}
export function deactivate(): void {
  for (const terminal of running.values()) { terminal.dispose(); }
  running.clear();
}
