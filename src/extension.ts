import * as path from 'node:path';
import * as vscode from 'vscode';
import { compilerVersion, executeProcess } from './cli';
import { parseDiagnostics, utf16OffsetForScalarColumn } from './diagnostics';
import { BUDGET_SETTINGS, BudgetSettings, budgetArguments } from './settings';

const running = new Map<string, vscode.Terminal>();
const checks = new Set<string>();
const priorDiagnostics = new Set<string>();
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

async function showProblems(
  doc: vscode.TextDocument, stderr: string, collection: vscode.DiagnosticCollection
): Promise<number> {
  for (const uri of priorDiagnostics) { collection.delete(vscode.Uri.parse(uri)); }
  priorDiagnostics.clear();
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
  for (const [key, items] of groups) {
    collection.set(vscode.Uri.parse(key), items);
    priorDiagnostics.add(key);
  }
  return [...groups.values()].reduce((sum, items) => sum + items.length, 0);
}
async function check(doc: vscode.TextDocument, output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const filename = doc.uri.fsPath;
  if (checks.has(filename)) { throw new Error('Scarp is already checking this file.'); }
  checks.add(filename);
  try {
    await ensureSaved(doc);
    const { binary, version } = await validateCompiler();
    const staticVerify = await supportsStaticVerify(binary);
    output.clear();
    output.appendLine('Scarp ' + version + (staticVerify
      ? ' — static verify ' : ' — legacy evaluating check ') + filename);
    const argumentsForCheck = staticVerify
      ? ['verify', '--diagnostic-format=json', '--', filename]
      : ['check', ...budgets(), '--', filename];
    const result = await executeProcess(binary, argumentsForCheck, {
      cwd: path.dirname(filename),
      timeoutMs: config().get<number>('checkTimeoutMs', 30000),
      maxOutputBytes: 1024 * 1024
    });
    output.append(result.stdout);
    output.append(result.stderr);
    const count = await showProblems(doc, result.stderr, diagnostics);
    if (result.exitCode === 0) {
      vscode.window.showInformationMessage(staticVerify
        ? 'Scarp static verification passed.' : 'Scarp legacy check passed.');
    }
    else {
      output.show(true);
      vscode.window.showErrorMessage('Scarp check exited ' + String(result.exitCode)
        + '. ' + count + ' diagnostic(s); see Scarp output.');
    }
  } finally { checks.delete(filename); }
}
async function run(doc: vscode.TextDocument, output: vscode.OutputChannel): Promise<void> {
  const filename = doc.uri.fsPath;
  if (running.has(filename)) {
    running.get(filename)?.show();
    throw new Error('Scarp is already running this file. Stop it before running again.');
  }
  await ensureSaved(doc);
  const { binary, version } = await validateCompiler();
  // VS Code launches the compiler directly as the terminal process.
  // shellArgs are argv entries, not interpolated source text.
  const terminal = vscode.window.createTerminal({
    name: 'Scarp: ' + path.basename(filename),
    shellPath: binary,
    shellArgs: ['run', ...budgets(), '--', filename],
    cwd: path.dirname(filename)
  });
  running.set(filename, terminal);
  output.appendLine('Scarp ' + version + ' — run ' + filename);
  terminal.show();
}
function stop(): void {
  const count = running.size;
  for (const terminal of running.values()) { terminal.dispose(); }
  running.clear();
  vscode.window.showInformationMessage(count ? 'Stopped ' + count + ' Scarp terminal(s).' : 'No Scarp program is running.');
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
  context.subscriptions.push(output, diagnostics,
    vscode.commands.registerCommand('scarp.runFile', () => safe(async () => run(selectedFile(), output))),
    vscode.commands.registerCommand('scarp.checkFile', () => safe(async () => check(selectedFile(), output, diagnostics))),
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
