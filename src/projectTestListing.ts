/** Parse only the published Scarp alpha.8 read-only test discovery schema.
 * Untrusted CLI stdout must never become an arbitrary editor file path.
 */
export function parseListedProjectTests(stdout: string): string[] {
  const fail = (): never => {
    throw new Error('Unsupported or malformed Scarp test listing JSON (expected schema v1).');
  };
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return fail(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return fail(); }
  const report = raw as Record<string, unknown>;
  if (report.schema_version !== 1 || report.mode !== 'list' ||
      !Number.isSafeInteger(report.discovered) ||
      (report.discovered as number) < 0 || (report.discovered as number) > 64 ||
      report.passed !== 0 || report.failed !== 0 ||
      !Array.isArray(report.tests) ||
      report.tests.length !== report.discovered) {
    return fail();
  }
  const filenames: string[] = [];
  const seen = new Set<string>();
  for (const test of report.tests as unknown[]) {
    if (!test || typeof test !== 'object' || Array.isArray(test)) { return fail(); }
    const item = test as Record<string, unknown>;
    const filename = item.path;
    if (item.status !== 'discovered' || typeof filename !== 'string' ||
        Buffer.byteLength(filename, 'utf8') > 512 ||
        !/^tests\/[^/\\:\x00-\x1F\x7F]+\.srp$/.test(filename) ||
        seen.has(filename)) {
      return fail();
    }
    seen.add(filename);
    filenames.push(filename);
  }
  return filenames;
}
