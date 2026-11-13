/**
 * Only the VS Code test-host downloader calls this helper. Retrying that
 * network operation is safe; repeating the extension test process is not.
 *
 * GitHub-hosted runners have produced both the test-electron request timeout
 * and an AggregateError containing a TCP ETIMEDOUT during version resolution.
 */
function isTransientDownloadTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) { return false; }
  if (error.name === 'TimeoutError' &&
      /@vscode\/test-electron request timeout.*after \d+ms/.test(error.message)) {
    return true;
  }
  if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return true;
  }
  return error instanceof AggregateError &&
    error.errors.some((part: unknown) => isTransientDownloadTimeout(part));
}

export async function withHostDownloadRetry<T>(
  download: () => Promise<T>, onRetry: (attempt: number) => void
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await download();
    } catch (error) {
      if (attempt === maxAttempts || !isTransientDownloadTimeout(error)) {
        throw error;
      }
      onRetry(attempt + 1);
    }
  }
  throw new Error('Unreachable test host retry state');
}
