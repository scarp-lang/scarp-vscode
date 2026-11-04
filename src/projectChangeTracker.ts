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

  watch(root: string): { isCurrent: () => boolean; dispose: () => void } {
    const session: Session = { root: path.resolve(root), stale: false };
    this.sessions.add(session);
    return {
      isCurrent: () => !session.stale,
      dispose: () => { this.sessions.delete(session); }
    };
  }

  changed(filename: string): void {
    for (const session of this.sessions) {
      if (isWithinProject(session.root, filename)) { session.stale = true; }
    }
  }
}
