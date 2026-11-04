import * as path from 'node:path';
import {
  ProjectDiskSnapshot, sameProjectDisk, snapshotProjectDisk
} from './projectDiskSnapshot';

export interface WatchDisposable { dispose(): void }
export type SourceWatchFactory = (
  root: string, pattern: string, changed: (filename: string) => void
) => WatchDisposable;

interface TrackedProject {
  owner: string;
  snapshot: ProjectDiskSnapshot;
  watchers: WatchDisposable[];
}

/**
 * Watch only explicitly verified roots. Focus-time reconciliation hashes the
 * exact verified source snapshot to detect edits missed by filesystem events.
 * The oldest of at most eight roots is evicted with its stale diagnostics.
 */
export class ProjectWatchRegistry implements WatchDisposable {
  private readonly tracked = new Map<string, TrackedProject>();
  private reconciling: Promise<number> | undefined;

  constructor(
    private readonly factory: SourceWatchFactory,
    private readonly onEvicted: (root: string, owner: string) => void,
    private readonly maxProjects = 8,
    private readonly readSnapshot: (root: string) => Promise<ProjectDiskSnapshot> =
      snapshotProjectDisk
  ) {
    if (!Number.isSafeInteger(maxProjects) || maxProjects < 1) {
      throw new Error('Project watch limit must be a positive integer.');
    }
  }

  track(
    root: string, owner: string, changed: (filename: string) => void,
    snapshot: ProjectDiskSnapshot
  ): void {
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
    // Make our own copy so callers cannot change the verification baseline.
    this.tracked.set(key, { owner, snapshot: new Map(snapshot), watchers });
  }

  /**
   * Compare completed verifications only when requested (e.g. focus regained).
   * Never invoke Scarp, reread non-verified roots, or mutate unrelated Problems.
   * Failed snapshots fail closed; disposed/replaced watches cannot be evicted
   * by an outdated in-flight reconciliation.
   */
  reconcile(): Promise<number> {
    if (this.reconciling) { return this.reconciling; }
    const work = this.reconcileOnce();
    this.reconciling = work;
    // Use both settlement branches to avoid an unhandled rejection if a
    // future reconciliation callback reports an unexpected error.
    const clear = () => {
      if (this.reconciling === work) { this.reconciling = undefined; }
    };
    void work.then(clear, clear);
    return work;
  }

  private async reconcileOnce(): Promise<number> {
    let invalidated = 0;
    for (const [root, item] of [...this.tracked.entries()]) {
      let current = false;
      try {
        current = sameProjectDisk(item.snapshot, await this.readSnapshot(root));
      } catch {
        // Deleted directories, permissions and oversized trees are unsafe.
        current = false;
      }
      if (this.tracked.get(root) !== item || current) { continue; }
      this.stopRoot(root);
      this.onEvicted(root, item.owner);
      invalidated++;
    }
    return invalidated;
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
