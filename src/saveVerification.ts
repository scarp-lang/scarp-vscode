/**
 * Debounce repeated save notifications independently per file, and never start
 * two jobs for the same file at once. The worker decides whether a version
 * is still relevant before running an external compiler.
 */
export class DebouncedSerialTasks<T> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<string>();
  private readonly rerun = new Map<string, T>();
  private disposed = false;

  constructor(
    private readonly delayMs: number,
    private readonly execute: (key: string, value: T) => Promise<void>,
    private readonly reportError: (error: unknown) => void
  ) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error('Invalid save verification debounce interval');
    }
  }

  request(key: string, value: T): void {
    if (this.disposed) { return; }
    const existing = this.timers.get(key);
    if (existing) { clearTimeout(existing); }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.disposed) { return; }
      if (this.active.has(key)) {
        this.rerun.set(key, value);
      } else {
        void this.start(key, value);
      }
    }, this.delayMs));
  }

  private async start(key: string, value: T): Promise<void> {
    this.active.add(key);
    try {
      await this.execute(key, value);
    } catch (error) {
      this.reportError(error);
    } finally {
      this.active.delete(key);
      const hadRerun = this.rerun.has(key);
      const latest = this.rerun.get(key);
      this.rerun.delete(key);
      // A newer save may still be inside its debounce window. Do not
      // replace its pending timer with an older, already-expired rerun.
      if (!this.disposed && hadRerun && !this.timers.has(key)) {
        this.request(key, latest as T);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    this.timers.clear();
    this.rerun.clear();
  }
}
