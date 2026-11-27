import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { watch as nativeWatch, type FSWatcher } from 'node:fs';
import * as vscode from 'vscode';
import { executeProcess, preferredExecutionVerb, supportsInteractiveExecution } from './cli';
import { resolveConfiguredCompiler } from './compilerDiscovery';
import {
  assessCompilerUpdate, compilerEditorCompatibility
} from './compilerStatus';
import {
  fetchCurrentCompilerPackage, installOfficialCompiler, OFFICIAL_RELEASES_URL
} from './compilerInstall';
import { setupRecoveryFor, type CompilerRecoveryAction } from './compilerSetupRecovery';
import { parseDiagnostics, utf16OffsetForScalarColumn } from './diagnostics';
import { diagnosticExplanationArgs, explainableDiagnosticCode } from './diagnosticExplanation';
import { BUDGET_SETTINGS, BudgetSettings, budgetArguments } from './settings';
import { DiagnosticOwners } from './problemOwners';
import { DebouncedSerialTasks } from './saveVerification';
import { scanScarpSymbols, ScarpSymbolKind } from './documentSymbols';
import { hasProjectWorkflow, projectArgv, projectCreationUi, projectTestListArgv, validProjectName, validProjectTestFilter } from './projectWorkflow';
import { isWithinProject, ProjectChangeTracker } from './projectChangeTracker';
import { findProjectManifest, isProjectManifestName } from './projectManifest';
import {
  snapshotProjectDisk, snapshotScarpSourceFile, sameProjectDisk,
  type ProjectDiskSnapshot
} from './projectDiskSnapshot';
import { ProjectWatchRegistry } from './projectWatchRegistry';
import { parseBrowsableProjectModules } from './projectModules';
import { parseListedProjectTests } from './projectTestListing';
import { registerCompilerNavigation } from './navigationProvider';
import { browseProjectSymbols } from './projectSymbolBrowser';
import { scarpBuiltinFromTokens } from './builtinHelp';
import { scarpSignatureFromTokens } from './builtinSignature';
import { scarpBuiltinMatches, scarpCompletionFromTokens } from './builtinCompletion';
import { scarpSourceCompletions, SOURCE_COMPLETION_LIMIT, type SourceCompletionKind } from './sourceCompletion';
import { BUILTIN_DOCUMENT_LIMIT } from './builtinLexicalContext';
import { BuiltinEditorCache } from './builtinEditorCache';
import { registerFileActionCodeLens } from './fileActionCodeLens';
import { registerScarpEditorProviders } from './editorProviders';
import { registerNativeObjectExport } from './nativeObjectCommand';
import { registerWorkspaceImportExplorer } from './editorWorkspaceExplorer';
import { registerWorkspaceProjectExplorer } from './editorProjectExplorer';
import {
  compilerAdvertisesImplicitExec, hasDefaultWorkspaceEntry, implicitExecArgv
} from './defaultWorkspaceExec';

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
// Read-only test discovery is one cancellable compiler inspection per
// explicit project root. Never leave an obsolete CLI running after an edit.
const activeTestDiscoveryAborts = new Map<string, AbortController>();
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
/**
 * A CodeLens or editor-title action carries its own resource URI. Always
 * execute against that explicit document rather than whichever tab happens
 * to be active when the user clicks the command.
 */
async function selectedOrExplicitFile(uri?: vscode.Uri): Promise<vscode.TextDocument> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before running Scarp.');
  }
  if (uri === undefined) { return selectedFile(); }
  if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file' ||
      path.extname(uri.fsPath).toLowerCase() !== '.srp') {
    throw new Error('A local Scarp .srp source file is required.');
  }
  return vscode.workspace.openTextDocument(uri);
}

async function ensureSaved(doc: vscode.TextDocument): Promise<void> {
  if (doc.isDirty && !(await doc.save())) { throw new Error('Save the source file first.'); }
}
async function validateCompiler(signal?: AbortSignal): Promise<{ binary: string; version: string }> {
  const binary = config().get<string>('compilerPath', 'scarp').trim();
  // An explicit compiler path always wins. The default command may fall back
  // to bounded installed-compiler discovery, but only for trusted actions.
  return resolveConfiguredCompiler(
    binary, config().get<boolean>('autoDiscoverCompiler', true), signal
  );
}
/**
 * Display published compiler catalogue guidance only after an explicit user
 * action. No Scarp source file is read, verified or executed by explain.
 */
async function explainDiagnostic(code: unknown, output: vscode.OutputChannel): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before invoking the Scarp compiler.');
  }
  let requested = code;
  if (requested === undefined) {
    requested = await vscode.window.showInputBox({
      prompt: 'Enter a Scarp compiler diagnostic code',
      placeHolder: 'E0004',
      validateInput: value => explainableDiagnosticCode(value)
        ? undefined : 'Use an uppercase diagnostic code such as E0004.'
    });
  }
  if (requested === undefined) { return; } // User cancelled the input prompt.
  const args = diagnosticExplanationArgs(requested);
  const revision = compilerRevision;
  const { binary, version } = await validateCompiler();
  if (revision !== compilerRevision || !vscode.workspace.isTrusted) { return; }
  const result = await executeProcess(binary, args, {
    timeoutMs: 5000, maxOutputBytes: 32768
  });
  if (revision !== compilerRevision || !vscode.workspace.isTrusted) { return; }
  if (result.exitCode !== 0) {
    output.appendLine('Scarp ' + version + ' has no available explanation for ' + args[1] + '.');
    if (result.stderr) { output.append(result.stderr); }
    output.show(true);
    throw new Error('Scarp diagnostic explanation unavailable for ' + args[1] +
      ' (exit ' + String(result.exitCode) + ').');
  }
  output.appendLine('Scarp ' + version + ' — explanation for ' + args[1]);
  if (result.stdout) { output.append(result.stdout); }
  output.show(true);
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
async function projectDirectory(provided?: vscode.Uri): Promise<{
  directory: vscode.Uri; manifest: vscode.Uri;
} | undefined> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before using Scarp project commands.');
  }
  let uri = provided;
  if (!uri) {
    const folder = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select the Scarp project folder containing scarp.project or Scarp.project'
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
  const filename = await findProjectManifest(uri.fsPath);
  if (!filename) {
    throw new Error('The selected folder has no scarp.project or Scarp.project file. '
      + 'Open an existing Scarp project root or create a project first.');
  }
  return { directory: uri, manifest: vscode.Uri.joinPath(uri, filename) };
}

