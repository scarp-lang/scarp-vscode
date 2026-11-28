import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { registerScarpAdvancedEditorProviders } from '../src/editorAdvancedProviders';

type Point = { line: number; character: number };
type RangeValue = { start: Point; end: Point };
class Range {
  constructor(readonly start: Point, readonly end: Point) {}
}
class Document {
  version = 1;
  languageId = 'scarp';
  constructor(public text: string, readonly uri: { scheme: string; toString(): string }) {}
  getText() { return this.text; }
  positionAt(offset: number): Point {
    const prefix = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length)));
    const lines = prefix.split('\n');
    return { line: lines.length - 1, character: lines.at(-1)!.length };
  }
  offsetAt(pos: Point): number {
    const lines = this.text.split('\n');
    const line = Math.min(Math.max(pos.line, 0), lines.length - 1);
    const before = lines.slice(0, line).reduce((sum, item) => sum + item.length + 1, 0);
    return before + Math.min(Math.max(pos.character, 0), lines[line].length);
  }
}
class WorkspaceEdit {
  readonly edits: Array<{ uri: unknown; range: RangeValue; value: string }> = [];
  replace(uri: unknown, range: RangeValue, value: string) {
    this.edits.push({ uri, range, value });
  }
}
class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: unknown[];
  constructor(readonly title: string, readonly kind: string) {}
}
class TextEdit {
  static replace(range: RangeValue, newText: string) { return { range, newText }; }
}
class DocumentHighlight {
  constructor(readonly range: RangeValue, readonly kind: number) {}
}
class CallHierarchyItem {
  constructor(readonly kind: number, readonly name: string,
    readonly detail: string, readonly uri: unknown,
    readonly range: RangeValue, readonly selectionRange: RangeValue) {}
}
class CallHierarchyIncomingCall {
  constructor(readonly from: CallHierarchyItem, readonly fromRanges: RangeValue[]) {}
}
class CallHierarchyOutgoingCall {
  constructor(readonly to: CallHierarchyItem, readonly fromRanges: RangeValue[]) {}
}
class Disposable {
  disposed = false;
  constructor(readonly callback: () => void) {}
  dispose() { this.disposed = true; this.callback(); }
}
interface Cancellation { isCancellationRequested: boolean }
interface Formatting { tabSize: number; insertSpaces: boolean }
interface EditorEdit { range: RangeValue; newText: string }
interface ReportedProblem {
  source?: string;
  code?: string | { value: string };
  message: string;
  range: RangeValue;
}
interface Providers {
  formatting: {
    provideDocumentFormattingEdits(
      document: Document, options: Formatting, token: Cancellation
    ): EditorEdit[];
  };
  rangeFormatting: {
    provideDocumentRangeFormattingEdits(
      document: Document, range: RangeValue, options: Formatting, token: Cancellation
    ): EditorEdit[];
  };
  quickFixes: {
    provideCodeActions(
      document: Document, range: RangeValue,
      context: { diagnostics: ReportedProblem[] }, token: Cancellation
    ): CodeAction[];
  };
  highlights: {
    provideDocumentHighlights(
      document: Document, position: Point, token: Cancellation
    ): DocumentHighlight[];
  };
  rename: {
    prepareRename(
      document: Document, position: Point, token: Cancellation
    ): { range: RangeValue; placeholder: string } | undefined;
    provideRenameEdits(
      document: Document, position: Point, newName: string, token: Cancellation
    ): WorkspaceEdit | undefined;
  };
  hierarchy: {
    prepareCallHierarchy(
      document: Document, position: Point, token: Cancellation
    ): CallHierarchyItem[];
    provideCallHierarchyIncomingCalls(
      item: CallHierarchyItem, token: Cancellation
    ): Promise<CallHierarchyIncomingCall[]>;
    provideCallHierarchyOutgoingCalls(
      item: CallHierarchyItem, token: Cancellation
    ): Promise<CallHierarchyOutgoingCall[]>;
  };
}
function setup(text = 'funcra f() {\nprint(1);\n}\n', scheme = 'file') {
  const uri = { scheme, toString: () => `${scheme}:///sample.srp` };
  const doc = new Document(text, uri);
  const docs = new Map([[uri.toString(), doc]]);
  const providers = {} as Providers;
  const subscriptions: Disposable[] = [];
  let onClose: ((doc: Document) => void) | undefined;
  const workspace = {
    isTrusted: true,
    async openTextDocument(uri: { toString(): string }) {
      const document = docs.get(uri.toString());
      if (!document) throw new Error('no file');
      return document;
    },
    onDidCloseTextDocument(callback: (document: Document) => void) {
      onClose = callback;
      return new Disposable(() => {});
    }
  };
  const registration = (which: keyof Providers) => (_selector: unknown, provider: unknown) => {
    providers[which] = provider as never;
    const entry = new Disposable(() => {});
    subscriptions.push(entry);
    return entry;
  };
  const api = {
    languages: {
      registerDocumentFormattingEditProvider: registration('formatting'),
      registerDocumentRangeFormattingEditProvider: registration('rangeFormatting'),
      registerCodeActionsProvider: registration('quickFixes'),
      registerDocumentHighlightProvider: registration('highlights'),
      registerRenameProvider: registration('rename'),
      registerCallHierarchyProvider: registration('hierarchy')
    },
    workspace, Range, TextEdit, CodeAction, CodeActionKind: { QuickFix: 'quickfix' },
    WorkspaceEdit, DocumentHighlight,
    DocumentHighlightKind: { Read: 1, Write: 2, Text: 0 },
    CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall,
    SymbolKind: { Function: 12 }, Disposable
  };
  const disposable = registerScarpAdvancedEditorProviders(api as never);
  const cancel = { isCancellationRequested: false };
  return { doc, docs, providers, workspace, disposable, subscriptions,
    cancel, close: () => onClose?.(doc) };
}
function translated(document: Document, edits: readonly {range: RangeValue; newText: string}[]) {
  let result = document.getText();
  for (const edit of [...edits].reverse()) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}
