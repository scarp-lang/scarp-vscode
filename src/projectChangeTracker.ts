import * as path from 'node:path';

/** Compare whole directory components, not path prefixes (/app vs /app-other). */
export function isWithinProject(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

interface Session {
  root: string;
  stale: boolean;
}

/**
 * Drop project verification results if an open document changes during the
 * external compiler run, including imported .srp files and Scarp.project.
 *
 * Only in-editor changes are monitored; disk edits from other processes are
 * not tracked here. Watch scopes are explicitly disposed after each run.
 */
export class ProjectChangeTracker {
  private readonly sessions = new Set<Session>();
  private readonly completed = new Map<string, string>();

  watch(root: string): { isCurrent: () => boolean; dispose: () => void } {
    const session: Session = { root: path.resolve(root), stale: false };
    this.sessions.add(session);
    return {
      isCurrent: () => !session.stale,
      dispose: () => { this.sessions.delete(session); }
    };
  }

  /** Track the manifest owner of the last completed verification for a root. */
  completedVerification(root: string, ownerUri: string): void {
    this.completed.set(path.resolve(root), ownerUri);
  }

  /** Stop retaining completed state when a watcher is evicted or removed. */
  forgetCompleted(root: string): string | undefined {
    const key = path.resolve(root);
    const owner = this.completed.get(key);
    this.completed.delete(key);
    return owner;
  }

  /**
   * Mark in-flight checks stale, and return finished verification owners whose
   * previous Problems must be cleared. An edit to a clean module can change
   * the meaning of errors in a different imported file.
   */
  changed(filename: string): string[] {
    for (const session of this.sessions) {
      if (isWithinProject(session.root, filename)) { session.stale = true; }
    }
    const relevant = path.extname(filename).toLowerCase() === '.srp' ||
      path.basename(filename) === 'Scarp.project';
    if (!relevant) { return []; }
    const owners: string[] = [];
    for (const [root, owner] of this.completed) {
      if (!isWithinProject(root, filename)) { continue; }
      owners.push(owner);
      this.completed.delete(root);
    }
    return owners;
  }
}
