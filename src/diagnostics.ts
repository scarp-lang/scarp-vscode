export interface ParsedDiagnostic {
  severity: 'error' | 'warning';
  code?: string;
  message: string;
  filename: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  help?: string;
}

interface SourcePosition { line: number; column: number; }
interface SourceLocation {
  path: string;
  start: SourcePosition;
  end: SourcePosition;
}
interface JsonDiagnostic {
  schema_version: number;
  severity: 'error' | 'warning';
  code: string | null;
  message: string;
  primary: SourceLocation | null;
  help: string | null;
}

function position(value: unknown): value is SourcePosition {
  if (!value || typeof value !== 'object') { return false; }
  const result = value as Partial<SourcePosition>;
  return Number.isSafeInteger(result.line) && Number(result.line) >= 1 &&
    Number.isSafeInteger(result.column) && Number(result.column) >= 1;
}

/** Read only the published Scarp v1 diagnostic JSON envelope (not arbitrary JSON). */
function parseJsonDiagnostic(text: string): ParsedDiagnostic[] | undefined {
  if (!text.trimStart().startsWith('{')) { return undefined; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return undefined; }
  if (!value || typeof value !== 'object') { return undefined; }
  const diagnostic = value as Partial<JsonDiagnostic>;
  if (diagnostic.schema_version !== 1 || typeof diagnostic.message !== 'string' ||
      (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning')) {
    return undefined;
  }
  const source = diagnostic.primary;
  if (!source || typeof source !== 'object' || typeof source.path !== 'string' ||
      !source.path || !position(source.start) || !position(source.end)) {
    // File I/O and usage diagnostics legitimately have null locations.
    return [];
  }
  const start = source.start;
  const end = source.end;
  const endAfterStart = end.line > start.line ||
    (end.line === start.line && end.column >= start.column);
  return [{
    severity: diagnostic.severity,
    code: typeof diagnostic.code === 'string' ? diagnostic.code : undefined,
    message: diagnostic.message,
    filename: source.path,
    line: start.line,
    column: start.column,
    endLine: endAfterStart ? end.line : undefined,
    endColumn: endAfterStart ? end.column : undefined,
    help: typeof diagnostic.help === 'string' ? diagnostic.help : undefined
  }];
}

/** Parse structured alpha.3 diagnostics or legacy compiler text. */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
  const structured = parseJsonDiagnostic(text);
  if (structured !== undefined) { return structured; }

  const lines = text.split(/\r?\n/);
  const result: ParsedDiagnostic[] = [];
  for (let index = 0; index < lines.length; index++) {
    const header = /^(error|warning)(?:\[([A-Za-z]\d{4})\])?:\s*(.+)$/.exec(lines[index].trim());
    if (!header) { continue; }
    // Look only a few lines ahead: do not assign a location from a later error.
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 5); lookahead++) {
      if (/^(error|warning)(?:\[|:)/.test(lines[lookahead].trim())) { break; }
      const location = /^\s*-->\s+(.+):(\d+):(\d+)\s*$/.exec(lines[lookahead]);
      if (!location) { continue; }
      const line = Number(location[2]);
      const column = Number(location[3]);
      if (line > 0 && column > 0 && Number.isSafeInteger(line) && Number.isSafeInteger(column)) {
        result.push({
          severity: header[1] as 'error' | 'warning',
          code: header[2],
          message: header[3],
          filename: location[1],
          line,
          column
        });
      }
      break;
    }
  }
  return result;
}

/** Scarp's columns use Unicode scalar values; VS Code needs UTF-16 offsets. */
export function utf16OffsetForScalarColumn(line: string, column: number): number {
  if (column <= 1) { return 0; }
  return Array.from(line).slice(0, column - 1).join('').length;
}