function offsetRange(doc: Document, start: number, end = start): RangeValue {
  return new Range(doc.positionAt(start), doc.positionAt(end));
}

test('registers formatting, quick fixes, highlights, rename and call hierarchy', () => {
  const s = setup();
  assert.deepEqual(Object.keys(s.providers).sort(),
    ['formatting', 'rangeFormatting', 'quickFixes', 'highlights', 'rename', 'hierarchy'].sort());
  assert.equal(s.disposable.length, 8);
  s.disposable.forEach(disposable => disposable.dispose());
  assert.ok(s.disposable.every(disposable => (disposable as unknown as Disposable).disposed));
});

test('format-document adapter creates source-preserving editor edits', () => {
  const s = setup('funcra f() {\nprint(1);\n}\n');
  const edits = s.providers.formatting.provideDocumentFormattingEdits(s.doc,
    { tabSize: 4, insertSpaces: true }, s.cancel);
  assert.equal(translated(s.doc, edits), 'funcra f() {\n    print(1);\n}\n');
});

test('document formatting respects editor tab options', () => {
  const s = setup('funcra f() {\nprint(1);\n}\n');
  const edits = s.providers.formatting.provideDocumentFormattingEdits(s.doc,
    { tabSize: 2, insertSpaces: false }, s.cancel);
  assert.equal(translated(s.doc, edits), 'funcra f() {\n\tprint(1);\n}\n');
});

test('range formatting cannot change lines outside the selection', () => {
  const source = 'funcra f() {\nprint(1);\nprint(2);\n}\n';
  const s = setup(source);
  const at = source.indexOf('print(2)');
  const edits = s.providers.rangeFormatting.provideDocumentRangeFormattingEdits(s.doc,
    offsetRange(s.doc, at, at + 3), { tabSize: 2, insertSpaces: true }, s.cancel);
  assert.equal(translated(s.doc, edits),
    'funcra f() {\nprint(1);\n  print(2);\n}\n');
});

test('cancelled editor format requests are ignored without mutation', () => {
  const s = setup();
  assert.deepEqual(s.providers.formatting.provideDocumentFormattingEdits(s.doc,
    { tabSize: 2, insertSpaces: true }, { isCancellationRequested: true }), []);
});

test('malformed indentation options fail closed in a provider', () => {
  const s = setup();
  for (const tabSize of [0, -1, 1.2, 32, NaN]) {
    assert.deepEqual(s.providers.formatting.provideDocumentFormattingEdits(s.doc,
      { tabSize, insertSpaces: true }, s.cancel), []);
  }
});

test('restricted workspaces can still use read-only formatting', () => {
  const s = setup();
  s.workspace.isTrusted = false;
  assert.ok(s.providers.formatting.provideDocumentFormattingEdits(s.doc,
    { tabSize: 4, insertSpaces: true }, s.cancel).length > 0);
});

test('compiler diagnostic quick fixes appear only in trusted workspaces', () => {
  const source = 'let x = 1;';
  const s = setup(source);
  const context = { diagnostics: [{ source: 'Scarp', code: 'E0005',
    message: 'legacy let declaration', range: offsetRange(s.doc, 0) }] };
  const found = s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), context, s.cancel);
  assert.equal(found.length, 1);
  assert.equal(found[0].edit?.edits[0].value, 'bind');
  s.workspace.isTrusted = false;
  assert.deepEqual(s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), context, s.cancel), []);
});