async function verifyProject(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection, owners: DiagnosticOwners<vscode.Diagnostic>,
  projectMonitors: ProjectWatchRegistry, onSourceChanged: (filename: string) => void
): Promise<void> {
  const project = await projectDirectory(explicit);
  if (!project) { return; }
  const { directory, manifest } = project;
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
    const doc = await vscode.workspace.openTextDocument(manifest);
    // The real compiler reads saved files from disk, not unsaved editor buffers.
    const dirty = vscode.workspace.textDocuments.find(source =>
      source.uri.scheme === 'file' && source.isDirty &&
      isWithinProject(key, source.uri.fsPath) &&
      (path.extname(source.uri.fsPath).toLowerCase() === '.srp' ||
        isProjectManifestName(path.basename(source.uri.fsPath)))
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
function isProjectTestFixture(root: string, filename: string): boolean {
  return path.dirname(path.relative(root, filename)) === 'tests' &&
    path.extname(filename).toLowerCase() === '.stdin';
}
function unsavedProjectInput(
  root: string, includeTestFixtures = false
): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(source =>
    source.uri.scheme === 'file' && source.isDirty &&
    isWithinProject(root, source.uri.fsPath) &&
    (path.extname(source.uri.fsPath).toLowerCase() === '.srp' ||
      isProjectManifestName(path.basename(source.uri.fsPath)) ||
      (includeTestFixtures && isProjectTestFixture(root, source.uri.fsPath)))
  );
}
async function browseProjectModules(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel
): Promise<void> {
  const project = await projectDirectory(explicit);
  if (!project) { return; }
  const root = project.directory.fsPath;
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

/** Read-only compiler-provided test discovery, never test execution or implicit search. */
async function listProjectTests(explicit: vscode.Uri | undefined,
  output: vscode.OutputChannel, filter?: string): Promise<void> {
  if (filter !== undefined && !validProjectTestFilter(filter)) {
    throw new Error('Invalid Scarp project test filename filter.');
  }
  const project = await projectDirectory(explicit);
  if (!project) { return; }
  const root = project.directory.fsPath;
  const revision = compilerRevision;
  if (activeTestDiscoveryAborts.has(root)) {
    throw new Error('Scarp is already listing tests for this project.');
  }
  const controller = new AbortController();
  activeTestDiscoveryAborts.set(root, controller);
  // Edits are detected immediately, including an edit quickly followed by
  // Save. On-disk rewrites from outside VS Code remain covered by snapshots.
  const sourceChanges = vscode.workspace.onDidChangeTextDocument(event => {
    const filename = event.document.uri.fsPath;
    if (event.contentChanges.length && event.document.uri.scheme === 'file' &&
        isWithinProject(root, filename) &&
        (path.extname(filename).toLowerCase() === '.srp' ||
          isProjectManifestName(path.basename(filename)))) {
      controller.abort();
    }
  });
  const fresh = (): boolean => !controller.signal.aborted &&
    vscode.workspace.isTrusted && revision === compilerRevision &&
    !unsavedProjectInput(root);

  try {
    if (!fresh()) {
      throw new Error('Save open Scarp project files before listing tests.');
    }
    const before = await snapshotProjectDisk(root);
    const { binary, version } = await validateProjectCompiler(controller.signal);
    if (!fresh()) { throw new Error('Project or compiler changed during test discovery. Retry.'); }
    const guide = await executeProcess(binary, ['guide', 'test'], {
      timeoutMs: 5000, maxOutputBytes: 32768, signal: controller.signal
    });
    if (guide.exitCode !== 0 || !/^Usage:\s*scarp test\b/m.test(guide.stdout)) {
      throw new Error('Listing tests requires Scarp v0.0.6-alpha.8+ with guide test support.');
    }
    if (!fresh()) { throw new Error('Project or compiler changed during test discovery. Retry.'); }
    const result = await executeProcess(binary,
      projectTestListArgv(root, filter), {
        cwd: root, timeoutMs: config().get<number>('checkTimeoutMs', 30000),
        maxOutputBytes: 1024 * 1024, signal: controller.signal
      });
    if (result.exitCode !== 0) {
      output.appendLine('Scarp ' + version + ' — test discovery failed for ' + root);
      if (result.stderr) { output.append(result.stderr); }
      output.show(true);
      throw new Error('The Scarp compiler could not list tests. See Scarp Output.');
    }
    const after = await snapshotProjectDisk(root);
    if (!fresh() || !sameProjectDisk(before, after)) {
      throw new Error('Scarp project changed during test discovery. Save files and retry.');
    }
    const paths = parseListedProjectTests(result.stdout);
    if (!paths.length) {
      void vscode.window.showInformationMessage(filter === undefined
        ? 'No Scarp tests found under tests/*.srp.'
        : 'No Scarp tests match this filename filter.');
      return;
    }
    const selected = await vscode.window.showQuickPick(paths.map(filename => ({
      label: filename, filename: path.join(root, filename)
    })), {
      title: filter === undefined
        ? 'Scarp: List Project Tests (read-only)'
        : 'Scarp: List Filtered Project Tests (read-only)',
      placeHolder: 'Choose a discovered test source to open; no test code is executed'
    });
    if (!selected) { return; }
    if (!fresh() || !sameProjectDisk(after, await snapshotProjectDisk(root))) {
      throw new Error('Scarp project changed while selecting a test. Retry discovery.');
    }

    // The CLI path is merely a label until independently checked on disk.
    // Reject symlinks and escapes even if a malformed/custom compiler lists them.
    const stat = await fs.lstat(selected.filename);
    const canonicalRoot = await fs.realpath(root);
    const canonicalFile = await fs.realpath(selected.filename);
    if (!stat.isFile() || !isWithinProject(canonicalRoot, canonicalFile) ||
        path.dirname(path.relative(canonicalRoot, canonicalFile)) !== 'tests') {
      throw new Error('Listed Scarp test is not an ordinary file inside the project tests directory.');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(canonicalFile));
    if (doc.isDirty || !Buffer.from(doc.getText(), 'utf8')
      .equals(await fs.readFile(canonicalFile))) {
      throw new Error('Listed Scarp test no longer matches the saved compiler snapshot.');
    }
    if (!fresh() || !sameProjectDisk(after, await snapshotProjectDisk(root))) {
      throw new Error('Scarp project changed before opening the listed test. Retry discovery.');
    }
    await vscode.window.showTextDocument(doc, { preview: true });
    output.appendLine('Scarp ' + version + ' — opened discovered test ' + canonicalFile);
  } catch (error) {
    if (!controller.signal.aborted) { throw error; }
  } finally {
    sourceChanges.dispose();
    if (activeTestDiscoveryAborts.get(root) === controller) {
      activeTestDiscoveryAborts.delete(root);
    }
    if (controller.signal.aborted) {
      output.appendLine('Scarp test discovery cancelled after a source or compiler change.');
    }
  }
}

/** A literal filename substring shared by explicit Run and read-only List. */
async function resolveProjectTestFilter(
  title: string, suppliedFilter?: unknown
): Promise<string | undefined> {
  const filter = suppliedFilter === undefined
    ? await vscode.window.showInputBox({
      title,
      prompt: 'Enter a literal, case-sensitive filename substring (not a glob or regex).',
      placeHolder: 'addition',
      validateInput: value => validProjectTestFilter(value)
        ? undefined : 'Use 1–128 UTF-8 bytes without leading -, path separators, colons or controls.'
    })
    : suppliedFilter;
  if (filter === undefined) { return undefined; } // User cancelled.
  if (!validProjectTestFilter(filter)) {
    throw new Error('Invalid Scarp project test filename filter.');
  }
  return filter;
}

/** Explicit filename-substring selection: never triggers execution automatically. */
async function runFilteredProjectTests(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel, suppliedFilter?: unknown
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before running Scarp project tests.');
  }
  const filter = await resolveProjectTestFilter('Scarp: Run Filtered Project Tests', suppliedFilter);
  if (filter !== undefined) { await launchProject(explicit, output, 'test', filter); }
}

/** A filtered read-only discovery still uses the official compiler's --list path. */
async function listFilteredProjectTests(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel, suppliedFilter?: unknown
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before listing Scarp project tests.');
  }
  const filter = await resolveProjectTestFilter('Scarp: List Filtered Project Tests', suppliedFilter);
  if (filter !== undefined) { await listProjectTests(explicit, output, filter); }
}

