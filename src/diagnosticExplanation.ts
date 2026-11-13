/** The published Scarp CLI accepts only canonical E#### explanation codes. */
export function explainableDiagnosticCode(input: unknown): string | undefined {
  return typeof input === 'string' && /^E\d{4}$/.test(input) ? input : undefined;
}

/** Construct exact, shell-free argv; reject injected or unsupported inputs. */
export function diagnosticExplanationArgs(input: unknown): ['explain', string] {
  const code = explainableDiagnosticCode(input);
  if (!code) {
    throw new Error('Enter a canonical Scarp diagnostic code (for example E0004).');
  }
  return ['explain', code];
}