test('diagnostics from another provider cannot trigger Scarp quick fixes', () => {
  const s = setup('let x = 1;');
  const context = { diagnostics: [{ source: 'Other', code: 'E0005',
    message: 'legacy let declaration', range: offsetRange(s.doc, 0) }] };
  assert.deepEqual(s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), context, s.cancel), []);
});

test('structured VS Code diagnostic code objects are recognized', () => {
  const s = setup('let x = 1;');
  const context = { diagnostics: [{ source: 'Scarp', code: { value: 'E0005' },
    message: 'legacy let declaration', range: offsetRange(s.doc, 0) }] };
  assert.equal(s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), context, s.cancel).length, 1);
});

test('a user explicitly requests local rename before any edit exists', () => {
  const s = setup('funcra f() { bind x = 2; print(x); }');
  const at = s.doc.text.indexOf('bind x') + 5;
  const prepared = s.providers.rename.prepareRename(s.doc, s.doc.positionAt(at), s.cancel);
  assert.equal(prepared?.placeholder, 'x');
  assert.equal(s.doc.getText(), 'funcra f() { bind x = 2; print(x); }');
});

test('rename emits a same-document workspace edit without applying it', () => {
  const s = setup('funcra f() { bind n = 1; print(n); }');
  const at = s.doc.text.indexOf('bind n') + 5;
  const edits = s.providers.rename.provideRenameEdits(s.doc,
    s.doc.positionAt(at), 'total', s.cancel);
  assert.equal(edits?.edits.length, 2);
  assert.ok(edits.edits.every((edit: { uri: unknown }) => edit.uri === s.doc.uri));
  assert.equal(s.doc.getText(), 'funcra f() { bind n = 1; print(n); }');
});

test('rename refuses conflicting new names', () => {
  const s = setup('funcra f() { bind a = 1; bind b = 2; print(a + b); }');
  const at = s.doc.text.indexOf('bind a') + 5;
  assert.equal(s.providers.rename.provideRenameEdits(s.doc,
    s.doc.positionAt(at), 'b', s.cancel), undefined);
});

test('rename and quick fixes are blocked in Restricted Mode', () => {
  const s = setup('funcra f() { bind x = 1; print(x); }');
  s.workspace.isTrusted = false;
  const at = s.doc.text.indexOf('bind x') + 5;
  assert.equal(s.providers.rename.prepareRename(s.doc, s.doc.positionAt(at), s.cancel), undefined);
  assert.equal(s.providers.rename.provideRenameEdits(s.doc,
    s.doc.positionAt(at), 'total', s.cancel), undefined);
});

test('document highlights distinguish resolved local reads from definitions', () => {
  const s = setup('funcra f() { bind x = 1; print(x); }');
  const at = s.doc.text.indexOf('bind x') + 5;
  const result = s.providers.highlights.provideDocumentHighlights(s.doc,
    s.doc.positionAt(at), s.cancel);
  assert.deepEqual(result.map((item: DocumentHighlight) => item.kind), [2, 1]);
});

test('document highlights do not require compiler execution or workspace trust', () => {
  const s = setup('funcra f(n: integer) { print(n); }');
  s.workspace.isTrusted = false;
  const at = s.doc.text.indexOf('n: integer');
  assert.equal(s.providers.highlights.provideDocumentHighlights(s.doc,
    s.doc.positionAt(at), s.cancel).length, 2);
});

test('call hierarchy resolves a known callable from its declaration name', () => {
  const s = setup('funcra a() { b(); }\nfuncra b() {}');
  const at = s.doc.text.indexOf('b() {}');
  const found = s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(at), s.cancel);
  assert.deepEqual(found.map((item: CallHierarchyItem) => item.name), ['b']);
});

test('call hierarchy resolves a callable from its call-site name', () => {
  const s = setup('funcra a() { b(); }\nfuncra b() {}');
  const at = s.doc.text.indexOf('b();');
  const found = s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(at), s.cancel);
  assert.deepEqual(found.map((item: CallHierarchyItem) => item.name), ['b']);
});

test('call hierarchy incoming and outgoing entries use source ranges', async () => {
  const s = setup('funcra a() { b(); b(); }\nfuncra b() {}');
  const at = s.doc.text.indexOf('funcra a') + 7;
  const [a] = s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(at), s.cancel);
  const outgoing = await s.providers.hierarchy.provideCallHierarchyOutgoingCalls(a, s.cancel);
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].to.name, 'b');
  assert.equal(outgoing[0].fromRanges.length, 2);
  const incoming = await s.providers.hierarchy.provideCallHierarchyIncomingCalls(
    outgoing[0].to, s.cancel);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].from.name, 'a');
  assert.equal(incoming[0].fromRanges.length, 2);
});

test('a missing or renamed source file cannot return guessed call hierarchy', async () => {
  const s = setup('funcra a() { b(); }\nfuncra b() {}');
  const [a] = s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(7), s.cancel);
  s.docs.delete(s.doc.uri.toString());
  assert.deepEqual(await s.providers.hierarchy.provideCallHierarchyIncomingCalls(a, s.cancel), []);
});