async function launchProject(explicit: vscode.Uri | undefined,
  output: vscode.OutputChannel, mode: 'launch' | 'test' = 'launch',
  testFilter?: string, interactive = false): Promise<void> {
  // Stop can be pressed while the workspace folder picker is still open.
  const generation = stopGeneration;
  const revision = compilerRevision;
  const project = await projectDirectory(explicit);
  if (!project || generation !== stopGeneration || revision !== compilerRevision) { return; }
  const key = project.directory.fsPath;
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
    const dirty = unsavedProjectInput(key, mode === 'test');
    if (dirty) {
      throw new Error('Save open Scarp project files before starting: ' +
        dirty.uri.fsPath);
    }
    const diskBefore = await snapshotProjectDisk(key, true, mode === 'test');
    if (!isCurrent()) { return; }
    const { binary, version } = await validateProjectCompiler(controller.signal);
    if (!isCurrent()) { return; }
    if (mode === 'test') {
      // Only the published alpha.8 compiler advertises this executable test route.
      // Testing is explicitly user-triggered: never run tests during discovery.
      const help = await executeProcess(binary, ['guide', 'test'], {
        timeoutMs: 5000, maxOutputBytes: 32768, signal: controller.signal
      });
      if (!isCurrent()) { return; }
      if (help.exitCode !== 0 || !/^Usage:\s*scarp test\b/m.test(help.stdout)) {
        throw new Error('Scarp project tests require compiler v0.0.6-alpha.8+ with guide test support.');
      }
    }
    if (interactive) {
      if (mode !== 'launch' || !await supportsInteractiveExecution(
        binary, 'launch', controller.signal)) {
        if (!isCurrent()) { return; }
        throw new Error('Interactive Scarp project input requires compiler v0.0.6-alpha.10+ with --interactive support.');
      }
      if (!isCurrent()) { return; }
    }
    // Guard against external editors and tools as well as VS Code changes.
    // No asynchronous gap remains between this final check and createTerminal.
    const diskAfter = await snapshotProjectDisk(key, true, mode === 'test');
    if (!isCurrent() || unsavedProjectInput(key, mode === 'test') ||
        !sameProjectDisk(diskBefore, diskAfter)) {
      output.appendLine('Scarp project changed during launch preparation; ' +
        'obsolete terminal startup cancelled. Save sources and retry.');
      return;
    }
    // Read this resource setting only at launch. Modifying it while a test
    // terminal is running does not silently restart or alter the process.
    // The separately installed compiler is authoritative for the guard.
    const requireNonemptyTests = mode === 'test' &&
      vscode.workspace.getConfiguration('scarp', project.directory)
        .get<boolean>('requireNonemptyProjectTests', false);
    const terminal = vscode.window.createTerminal({
      name: (mode === 'test'
        ? (testFilter === undefined ? 'Scarp Tests: ' : 'Scarp Tests (filtered): ')
        : 'Scarp Project: ') + path.basename(key),
      shellPath: binary,
      shellArgs: projectArgv(mode, key, mode === 'launch' ? budgets() : [],
        testFilter, requireNonemptyTests, interactive),
      cwd: key
    });
    running.set(key, terminal);
    output.appendLine('Scarp ' + version + ' — ' + (mode === 'test' ? 'test' : 'launch') +
      (interactive ? ' --interactive' : '') + ' project ' + key + (testFilter === undefined ? '' :
        ' (literal filename filter: ' + testFilter + ')') +
      (requireNonemptyTests ? ' (requires at least one selected test)' : ''));
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

/**
 * Explicit alpha.18 default-entry run: scarp exec (no filename argument).
 * Only an opened, local, trusted workspace root may be chosen. Compiler
 * capability is probed and source snapshots protect against stale launches.
 */
async function runWorkspaceEntry(
  explicit: vscode.Uri | undefined, output: vscode.OutputChannel
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before running Scarp.');
  }
  const generation = stopGeneration;
  const revision = compilerRevision;
  const uri = explicit ?? (await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Choose an open workspace root for Scarp default entry execution'
  }))?.uri;
  if (!uri || generation !== stopGeneration || revision !== compilerRevision ||
      !vscode.workspace.isTrusted) { return; }
  if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file' ||
      !vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === uri.toString())) {
    throw new Error('Select an opened local workspace root, not an arbitrary directory.');
  }
  const root = uri.fsPath;
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) === 0) {
    throw new Error('Scarp default-entry execution requires a workspace directory.');
  }
  if (running.has(root) || pendingStarts.has(root)) {
    running.get(root)?.show();
    throw new Error('Scarp is already running or starting for this workspace. Stop it before relaunching.');
  }

  const pending = { cancelled: false };
  const controller = new AbortController();
  pendingStarts.set(root, pending);
  activeProjectRunProbes.set(root, controller);
  const isCurrent = (): boolean => !pending.cancelled &&
    !controller.signal.aborted && generation === stopGeneration &&
    revision === compilerRevision && vscode.workspace.isTrusted;
  try {
    const dirty = unsavedProjectInput(root);
    if (dirty) {
      throw new Error('Save open Scarp workspace sources before running: ' + dirty.uri.fsPath);
    }
    // Unlike legacy project commands, alpha.18 allows a plain src/main.srp or
    // main.srp without a manifest. Still inspect only the explicit root.
    const before = await snapshotProjectDisk(root, false);
    if (!isCurrent()) { return; }
    if (!hasDefaultWorkspaceEntry(before)) {
      throw new Error('No Scarp default entrypoint found at this workspace root. ' +
        'Add scarp.project, Scarp.project, src/main.srp or main.srp.');
    }

    const { binary, version } = await validateCompiler(controller.signal);
    if (!isCurrent()) { return; }
    const guide = await executeProcess(binary, ['guide', 'exec'], {
      timeoutMs: 5000, maxOutputBytes: 32768, signal: controller.signal
    });
    if (!isCurrent()) { return; }
    if (guide.exitCode !== 0 || !compilerAdvertisesImplicitExec(guide.stdout)) {
      throw new Error('Run Workspace Entry requires the published Scarp ' +
        'v0.0.6-alpha.18+ default-entry exec capability. ' +
        'Use Run Current File with older compilers.');
    }

    const after = await snapshotProjectDisk(root, false);
    if (!isCurrent() || unsavedProjectInput(root) || !sameProjectDisk(before, after)) {
      output.appendLine('Scarp workspace changed during default-entry launch preparation; ' +
        'obsolete terminal cancelled. Save sources and retry.');
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: 'Scarp Entry: ' + path.basename(root),
      shellPath: binary,
      shellArgs: implicitExecArgv(budgets()),
      cwd: root
    });
    running.set(root, terminal);
    output.appendLine('Scarp ' + version + ' — exec default workspace entry in ' + root);
    terminal.show();
  } catch (error) {
    if (isCurrent()) { throw error; }
  } finally {
    if (pendingStarts.get(root) === pending) { pendingStarts.delete(root); }
    if (activeProjectRunProbes.get(root) === controller) {
      activeProjectRunProbes.delete(root);
    }
  }
}

