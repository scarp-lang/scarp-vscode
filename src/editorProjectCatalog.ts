import * as path from 'node:path';

export type ScarpManifestKind = 'declarative-v2' | 'legacy-v1';
export type ScarpCatalogIssueKind =
  'oversized' | 'unsafe-path' | 'unrecognized' |
  'missing-entry' | 'duplicate' | 'limit';
export interface ScarpCatalogIssue {
  readonly manifest: string;
  readonly kind: ScarpCatalogIssueKind;
  readonly detail: string;
}
export interface ScarpProjectCandidate {
  /** Workspace-root-relative, forward-slash path to manifest on disk. */
  readonly filename: string;
  readonly content: string;
}
export interface ScarpProjectDescription {
  readonly manifest: string;
  readonly root: string;
  readonly kind: ScarpManifestKind;
  readonly name: string;
  readonly entry: string;
  readonly version?: string;
}
export interface ScarpProjectCatalog {
  readonly projects: readonly ScarpProjectDescription[];
  readonly issues: readonly ScarpCatalogIssue[];
}
export interface ScarpCatalogOptions {
  readonly maxManifests?: number;
  readonly maxManifestBytes?: number;
}
const MAX_MANIFESTS = 256;
const MAX_MANIFEST_BYTES = 4096;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function bounded(value: number | undefined, defaultValue: number): number {
  return value === undefined ? defaultValue :
    Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function safeRelative(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) ||
      value.includes('\\') || value.includes(':') ||
      /[\x00-\x1f\x7f]/.test(value) || value.includes('%')) { return false; }
  return value.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..');
}
function safeManifest(filename: string): boolean {
  return safeRelative(filename) && (
    filename === 'scarp.project' || filename.endsWith('/scarp.project') ||
    filename === 'Scarp.project' || filename.endsWith('/Scarp.project')
  );
}
function extractEntry(value: string): string | undefined {
  return safeRelative(value) && value.endsWith('.srp') &&
    value.length <= 512 ? value : undefined;
}
function sanitizedLines(content: string): string[] {
  // The catalog is a preview rather than a complete grammar parser.
  // Strip only full-line comments; do not decode escapes or expressions.
  return content.split(/\r\n|\r|\n/)
    .map(line => line.trim()).filter(line =>
      line.length > 0 && !line.startsWith('//'));
}
function decodeQuoted(value: string): string | undefined {
  if (!/^"[^"\\\r\n]*"$/.test(value)) { return undefined; }
  return value.slice(1, -1);
}
function parseV2(content: string): Omit<ScarpProjectDescription,
  'manifest' | 'root' | 'kind'> | undefined {
  const lines = sanitizedLines(content);
  if (lines.length < 5 || lines.length > 12) { return undefined; }
  const declaration = /^project\s+("[^"\\]*")\s*\{$/.exec(lines[0]);
  if (!declaration || lines[lines.length - 1] !== '}') { return undefined; }
  const name = decodeQuoted(declaration[1]);
  if (!name || name.length > 96) { return undefined; }
  let entry: string | undefined;
  let version: string | undefined;
  let projectType: string | undefined;
  let dependencies = 0;
  for (const line of lines.slice(1, -1)) {
    if (line === 'dependencies {}') {
      dependencies++;
      continue;
    }
    const field = /^(version|entry|type)\s*:\s*("[^"\\]*")$/.exec(line);
    if (!field) { return undefined; }
    const value = decodeQuoted(field[2]);
    if (value === undefined) { return undefined; }
    switch (field[1]) {
      case 'version':
        if (version !== undefined || !SEMVER.test(value)) { return undefined; }
        version = value;
        break;
      case 'entry':
        if (entry !== undefined) { return undefined; }
        entry = extractEntry(value);
        if (!entry) { return undefined; }
        break;
      case 'type':
        if (projectType !== undefined) { return undefined; }
        projectType = value;
        break;
    }
  }
  if (!version || !entry || projectType !== 'application' ||
      dependencies > 1) { return undefined; }
  return { name, version, entry };
}
function parseLegacy(content: string): Omit<ScarpProjectDescription,
  'manifest' | 'root' | 'kind'> | undefined {
  const lines = sanitizedLines(content);
  if (lines.length < 3 || lines.length > 8 ||
      lines[0] !== 'scarp-project: 1') { return undefined; }
  let name: string | undefined;
  let entry: string | undefined;
  for (const line of lines.slice(1)) {
    const field = /^(name|entry):\s*(\S.*)$/.exec(line);
    if (!field) { return undefined; }
    if (field[1] === 'name') {
      if (name !== undefined || !IDENTIFIER.test(field[2])) { return undefined; }
      name = field[2];
    } else {
      if (entry !== undefined) { return undefined; }
      entry = extractEntry(field[2]);
      if (!entry) { return undefined; }
    }
  }
  return name && entry ? { name, entry } : undefined;
}
/**
 * Offline catalog of compiler-written project manifests within a selected
 * workspace. No source execution, dependency loading or semantic validation.
 * The official compiler remains the authority for actual project validity.
 */
