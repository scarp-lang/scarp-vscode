import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  diagnosticExplanationArgs, explainableDiagnosticCode
} from '../src/diagnosticExplanation';

test('accepts only official uppercase four-digit diagnostic identifiers', () => {
  assert.equal(explainableDiagnosticCode('E0001'), 'E0001');
  assert.equal(explainableDiagnosticCode('E0044'), 'E0044');
  assert.equal(explainableDiagnosticCode('E0065'), 'E0065');
  for (const value of [
    'e0001', 'W0001', 'E001', 'E00001', ' E0004', 'E0004 ',
    'E0004\n', 'E0004\r', 'E0004\r\n', 'E0004\u2028', 'E0004\u2029',
    'E0004;echo unsafe', '../E0004', '--help', '', 123, undefined, null,
    { value: 'E0004', target: 'https://example.invalid' }
  ]) {
    assert.equal(explainableDiagnosticCode(value), undefined,
      'Unexpected explain-code acceptance: ' + String(value));
  }
});

test('builds exact shell-free argv and fails closed on invalid arguments', () => {
  assert.deepEqual(diagnosticExplanationArgs('E0015'), ['explain', 'E0015']);
  assert.throws(() => diagnosticExplanationArgs('E0015 --help'),
    /canonical Scarp diagnostic code/);
  assert.throws(() => diagnosticExplanationArgs({ code: 'E0015' }),
    /canonical Scarp diagnostic code/);
});