async function createProject(output: vscode.OutputChannel, modern = false): Promise<void> {
  const command = modern ? 'init' : 'create';
  const presentation = projectCreationUi(command);
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
    title: presentation.title,
    prompt: 'Name for a new subfolder (existing destinations are never overwritten)',
    placeHolder: 'hello-world',
    validateInput: text => validProjectName(text) ? undefined
      : 'Use one folder name (1–96 UTF-8 bytes), without separators, colons or control characters.'
  });
  if (name === undefined) { return; }
  if (!validProjectName(name)) { throw new Error('Invalid Scarp project folder name.'); }
  const destination = path.join(parent.uri.fsPath, name);
  const { binary, version } = await validateProjectCompiler();
  if (modern) {
    // Older compilers may provide create but not the separate init command.
    const help = await executeProcess(binary, ['guide', 'init'], {
      timeoutMs: 5000, maxOutputBytes: 32768
    });
    if (help.exitCode !== 0 || !/^Usage:\s*scarp init\b/m.test(help.stdout)) {
      throw new Error('Modern projects require Scarp v0.0.6-alpha.8+ with guide init support.');
    }
  }
  const result = await executeProcess(binary, projectArgv(command, destination), {
    cwd: parent.uri.fsPath, timeoutMs: 30000, maxOutputBytes: 65536
  });
  if (result.stdout) { output.append(result.stdout); }
  if (result.stderr) { output.append(result.stderr); }
  if (result.exitCode !== 0) {
    output.show(true);
    throw new Error('Scarp project creation failed. The compiler will not overwrite '
      + 'an existing directory. See Scarp output.');
  }
  output.appendLine('Created Scarp ' + version + ' project with ' +
    presentation.commandLabel + ': ' + destination);
  const choice = await vscode.window.showInformationMessage(
    'Created Scarp project ' + name + '.', 'Open Project'
  );
  if (choice === 'Open Project') {
    await vscode.commands.executeCommand('vscode.openFolder',
      vscode.Uri.file(destination), { forceNewWindow: true });
  }
}

async function run(doc: vscode.TextDocument, output: vscode.OutputChannel,
  interactive = false): Promise<void> {
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
    if (interactive) {
      if (!await supportsInteractiveExecution(binary, command, controller.signal)) {
        if (!isCurrent()) { return; }
        throw new Error('Interactive Scarp input requires compiler v0.0.6-alpha.10+ with --interactive support.');
      }
      if (!isCurrent()) { return; }
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
      shellArgs: [command, ...(interactive ? ['--interactive'] : []), ...budgets(), '--', filename],
      cwd: path.dirname(filename)
    });
    running.set(filename, terminal);
    output.appendLine('Scarp ' + version + ' — ' + command +
      (interactive ? ' --interactive ' : ' ') + filename);
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

/**
 * User-directed setup only. Scarp files, hovering, automatic verification and
 * Run never trigger a network request or a compiler installation themselves.
 */
interface CompilerProgressResult<T> {
  readonly cancelled: boolean;
  readonly value?: T;
}

