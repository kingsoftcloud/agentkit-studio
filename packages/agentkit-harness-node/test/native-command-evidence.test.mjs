import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFailureEvidence, commandExceptionCause, validCommandEvidence }
  from '../src/native/local-command-evidence.mjs';

test('cleanup and control failures preserve observed exit separately from success', () => {
  const evidence = commandFailureEvidence('execute', { result: { controls: { status: 'failed' },
    cleanupError: 'process_stdio_close_timeout,group_SIGKILL:EIO', exitCode: 0 } });
  assert.deepEqual(evidence.causes, ['control_report_failed', 'process_cleanup_failed']);
  assert.deepEqual(evidence.cleanupIssues, ['group_signal_failed', 'process_stdio_close_timeout']);
  assert.equal(evidence.observedExitCode, 0);
  assert.equal(validCommandEvidence(evidence), true);
  assert.equal('status' in evidence, false);
});

test('a later publication error retains the earlier process failure facts', () => {
  const previous = commandFailureEvidence('execute', { result: { controls: { status: 'partial' },
    exitCode: -9, cleanupError: null }, failures: ['output_recording_failed'] });
  const evidence = commandFailureEvidence('publish', { previous, failures: ['private_state_invalid'] });
  assert.equal(evidence.stage, 'publish'); assert.equal(evidence.observedExitCode, -9);
  assert.deepEqual(evidence.causes, ['output_recording_failed', 'private_state_invalid']);
});

test('exception classification and future cleanup codes cannot disclose arbitrary text', () => {
  const secret = 'SYNTHETIC_PRIVATE_TEXT';
  assert.equal(commandExceptionCause({ code: 'EACCES', message: secret }, 'transport_exception'), 'filesystem_failed');
  assert.equal(commandExceptionCause({ code: 'local_command_authority_stale' }, 'transport_exception'), 'authority_lost');
  assert.equal(commandExceptionCause({ code: secret, stack: secret }, 'supervisor_exception'), 'supervisor_exception');
  assert.equal(commandExceptionCause({ get code() { throw Error(secret); } }, 'transport_exception'), 'transport_exception');
  const evidence = commandFailureEvidence('execute', { result: { controls: { status: 'partial' },
    exitCode: 0, cleanupError: secret } });
  assert.deepEqual(evidence.cleanupIssues, ['cleanup_issue_unclassified']);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
});

test('durable diagnostics reject unknown fields, causes and malformed codes', () => {
  const evidence = commandFailureEvidence('transport', { failures: ['canceled'] });
  for (const bad of [{ ...evidence, text: 'private' }, { ...evidence, causes: ['invented'] },
    { ...evidence, causes: ['canceled', 'canceled'] }, { ...evidence, observedExitCode: '0' },
    { ...evidence, cleanupIssues: ['arbitrary'] }, { ...evidence, stage: 'invented' }])
    assert.equal(validCommandEvidence(bad), false);
});