test('cancelled call-hierarchy reads are inert', async () => {
  const s = setup('funcra a() { b(); }\nfuncra b() {}');
  const token = { isCancellationRequested: true };
  assert.deepEqual(s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(7), token), []);
});

test('provider skips non-Scarp documents', () => {
  const s = setup('funcra f() { print(1); }');
  s.doc.languageId = 'plaintext';
  assert.deepEqual(s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(7), s.cancel), []);
  assert.deepEqual(s.providers.highlights.provideDocumentHighlights(s.doc,
    s.doc.positionAt(7), s.cancel), []);
});

test('non-file documents cannot trigger file-editing actions', () => {
  const s = setup('let x = 1;', 'untitled');
  const ctx = { diagnostics: [{ source: 'Scarp', code: 'E0005',
    message: 'obsolete let', range: offsetRange(s.doc, 0) }] };
  assert.deepEqual(s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), ctx, s.cancel), []);
  assert.equal(s.providers.rename.provideRenameEdits(s.doc,
    s.doc.positionAt(0), 'name', s.cancel), undefined);
});

test('close notifications invalidate the read-only cached snapshot', () => {
  const s = setup('funcra f() { print(1); }');
  s.providers.hierarchy.prepareCallHierarchy(s.doc, s.doc.positionAt(7), s.cancel);
  assert.doesNotThrow(() => s.close());
  assert.doesNotThrow(() => s.disposable.forEach(d => d.dispose()));
});

test('document changes during formatting discard all computed source edits', () => {
  const s = setup('funcra f() {\nprint(1);\n}\n');
  const original = s.doc.getText.bind(s.doc);
  let reads = 0;
  s.doc.getText = () => {
    if (++reads === 2) s.doc.version++;
    return original();
  };
  assert.deepEqual(s.providers.formatting.provideDocumentFormattingEdits(s.doc,
    { tabSize: 4, insertSpaces: true }, s.cancel), []);
});

test('document edits during rename cannot commit a stale plan', () => {
  const s = setup('funcra f() { bind n = 1; print(n); }');
  const original = s.doc.getText.bind(s.doc);
  let reads = 0;
  s.doc.getText = () => {
    if (++reads === 2) s.doc.text = s.doc.text.replace('print(n)', 'print(2)');
    return original();
  };
  const at = s.doc.text.indexOf('bind n') + 5;
  assert.equal(s.providers.rename.provideRenameEdits(s.doc,
    s.doc.positionAt(at), 'renamed', s.cancel), undefined);
});

test('a cancelled rename does not submit any workspace edits', () => {
  const s = setup('funcra f() { bind n = 1; print(n); }');
  const at = s.doc.text.indexOf('bind n') + 5;
  assert.equal(s.providers.rename.provideRenameEdits(s.doc,
    s.doc.positionAt(at), 'renamed', { isCancellationRequested: true }), undefined);
});

test('a cancelled diagnostic action cannot be offered after cancellation', () => {
  const s = setup('let x = 1;');
  const ctx = { diagnostics: [{ source: 'Scarp', code: 'E0005',
    message: 'obsolete let', range: offsetRange(s.doc, 0) }] };
  assert.deepEqual(s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), ctx, { isCancellationRequested: true }), []);
});

test('a changed source invalidates an old call hierarchy item selection', async () => {
  const s = setup('funcra alpha() { beta(); }\nfuncra beta() {}');
  const [item] = s.providers.hierarchy.prepareCallHierarchy(s.doc,
    s.doc.positionAt(s.doc.text.indexOf('beta() {}')), s.cancel);
  assert.ok(item);
  s.doc.text = s.doc.text.replace('funcra beta()', 'funcra gamma()');
  s.doc.version++;
  assert.deepEqual(await s.providers.hierarchy.provideCallHierarchyIncomingCalls(
    item, s.cancel), []);
});

test('a source document in another language cannot produce quick fixes', () => {
  const s = setup('let x = 1;');
  s.doc.languageId = 'plaintext';
  const ctx = { diagnostics: [{ source: 'Scarp', code: 'E0005',
    message: 'obsolete let', range: offsetRange(s.doc, 0) }] };
  assert.deepEqual(s.providers.quickFixes.provideCodeActions(s.doc,
    offsetRange(s.doc, 0), ctx, s.cancel), []);
});

test('a cancelled document-highlight request leaves the editor unchanged', () => {
  const s = setup('funcra f() { bind x = 1; print(x); }');
  const at = s.doc.text.indexOf('bind x') + 5;
  assert.deepEqual(s.providers.highlights.provideDocumentHighlights(s.doc,
    s.doc.positionAt(at), { isCancellationRequested: true }), []);
});
