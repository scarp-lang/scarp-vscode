import * as vscode from 'vscode';
import { scanScarpStructure } from './editorStructure';
import { scarpFoldsFromStructure } from './editorFolding';
import { scarpSelectionRangesFromStructure } from './editorSelection';
import { scarpImportLinksFromStructure } from './editorImports';

/**
 * No command registrations and no process launch. The folding and selection
 * providers are safe in Restricted Mode. Link discovery is restricted to
 * trusted local workspaces and validates real filesystem containment.
 */
export function registerScarpEditorProviders(): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { language: 'scarp' };

  const folding = vscode.languages.registerFoldingRangeProvider(selector, {
    provideFoldingRanges(
      document: vscode.TextDocument, _context: vscode.FoldingContext,
      token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
      if (token.isCancellationRequested) { return []; }
      const text = document.getText();
      const parsed = scanScarpStructure(text);
      if (!parsed) { return []; }
      return scarpFoldsFromStructure(text, parsed, { maximumRanges: 5000 }).map(item => {
        const kind = item.kind === 'region' ? vscode.FoldingRangeKind.Region :
          item.kind === 'comment' ? vscode.FoldingRangeKind.Comment :
          item.kind === 'imports' ? vscode.FoldingRangeKind.Imports : undefined;
        return new vscode.FoldingRange(item.start, item.end, kind);
      });
    }
  });

  const selections = vscode.languages.registerSelectionRangeProvider(selector, {
    provideSelectionRanges(
      document: vscode.TextDocument, positions: readonly vscode.Position[],
      token: vscode.CancellationToken
    ): vscode.SelectionRange[] {
      if (token.isCancellationRequested) { return []; }
      const text = document.getText();
      const parsed = scanScarpStructure(text);
      return positions.map(position => {
        // The API requires one selection chain per requested position.
        const cursor = document.offsetAt(position);
        const choices = parsed
          ? scarpSelectionRangesFromStructure(text, parsed, cursor) : [];
        if (!choices.length) {
          return new vscode.SelectionRange(new vscode.Range(position, position));
        }
        let parent: vscode.SelectionRange | undefined;
        for (let i = choices.length - 1; i >= 0; i--) {
          const choice = choices[i];
          const r = new vscode.Range(document.positionAt(choice.start),
            document.positionAt(choice.end));
          parent = new vscode.SelectionRange(r, parent);
        }
        return parent!;
      });
    }
  });

  const links = vscode.languages.registerDocumentLinkProvider(selector, {
    async provideDocumentLinks(
      document: vscode.TextDocument, token: vscode.CancellationToken
    ): Promise<vscode.DocumentLink[]> {
      if (!vscode.workspace.isTrusted || token.isCancellationRequested ||
          document.uri.scheme !== 'file') { return []; }
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder || folder.uri.scheme !== 'file') { return []; }
      const text = document.getText();
      const parsed = scanScarpStructure(text);
      if (!parsed) { return []; }
      const references = await scarpImportLinksFromStructure(parsed, {
        workspaceRoot: folder.uri.fsPath,
        sourceFilename: document.uri.fsPath
      });
      if (token.isCancellationRequested || !vscode.workspace.isTrusted ||
          document.version < 0 || document.getText() !== text) { return []; }
      return references.map(item => {
        const range = new vscode.Range(
          document.positionAt(item.start), document.positionAt(item.end));
        const link = new vscode.DocumentLink(range, vscode.Uri.file(item.target));
        link.tooltip = 'Open local Scarp module: ' + item.relativePath;
        return link;
      });
    }
  });
  return [folding, selections, links];
}
