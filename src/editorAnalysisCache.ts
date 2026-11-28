import type { ScarpStructure } from './editorStructure';
import { scarpLocalCallGraph, type ScarpCallGraph } from './editorCallHierarchy';
import { scarpLocalBindings, type ScarpLocalBindings } from './editorLocalBindings';

export interface ScarpAnalysisCacheOptions {
  readonly maximumEntries?: number;
  readonly maximumSourceBytes?: number;
  readonly maximumTotalBytes?: number;
}
export interface ScarpAnalysisCacheStats {
  readonly entries: number;
  readonly allocatedBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly callGraphComputations: number;
  readonly bindingComputations: number;
}
interface Snapshot {
  readonly version: number;
  readonly source: string;
  readonly structure: ScarpStructure;
  readonly size: number;
  graph?: ScarpCallGraph;
  locals?: ScarpLocalBindings;
  graphComputed: boolean;
  localsComputed: boolean;
}
const DEFAULT_ENTRIES = 8;
const DEFAULT_TOTAL_BYTES = 8_000_000;
const DEFAULT_SOURCE_BYTES = 1_000_000;
function positive(value: number | undefined, fallback: number, ceiling: number): number {
  const n = value ?? fallback;
  return Number.isSafeInteger(n) && n > 0 && n <= ceiling ? n : 0;
}

/**
 * Bounded process-local LRU for expensive lexical lookups. No timers,
 * filesystem reads, network, source execution or persistent storage.
 * A version number alone is insufficient: external edits may reuse it, so
 * the exact UTF-16 source is checked before any previous result is returned.
 */
export class ScarpEditorAnalysisCache {
  private readonly entries = new Map<string, Snapshot>();
  private readonly maximumEntries: number;
  private readonly maximumSourceBytes: number;
  private readonly maximumTotalBytes: number;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private graphComputations = 0;
  private bindingComputations = 0;

  constructor(options: ScarpAnalysisCacheOptions = {}) {
    this.maximumEntries = positive(options.maximumEntries, DEFAULT_ENTRIES, 512);
    this.maximumSourceBytes = positive(options.maximumSourceBytes, DEFAULT_SOURCE_BYTES, 2_000_000);
    this.maximumTotalBytes = positive(options.maximumTotalBytes, DEFAULT_TOTAL_BYTES, 256_000_000);
  }
  /** Call only after a successfully parsed, current editor structure exists. */
  private snapshot(
    key: string, version: number, source: string, structure: ScarpStructure
  ): Snapshot | undefined {
    if (!this.maximumEntries || !this.maximumSourceBytes || !this.maximumTotalBytes ||
        !key || key.length > 8192 || !Number.isSafeInteger(version) || version < 0 ||
        structure.length !== source.length || source.length > this.maximumSourceBytes) return undefined;
    const previous = this.entries.get(key);
    if (previous && previous.version === version && previous.source === source &&
        previous.structure === structure) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, previous);
      return previous;
    }
    this.misses++;
    if (previous) this.remove(key);
    const size = source.length * 2;
    const state: Snapshot = {
      version, source, structure, size,
      graphComputed: false, localsComputed: false
    };
    if (size <= this.maximumTotalBytes) {
      while (this.entries.size >= this.maximumEntries ||
             this.bytes + size > this.maximumTotalBytes) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.remove(oldest);
        this.evictions++;
      }
      this.entries.set(key, state);
      this.bytes += size;
    }
    return state;
  }
  graph(key: string, version: number, source: string,
    structure: ScarpStructure): ScarpCallGraph | undefined {
    const value = this.snapshot(key, version, source, structure);
    if (!value) return undefined;
    if (!value.graphComputed) {
      this.graphComputations++;
      value.graph = scarpLocalCallGraph(source, structure);
      value.graphComputed = true;
    }
    return value.graph;
  }
  bindings(key: string, version: number, source: string,
    structure: ScarpStructure): ScarpLocalBindings | undefined {
    const value = this.snapshot(key, version, source, structure);
    if (!value) return undefined;
    if (!value.localsComputed) {
      this.bindingComputations++;
      value.locals = scarpLocalBindings(source, structure);
      value.localsComputed = true;
    }
    return value.locals;
  }
  private remove(key: string): void {
    const value = this.entries.get(key);
    if (!value) return;
    this.entries.delete(key);
    this.bytes -= value.size;
  }
  invalidate(key: string): void { this.remove(key); }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
  stats(): ScarpAnalysisCacheStats {
    return {
      entries: this.entries.size, allocatedBytes: this.bytes,
      hits: this.hits, misses: this.misses, evictions: this.evictions,
      callGraphComputations: this.graphComputations,
      bindingComputations: this.bindingComputations
    };
  }
}
