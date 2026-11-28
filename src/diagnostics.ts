/** Secondary compiler source ranges, displayed as linked VS Code related information. */
export interface ParsedDiagnosticRelated {
  message: string;
  filename: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

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
  related?: readonly ParsedDiagnosticRelated[];
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
  related?: Array<{ message: string; location: SourceLocation | null }>;
}

const MAX_RELATED_LOCATIONS = 8;

function position(value: unknown): value is SourcePosition {
  if (!value || typeof value !== 'object') { return false; }
  const result = value as Partial<SourcePosition>;
  return Number.isSafeInteger(result.line) && Number(result.line) >= 1 &&
    Number.isSafeInteger(result.column) && Number(result.column) >= 1;
}

/** Validate a source range without trusting the compiler's JSON runtime shape. */
function sourceRange(value: unknown): Omit<ParsedDiagnosticRelated, 'message'> | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const source = value as Partial<SourceLocation>;
  if (typeof source.path !== 'string' || !source.path || source.path.includes('\0') ||
      !position(source.start) || !position(source.end)) { return undefined; }
  const start = source.start;
  const end = source.end;
  const forwards = end.line > start.line ||
    (end.line === start.line && end.column >= start.column);
  return {
    filename: source.path, line: start.line, column: start.column,
    endLine: forwards ? end.line : undefined,
    endColumn: forwards ? end.column : undefined
  };
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
  const primary = sourceRange(diagnostic.primary);
  if (!primary) {
    // File I/O and usage diagnostics legitimately have null locations.
    return [];
  }
  const related: ParsedDiagnosticRelated[] = [];
  if (Array.isArray(diagnostic.related)) {
    for (const note of diagnostic.related.slice(0, MAX_RELATED_LOCATIONS)) {
      if (!note || typeof note !== 'object' ||
          typeof note.message !== 'string' || !note.message) { continue; }
      const location = sourceRange(note.location);
      if (location) { related.push({ message: note.message, ...location }); }
    }
  }
  return [{
    severity: diagnostic.severity,
    code: typeof diagnostic.code === 'string' ? diagnostic.code : undefined,
    message: diagnostic.message,
    ...primary,
    help: typeof diagnostic.help === 'string' ? diagnostic.help : undefined,
    ...(related.length ? { related } : {})
  }];
}

/**
 * The Extension Host caps compiler output at one MiB. Maintain the same
 * ceiling when this parser is used independently of the process runner.
 * Refuse truncated or unbounded data rather than publishing partial Problems.
 */
const MAX_DIAGNOSTIC_OUTPUT = 1024 * 1024;
const MAX_DIAGNOSTICS = 512;

/**
 * Parse official schema-v1 envelopes and older source-location text.
 *
 * The compiler normally emits one JSON object. Some wrappers forward
 * multiple, newline-delimited JSON envelopes and progress text; accept those
 * envelopes independently without interpreting arbitrary JSON as diagnostics.
 * Preserve original emission order when structured and textual diagnostics
 * coexist, and never infer missing source positions.
 */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
  if (text.length > MAX_DIAGNOSTIC_OUTPUT) { return []; }
  const structured = parseJsonDiagnostic(text);
  if (structured !== undefined) { return structured; }

  const lines = text.split(/\r?\n/);
  const result: ParsedDiagnostic[] = [];
  for (let index = 0; index < lines.length && result.length < MAX_DIAGNOSTICS; index++) {
    // JSON Lines keep each v1 envelope self-contained. A null-location JSON
    // record is still recognized, but does not invent a VS Code diagnostic.
    const envelope = parseJsonDiagnostic(lines[index]);
    if (envelope !== undefined) {
      result.push(...envelope);
      continue;
    }

    const header = /^(error|warning)(?:\[([A-Za-z]\d{4})\])?:\s*(.+)$/.exec(lines[index].trim());
    if (!header) { continue; }
    // Look only a few lines ahead: do not assign a location from a later error.
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 5); lookahead++) {
      // A subsequent JSON envelope is another diagnostic, not a location
      // belonging to the current legacy error header.
      if (parseJsonDiagnostic(lines[lookahead]) !== undefined ||
          /^(error|warning)(?:\[|:)/.test(lines[lookahead].trim())) { break; }
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

/**
 * Scarp's columns use Unicode scalar values; VS Code needs UTF-16 offsets.
 * Scan only as far as the target column, without allocating an array of every
 * codepoint on potentially large or malformed source lines.
 */
export function utf16OffsetForScalarColumn(line: string, column: number): number {
  if (!Number.isSafeInteger(column) || column <= 1) { return 0; }
  let offset = 0;
  let scalar = 1;
  while (offset < line.length && scalar < column) {
    const point = line.codePointAt(offset)!;
    offset += point > 0xffff ? 2 : 1;
    scalar++;
  }
  return offset;
}
