/**
 * Retry only transient downloads of the VS Code test host. Never re-run an
 * extension test failure: this narrow error originates in the test-electron
 * HTTP request used when resolving or downloading the host binary.
 */
function isHostRequestTimeout(error: unknown): boolean {
  return error instanceof Error &&
    error.name === 'TimeoutError' &&
    /@vscode\/test-electron request timeout.*after \d+ms/.test(error.message);
}

export async function withHostDownloadRetry<T>(
  operation: () => Promise<T>, onRetry: (attempt: number) => void
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !isHostRequestTimeout(error)) {
        throw error;
      }
      onRetry(attempt + 1);
    }
  }
  throw new Error('Unreachable test host retry state');
}