/** All user-initiated network and CLI probes honor VS Code Cancel. */
async function cancellableCompilerTask<T>(
  title: string, task: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
): Promise<CompilerProgressResult<T>> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title, cancellable: true
  }, async (progress, token): Promise<CompilerProgressResult<T>> => {
    const controller = new AbortController();
    const cancel = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) { controller.abort(); }
    try {
      if (controller.signal.aborted) { return { cancelled: true }; }
      const value = await task(controller.signal, message => progress.report({ message }));
      if (controller.signal.aborted) { return { cancelled: true }; }
      return { cancelled: false, value };
    } catch (error) {
      if (controller.signal.aborted) { return { cancelled: true }; }
      throw error;
    } finally { cancel.dispose(); }
  });
}

async function setupCompiler(
  context: vscode.ExtensionContext, output: vscode.OutputChannel,
  requestedAction?: unknown
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before setting up an executable compiler.');
  }
  const startRevision = compilerRevision;
  const originalPath = config().get<string>('compilerPath', 'scarp');
  const stillCurrent = (): boolean => vscode.workspace.isTrusted &&
    compilerRevision === startRevision &&
    config().get<string>('compilerPath', 'scarp') === originalPath;
  const canChangeSelection = (): boolean => {
    if (stillCurrent()) { return true; }
    output.appendLine('Scarp setup stopped: compiler configuration or trust changed during setup.');
    void vscode.window.showWarningMessage(
      'Scarp compiler settings changed during setup. The previous selection was preserved. ' +
      'Reopen Scarp: Set Up Compiler to make an intentional new selection.'
    );
    return false;
  };

  // Recovery buttons may select an explicit local file action. Every install
  // must still go through BOTH the setup choice and the modal confirmation.
  const selected = requestedAction === 'choose' ? { action: 'choose' } :
    await vscode.window.showQuickPick([
      { label: 'Detect Existing Compiler', description: 'Check configured and known local paths', action: 'detect' },
      { label: 'Install Official Scarp Release', description: 'Download, verify SHA-256 and select the compiler', action: 'install' },
      { label: 'Choose Installed Compiler File', description: 'Validate a compiler you already installed', action: 'choose' },
      { label: 'View Official Scarp Releases', description: 'Open the GitHub compiler release page', action: 'releases' }
    ], { title: 'Scarp Compiler Setup', placeHolder: 'Select an explicit setup action' });
  if (!selected || !stillCurrent()) { return; }
  if (selected.action === 'releases') {
    await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_RELEASES_URL));
    return;
  }

  if (selected.action === 'detect') {
    const result = await cancellableCompilerTask(
      'Detecting an installed Scarp compiler',
      async signal => validateCompiler(signal)
    );
    if (result.cancelled || !result.value || !stillCurrent()) { return; }
    const found = result.value;
    if (found.binary !== originalPath) {
      const choice = await vscode.window.showInformationMessage(
        'Found Scarp ' + found.version + ' at ' + found.binary + '.', 'Use This Compiler'
      );
      if (choice !== 'Use This Compiler' || !canChangeSelection()) { return; }
      await config().update('compilerPath', found.binary, vscode.ConfigurationTarget.Global);
    }
    void vscode.window.showInformationMessage(
      'Scarp compiler ready: ' + found.version + ' (' + found.binary + ')'
    );
    return;
  }

  if (selected.action === 'choose') {
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      title: 'Select the official Scarp compiler executable',
      openLabel: 'Validate Scarp Compiler'
    });
    if (!files?.length || files[0].scheme !== 'file' || !stillCurrent()) { return; }
    const compilerPath = files[0].fsPath;
    const result = await cancellableCompilerTask(
      'Validating selected Scarp executable',
      async signal => resolveConfiguredCompiler(compilerPath, false, signal)
    );
    if (result.cancelled || !result.value || !stillCurrent()) { return; }
    const found = result.value;
    const accepted = await vscode.window.showInformationMessage(
      'Use Scarp ' + found.version + ' from ' + found.binary + '?',
      { modal: true }, 'Set Compiler Path'
    );
    if (accepted !== 'Set Compiler Path' || !canChangeSelection()) { return; }
    await config().update('compilerPath', found.binary, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      'Scarp ' + found.version + ' selected. Run and Verify now use this executable.'
    );
    return;
  }

  if (context.globalStorageUri.scheme !== 'file') {
    throw new Error('Scarp installation needs a local filesystem extension host.');
  }
  const catalogue = await cancellableCompilerTask(
    'Checking published Scarp compiler packages',
    async signal => fetchCurrentCompilerPackage(process.platform, process.arch, signal)
  );
  if (catalogue.cancelled || !catalogue.value || !stillCurrent()) { return; }
  const bundle = catalogue.value;
  const accepted = await vscode.window.showWarningMessage(
    'Install official Scarp ' + bundle.version + ' (' + bundle.target + ')?',
    {
      modal: true,
      detail: 'This downloads the published GitHub compiler archive and its SHA-256 ' +
        'checksum, verifies both, extracts only the compiler executable into ' +
        'VS Code extension storage, checks its version, and sets scarp.compilerPath. ' +
        'Current compiler setting: ' + originalPath + '. No source files are executed.'
    }, 'Install and Select Compiler'
  );
  if (accepted !== 'Install and Select Compiler' || !stillCurrent()) { return; }
  const install = await cancellableCompilerTask(
    'Installing ' + bundle.packageRoot,
    async (signal, report) => installOfficialCompiler(
      context.globalStorageUri.fsPath, bundle, signal, report
    )
  );
  if (install.cancelled) {
    output.appendLine('Scarp installation cancelled. Existing compiler setting preserved. ' +
      'If a versioned compiler was committed before cancellation, Setup can reuse it.');
    return;
  }
  if (!install.value) { return; }
  if (!canChangeSelection()) {
    output.appendLine('Scarp ' + install.value.version +
      ' was validated but not selected because compiler settings changed.');
    return;
  }
  await config().update('compilerPath', install.value.binary, vscode.ConfigurationTarget.Global);
  output.appendLine('Scarp ' + install.value.version + (install.value.reused
    ? ' reused at ' : ' installed at ') + install.value.binary);
  void vscode.window.showInformationMessage(
    'Scarp ' + install.value.version + ' is ready. Run and Verify use ' + install.value.binary
  );
}

