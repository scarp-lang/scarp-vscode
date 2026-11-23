import * as path from 'node:path';

/**
 * Scarp alpha.18 made `exec` a no-path entrypoint runner. Unlike historical
 * `guide exec` output, its usage has an optional source/project argument.
 * Probe the installed compiler rather than assuming a version string.
 */
export function compilerAdvertisesImplicitExec(help: string): boolean {
  return /^Usage:\s*scarp exec\b[^\r\n]*\[file\.srp\|project-directory\]/m.test(help) &&
    /Without a path, use the current scarp\.project\/Scarp\.project entrypoint/.test(help);
}

/** Only known compiler default candidates are eligible for an implicit launch. */
export function hasDefaultWorkspaceEntry(snapshot: ReadonlyMap<string, string>): boolean {
  return ['scarp.project', 'Scarp.project', path.join('src', 'main.srp'), 'main.srp']
    .some(candidate => snapshot.has(candidate));
}

/** No empty filename, project directory or `--` separator is forwarded. */
export function implicitExecArgv(budgetArgs: readonly string[] = []): string[] {
  return ['exec', ...budgetArgs];
}
