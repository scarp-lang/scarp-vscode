import { scanScarpSymbols, type ScarpSymbolKind } from './documentSymbols';
import { scanScarpStructure, scarpLineAt, type ScarpStructure } from './editorStructure';

export interface ScarpSourceMetrics {
  readonly sourceBytes: number;
  readonly sourceCodeUnits: number;
  readonly physicalLines: number;
  readonly nonemptyLines: number;
  readonly whitespaceOnlyLines: number;
  readonly commentOnlyLines: number;
  readonly trailingComments: number;
  readonly stringLiterals: number;
  readonly numericLiterals: number;
  readonly identifiers: number;
  readonly imports: number;
  readonly regions: number;
  readonly delimiterPairs: number;
  readonly maximumDelimiterDepth: number;
  readonly functions: number;
  readonly records: number;
  readonly variants: number;
  readonly topLevelBindings: number;
  readonly topLevelVariables: number;
  readonly importedAliases: number;
}
function physicalLines(source: string): readonly string[] {
  // CRLF is one physical newline. Lone CR is supported for older editor files.
  return source.split(/\r\n|\r|\n/);
}
function symbolsByKind(
  symbols: readonly { kind: ScarpSymbolKind }[], kind: ScarpSymbolKind
): number {
  return symbols.filter(item => item.kind === kind).length;
}
/**
 * Syntactic source metrics; never a compiler complexity or type analysis.
 * These are safe to show in a source inventory report, not as diagnostics.
 *
 * A malformed/oversized source is omitted instead of inventing metrics;
 * this protects runtime and memory even when an editor file is adversarial.
 */
export function scarpSourceMetrics(
  source: string, snapshot?: ScarpStructure
): ScarpSourceMetrics | undefined {
  const parsed = snapshot ?? scanScarpStructure(source);
  if (!parsed || parsed.length !== source.length) { return undefined; }
  const lines = physicalLines(source);
  const symbols = scanScarpSymbols(source);
  const commentOnlyLines = new Set<number>();
  let trailingComments = 0;
  for (const comment of parsed.comments) {
    const line = scarpLineAt(parsed.lines, comment.start);
    if (source.slice(parsed.lines[line], comment.start).trim() === '') {
      commentOnlyLines.add(line);
    }
    else { trailingComments++; }
  }
  const maxDepth = parsed.pairs.reduce((largest, item) =>
    Math.max(largest, item.depth + 1), 0);
  const words = parsed.tokens.filter(item => item.kind === 'word');
  return {
    sourceBytes: Buffer.byteLength(source, 'utf8'),
    sourceCodeUnits: source.length,
    physicalLines: lines.length,
    nonemptyLines: lines.filter(line => line.trim() !== '').length,
    whitespaceOnlyLines: lines.filter(line => line.trim() === '').length,
    commentOnlyLines: commentOnlyLines.size,
    trailingComments,
    stringLiterals: parsed.strings.length,
    numericLiterals: parsed.tokens.filter(t => t.kind === 'number').length,
    identifiers: words.length,
    imports: parsed.imports.length,
    regions: parsed.regions.length,
    delimiterPairs: parsed.pairs.length,
    maximumDelimiterDepth: maxDepth,
    functions: symbolsByKind(symbols, 'function'),
    records: symbolsByKind(symbols, 'record'),
    variants: symbolsByKind(symbols, 'variant'),
    topLevelBindings: symbolsByKind(symbols, 'constant'),
    topLevelVariables: symbolsByKind(symbols, 'variable'),
    importedAliases: symbolsByKind(symbols, 'import')
  };
}
export interface ScarpMetricSummary {
  readonly sources: number;
  readonly bytes: number;
  readonly lines: number;
  readonly functions: number;
  readonly bindings: number;
  readonly comments: number;
  readonly imports: number;
  readonly maximumDepth: number;
}
export function summarizeScarpSourceMetrics(
  sources: readonly { readonly file: string; readonly source: string }[]
): ScarpMetricSummary {
  const result = {
    sources: 0, bytes: 0, lines: 0, functions: 0, bindings: 0,
    comments: 0, imports: 0, maximumDepth: 0
  };
  for (const item of sources) {
    const metrics = scarpSourceMetrics(item.source);
    if (!metrics) { continue; }
    result.sources++;
    result.bytes += metrics.sourceBytes;
    result.lines += metrics.physicalLines;
    result.functions += metrics.functions;
    result.bindings += metrics.topLevelBindings + metrics.topLevelVariables;
    result.comments += metrics.commentOnlyLines + metrics.trailingComments;
    result.imports += metrics.imports;
    result.maximumDepth = Math.max(result.maximumDepth,
      metrics.maximumDelimiterDepth);
  }
  return result;
}