const recoveryLabels: Readonly<Record<CompilerRecoveryAction, string>> = {
  retry: 'Retry Setup',
  choose: 'Choose Compiler File',
  releases: 'View Official Releases',
  settings: 'Open Compiler Settings'
};

/** A user click is required for every recovery action; never auto-retry. */
async function runCompilerSetup(
  context: vscode.ExtensionContext, output: vscode.OutputChannel,
  requestedAction?: unknown
): Promise<void> {
  try {
    await setupCompiler(context, output, requestedAction);
  } catch (error) {
    if (!vscode.workspace.isTrusted) { throw error; }
    const recovery = setupRecoveryFor(error);
    output.appendLine('Scarp compiler setup failure (' + recovery.kind + '): ' +
      (error instanceof Error ? error.message : String(error)));
    const picked = await vscode.window.showErrorMessage(
      'Scarp setup: ' + recovery.explanation,
      ...recovery.actions.map(action => recoveryLabels[action])
    );
    const action = recovery.actions.find(a => recoveryLabels[a] === picked);
    if (!action || !vscode.workspace.isTrusted) { return; }
    if (action === 'retry') {
      await vscode.commands.executeCommand('scarp.setupCompiler');
    } else if (action === 'choose') {
      await vscode.commands.executeCommand('scarp.setupCompiler', 'choose');
    } else if (action === 'releases') {
      await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_RELEASES_URL));
    } else if (action === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'scarp.compilerPath');
    }
  }
}

/**
 * Compiler management is deliberately request-driven. Neither the status-bar
 * entry nor the Scarp editor's activation performs CLI probes or network I/O.
 */