export function catalogScarpProjects(
  candidates: readonly ScarpProjectCandidate[],
  options: ScarpCatalogOptions = {}
): ScarpProjectCatalog {
  const maxManifests = bounded(options.maxManifests, MAX_MANIFESTS);
  const maxBytes = bounded(options.maxManifestBytes, MAX_MANIFEST_BYTES);
  const projects: ScarpProjectDescription[] = [];
  const issues: ScarpCatalogIssue[] = [];
  if (!maxManifests || !maxBytes) {
    return {
      projects, issues: [{
        manifest: '', kind: 'limit', detail: 'Invalid manifest catalog limits.'
      }]
    };
  }
  const byRoot = new Map<string, ScarpProjectDescription>();
  let examined = 0;
  for (const candidate of [...candidates].sort(
    (a, b) => a.filename.localeCompare(b.filename)
  )) {
    if (examined >= maxManifests) {
      issues.push({
        manifest: '', kind: 'limit', detail: 'Manifest count exceeded.'
      });
      break;
    }
    examined++;
    if (!safeManifest(candidate.filename)) {
      issues.push({
        manifest: candidate.filename, kind: 'unsafe-path',
        detail: 'Manifest must be a safe workspace-relative Scarp filename.'
      });
      continue;
    }
    if (Buffer.byteLength(candidate.content, 'utf8') > maxBytes) {
      issues.push({
        manifest: candidate.filename, kind: 'oversized',
        detail: 'Manifest exceeds bounded preview size.'
      });
      continue;
    }
    const kind: ScarpManifestKind = candidate.filename.endsWith('scarp.project')
      ? 'declarative-v2' : 'legacy-v1';
    const data = kind === 'declarative-v2'
      ? parseV2(candidate.content) : parseLegacy(candidate.content);
    if (!data) {
      issues.push({
        manifest: candidate.filename, kind: 'unrecognized',
        detail: 'Manifest is not a recognized compiler scaffold format.'
      });
      continue;
    }
    const root = path.posix.dirname(candidate.filename) === '.'
      ? '' : path.posix.dirname(candidate.filename);
    if (byRoot.has(root)) {
      issues.push({
        manifest: candidate.filename, kind: 'duplicate',
        detail: 'Two project manifests describe the same workspace folder.'
      });
      continue;
    }
    const description: ScarpProjectDescription = {
      manifest: candidate.filename, root, kind,
      name: data.name, entry: data.entry, version: data.version
    };
    byRoot.set(root, description);
    projects.push(description);
  }
  return { projects, issues };
}
export function projectEntryPath(
  project: ScarpProjectDescription
): string | undefined {
  if (!safeRelative(project.entry) ||
      project.root && !safeRelative(project.root)) {
    return undefined;
  }
  return project.root ? project.root + '/' + project.entry : project.entry;
}
