/**
 * Convert the native compiler's half-open UTF-8 byte spans into editor
 * coordinates without allocating one mapping entry per source character.
 *
 * The input is the exact frozen source snapshot, including any UTF-8 BOM.
 * Editor line/column values are one-based; columns count UTF-16 code units.
 * This is an informational mapping, not a runtime diagnostic or debugger.
 */
export interface NativeSourcePosition {
  readonly line: number;
  readonly column: number;
}
export interface NativeSourceSpan {
  readonly id: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly start: NativeSourcePosition;
  readonly end: NativeSourcePosition;
}

const MAX_BYTES = 1024 * 1024;
const MAX_SPANS = 65536;
const MAX_PREVIEW = 64;

export function nativeSpanPositions(
  source: Buffer, spans: readonly (readonly [number, number])[]
): NativeSourceSpan[] {
  if (source.length > MAX_BYTES || spans.length > MAX_SPANS) {
    throw new Error('Native source span mapping exceeds its size limit.');
  }
  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) {
    throw new Error('Native source span mapping requires valid UTF-8.');
  }
  const requested = new Set<number>();
  for (const [start, end] of spans) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || start > end || end > source.length) {
      throw new Error('Invalid native failure span byte range.');
    }
    requested.add(start);
    requested.add(end);
  }
  const offsets = [...requested].sort((a, b) => a - b);
  const positions = new Map<number, NativeSourcePosition>();
  let next = 0;
  let bytes = 0;
  let units = 0;
  let line = 1;
  let column = 1;
  function mark(): void {
    if (offsets[next] === bytes) {
      positions.set(bytes, { line, column });
      next++;
    } else if (next < offsets.length && offsets[next] < bytes) {
      throw new Error('Native failure span splits a UTF-8 code point.');
    }
  }

  // Scan code points once. Only requested endpoints are stored. Treat CRLF as
  // one newline, and a leading BOM as present in byte offsets but not in the
  // VS Code editor's visible text. Standalone CR and LF each end a line.
  for (const scalar of text) {
    mark();
    if (units === 0 && scalar === '\uFEFF') {
      // The first visible column remains 1 after the BOM.
    } else if (scalar === '\r') {
      if (text[units + 1] !== '\n') { line++; column = 1; }
    } else if (scalar === '\n') {
      line++;
      column = 1;
    } else {
      column += scalar.length;
    }
    bytes += Buffer.byteLength(scalar, 'utf8');
    units += scalar.length;
  }
  mark();
  if (next !== offsets.length) throw new Error('Unmapped native failure span.');

  return spans.map(([startByte, endByte], id) => ({
    id, startByte, endByte,
    start: positions.get(startByte)!,
    end: positions.get(endByte)!
  }));
}

/** A bounded human-readable preview. The full JSON report retains all spans. */
export function formatNativeSpanPreview(spans: readonly NativeSourceSpan[]): string {
  if (!spans.length) return 'No native failure spans reported.';
  const lines = [
    'Native failure spans (one-based lines and UTF-16 editor columns; end exclusive):'
  ];
  for (const span of spans.slice(0, MAX_PREVIEW)) {
    lines.push('  #' + span.id + ' bytes [' + span.startByte + ', ' + span.endByte +
      ') → ' + span.start.line + ':' + span.start.column + '–' +
      span.end.line + ':' + span.end.column);
  }
  if (spans.length > MAX_PREVIEW) {
    lines.push('  … ' + (spans.length - MAX_PREVIEW) +
      ' additional spans; see the full compiler JSON metadata.');
  }
  return lines.join('\n');
}