async function manageCompiler(
  context: vscode.ExtensionContext, output: vscode.OutputChannel
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before managing the Scarp compiler.');
  }
  const revision = compilerRevision;
  const configuredPath = config().get<string>('compilerPath', 'scarp').trim();
  const discovery = config().get<boolean>('autoDiscoverCompiler', true);
  const inspected = await vscode.window.withProgress({
    title: 'Inspecting installed Scarp compiler',
    location: vscode.ProgressLocation.Notification,
    cancellable: true
  }, async (_progress, token): Promise<{
    installed?: { binary: string; version: string };
    probeError?: string;
    cancelled?: boolean;
  }> => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return { installed: await validateCompiler(controller.signal) };
    } catch (error) {
      if (controller.signal.aborted) { return { cancelled: true }; }
      return { probeError: error instanceof Error ? error.message : String(error) };
    } finally { cancellation.dispose(); }
  });
  if (inspected.cancelled) { return; }
  const { installed, probeError } = inspected;
  if (!vscode.workspace.isTrusted || revision !== compilerRevision) {
    return; // A changed setting/trust level invalidates this snapshot.
  }

  const source = !installed ? 'Unavailable' :
    installed.binary === configuredPath
      ? configuredPath === 'scarp' ? 'PATH' : 'Configured executable'
      : 'Automatically discovered executable';
  const summary = installed
    ? 'Installed Scarp ' + installed.version + ' (' + source + ')'
    : 'Compiler unavailable (' + (probeError ?? 'not detected') + ')';
  const choice = await vscode.window.showQuickPick([
    { label: '$(info) Compiler Details', description: installed
      ? installed.version + ' · ' + source : 'Compiler not found', action: 'details' },
    { label: '$(cloud-download) Check Official Compiler Updates',
      description: 'Only now query published GitHub releases; no installation', action: 'updates' },
    { label: '$(tools) Set Up or Change Compiler',
      description: 'Detect, choose or explicitly install a release', action: 'setup' },
    { label: '$(gear) Open Scarp Compiler Settings',
      description: 'Configure compilerPath and autoDiscoverCompiler', action: 'settings' },
    { label: '$(link-external) View Official Scarp Releases',
      description: 'Open the official release page', action: 'releases' }
  ], { title: 'Scarp Compiler Manager', placeHolder: summary });
  if (!choice || !vscode.workspace.isTrusted ||
      revision !== compilerRevision) { return; }

  if (choice.action === 'setup') {
    await runCompilerSetup(context, output);
    return;
  }
  if (choice.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'scarp.compilerPath');
    return;
  }
  if (choice.action === 'releases') {
    await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_RELEASES_URL));
    return;
  }
  if (choice.action === 'details') {
    const details = [
      'Scarp compiler management — explicit inspection',
      'Configured executable: ' + (configuredPath || '(empty)'),
      'Local auto-discovery: ' + (discovery ? 'enabled' : 'disabled'),
      'Resolved executable: ' + (installed?.binary ?? '(not found)'),
      'Version: ' + (installed?.version ?? '(unknown)'),
      'Executable source: ' + source,
      'Editor compatibility: ' + compilerEditorCompatibility(installed?.version),
      'Version check error: ' + (probeError ?? 'none'),
      'No source file was executed, and no GitHub update check was performed.'
    ].join('\n');
    output.appendLine(details);
    output.show(true);
    if (installed) {
      const action = await vscode.window.showInformationMessage(
        'Scarp ' + installed.version + ' — ' + source,
        'Copy Compiler Path'
      );
      if (action === 'Copy Compiler Path' && vscode.workspace.isTrusted &&
          revision === compilerRevision) {
        await vscode.env.clipboard.writeText(installed.binary);
      }
    } else {
      void vscode.window.showWarningMessage(
        'Scarp compiler unavailable. Use Scarp: Set Up Compiler to configure an executable.'
      );
    }
    return;
  }

  // The only compiler manager branch that requests GitHub release metadata.
  const lookup = await cancellableCompilerTask(
    'Checking published Scarp compiler releases',
    async signal => fetchCurrentCompilerPackage(process.platform, process.arch, signal)
  );
  if (lookup.cancelled || !lookup.value ||
      !vscode.workspace.isTrusted || revision !== compilerRevision) {
    return;
  }
  const bundle = lookup.value;
  const assessment = assessCompilerUpdate(installed?.version, bundle.version);
  const message = 'Installed: ' + (installed?.version ?? 'not detected') +
    '. Published for ' + bundle.target + ': ' + bundle.version + '. ' +
    assessment.message;
  output.appendLine('Scarp official update check: ' + message);
  const next = await vscode.window.showInformationMessage(
    message, 'Set Up Compiler', 'View Release'
  );
  if (next === 'Set Up Compiler' && vscode.workspace.isTrusted &&
      revision === compilerRevision) {
    await runCompilerSetup(context, output);
  } else if (next === 'View Release') {
    await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_RELEASES_URL +
      '/tag/v' + bundle.version));
  }
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
                isProjectManifestName(relative) ||
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
        path.extname(filename).toLowerCase() === '.stdin' ||
        isProjectManifestName(path.basename(filename))) {
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
    import: vscode.SymbolKind.Namespace,
    record: vscode.SymbolKind.Struct,
    variant: vscode.SymbolKind.Enum
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
  // Scan the exact bounded document prefix once per version. Never start a
  // window inside a multiline literal; never copy an unbounded document.
  const builtinCache = new BuiltinEditorCache();
  function builtinSnapshot(document: vscode.TextDocument) {
    const last = document.lineAt(document.lineCount - 1).range.end;
    const length = Math.min(document.offsetAt(last), BUILTIN_DOCUMENT_LIMIT);
    const source = document.getText(new vscode.Range(new vscode.Position(0, 0),
      document.positionAt(length)));
    return builtinCache.get(document.uri.toString(), document.version, source);
  }
  // Static, read-only help remains available in Restricted Mode. No compiler
  // executable is launched by pointer movement or hover requests.
  const builtinHover = vscode.languages.registerHoverProvider({ language: 'scarp' }, {
    provideHover(document, position, token): vscode.Hover | undefined {
      if (token.isCancellationRequested || position.line >= document.lineCount) {
        return undefined;
      }
      const current = document.lineAt(position.line);
      const lineStart = document.offsetAt(current.range.start);
      const lineEnd = document.offsetAt(current.range.end);
      const cursor = document.offsetAt(position);
      if (lineEnd > BUILTIN_DOCUMENT_LIMIT) return undefined;
      const snapshot = builtinSnapshot(document);
      if (!snapshot) return undefined;
      const following = position.line + 1 < document.lineCount
        ? document.lineAt(position.line + 1) : undefined;
      const nextEnd = following ? document.offsetAt(following.range.end) : lineEnd;
      const lookaheadEnd = nextEnd <= snapshot.source.length ? nextEnd : lineEnd;
      const call = scarpBuiltinFromTokens(snapshot.tokens, snapshot.source, cursor, lineStart, lookaheadEnd);
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
        const cursor = document.offsetAt(position);
        if (cursor > BUILTIN_DOCUMENT_LIMIT) return undefined;
        const snapshot = builtinSnapshot(document);
        if (!snapshot || cursor > snapshot.source.length) return undefined;
        const hint = scarpSignatureFromTokens(snapshot.tokens, cursor);
        if (!hint) { return undefined; }
        const signature = new vscode.SignatureInformation(hint.help.signature,
          hint.help.summary + '\n\n' + hint.help.constraints + '\n\nRequires ' + hint.help.introduced +
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
  // Both completion sources are lexical and compiler-free. The current
  // unsaved document is the only source of user-defined candidates.
  const sourceKinds: Record<SourceCompletionKind, vscode.CompletionItemKind> = {
    function: vscode.CompletionItemKind.Function,
    constant: vscode.CompletionItemKind.Constant,
    variable: vscode.CompletionItemKind.Variable,
    parameter: vscode.CompletionItemKind.Variable,
    import: vscode.CompletionItemKind.Module
  };
  const builtinCompletions = vscode.languages.registerCompletionItemProvider(
    { language: 'scarp' },
    {
      provideCompletionItems(document, position, token): vscode.CompletionItem[] {
        if (token.isCancellationRequested || position.line >= document.lineCount) {
          return [];
        }
        const current = document.lineAt(position.line);
        const lineStart = document.offsetAt(current.range.start);
        const lineEnd = document.offsetAt(current.range.end);
        if (lineEnd > BUILTIN_DOCUMENT_LIMIT) return [];
        const snapshot = builtinSnapshot(document);
        if (!snapshot) return [];
        const prefix = scarpCompletionFromTokens(snapshot.tokens, document.offsetAt(position), lineStart);
        if (!prefix) return [];
        const range = new vscode.Range(position.line, prefix.start, position.line, prefix.end);
        const items = scarpBuiltinMatches(prefix.prefix).map(meta => {
          const item = new vscode.CompletionItem(
            meta.name, vscode.CompletionItemKind.Function);
          item.detail = meta.signature + ' · Scarp ' + meta.introduced + '+' +
            (meta.variadicSince && meta.variadicSince !== meta.introduced
              ? ' · additional operands: ' + meta.variadicSince + '+' : '');
          const docs = new vscode.MarkdownString();
          docs.isTrusted = false;
          docs.supportHtml = false;
          docs.appendMarkdown(meta.summary + '\n\n**Constraints:** ' + meta.constraints +
            '\n\n*Lexical reference only. Verify with the installed Scarp compiler.*');
          item.documentation = docs;
          item.range = range;
          item.insertText = meta.name;
          item.sortText = '1_' + meta.name;
          return item;
        });
        const start = document.offsetAt(range.start);
        if (start > SOURCE_COMPLETION_LIMIT || token.isCancellationRequested) return items;
        const source = document.getText(new vscode.Range(new vscode.Position(0, 0), range.start));
        const known = new Set(items.map(item => String(item.label)));
        for (const candidate of scarpSourceCompletions(source, prefix.prefix)) {
          if (known.has(candidate.name)) continue;
          const item = new vscode.CompletionItem(candidate.name, sourceKinds[candidate.kind]);
          item.range = range;
          item.insertText = candidate.name;
          item.detail = candidate.detail + ' · current document';
          item.sortText = '0_' + candidate.name;
          const docs = new vscode.MarkdownString();
          docs.isTrusted = false;
          docs.appendText('Lexical declaration in the current editor buffer. The Scarp compiler is authoritative.');
          item.documentation = docs;
          items.push(item);
        }
        return items;
      }
    }
  );
  // Quick Fix entries explain diagnostics; they never apply edits or invoke
  // a compiler until the user selects the action. Restricted Mode stays inert.
  const explainActions = vscode.languages.registerCodeActionsProvider(
    { language: 'scarp', scheme: 'file' },
    {
      provideCodeActions(document, _range, context, token): vscode.CodeAction[] {
        if (!vscode.workspace.isTrusted || token.isCancellationRequested ||
            path.extname(document.uri.fsPath).toLowerCase() !== '.srp') { return []; }
        const codes = new Set<string>();
        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source !== 'Scarp') { continue; }
          const code = explainableDiagnosticCode(diagnostic.code);
          if (!code || codes.has(code)) { continue; }
          codes.add(code);
          const action = new vscode.CodeAction('Explain Scarp ' + code,
            vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diagnostic];
          action.command = {
            command: 'scarp.explainDiagnostic',
            title: 'Explain Scarp ' + code,
            arguments: [code]
          };
          actions.push(action);
          if (actions.length >= 16) { break; }
        }
        return actions;
      }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );
  const compilerBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 90
  );
  compilerBar.text = '$(tools) Scarp Compiler';
  compilerBar.tooltip = 'Manage the Scarp compiler (explicit local check; no automatic downloads).';
  compilerBar.command = 'scarp.manageCompiler';
  const updateCompilerBar = (): void => {
    if (vscode.workspace.isTrusted &&
        vscode.window.activeTextEditor?.document.languageId === 'scarp') {
      compilerBar.show();
    } else {
      compilerBar.hide();
    }
  };
  updateCompilerBar();
  context.subscriptions.push(compilerBar,
    vscode.window.onDidChangeActiveTextEditor(updateCompilerBar),
    vscode.workspace.onDidGrantWorkspaceTrust(updateCompilerBar)
  );
  context.subscriptions.push(output, diagnostics, saveVerifier, navigation,
    builtinHover, builtinSignatures, builtinCompletions, explainActions,
    new vscode.Disposable(() => builtinCache.clear()),
    registerFileActionCodeLens(), ...registerScarpEditorProviders(),
    registerWorkspaceImportExplorer(output),
    registerWorkspaceProjectExplorer(output), projectMonitors,
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
      builtinCache.invalidate(doc.uri.toString());
      activeFileCheckAborts.get(doc.uri.fsPath)?.abort();
      activeFileRunProbes.get(doc.uri.fsPath)?.abort();
      verifiedVersions.delete(doc.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scarp.compilerPath') ||
          event.affectsConfiguration('scarp.autoDiscoverCompiler')) {
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
        for (const controller of activeTestDiscoveryAborts.values()) {
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
          event.affectsConfiguration('scarp.autoDiscoverCompiler') ||
          event.affectsConfiguration('scarp.verifyOnSave')) {
        verifiedVersions.clear();
      }
    }),
    registerNativeObjectExport(validateCompiler, output),
    vscode.commands.registerCommand('scarp.createProject',
      (): Promise<void> => safe(async () => createProject(output))),
    vscode.commands.registerCommand('scarp.initProject',
      (): Promise<void> => safe(async () => createProject(output, true))),
    vscode.commands.registerCommand('scarp.verifyProject',
      (uri?: vscode.Uri): Promise<void> => safe(async () => verifyProject(
        uri, output, diagnostics, owners, projectMonitors, invalidateProject))),
    vscode.commands.registerCommand('scarp.reconcileProjects',
      (): Promise<void> => safe(reconcileVerifiedProjects)),
    vscode.commands.registerCommand('scarp.browseProjectModules',
      (uri?: vscode.Uri): Promise<void> => safe(async () => browseProjectModules(uri, output))),
    vscode.commands.registerCommand('scarp.browseProjectSymbols',
      (uri?: vscode.Uri): Promise<void> => safe(async () => {
        const project = await projectDirectory(uri);
        if (!project) { return; }
        const { binary } = await validateProjectCompiler();
        await browseProjectSymbols(project.directory.fsPath, binary, output,
          config().get<number>('checkTimeoutMs', 30000));
      })),
    vscode.commands.registerCommand('scarp.launchProject',
      (uri?: vscode.Uri): Promise<void> => safe(async () => launchProject(uri, output))),
    vscode.commands.registerCommand('scarp.runWorkspaceEntry',
      (uri?: vscode.Uri): Promise<void> => safe(async () => runWorkspaceEntry(uri, output))),
    vscode.commands.registerCommand('scarp.launchProjectInteractive',
      (uri?: vscode.Uri): Promise<void> => safe(async () =>
        launchProject(uri, output, 'launch', undefined, true))),
    vscode.commands.registerCommand('scarp.testProject',
      (uri?: vscode.Uri): Promise<void> => safe(async () => launchProject(uri, output, 'test'))),
    vscode.commands.registerCommand('scarp.testProjectFiltered',
      (uri?: vscode.Uri, filter?: unknown): Promise<void> =>
        safe(async () => runFilteredProjectTests(uri, output, filter))),
    vscode.commands.registerCommand('scarp.listProjectTests',
      (uri?: vscode.Uri): Promise<void> => safe(async () => listProjectTests(uri, output))),
    vscode.commands.registerCommand('scarp.listFilteredProjectTests',
      (uri?: vscode.Uri, filter?: unknown): Promise<void> =>
        safe(async () => listFilteredProjectTests(uri, output, filter))),
    vscode.commands.registerCommand('scarp.runFile', (uri?: vscode.Uri) =>
      safe(async () => run(await selectedOrExplicitFile(uri), output))),
    vscode.commands.registerCommand('scarp.runFileInteractive', (uri?: vscode.Uri) =>
      safe(async () => run(await selectedOrExplicitFile(uri), output, true))),
    vscode.commands.registerCommand('scarp.checkFile', (uri?: vscode.Uri): Promise<void> =>
      safe(async () => check(await selectedOrExplicitFile(uri), output, diagnostics, owners))),
    vscode.commands.registerCommand('scarp.explainDiagnostic', (code?: unknown): Promise<void> =>
      safe(async () => explainDiagnostic(code, output))),
    vscode.commands.registerCommand('scarp.setupCompiler',
      (requestedAction?: unknown): Promise<void> =>
        safe(async () => runCompilerSetup(context, output, requestedAction))),
    vscode.commands.registerCommand('scarp.manageCompiler',
      (): Promise<void> => safe(async () => manageCompiler(context, output))),
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
  for (const controller of activeTestDiscoveryAborts.values()) { controller.abort(); }
  for (const terminal of running.values()) { terminal.dispose(); }
  running.clear();
}
