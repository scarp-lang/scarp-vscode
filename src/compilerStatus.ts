/**
 * Release-order decisions are deliberately separate from the network and UI.
 * No extension update check, compiler launch, or auto-install occurs here.
 */
export interface ParsedCompilerVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

export type CompilerUpdateState =
  'not-installed' | 'update-available' | 'current' | 'ahead' | 'unrecognized';

export interface CompilerUpdateAssessment {
  state: CompilerUpdateState;
  installed?: string;
  published: string;
  message: string;
}

export function parseCompilerVersion(version: string): ParsedCompilerVersion | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) { return undefined; }
  const numbers = match.slice(1, 4).map(value => Number(value));
  if (numbers.some(n => !Number.isSafeInteger(n))) { return undefined; }
  const prerelease = match[4]?.split('.') ?? [];
  // SemVer numeric identifiers cannot have ambiguous leading zeroes.
  if (prerelease.some(p => /^[0-9]+$/.test(p) && p.length > 1 && p.startsWith('0'))) {
    return undefined;
  }
  return {
    major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease
  };
}

function compareIdentifier(left: string, right: string): number {
  const numericLeft = /^[0-9]+$/.test(left);
  const numericRight = /^[0-9]+$/.test(right);
  if (numericLeft !== numericRight) { return numericLeft ? -1 : 1; }
  if (numericLeft && numericRight) {
    // Avoid rounding or overflow for arbitrarily large numeric segments.
    if (left.length !== right.length) {
      return left.length < right.length ? -1 : 1;
    }
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compare official Scarp version strings using SemVer prerelease ordering. */
export function compareCompilerVersions(
  left: string, right: string
): -1 | 0 | 1 | undefined {
  const a = parseCompilerVersion(left);
  const b = parseCompilerVersion(right);
  if (!a || !b) { return undefined; }
  for (const name of ['major', 'minor', 'patch'] as const) {
    if (a[name] !== b[name]) { return a[name] < b[name] ? -1 : 1; }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) { return 0; }
    return a.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === b.prerelease[i]) { continue; }
    const diff = compareIdentifier(a.prerelease[i], b.prerelease[i]);
    if (diff !== 0) { return diff; }
  }
  if (a.prerelease.length === b.prerelease.length) { return 0; }
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

export function assessCompilerUpdate(
  installed: string | undefined, published: string
): CompilerUpdateAssessment {
  if (!installed) {
    return { state: 'not-installed', published,
      message: 'No executable compiler has been detected; a published native package is available.' };
  }
  const order = compareCompilerVersions(installed, published);
  if (order === undefined) {
    return { state: 'unrecognized', installed, published,
      message: 'The versions cannot be compared safely; no update is recommended automatically.' };
  }
  if (order < 0) {
    return { state: 'update-available', installed, published,
      message: 'A newer published compiler is available. Installation requires explicit confirmation.' };
  }
  if (order === 0) {
    return { state: 'current', installed, published,
      message: 'The installed compiler matches the newest published native package for this host.' };
  }
  return { state: 'ahead', installed, published,
    message: 'Your compiler version is newer than the published native package for this host. It will not be replaced automatically.' };
}

export function compilerEditorCompatibility(version: string | undefined): string {
  if (!version) { return 'Not checked (no validated compiler).'; }
  const order = compareCompilerVersions(version, '0.0.6-alpha.17');
  if (order === undefined) {
    return 'Unknown version; compiler support must be confirmed with actual CLI probes.';
  }
  if (order < 0) {
    return 'Older than the alpha.17 editor reference. Some highlighted built-ins and snippets may not be supported.';
  }
  return 'At least alpha.17 by version; actual feature support still depends on CLI capability probes.';
}
