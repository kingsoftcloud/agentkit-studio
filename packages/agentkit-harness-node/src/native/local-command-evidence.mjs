// Bounded diagnostic facts only. Exception text, tool input and paths never
// enter these records, and an observed exit code is not a verified outcome.
export const COMMAND_EVIDENCE_CONTRACT = 'agentkit.local-command-evidence/v1';
const stages = new Set(['request', 'execute', 'publish', 'transport']);
const causes = new Set(['control_report_failed', 'process_cleanup_failed', 'output_recording_failed',
  'state_observation_failed', 'private_state_invalid', 'authority_lost', 'request_changed',
  'canceled', 'filesystem_failed', 'supervisor_exception', 'transport_exception']);
const cleanup = new Set(['spawn_observer_failed', 'stdout_read_error', 'stderr_read_error',
  'control_report_read_error', 'control_report_oversize', 'owner_lease_error',
  'process_reap_timeout', 'process_stdio_close_timeout', 'group_signal_failed', 'cleanup_issue_unclassified']);
const privateCodes = new Set(['background_state_not_private', 'background_state_symlink',
  'background_state_changed', 'invalid_background_record']);
const filesystemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EROFS']);

/** Classify only explicitly recognized exception codes, never their text. */
export function commandExceptionCause(error, fallback) {
  let code;
  try { code = error?.code; } catch { return fallback; }
  if (privateCodes.has(code)) return 'private_state_invalid';
  if (filesystemCodes.has(code)) return 'filesystem_failed';
  if (['local_command_authority_stale', 'background_command_authority_lost'].includes(code)) return 'authority_lost';
  if (code === 'local_command_request_drifted') return 'request_changed';
  if (code === 'local_command_signal_stale') return 'canceled';
  return fallback;
}

/** Combine observed failure facts without assigning a task execution verdict. */
export function commandFailureEvidence(stage, { result, failures = [], previous } = {}) {
  if (!stages.has(stage)) throw Error('invalid_command_evidence_stage');
  const reasons = new Set(previous?.causes ?? []), issues = new Set(previous?.cleanupIssues ?? []);
  for (const value of failures) reasons.add(value);
  if (result?.controls?.status === 'failed') reasons.add('control_report_failed');
  if (result?.cleanupError) {
    reasons.add('process_cleanup_failed');
    for (const value of result.cleanupError.split(','))
      issues.add(cleanup.has(value) ? value : /^group_SIG(?:TERM|KILL):/.test(value)
        ? 'group_signal_failed' : 'cleanup_issue_unclassified');
  }
  const observedExitCode = result?.exitCode ?? previous?.observedExitCode ?? null;
  const evidence = { contract: COMMAND_EVIDENCE_CONTRACT, stage,
    causes: [...reasons].sort(), cleanupIssues: [...issues].sort(), observedExitCode };
  if (!validCommandEvidence(evidence)) throw Error('invalid_command_evidence');
  return evidence;
}

/** Durable optional field: old records retain their absence of diagnostics. */
export function validCommandEvidence(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 5
    && Object.keys(value).every(key => ['contract', 'stage', 'causes', 'cleanupIssues', 'observedExitCode'].includes(key))
    && value.contract === COMMAND_EVIDENCE_CONTRACT && stages.has(value.stage)
    && Array.isArray(value.causes) && value.causes.length <= causes.size
    && value.causes.every(item => causes.has(item)) && new Set(value.causes).size === value.causes.length
    && Array.isArray(value.cleanupIssues) && value.cleanupIssues.length <= cleanup.size
    && value.cleanupIssues.every(item => cleanup.has(item)) && new Set(value.cleanupIssues).size === value.cleanupIssues.length
    && (value.observedExitCode === null || Number.isSafeInteger(value.observedExitCode));
}
