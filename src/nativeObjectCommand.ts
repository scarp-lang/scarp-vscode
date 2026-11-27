import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { formatNativeSpanPreview, nativeSpanPositions } from './nativeSourceSpans';
import * as vscode from 'vscode';
import { executeProcess } from './cli';
import { snapshotScarpSourceFile } from './projectDiskSnapshot';
import {
  exportNativeObject, nativeObjectAdvertised, parseNativeBudget, readNativeSource,
  validNativeEntry, type NativeObjectRequest
} from './nativeObject';

export const NATIVE_EXPORT_COMMAND = 'scarp.exportNativeObject';

type CompilerResolver = (signal?: AbortSignal) => Promise<{ binary: string; version: string }>;

async function askBudget(label: string, suggested: string): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title: label,
    value: suggested,
    prompt: 'Decimal integer from 0 through 4294967295',
    ignoreFocusOut: true,
    validateInput: input => parseNativeBudget(input) === undefined
      ? 'Enter a decimal unsigned 32-bit integer.' : undefined
  });
  return value === undefined ? undefined : parseNativeBudget(value);
}

async function selectMode(): Promise<NativeObjectRequest | undefined> {
  const modes: Array<vscode.QuickPickItem & { mode: NativeObjectRequest['mode'] }> = [
    { label: 'Checked function', description: 'Forward scalar control flow', mode: 'checked' },
    { label: 'Bounded function', description: 'Counted repeat and while loops', mode: 'bounded' },
    { label: 'Bounded entry call graph', description: 'Named entry and nonrecursive direct calls',
      mode: 'bounded-entry' }
  ];
  const selected = await vscode.window.showQuickPick(modes, {
    title: 'Experimental Scarp native object mode', ignoreFocusOut: true
  });
  if (!selected) return undefined;
  if (selected.mode === 'checked') return { mode: 'checked' };
  let entry: string | undefined;
  if (selected.mode === 'bounded-entry') {
    entry = await vscode.window.showInputBox({
      title: 'Entry function name', prompt: 'A pure integer function declared in the source',
      ignoreFocusOut: true,
      validateInput: value => validNativeEntry(value) ? undefined : 'Enter a Scarp identifier.'
    });
    if (entry === undefined) return undefined;
  }
  const maxWork = await askBudget('Native maximum work', '1000');
  if (maxWork === undefined) return undefined;
  if (selected.mode === 'bounded') return { mode: 'bounded', maxWork };
  const maxStackBytes = await askBudget('Native call graph maximum stack bytes', '512');
  if (maxStackBytes === undefined || entry === undefined) return undefined;
  return { mode: 'bounded-entry', entry, maxWork, maxStackBytes };
}

function selection(uri: unknown): vscode.Uri {
  const selected = uri === undefined ? vscode.window.activeTextEditor?.document.uri : uri;
  if (!(selected instanceof vscode.Uri) || selected.scheme !== 'file' ||
      path.extname(selected.fsPath).toLowerCase() !== '.srp') {
    throw new Error('Open a local Scarp .srp source file first.');
  }
  return selected;
}

/**
 * A separate, trusted and explicitly confirmed command. No activation-time
 * compiler probe, implicit save, background generation or terminal launch.
 */
