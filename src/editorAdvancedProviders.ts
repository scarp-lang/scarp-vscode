import type * as VSC from 'vscode';
import { ScarpStructureCache } from './editorStructureCache';
import { ScarpEditorAnalysisCache } from './editorAnalysisCache';
import { scarpIndentationEdits } from './editorIndentation';
import { scarpQuickFixes, type ScarpQuickFixContext } from './editorCodeActions';
import { scarpBindingAt } from './editorLocalBindings';
import { scarpLocalRenamePlan } from './editorLocalRename';
import { scarpDocumentHighlights } from './editorDocumentHighlights';
import {
  scarpCallNodeAt, scarpIncomingCalls,
  scarpOutgoingCalls, type ScarpCallGraph, type ScarpCallNode
} from './editorCallHierarchy';
import {
  scarpEditorSnapshotAllowed, sameScarpSnapshot,
  scarpEditorRangeAllowed, type ScarpEditorSnapshot
} from './editorProviderPolicy';

/**
 * Independent VS Code adapters for editor-only features. Everything here is
 * compiler-free, shell-free and filesystem-write-free. Formatting and quick
 * fixes return edits for user review; the extension never applies them itself.
 */
export function registerScarpAdvancedEditorProviders(api: typeof VSC): VSC.Disposable[] {
  const selector: VSC.DocumentSelector = { language: 'scarp' };
  const cache = new ScarpStructureCache({ maximumEntries: 8, maximumBytes: 8_000_000 });
  const analyses = new ScarpEditorAnalysisCache();
  const MAX_FORMAT_EDITS = 5000;
  const MAX_QUICK_FIXES = 8;
  const MAX_CALL_HIERARCHY_ITEMS = 512;
  const MAX_CALL_HIERARCHY_SITES = 5000;

  const snapshot = (document: VSC.TextDocument): ScarpEditorSnapshot => {
    const beforeVersion = document.version;
    const text = document.getText();
    // A document may change while materializing its text. Never associate
    // the earlier revision with bytes read from a newer revision.
    const afterVersion = document.version;
    return {
      key: document.uri.toString(), scheme: document.uri.scheme,
      languageId: document.languageId,
      version: beforeVersion === afterVersion ? afterVersion : -1,
      text
    };
  };
  const allowed = (
    item: ScarpEditorSnapshot, token: VSC.CancellationToken,
    requireTrust = false
  ): boolean => scarpEditorSnapshotAllowed(item, {
    workspaceTrusted: api.workspace.isTrusted,
    cancellationRequested: token.isCancellationRequested
  }, { requireTrust });
  const current = (document: VSC.TextDocument, original: ScarpEditorSnapshot,
    token: VSC.CancellationToken): boolean =>
    !token.isCancellationRequested && sameScarpSnapshot(original, snapshot(document));
  const structureFor = (item: ScarpEditorSnapshot) =>
    cache.get(item.key, item.version, item.text);
  const graphFor = (item: ScarpEditorSnapshot): ScarpCallGraph | undefined => {
    const parsed = structureFor(item);
    return parsed ? analyses.graph(item.key, item.version, item.text, parsed) : undefined;
  };
  const asEdit = (document: VSC.TextDocument,
    item: { start: number; end: number; replacement: string }): VSC.TextEdit =>
    api.TextEdit.replace(new api.Range(
      document.positionAt(item.start), document.positionAt(item.end)), item.replacement);
  const formatting = (
    document: VSC.TextDocument, token: VSC.CancellationToken,
    options: VSC.FormattingOptions, range?: VSC.Range
  ): VSC.TextEdit[] => {
    const item = snapshot(document);
    if (!allowed(item, token) || !Number.isSafeInteger(options.tabSize) ||
        options.tabSize <= 0 || options.tabSize > 16) return [];
    const parsed = structureFor(item);
    if (!parsed) return [];
    const target = range ? {
      start: document.offsetAt(range.start), end: document.offsetAt(range.end)
    } : undefined;
    if (target && !scarpEditorRangeAllowed(target.start, target.end, item.text.length)) return [];
    const edits = scarpIndentationEdits(item.text, parsed, {
      tabSize: options.tabSize, insertSpaces: options.insertSpaces,
      range: target, maximumEdits: MAX_FORMAT_EDITS
    });
    if (!current(document, item, token)) return [];
    return edits.map(edit => asEdit(document, edit));
  };

  const documentFormatting = api.languages.registerDocumentFormattingEditProvider(selector, {
    provideDocumentFormattingEdits(document, options, token) {
      return formatting(document, token, options);
    }
  });
  const rangeFormatting = api.languages.registerDocumentRangeFormattingEditProvider(selector, {
    provideDocumentRangeFormattingEdits(document, range, options, token) {
      return formatting(document, token, options, range);
    }
  });
  const quickFixes = api.languages.registerCodeActionsProvider(selector, {
    provideCodeActions(document, _range, context, token) {
      const item = snapshot(document);
      if (!allowed(item, token, true) || document.uri.scheme !== 'file') return [];
      const parsed = structureFor(item);
      if (!parsed) return [];
      const report: ScarpQuickFixContext[] = [];
      for (const problem of context.diagnostics) {
        // VS Code supports either simple string codes or an object containing
        // `{value, target}`. Only the original Scarp diagnostics are eligible.
        if (problem.source !== 'Scarp') continue;
        const code = typeof problem.code === 'object' && problem.code !== null
          ? problem.code.value : problem.code;
        const start = document.offsetAt(problem.range.start);
        const end = document.offsetAt(problem.range.end);
        if (!scarpEditorRangeAllowed(start, end, item.text.length)) continue;
        report.push({ code, message: problem.message, range: { start, end } });
      }
      const suggestions = scarpQuickFixes(item.text, parsed, report, {
        maximumActions: MAX_QUICK_FIXES
      });
      if (!current(document, item, token) || !api.workspace.isTrusted) return [];
      return suggestions.map(suggestion => {
        const action = new api.CodeAction(suggestion.title, api.CodeActionKind.QuickFix);
        action.edit = new api.WorkspaceEdit();
        action.edit.replace(document.uri,
          new api.Range(document.positionAt(suggestion.start),
            document.positionAt(suggestion.end)), suggestion.replacement);
        action.diagnostics = context.diagnostics.filter(diagnostic => {
          const value = typeof diagnostic.code === 'object' && diagnostic.code !== null
            ? diagnostic.code.value : diagnostic.code;
          return value === suggestion.diagnosticCode;
        });
        return action;
      });
    }
  }, { providedCodeActionKinds: [api.CodeActionKind.QuickFix] });

  const highlights = api.languages.registerDocumentHighlightProvider(selector, {
    provideDocumentHighlights(document, position, token) {
      const item = snapshot(document);
      if (!allowed(item, token)) return [];
      const parsed = structureFor(item);
      if (!parsed) return [];
      const graph = graphFor(item);
      const locals = analyses.bindings(item.key, item.version, item.text, parsed);
      const selected = scarpDocumentHighlights(graph, locals, document.offsetAt(position), {
        maximumHighlights: 2000
      });
      if (!current(document, item, token)) return [];
      return selected.map(item => new api.DocumentHighlight(
        new api.Range(document.positionAt(item.span.start),
          document.positionAt(item.span.end)),
        item.kind === 'read' ? api.DocumentHighlightKind.Read :
          item.kind === 'write' ? api.DocumentHighlightKind.Write :
            api.DocumentHighlightKind.Text
      ));
    }
  });

  const localRename = api.languages.registerRenameProvider(selector, {
    prepareRename(document, position, token) {
      const item = snapshot(document);
      if (!allowed(item, token, true) || item.scheme !== 'file') return undefined;
      const parsed = structureFor(item);
      const locals = parsed ? analyses.bindings(item.key, item.version, item.text, parsed) : undefined;
      const selected = locals && scarpBindingAt(locals, document.offsetAt(position));
      if (!selected || !current(document, item, token) || !api.workspace.isTrusted) {
        return undefined;
      }
      const range = new api.Range(
        document.positionAt(selected.declaration.start),
        document.positionAt(selected.declaration.end));
      return { range, placeholder: selected.name };
    },
    provideRenameEdits(document, position, newName, token) {
      const item = snapshot(document);
      if (!allowed(item, token, true) || item.scheme !== 'file') return undefined;
      const parsed = structureFor(item);
      if (!parsed) return undefined;
      const plan = scarpLocalRenamePlan(item.text, parsed,
        document.offsetAt(position), newName);
      if (!plan || !current(document, item, token) || !api.workspace.isTrusted) {
        return undefined;
      }
      const changes = new api.WorkspaceEdit();
      for (const edit of plan.edits) {
        changes.replace(document.uri, new api.Range(
          document.positionAt(edit.start), document.positionAt(edit.end)), edit.replacement);
      }
      return changes;
    }
  });

  const hierarchyItem = (document: VSC.TextDocument, node: ScarpCallNode) =>
    new api.CallHierarchyItem(
      api.SymbolKind.Function, node.name,
      'Scarp source (same file, lexical)', document.uri,
      new api.Range(document.positionAt(node.declarationRange.start),
        document.positionAt(node.declarationRange.end)),
      new api.Range(document.positionAt(node.nameRange.start),
        document.positionAt(node.nameRange.end))
    );
  const resolve = async (item: VSC.CallHierarchyItem,
    token: VSC.CancellationToken): Promise<{
      document: VSC.TextDocument; graph: ScarpCallGraph; node: ScarpCallNode
    } | undefined> => {
    if (token.isCancellationRequested || item.uri.scheme !== 'file') return undefined;
    let document: VSC.TextDocument;
    try { document = await api.workspace.openTextDocument(item.uri); }
    catch { return undefined; }
    const doc = snapshot(document);
    if (!allowed(doc, token)) return undefined;
    const graph = graphFor(doc);
    const node = graph?.nodes.find(n => n.name === item.name &&
      n.nameRange.start === document.offsetAt(item.selectionRange.start));
    if (!node || !current(document, doc, token)) return undefined;
    return { document, graph: graph!, node };
  };
  const hierarchy = api.languages.registerCallHierarchyProvider(selector, {
    prepareCallHierarchy(document, position, token) {
      const doc = snapshot(document);
      if (!allowed(doc, token)) return [];
      const graph = graphFor(doc);
      if (!graph) return [];
      const offset = document.offsetAt(position);
      const chosen = scarpCallNodeAt(graph, offset) ?? graph.nodes.find(node =>
        graph.calls.some(site => site.callee === node.name &&
          site.nameRange.start <= offset && offset < site.nameRange.end));
      if (!chosen || !current(document, doc, token)) return [];
      return [hierarchyItem(document, chosen)];
    },
    async provideCallHierarchyIncomingCalls(item, token) {
      const resolved = await resolve(item, token);
      if (!resolved) return [];
      const { document, graph, node } = resolved;
      const incoming = scarpIncomingCalls(graph, node);
      if (incoming.length > MAX_CALL_HIERARCHY_ITEMS ||
          incoming.reduce((n, edge) => n + edge.sites.length, 0) > MAX_CALL_HIERARCHY_SITES) return [];
      return incoming.map(edge => new api.CallHierarchyIncomingCall(
        hierarchyItem(document, edge.from), edge.sites.map(site =>
          new api.Range(document.positionAt(site.nameRange.start),
            document.positionAt(site.nameRange.end)))
      ));
    },
    async provideCallHierarchyOutgoingCalls(item, token) {
      const resolved = await resolve(item, token);
      if (!resolved) return [];
      const { document, graph, node } = resolved;
      const outgoing = scarpOutgoingCalls(graph, node);
      if (outgoing.length > MAX_CALL_HIERARCHY_ITEMS ||
          outgoing.reduce((n, edge) => n + edge.sites.length, 0) > MAX_CALL_HIERARCHY_SITES) return [];
      return outgoing.map(edge => new api.CallHierarchyOutgoingCall(
        hierarchyItem(document, edge.to), edge.sites.map(site =>
          new api.Range(document.positionAt(site.nameRange.start),
            document.positionAt(site.nameRange.end)))
      ));
    }
  });
  const closed = api.workspace.onDidCloseTextDocument(doc => {
    cache.invalidate(doc.uri.toString());
    analyses.invalidate(doc.uri.toString());
  });
  const cleanup = new api.Disposable(() => { cache.clear(); analyses.clear(); });
  return [documentFormatting, rangeFormatting, quickFixes, highlights, localRename, hierarchy, closed, cleanup];
}
