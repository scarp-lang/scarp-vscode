import type { ScarpStructure, ScarpSpan, ScarpToken } from './editorStructure';

export interface ScarpQuickFixContext {
  /** Exact compiler diagnostic code, never inferred from the message. */
  readonly code: unknown;
  readonly message: string;
  /** VS Code UTF-16 start/end of the compiler-reported primary diagnostic. */
  readonly range: ScarpSpan;
}
export interface ScarpQuickFix {
  readonly title: string;
  readonly kind: 'quickfix';
  readonly diagnosticCode: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /** Explanation shown to the editor user; no fix is applied automatically. */
  readonly detail: string;
}
export interface ScarpQuickFixOptions {
  readonly maximumDocumentLength?: number;
  readonly maximumActions?: number;
}
const DEFAULT_MAX_DOCUMENT = 512_000;
const DEFAULT_MAX_ACTIONS = 8;

function validInteger(value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value > 0 && value <= max ? value : 0;
}
function validSpan(source: string, span: ScarpSpan): boolean {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
    span.start >= 0 && span.start <= span.end && span.end <= source.length;
}
function isWithinProtectedSpan(offset: number, structure: ScarpStructure): boolean {
  return structure.strings.some(s => s.start <= offset && offset < s.end) ||
    structure.comments.some(s => s.start <= offset && offset < s.end);
}
function lineStart(text: string, offset: number): number {
  for (let index = offset - 1; index >= 0; index--) {
    if (text[index] === '\n' || text[index] === '\r') return index + 1;
  }
  return 0;
}
function lineEnd(text: string, offset: number): number {
  let at = offset;
  while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++;
  return at;
}
function previousNonWhitespace(text: string, end: number): number {
  let index = end - 1;
  while (index >= 0 && /\s/.test(text[index])) index--;
  return index;
}
function nextNonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}
function tokenAt(structure: ScarpStructure, offset: number): ScarpToken | undefined {
  let lo = 0, hi = structure.tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (structure.tokens[mid].span.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  const token = structure.tokens[lo];
  return token && token.span.start <= offset && offset < token.span.end
    ? token : undefined;
}
function previousToken(structure: ScarpStructure, offset: number): ScarpToken | undefined {
  let lo = 0, hi = structure.tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (structure.tokens[mid].span.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return structure.tokens[lo - 1];
}
function nextToken(structure: ScarpStructure, offset: number): ScarpToken | undefined {
  let lo = 0, hi = structure.tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (structure.tokens[mid].span.start < offset) lo = mid + 1;
    else hi = mid;
  }
  return structure.tokens[lo];
}
function statementBoundary(token: ScarpToken | undefined): boolean {
  return !token || token.text === ';' || token.text === '{' || token.text === '}';
}
function validIdentifier(token: ScarpToken | undefined): boolean {
  return !!token && token.kind === 'word' && /^[A-Za-z_][A-Za-z_0-9]*$/.test(token.text);
}
function makeFix(
  code: string, title: string, start: number, end: number,
  replacement: string, detail: string
): ScarpQuickFix {
  return { kind: 'quickfix', diagnosticCode: code, title, start, end, replacement, detail };
}

/**
 * Legacy language spelling. It is safe only when the compiler explicitly
 * reports the obsolete declaration: this is not a global let-to-bind replace.
 * Convert exactly the starting keyword and preserve every other source byte.
 */
function legacyDeclarationFix(
  text: string, parsed: ScarpStructure, report: ScarpQuickFixContext
): ScarpQuickFix | undefined {
  if (report.code !== 'E0005' || !/\blet\b/i.test(report.message)) return undefined;
  const at = report.range.start;
  const token = tokenAt(parsed, at) ?? nextToken(parsed, at);
  if (!token || token.text !== 'let' || token.kind !== 'word' ||
      token.span.start < lineStart(text, at)) return undefined;
  if (isWithinProtectedSpan(token.span.start, parsed)) return undefined;
  const before = previousToken(parsed, token.span.start);
  if (!statementBoundary(before)) return undefined;
  // Only complete, ordinary declaration forms are eligible. The compiler
  // decides whether the resulting program typechecks after the user applies it.
  const after = nextToken(parsed, token.span.end);
  let spelling = 'bind';
  let end = token.span.end;
  let identifier = after;
  if (after?.text === 'mut') {
    spelling = 'var';
    end = after.span.end;
    identifier = nextToken(parsed, end);
  }
  if (!identifier || !validIdentifier(identifier) || identifier.text === '_') return undefined;
  const afterName = nextToken(parsed, identifier.span.end);
  if (!afterName || ![':', '='].includes(afterName.text)) return undefined;
  if (lineEnd(text, token.span.start) < afterName.span.start) return undefined;
  return makeFix('E0005', spelling === 'var' ? 'Convert let mut to var' : 'Convert let to bind',
    token.span.start, end, spelling, 'Replace only the old declaration keyword.');
}

/**
 * Missing statement terminator. A Scarp source snapshot may contain many
 * semicolons, so only an explicit compiler expectation at the end of a
 * statement is actionable. Comments and strings are never edited.
 */
function terminatorFix(
  text: string, parsed: ScarpStructure, report: ScarpQuickFixContext
): ScarpQuickFix | undefined {
  if (report.code !== 'E0004' ||
      !/expected\s+['`"]?;['`"]?/i.test(report.message)) return undefined;
  const at = report.range.start;
  if (isWithinProtectedSpan(at, parsed) || at !== report.range.end) return undefined;
  const prevIndex = previousNonWhitespace(text, at);
  if (prevIndex < 0) return undefined;
  const prev = text[prevIndex];
  // End-of-block or EOF is an unambiguous semicolon insertion point only if
  // the reported offset itself is the next nonspace position or a closing }.
  const nextIndex = nextNonWhitespace(text, at);
  if (nextIndex < text.length && text[nextIndex] !== '}') return undefined;
  if ([';', '{', '}', ':', ','].includes(prev)) return undefined;
  const before = previousToken(parsed, nextIndex);
  if (before && before.span.end > at && before.kind !== 'punctuation') return undefined;
  // Do not modify a line whose terminator would land inside a comment, even
  // if the diagnostic points just after comment text.
  if (parsed.comments.some(s => s.start <= at && at <= s.end)) return undefined;
  const insertion = prevIndex + 1;
  if (parsed.strings.some(s => s.start < insertion && insertion < s.end)) return undefined;
  return makeFix('E0004', 'Insert missing semicolon', insertion, insertion,
    ';', 'Insert the exact terminator requested by Scarp.');
}

/**
 * Enforces source bounds and deduplicates fixes from the compiler. The caller
 * can hand these edits to VS Code's CodeActionProvider, but must never run
 * source, ask a model for a speculative repair, or auto-apply a suggestion.
 */
export function scarpQuickFixes(
  source: string, structure: ScarpStructure, diagnostics: readonly ScarpQuickFixContext[],
  options: ScarpQuickFixOptions = {}
): readonly ScarpQuickFix[] {
  const maxDocument = validInteger(options.maximumDocumentLength, DEFAULT_MAX_DOCUMENT, 2_000_000);
  const maxActions = validInteger(options.maximumActions, DEFAULT_MAX_ACTIONS, 100);
  if (!maxDocument || !maxActions || source.length > maxDocument ||
      structure.length !== source.length) return [];
  const seen = new Set<string>();
  const fixes: ScarpQuickFix[] = [];
  for (const report of diagnostics) {
    if (!validSpan(source, report.range) || typeof report.message !== 'string') continue;
    const fix = legacyDeclarationFix(source, structure, report) ??
      terminatorFix(source, structure, report);
    if (!fix || fix.start > fix.end || fix.start < 0 || fix.end > source.length ||
        isWithinProtectedSpan(fix.start, structure)) continue;
    const identity = `${fix.start}:${fix.end}:${fix.replacement}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    fixes.push(fix);
    if (fixes.length >= maxActions) break;
  }
  return fixes;
}
