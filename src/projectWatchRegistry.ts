import * as path from 'node:path';

export interface WatchDisposable { dispose(): void }
export type SourceWatchFactory = (
  root: string, pattern: string, changed: (filename: string) => void
) => WatchDisposable;

interface TrackedProject {
  owner: string;
  watchers: WatchDisposable[];
}

/**
 * Scope file-event watchers to explicitly verified roots, not every open
 * workspace. Only the newest eight verified projects retain watchers.
 * The oldest project's Problems must be invalidated when its watch is evicted.
 */
export class ProjectWatchRegistry implements WatchDisposable {
  private readonly tracked = new Map<string, TrackedProject>();

  constructor(
    private readonly factory: SourceWatchFactory,
    private readonly onEvicted: (root: string, owner: string) => void,
    private readonly maxProjects = 8
  ) {
    if (!Number.isSafeInteger(maxProjects) || maxProjects < 1) {
      throw new Error('Project watch limit must be a positive integer.');
    }
  }

  track(root: string, owner: string, changed: (filename: string) => void): void {
    const key = path.resolve(root);
    this.stopRoot(key);

    if (this.tracked.size >= this.maxProjects) {
      const [oldRoot, old] = this.tracked.entries().next().value as
        [string, TrackedProject];
      this.stopRoot(oldRoot);
      this.onEvicted(oldRoot, old.owner);
    }

    const watchers: WatchDisposable[] = [];
    try {
      watchers.push(this.factory(key, '**/*.srp', changed));
      watchers.push(this.factory(key, 'Scarp.project', changed));
    } catch (error) {
      watchers.forEach(watcher => watcher.dispose());
      throw error;
    }
    this.tracked.set(key, { owner, watchers });
  }

  stopOwner(owner: string): void {
    for (const [root, item] of this.tracked) {
      if (item.owner === owner) { this.stopRoot(root); }
    }
  }

  stopRoot(root: string): void {
    const key = path.resolve(root);
    const item = this.tracked.get(key);
    if (!item) { return; }
    this.tracked.delete(key);
    for (const watcher of item.watchers) { watcher.dispose(); }
  }

  dispose(): void {
    for (const root of this.tracked.keys()) { this.stopRoot(root); }
  }
}
