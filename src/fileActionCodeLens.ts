import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Opt-in, file-scoped CodeLens shortcuts. These only construct UI commands:
 * they never inspect the filesystem or start any compiler process.
 *
 * Command handlers independently re-check trust, file type and URI before
 * running or verifying the explicitly selected document.
 */
export function registerFileActionCodeLens(): vscode.Disposable {
  const changes = new vscode.EventEmitter<void>();
  const provider = vscode.languages.registerCodeLensProvider(
    { language: 'scarp', scheme: 'file' },
    {
      onDidChangeCodeLenses: changes.event,
      provideCodeLenses(document, token): vscode.CodeLens[] {
        if (token.isCancellationRequested || !vscode.workspace.isTrusted ||
            document.uri.scheme !== 'file' ||
            path.extname(document.uri.fsPath).toLowerCase() !== '.srp' ||
            !vscode.workspace.getConfiguration('scarp', document.uri)
              .get<boolean>('showFileActionsCodeLens', false)) {
          return [];
        }
        const range = new vscode.Range(0, 0, 0, 0);
        return [
          new vscode.CodeLens(range, {
            title: 'Run Scarp File',
            command: 'scarp.runFile',
            arguments: [document.uri],
            tooltip: 'Run this saved Scarp file with the configured compiler (executes program statements).'
          }),
          new vscode.CodeLens(range, {
            title: 'Verify Scarp File',
            command: 'scarp.checkFile',
            arguments: [document.uri],
            tooltip: 'Verify this source. Older Scarp compilers can use evaluating check instead of static verify.'
          })
        ];
      }
    }
  );

  const settingChanged = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scarp.showFileActionsCodeLens')) { changes.fire(); }
  });
  const trusted = vscode.workspace.onDidGrantWorkspaceTrust(() => changes.fire());
  return vscode.Disposable.from(provider, changes, settingChanged, trusted);
}
