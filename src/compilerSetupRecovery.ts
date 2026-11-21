/**
 * User-facing recovery is intentionally conservative: an integrity failure
 * must never offer a way to skip hashes, and a cancelled user action must
 * not be shown as a failed installation.
 */
export type CompilerRecoveryKind =
  'unsupported-host' | 'integrity' | 'existing-invalid' |
  'network' | 'local-executable' | 'other';

export type CompilerRecoveryAction = 'retry' | 'choose' | 'releases' | 'settings';

export interface CompilerSetupRecovery {
  readonly kind: CompilerRecoveryKind;
  readonly explanation: string;
  readonly actions: readonly CompilerRecoveryAction[];
}

export function setupRecoveryFor(error: unknown): CompilerSetupRecovery {
  const message = error instanceof Error ? error.message : String(error);
  if (/no official native package|unsupported platform|source build instructions/i.test(message)) {
    return {
      kind: 'unsupported-host',
      explanation: 'No official native Scarp download is available for this extension host. ' +
        'Select a compiler you have built or installed, or see the official release instructions.',
      actions: ['choose', 'releases', 'settings']
    };
  }
  if (/sha-?256|checksum|unexpected official asset metadata|unsafe compiler|corrupt|invalid ZIP|invalid tar|extract|invalid.*archive|version validation/i.test(message)) {
    return {
      kind: 'integrity',
      explanation: 'The compiler package did not pass release integrity, extraction or version checks. ' +
        'No unsafe package will be selected. Check the official release or retry a new verified download.',
      actions: ['releases', 'retry', 'choose']
    };
  }
  if (/existing installation failed validation/i.test(message)) {
    return {
      kind: 'existing-invalid',
      explanation: 'A previous compiler folder is present but failed validation. ' +
        'It was not overwritten. Select another existing compiler or inspect the extension storage folder.',
      actions: ['choose', 'settings', 'releases']
    };
  }
  if (/http\s+\d{3}|download|network|fetch failed|timed out|timeout|release catalogue|GitHub/i.test(message)) {
    return {
      kind: 'network',
      explanation: 'The official release service or package download is unavailable. ' +
        'Check the connection, proxy or rate limits; you can retry or select a local executable.',
      actions: ['retry', 'choose', 'releases']
    };
  }
  if (/compiler not found|scarp\.compilerPath|--version response|failed to spawn|ENOENT/i.test(message)) {
    return {
      kind: 'local-executable',
      explanation: 'The selected executable could not be validated. ' +
        'Select an existing Scarp binary or review scarp.compilerPath.',
      actions: ['choose', 'settings', 'releases']
    };
  }
  return {
    kind: 'other',
    explanation: 'Compiler setup could not finish. Your current compiler setting remains unchanged.',
    actions: ['retry', 'choose', 'releases']
  };
}
