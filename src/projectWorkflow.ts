/** v0.0.5-alpha.4 Scarp compiler feature handshake and safe project argv. */

export interface ScarpCapabilityReport {
  schema_version: number;
  version: string;
  execution: string;
  static_verify: boolean;
  project_workflow?: boolean;
}

/** Only a positive, versioned capability response enables filesystem actions. */
export function hasProjectWorkflow(stdout: string): boolean {
  let report: unknown;
  try { report = JSON.parse(stdout); }
  catch { return false; }
  if (!report || typeof report !== 'object') { return false; }
  const fields = report as Partial<ScarpCapabilityReport>;
  return fields.schema_version === 1 &&
    typeof fields.version === 'string' &&
    /^0\.0\.\d+(?:-[A-Za-z0-9.-]+)?$|^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(fields.version) &&
    fields.execution === 'interpreter' &&
    fields.static_verify === true &&
    fields.project_workflow === true;
}

/** A single directory component, respecting the compiler's 96-byte name cap. */
export function validProjectName(name: string): boolean {
  return name.length > 0 &&
    Buffer.byteLength(name, 'utf8') <= 96 &&
    name.trim() === name &&
    name !== '.' && name !== '..' &&
    !/[\\/:\x00-\x1F\x7F]/.test(name);
}

/** Published alpha.8's --filter matches a literal test filename substring. */
export function validProjectTestFilter(value: unknown): value is string {
  return typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 128 &&
    !value.startsWith('-') &&
    !/[\\/:\x00-\x1F\x7F]/.test(value);
}

export function projectArgv(
  command: 'verify' | 'launch' | 'create' | 'init' | 'test',
  directory: string,
  budgets: readonly string[] = [],
  testFilter?: string,
  requireNonemptyTests = false
): string[] {
  if (!directory) { throw new Error('Project directory is required.'); }
  if (testFilter !== undefined && command !== 'test') {
    throw new Error('Only project test runs accept a test filename filter.');
  }
  if (typeof requireNonemptyTests !== 'boolean' ||
      (requireNonemptyTests && command !== 'test')) {
    throw new Error('Only project test runs accept the nonempty-suite guard.');
  }
  if (command === 'verify') {
    if (budgets.length) { throw new Error('Static project verification rejects execution budgets.'); }
    return ['verify', '--diagnostic-format=json', '--', directory];
  }
  if (command === 'create' || command === 'init') {
    if (budgets.length) { throw new Error('Creating a project does not accept execution budgets.'); }
    return [command, '--', directory];
  }
  if (command === 'test') {
    if (budgets.length) { throw new Error('Project test runs reject execution budgets.'); }
    if (testFilter !== undefined && !validProjectTestFilter(testFilter)) {
      throw new Error('Invalid Scarp project test filename filter.');
    }
    return ['test', ...(requireNonemptyTests ? ['--require-tests'] : []),
      ...(testFilter === undefined ? [] : ['--filter', testFilter]),
      '--', directory];
  }
  return ['launch', ...budgets, '--', directory];
}
