/**
 * Maintain Problems contributed by each independent Scarp verification.
 *
 * A single source file may be imported by several entry points, so replacing
 * one entry point's diagnostics must never erase another's contributions.
 * This model is VS Code-independent to keep ownership rules unit-testable.
 */
export class DiagnosticOwners<T> {
  private readonly roots = new Map<string, Map<string, T[]>>();

  replace(root: string, groups: ReadonlyMap<string, readonly T[]>): Map<string, T[]> {
    const previous = this.roots.get(root);
    const next = new Map<string, T[]>();
    for (const [uri, diagnostics] of groups) {
      if (diagnostics.length) { next.set(uri, [...diagnostics]); }
    }
    this.roots.set(root, next);
    return this.collect(new Set([...(previous?.keys() ?? []), ...next.keys()]));
  }

  /**
   * An edit invalidates a verified entry point or a source with diagnostics
   * from that entry point. Other entry points' diagnostics remain available.
   */
  invalidateChanged(uri: string): Map<string, T[]> {
    const affected = new Set<string>();
    for (const [root, groups] of this.roots) {
      if (root !== uri && !groups.has(uri)) { continue; }
      for (const key of groups.keys()) { affected.add(key); }
      this.roots.delete(root);
    }
    return this.collect(affected);
  }

  private collect(uris: ReadonlySet<string>): Map<string, T[]> {
    const updated = new Map<string, T[]>();
    for (const uri of uris) {
      const diagnostics: T[] = [];
      for (const groups of this.roots.values()) {
        diagnostics.push(...(groups.get(uri) ?? []));
      }
      updated.set(uri, diagnostics);
    }
    return updated;
  }
}