export function registerNativeObjectExport(
  resolveCompiler: CompilerResolver, output: vscode.OutputChannel
): vscode.Disposable {
  let active: AbortController | undefined;
  const command = vscode.commands.registerCommand(NATIVE_EXPORT_COMMAND, async (uri?: unknown) => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust the workspace before exporting a Scarp native object.');
      return;
    }
    if (active) {
      void vscode.window.showWarningMessage('A Scarp native object export is already in progress.');
      return;
    }
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    const subscriptions: vscode.Disposable[] = [];
    try {
      const sourceUri = selection(uri);
      const document = await vscode.workspace.openTextDocument(sourceUri);
      if (document.isDirty) throw new Error('Save the Scarp source explicitly before exporting.');
      const version = document.version;
      const sourcePath = sourceUri.fsPath;
      const sameBuffer = (): boolean => !signal.aborted && vscode.workspace.isTrusted &&
        !document.isClosed && !document.isDirty && document.version === version;
      subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document.uri.toString() === sourceUri.toString()) controller.abort();
        }),
        vscode.workspace.onDidCloseTextDocument(closed => {
          if (closed.uri.toString() === sourceUri.toString()) controller.abort();
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
          if (event.affectsConfiguration('scarp.compilerPath') ||
              event.affectsConfiguration('scarp.autoDiscoverCompiler') ||
              event.affectsConfiguration('scarp.checkTimeoutMs')) controller.abort();
        })
      );
      const snapshot = await snapshotScarpSourceFile(sourcePath);
      const bytes = await readNativeSource(sourcePath);
      // Compare exact saved text (apart from the supported UTF-8 BOM) against
      // the editor buffer. A different encoding or external edit fails closed.
      const decoded = bytes.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(bytes) ||
          decoded.replace(/^\uFEFF/, '') !== document.getText() ||
          !sameBuffer() || await snapshotScarpSourceFile(sourcePath) !== snapshot) {
        throw new Error('The saved UTF-8 source and editor buffer must match before export.');
      }
      const stillCurrent = async (): Promise<boolean> => {
        if (!sameBuffer()) return false;
        try { return await snapshotScarpSourceFile(sourcePath) === snapshot && sameBuffer(); }
        catch { return false; }
      };

      const request = await selectMode();
      if (!request || !await stillCurrent()) return;
      const destination = await vscode.window.showSaveDialog({
        title: 'Choose a new Scarp ELF64 object filename',
        defaultUri: vscode.Uri.file(path.join(path.dirname(sourcePath),
          path.basename(sourcePath, path.extname(sourcePath)) + '.o')),
        filters: { 'Relocatable ELF object': ['o'] },
        saveLabel: 'Export Object'
      });
      if (!destination || !await stillCurrent()) return;
      if (destination.scheme !== 'file' || path.extname(destination.fsPath).toLowerCase() !== '.o') {
        throw new Error('Choose a new local .o output filename.');
      }
      const consent = await vscode.window.showWarningMessage(
        'Export an experimental x86-64 ELF64 relocatable object?',
        { modal: true, detail: 'Source: ' + sourcePath + '\nOutput: ' + destination.fsPath +
          '\nMode: ' + request.mode +
          '\nThe configured compiler will be invoked. Existing output is never replaced. ' +
          'No native linking or execution occurs.' },
        'Export Object'
      );
      if (consent !== 'Export Object' || !await stillCurrent()) return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Scarp: Export Native Object', cancellable: true
      }, async (progress, token) => {
        const cancelled = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          if (!await stillCurrent()) return;
          progress.report({ message: 'Checking compiler native-object support' });
          const { binary, version: compilerVersion } = await resolveCompiler(signal);
          if (!await stillCurrent()) return;
          const help = await executeProcess(binary, ['guide', 'native-object'], {
            timeoutMs: 5000, maxOutputBytes: 32768, signal
          });
          if (help.exitCode !== 0 || !nativeObjectAdvertised(help.stdout, request.mode)) {
            throw new Error('The installed compiler does not advertise the selected native-object mode. ' +
              'Published Scarp v0.0.7-alpha.2 introduced this experimental command.');
          }
          if (!await stillCurrent()) return;
          progress.report({ message: 'Compiling and validating a relocatable object' });
          const report = await exportNativeObject({
            binary, source: bytes, destination: destination.fsPath, request,
            timeoutMs: vscode.workspace.getConfiguration('scarp').get<number>('checkTimeoutMs', 30000),
            signal, stillCurrent,
            onCompilerError: stderr => { output.appendLine(stderr); output.show(true); },
            onCleanupError: error => output.appendLine('Native export staging cleanup failed: ' + String(error))
          });
          output.appendLine('Scarp ' + compilerVersion + ' native object: ' + destination.fsPath);
          output.appendLine('Source snapshot: ' + sourcePath);
          output.appendLine('Source SHA-256 (raw UTF-8 bytes): ' +
            createHash('sha256').update(bytes).digest('hex'));
          output.appendLine(formatNativeSpanPreview(nativeSpanPositions(bytes, report.failure_spans)));
          output.appendLine(JSON.stringify(report, null, 2));
          // The hard-link publication is the commit point; report success even
          // if cancellation arrives after that point rather than pretending the
          // already-published object was deleted.
          void vscode.window.showInformationMessage(
            'Scarp native object exported. ABI metadata is available in Scarp Output.');
        } finally { cancelled.dispose(); }
      });
    } catch (error) {
      if (!signal.aborted) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      subscriptions.forEach(item => item.dispose());
      if (active === controller) active = undefined;
    }
  });
  return { dispose() { active?.abort(); command.dispose(); } };
}
