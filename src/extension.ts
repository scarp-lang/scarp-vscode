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
import {
  snapshotProjectDisk, snapshotScarpSourceFile, sameProjectDisk,
  type ProjectDiskSnapshot
} from './projectDiskSnapshot';
import { ProjectWatchRegistry } from './projectWatchRegistry';
import { parseBrowsableProjectModules } from './projectModules';
import { registerCompilerNavigation } from './navigationProvider';
import { browseProjectSymbols } from './projectSymbolBrowser';
import { scarpBuiltinAt } from './builtinHelp';
import { scarpSignatureAt } from './builtinSignature';
import { scarpBuiltinCompletionAt } from './builtinCompletion';

const running = new Map<string, vscode.Terminal>();
// Reserve a filename/root before the first await so simultaneous commands
// cannot start multiple terminals. Stop also invalidates pending launches.
const pendingStarts = new Map<string, { cancelled: boolean }>();
// Cancel obsolete file Run startup compiler probes on source edits, closes,
// Stop, and compiler switches; never affect already-started terminals.
const activeFileRunProbes = new Map<string, AbortController>();
// A project launch must not open a terminal for a manifest/source snapshot
// superseded while compiler capability probing. Scopes are explicit roots.
const activeProjectRunProbes = new Map<string, AbortController>();
let stopGeneration = 0;
// Discard in-flight results if scarp.compilerPath changes.
// Previous verified Problems remain until the user checks again.
let compilerRevision = 0;
const checks = new Map<string, Promise<void>>();
// Only file verification is cancellable; project operations and Run terminals
// must stay independent of another document's edits.
const activeFileCheckAborts = new Map<string, AbortController>();
// Keep opt-in save checks distinct so disabling automatic verification never
// cancels a manually requested file check for that or another document.
const activeSaveCheckAborts = new Map<string, AbortController>();
const verifiedVersions = new Map<string, number>();
const projectChanges = new ProjectChangeTracker();
const activeProjectChecks = new Set<string>();
// Cancellation is per explicit project root: a changed module cannot stop
// unrelated project checks, file checks or user-run Scarp terminals.
const activeProjectCheckAborts = new Map<string, AbortController>();
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
async function validateCompiler(signal?: AbortSignal): Promise<{ binary: string; version: string }> {
  const binary = config().get<string>('compilerPath', 'scarp').trim();
  if (!binary) { throw new Error('Set scarp.compilerPath to an executable.'); }
  let result;
  try {
    result = await executeProcess(binary, ['--version'], {
      timeoutMs: 5000, maxOutputBytes: 65536, signal
    });
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
async function supportsStaticVerify(binary: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await executeProcess(binary, ['verify', '--help'], {
      timeoutMs: 5000,
      maxOutputBytes: 32768, signal
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

  const controller = new AbortController();
  const work = (async () => {
    try {
      if (mode === 'manual') { await ensureSaved(doc); }
      const expectedVersion = doc.version;
      const current = (): boolean => !controller.signal.aborted &&
        revision === compilerRevision && vscode.workspace.isTrusted &&
        !doc.isClosed && !doc.isDirty && doc.version === expectedVersion &&
        (mode === 'manual' || vscode.workspace.getConfiguration('scarp', doc.uri)
          .get<boolean>('verifyOnSave', false));
      if (!current()) { return; }
      // VS Code document versions do not reliably change when an external
      // editor replaces the saved source. Capture only this selected file;
      // recursively hashing its parent could scan an unrelated monorepo.
      const diskBefore = await snapshotScarpSourceFile(filename);
      if (!current()) { return; }
      const diskCurrent = async (): Promise<boolean> => {
        if (!current()) { return false; }
        try {
          const diskAfter = await snapshotScarpSourceFile(filename);
          return diskBefore === diskAfter && current();
        } catch (error) {
          output.appendLine('Scarp source disk snapshot could not be validated: ' +
            String(error));
          return false;
        }
      };
      const { binary, version } = await validateCompiler(controller.signal);
      if (!current()) { return; }
      const staticVerify = await supportsStaticVerify(binary, controller.signal);
      if (!current()) { return; }
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
        maxOutputBytes: 1024 * 1024,
        signal: controller.signal
      });
      if (!current()) { return; }
      if (!(await diskCurrent())) {
        output.appendLine('Scarp source changed on disk during file verification; ' +
          'outdated diagnostics discarded.');
        return;
      }
      if (result.stdout) { output.append(result.stdout); }
      if (result.stderr) { output.append(result.stderr); }
      const count = await showProblems(doc, result.stderr, diagnostics, owners,
        expectedVersion, diskCurrent);
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
    } catch (error) {
      // A superseded check is not a failed check. Never show a popup or
      // replace completed Problems with its obsolete compiler result.
      if (!controller.signal.aborted) { throw error; }
    }
  })();
  checks.set(filename, work);
  activeFileCheckAborts.set(filename, controller);
  if (mode === 'save') { activeSaveCheckAborts.set(filename, controller); }
  try {
    await work;
  } finally {
    if (checks.get(filename) === work) { checks.delete(filename); }
    if (activeFileCheckAborts.get(filename) === controller) {
      activeFileCheckAborts.delete(filename);
    }
    if (activeSaveCheckAborts.get(filename) === controller) {
      activeSaveCheckAborts.delete(filename);
    }
  }
}
/** Never assume project support from a version string or from the old evaluating check. */
async function validateProjectCompiler(signal?: AbortSignal): Promise<{ binary: string; version: string }> {
  const compiler = await validateCompiler(signal);
  const result = await executeProcess(compiler.binary, ['diagnose', '--json'], {
    timeoutMs: 5000, maxOutputBytes: 65536, signal
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
  const controller = new AbortController();
  activeProjectCheckAborts.set(key, controller);
  const watch = projectChanges.watch(key);
  const isCurrent = (): boolean => !controller.signal.aborted &&
    revision === compilerRevision && watch.isCurrent() &&
    vscode.workspace.isTrusted;
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
    if (!isCurrent()) { return; }
    const { binary, version } = await validateProjectCompiler(controller.signal);
    if (!isCurrent()) { return; }
    output.clear();
    output.appendLine('Scarp ' + version + ' — static verify project ' + key);
    const result = await executeProcess(binary, projectArgv('verify', key), {
      cwd: key,
      timeoutMs: config().get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 1024 * 1024,
      signal: controller.signal
    });
    if (!isCurrent()) { return; }
    if (result.stdout) { output.append(result.stdout); }
    if (result.stderr) { output.append(result.stderr); }
    const count = await showProblems(doc, result.stderr, diagnostics, owners,
      manifestVersion, async () => {
        if (!isCurrent()) { return false; }
        try {
          const diskAfter = await snapshotProjectDisk(key);
          const unchanged = sameProjectDisk(diskBefore, diskAfter) && isCurrent();
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
  } catch (error) {
    // Source edits and compiler switches invalidate this attempt before it
    // can publish results. They are not user-visible verification failures.
    if (!controller.signal.aborted) { throw error; }
  } finally {
    watch.dispose();
    activeProjectChecks.delete(key);
    if (activeProjectCheckAborts.get(key) === controller) {
      activeProjectCheckAborts.delete(key);
    }
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
  const controller = new AbortController();
  pendingStarts.set(key, pending);
  activeProjectRunProbes.set(key, controller);
  const isCurrent = (): boolean => !pending.cancelled &&
    !controller.signal.aborted && generation === stopGeneration &&
    revision === compilerRevision && vscode.workspace.isTrusted;
  try {
    // Launching a project while one of its sources has unsaved changes would
    // run disk bytes different from those shown in the user's editor.
    const dirty = unsavedProjectInput(key);
    if (dirty) {
      throw new Error('Save open Scarp project files before launching: ' +
        dirty.uri.fsPath);
    }
    const diskBefore = await snapshotProjectDisk(key);
    if (!isCurrent()) { return; }
    const { binary, version } = await validateProjectCompiler(controller.signal);
    if (!isCurrent()) { return; }
    // Guard against external editors and tools as well as VS Code changes.
    // No asynchronous gap remains between this final check and createTerminal.
    const diskAfter = await snapshotProjectDisk(key);
    if (!isCurrent() || unsavedProjectInput(key) ||
        !sameProjectDisk(diskBefore, diskAfter)) {
      output.appendLine('Scarp project changed during launch preparation; ' +
        'obsolete terminal startup cancelled. Save sources and retry.');
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
    // Stop, edits, and compiler switches are cancellations, not late errors.
    if (isCurrent()) { throw error; }
  } finally {
    if (pendingStarts.get(key) === pending) { pendingStarts.delete(key); }
    if (activeProjectRunProbes.get(key) === controller) {
      activeProjectRunProbes.delete(key);
    }
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
  const controller = new AbortController();
  pendingStarts.set(filename, pending);
  activeFileRunProbes.set(filename, controller);
  let savedVersion: number | undefined;
  const isCurrent = (): boolean => !pending.cancelled &&
    !controller.signal.aborted && generation === stopGeneration &&
    revision === compilerRevision && vscode.workspace.isTrusted &&
    !doc.isClosed && (savedVersion === undefined ||
      (!doc.isDirty && doc.version === savedVersion));
  try {
    await ensureSaved(doc);
    savedVersion = doc.version;
    if (!isCurrent()) {
      output.appendLine('Scarp file run cancelled before compiler detection.');
      return;
    }
    // A separate editor or generator may rewrite the saved file while the
    // Scarp compiler version and execution-command probes are running.
    // Capture only the selected input: don't traverse an unrelated workspace.
    const sourceBefore = await snapshotScarpSourceFile(filename);
    if (!isCurrent()) { return; }
    const { binary, version } = await validateCompiler(controller.signal);
    if (!isCurrent()) {
      output.appendLine('Scarp file run cancelled during compiler detection.');
      return;
    }
    const command = await preferredExecutionVerb(binary, controller.signal);
    if (!isCurrent()) {
      output.appendLine('Scarp file run cancelled before terminal startup.');
      return;
    }
    // The terminal reads the saved file from disk, not the editor buffer.
    // Refuse a stale launch if external tools replaced or rewrote that file
    // during our asynchronous compiler probes. A missing/deleted file also
    // fails closed, rather than turning into an unrelated Run error.
    let sourceStillCurrent = false;
    try {
      sourceStillCurrent = sourceBefore === await snapshotScarpSourceFile(filename);
    } catch (error) {
      output.appendLine('Scarp file changed or disappeared during Run preparation: ' +
        String(error));
    }
    if (!isCurrent() || !sourceStillCurrent) {
      output.appendLine('Scarp file changed on disk before Run startup; ' +
        'obsolete terminal cancelled. Reload the file and retry.');
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
    // An edited/closed document or a canceled probe cannot open a terminal
    // and is not a failed Run command.
    if (isCurrent()) { throw error; }
  } finally {
    if (pendingStarts.get(filename) === pending) { pendingStarts.delete(filename); }
    if (activeFileRunProbes.get(filename) === controller) {
      activeFileRunProbes.delete(filename);
    }
  }
}
function stop(): void {
  const count = running.size;
  const pendingCount = pendingStarts.size;
  stopGeneration++;
  for (const pending of pendingStarts.values()) { pending.cancelled = true; }
  for (const controller of activeFileRunProbes.values()) { controller.abort(); }
  for (const controller of activeProjectRunProbes.values()) { controller.abort(); }
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
    // Only Scarp source and the project manifest affect static compilation.
    // Other files, and changes in sibling projects, must not stop a check.
    if (path.extname(filename).toLowerCase() === '.srp' ||
        path.basename(filename) === 'Scarp.project') {
      for (const [root, controller] of activeProjectCheckAborts) {
        if (isWithinProject(root, filename)) { controller.abort(); }
      }
      for (const [root, controller] of activeProjectRunProbes) {
        if (isWithinProject(root, filename)) { controller.abort(); }
      }
    }
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
  // Static, read-only help remains available in Restricted Mode. No compiler
  // executable is launched by pointer movement or hover requests.
  const builtinHover = vscode.languages.registerHoverProvider({ language: 'scarp' }, {
    provideHover(document, position, token): vscode.Hover | undefined {
      if (token.isCancellationRequested || position.line >= document.lineCount) {
        return undefined;
      }
      const line = document.lineAt(position.line).text;
      const nextLine = position.line + 1 < document.lineCount
        ? document.lineAt(position.line + 1).text : '';
      const call = scarpBuiltinAt(line, position.character, nextLine);
      if (!call) { return undefined; }
      const hover = new vscode.MarkdownString();
      hover.isTrusted = false;
      hover.supportHtml = false;
      hover.appendCodeblock(call.help.signature, 'scarp');
      hover.appendMarkdown('\n\n' + call.help.summary);
      hover.appendMarkdown('\n\n**Constraints:** ' + call.help.constraints);
      hover.appendMarkdown('\n\n**Introduced in compiler:** ' + call.help.introduced +
        ' (experimental). Availability depends on the separately installed compiler.');
      hover.appendMarkdown('\n\n*Editor reference only; semantic resolution and errors belong to Scarp.*');
      return new vscode.Hover(hover,
        new vscode.Range(position.line, call.start, position.line, call.end));
    }
  });
  // Signature help is a bounded lexical reference, not a semantic index or
  // compiler execution. It remains usable in Restricted Mode.
  const builtinSignatures = vscode.languages.registerSignatureHelpProvider(
    { language: 'scarp' },
    {
      provideSignatureHelp(document, position, token): vscode.SignatureHelp | undefined {
        if (token.isCancellationRequested || position.line >= document.lineCount) {
          return undefined;
        }
        // Avoid scanning an entire file while typing. A truncated prefix can
        // simply omit help for a call opened too far above the cursor.
        const start = new vscode.Position(Math.max(0, position.line - 24), 0);
        const prefix = document.getText(new vscode.Range(start, position));
        const hint = scarpSignatureAt(prefix);
        if (!hint) { return undefined; }
        const signature = new vscode.SignatureInformation(hint.help.signature,
          hint.help.summary + ' Requires ' + hint.help.introduced +
          ' or later; the installed compiler is authoritative.');
        signature.parameters = hint.parameters.map(p => new vscode.ParameterInformation(p));
        const help = new vscode.SignatureHelp();
        help.signatures = [signature];
        help.activeSignature = 0;
        help.activeParameter = hint.activeParameter;
        return help;
      }
    },
    '(', ','
  );
  // Static suggestions never invoke the compiler, query the network or
  // invent user-defined symbols. Manual Ctrl+Space works in Restricted Mode.
  const builtinCompletions = vscode.languages.registerCompletionItemProvider(
    { language: 'scarp' },
    {
      provideCompletionItems(document, position, token): vscode.CompletionItem[] {
        if (token.isCancellationRequested || position.line >= document.lineCount) {
          return [];
        }
        const suggestion = scarpBuiltinCompletionAt(
          document.lineAt(position.line).text, position.character);
        if (!suggestion) { return []; }
        return suggestion.matches.map(meta => {
          const item = new vscode.CompletionItem(
            meta.name, vscode.CompletionItemKind.Function);
          item.detail = meta.signature + ' · Scarp ' + meta.introduced + '+';
          const docs = new vscode.MarkdownString();
          docs.isTrusted = false;
          docs.supportHtml = false;
          docs.appendMarkdown(meta.summary + '\\n\\n**Constraints:** ' + meta.constraints +
            '\\n\\n*Lexical reference only. Verify with the installed Scarp compiler.*');
          item.documentation = docs;
          item.range = new vscode.Range(position.line, suggestion.start,
            position.line, position.character);
          item.insertText = meta.name;
          return item;
        });
      }
    }
  );
  context.subscriptions.push(output, diagnostics, saveVerifier, navigation,
    builtinHover, builtinSignatures, builtinCompletions, projectMonitors,
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
        // A changed buffer makes the running file check obsolete. Cancel its
        // process, not independent project checks or other file operations.
        activeFileCheckAborts.get(event.document.uri.fsPath)?.abort();
        activeFileRunProbes.get(event.document.uri.fsPath)?.abort();
        // Scarp.project is normally not assigned the 'scarp' language ID.
        // A file with no previous errors can still invalidate the project.
        invalidateProject(event.document.uri.fsPath);
      }
      if (event.document.languageId !== 'scarp') { return; }
      verifiedVersions.delete(event.document.uri.fsPath);
      applyProblems(diagnostics, owners.invalidateChanged(event.document.uri.toString()));
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      activeFileCheckAborts.get(doc.uri.fsPath)?.abort();
      activeFileRunProbes.get(doc.uri.fsPath)?.abort();
      verifiedVersions.delete(doc.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scarp.compilerPath')) {
        // A delayed probe/check from the previous executable must never
        // publish new Problems or open a terminal after this setting changes.
        compilerRevision++;
        for (const controller of activeFileCheckAborts.values()) {
          controller.abort();
        }
        for (const controller of activeFileRunProbes.values()) {
          controller.abort();
        }
        for (const controller of activeProjectRunProbes.values()) {
          controller.abort();
        }
        for (const controller of activeProjectCheckAborts.values()) {
          controller.abort();
        }
        for (const pending of pendingStarts.values()) { pending.cancelled = true; }
        output.appendLine('Scarp compiler changed; in-flight results and pending launches invalidated.');
      }
      if (event.affectsConfiguration('scarp.verifyOnSave')) {
        // Disabling the opt-in setting is a cancellation, not permission for
        // an already-running auto-check to continue. Respect resource-scoped
        // overrides, and leave explicit Verify Current File untouched.
        for (const [filename, controller] of activeSaveCheckAborts) {
          const uri = vscode.Uri.file(filename);
          if (event.affectsConfiguration('scarp.verifyOnSave', uri) &&
              !vscode.workspace.getConfiguration('scarp', uri)
                .get<boolean>('verifyOnSave', false)) {
            controller.abort();
          }
        }
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
