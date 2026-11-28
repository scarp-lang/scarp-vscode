import { utf16OffsetForScalarColumn } from './diagnostics';

/** Subset of a compiler-reported primary or related JSON source location. */
export interface ScarpSourceSpan {
  readonly filename: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

/** The minimal editor document contract needed to map scalar coordinates. */
export interface ScarpEditorDocument {
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
}

/** VS Code positions use zero-based UTF-16 offsets, not Unicode scalar columns. */
export interface ScarpEditorPosition {
  readonly line: number;
  readonly character: number;
}
export interface ScarpEditorRange {
  readonly start: ScarpEditorPosition;
  readonly end: ScarpEditorPosition;
}

function editorLineIndex(requested: number, total: number): number {
  return Math.min(requested - 1, total - 1);
}

/**
 * Convert Scarp's one-based Unicode scalar positions to a VS Code range.
 *
 * The compiler's source is read from disk while the editor may be displaying
 * a newer buffer. Clamp to the actual document shape rather than letting a
 * stale source position escape the document. The caller must still reject
 * stale compiler results before publishing Problems.
 *
 * Empty spans receive a one-character highlight where possible, matching
 * the historical Scarp editor behavior at unexpected tokens and EOF.
 */
export function scarpSpanToEditorRange(
  document: ScarpEditorDocument, span: ScarpSourceSpan
): ScarpEditorRange | undefined {
  if (!Number.isSafeInteger(document.lineCount) || document.lineCount < 1 ||
      !Number.isSafeInteger(span.line) || span.line < 1 ||
      !Number.isSafeInteger(span.column) || span.column < 1 ||
      (span.endLine !== undefined &&
        (!Number.isSafeInteger(span.endLine) || span.endLine < 1)) ||
      (span.endColumn !== undefined &&
        (!Number.isSafeInteger(span.endColumn) || span.endColumn < 1))) {
    return undefined;
  }

  const startLine = editorLineIndex(span.line, document.lineCount);
  const startText = document.lineAt(startLine).text;
  const startColumn = Math.min(
    utf16OffsetForScalarColumn(startText, span.column), startText.length
  );
  const candidateEndLine = editorLineIndex(
    span.endLine ?? span.line, document.lineCount
  );
  const endLine = Math.max(startLine, candidateEndLine);
  const endText = endLine === startLine
    ? startText : document.lineAt(endLine).text;
  const candidateEndColumn = span.endColumn === undefined
    ? Math.min(startColumn + 1, endText.length)
    : Math.min(utf16OffsetForScalarColumn(endText, span.endColumn), endText.length);
  const endColumn = endLine === startLine && candidateEndColumn <= startColumn
    ? Math.min(startColumn + 1, startText.length) : candidateEndColumn;

  return {
    start: { line: startLine, character: startColumn },
    end: { line: endLine, character: endColumn }
  };
}
