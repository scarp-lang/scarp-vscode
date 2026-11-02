export interface ParsedDiagnostic {
  severity: 'error' | 'warning';
  code?: string;
  message: string;
  filename: string;
  line: number;
  column: number;
}

/** Parse Scarp's human-readable diagnostic format, not an invented JSON protocol. */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
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
