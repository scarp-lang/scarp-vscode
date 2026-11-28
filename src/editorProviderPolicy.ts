/**
 * Pure policy checks used by the VS Code adapter. The strict separation keeps
 * trust-sensitive and stale-version behavior testable without an Extension
 * Host, and keeps the source features free of VS Code's runtime dependency.
 */
export interface ScarpEditorSnapshot {
  readonly key: string;
  readonly scheme: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}
export interface ScarpEditorEnvironment {
  readonly cancellationRequested: boolean;
  readonly workspaceTrusted: boolean;
}
export interface ScarpEditorPolicyOptions {
  readonly maximumSourceBytes?: number;
  readonly allowUntitled?: boolean;
  readonly requireTrust?: boolean;
}
const DEFAULT_BYTES = 1_000_000;
const SAFE_SCHEMES = new Set(['file', 'untitled']);

function maxBytes(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_BYTES;
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_000_000
    ? value : undefined;
}
/** A stale editor snapshot must never be used to emit current edits. */
export function scarpEditorSnapshotAllowed(
  snapshot: ScarpEditorSnapshot, env: ScarpEditorEnvironment,
  options: ScarpEditorPolicyOptions = {}
): boolean {
  const maximum = maxBytes(options.maximumSourceBytes);
  return maximum !== undefined && snapshot.key.length > 0 &&
    snapshot.key.length <= 8192 && SAFE_SCHEMES.has(snapshot.scheme) &&
    (snapshot.scheme !== 'untitled' || options.allowUntitled !== false) &&
    snapshot.languageId === 'scarp' &&
    Number.isSafeInteger(snapshot.version) && snapshot.version >= 0 &&
    snapshot.text.length <= maximum &&
    !env.cancellationRequested &&
    (options.requireTrust !== true || env.workspaceTrusted);
}
export function sameScarpSnapshot(
  previous: ScarpEditorSnapshot, current: ScarpEditorSnapshot
): boolean {
  return previous.key === current.key && previous.scheme === current.scheme &&
    previous.languageId === current.languageId &&
    previous.version === current.version && previous.text === current.text;
}
/**
 * Explicit source offsets are always one-based in compiler diagnostics but
 * zero-based in the editor. This helper validates a range after conversion,
 * rather than accidentally accepting a completely different document.
 */
export function scarpEditorRangeAllowed(
  start: number, end: number, sourceLength: number
): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    Number.isSafeInteger(sourceLength) && start >= 0 && end >= start &&
    end <= sourceLength;
}
/** Bound the size of accumulated editor results, not only source documents. */
export function scarpEditorResultAllowed(
  count: number, limit: number
): boolean {
  return Number.isSafeInteger(count) && Number.isSafeInteger(limit) &&
    count >= 0 && limit >= 0 && count <= limit;
}
