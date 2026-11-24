import {
  scanScarpStructure, type ScarpStructure, type ScarpScanOptions
} from './editorStructure';

interface CachedStructure {
  readonly key: string;
  readonly version: number;
  readonly source: string;
  readonly structure: ScarpStructure | undefined;
  readonly cost: number;
}
export interface ScarpStructureCacheOptions {
  readonly maximumEntries?: number;
  readonly maximumBytes?: number;
  readonly scan?: ScarpScanOptions;
}
export interface ScarpStructureCacheStats {
  readonly entries: number;
  readonly allocatedBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}
const DEFAULT_ENTRIES = 12;
const DEFAULT_BYTES = 12_000_000;
function positive(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value > 0 ? value : 0;
}
/**
 * Snapshot-only, process-local LRU for editor structural queries.
 * No background timers, filesystem I/O, compiler invocation or network access.
 * Source version plus exact text guard against stale ranges during edits.
 *
 * A rejected scan is also cached by version to avoid repeated pathological
 * lexing attempts until the user actually changes the source.
 */
export class ScarpStructureCache {
  private readonly entries = new Map<string, CachedStructure>();
  private readonly maximumEntries: number;
  private readonly maximumBytes: number;
  private readonly scanOptions: ScarpScanOptions;
  private allocatedBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ScarpStructureCacheOptions = {}) {
    this.maximumEntries = positive(options.maximumEntries, DEFAULT_ENTRIES);
    this.maximumBytes = positive(options.maximumBytes, DEFAULT_BYTES);
    this.scanOptions = options.scan ?? {};
  }
  public get(key: string, version: number, source: string): ScarpStructure | undefined {
    if (!key || !Number.isSafeInteger(version) || version < 0 ||
        !this.maximumBytes || !this.maximumEntries) { return undefined; }
    const previous = this.entries.get(key);
    if (previous && previous.version === version && previous.source === source) {
      this.entries.delete(key);
      this.entries.set(key, previous);
      this.hits++;
      return previous.structure;
    }
    this.misses++;
    if (previous) { this.remove(key); }
    const scanned = scanScarpStructure(source, this.scanOptions);
    const cost = source.length * 2;
    if (cost > this.maximumBytes) { return scanned; }
    while (this.entries.size >= this.maximumEntries ||
           this.allocatedBytes + cost > this.maximumBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) { break; }
      this.remove(oldest);
      this.evictions++;
    }
    const snapshot: CachedStructure = {
      key, version, source, structure: scanned, cost
    };
    this.entries.set(key, snapshot);
    this.allocatedBytes += cost;
    return scanned;
  }
  public invalidate(key: string): void {
    this.remove(key);
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) { return; }
    this.entries.delete(key);
    this.allocatedBytes -= entry.cost;
  }
  public clear(): void {
    this.entries.clear();
    this.allocatedBytes = 0;
  }
  public stats(): ScarpStructureCacheStats {
    return {
      entries: this.entries.size,
      allocatedBytes: this.allocatedBytes,
      hits: this.hits, misses: this.misses, evictions: this.evictions
    };
  }
}
