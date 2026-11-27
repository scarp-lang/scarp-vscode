import { BUILTIN_DOCUMENT_LIMIT, BUILTIN_DOCUMENT_TOKEN_LIMIT,
  scanBuiltinContext, type BuiltinToken } from './builtinLexicalContext';

export interface BuiltinEditorSnapshot {
  readonly source: string;
  readonly tokens: readonly BuiltinToken[];
}
interface Entry {
  readonly version: number;
  readonly source: string;
  readonly snapshot: BuiltinEditorSnapshot | undefined;
  readonly tokenCount: number;
}
const MAX_ENTRIES = 4;
const MAX_RETAINED_UNITS = BUILTIN_DOCUMENT_LIMIT * 2;
const MAX_RETAINED_TOKENS = BUILTIN_DOCUMENT_TOKEN_LIMIT * 2;

/** Bounded LRU of exact document prefixes, not arbitrary suffixes. No timers,
 * I/O or compiler invocations. Failed scans are negatively cached by version.
 * The caller may provide a bounded prefix of a larger document, but may only
 * query complete lines (or a signature cursor) within that prefix.
 */
export class BuiltinEditorCache {
  private readonly entries = new Map<string, Entry>();
  private units = 0;
  private tokens = 0;

  get(key: string, version: number, source: string): BuiltinEditorSnapshot | undefined {
    if (!key || !Number.isSafeInteger(version) || version < 0 ||
        source.length > BUILTIN_DOCUMENT_LIMIT) return undefined;
    const previous = this.entries.get(key);
    if (previous?.version === version && previous.source === source) {
      this.entries.delete(key);
      this.entries.set(key, previous);
      return previous.snapshot;
    }
    this.invalidate(key);
    const tokens = scanBuiltinContext(source, true);
    const snapshot = tokens ? { source, tokens } : undefined;
    const tokenCount = tokens?.length ?? 0;
    while (this.entries.size >= MAX_ENTRIES ||
           this.units + source.length > MAX_RETAINED_UNITS ||
           this.tokens + tokenCount > MAX_RETAINED_TOKENS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.invalidate(oldest);
    }
    this.entries.set(key, { version, source, snapshot, tokenCount });
    this.units += source.length;
    this.tokens += tokenCount;
    return snapshot;
  }

  invalidate(key: string): void {
    const old = this.entries.get(key);
    if (!old) return;
    this.entries.delete(key);
    this.units -= old.source.length;
    this.tokens -= old.tokenCount;
  }

  clear(): void {
    this.entries.clear();
    this.units = 0;
    this.tokens = 0;
  }

  stats(): { entries: number; units: number; tokens: number } {
    return { entries: this.entries.size, units: this.units, tokens: this.tokens };
  }
}
