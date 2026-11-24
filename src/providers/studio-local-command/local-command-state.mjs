/** Local-process receipt validation. E2B has a separate backend decoder. */
import { constants, closeSync, fstatSync, fsyncSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPrivate, privateDirectory } from '../../host/private-state.mjs';
import { check, LOCAL_BACKGROUND_CONTRACT, LocalCommandError, unknownRecord, validId } from '../studio-command-state.mjs';
import { validCommandEvidence } from './local-command-evidence.mjs';

export const START_GRACE_MS = 5000;
export const TERMINAL = new Set(['completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown']);
const startFailureReason = reason => reason === 'supervisor_start_expired' || reason === 'supervisor_launch_failed';
const preLaunchFailure = record => startFailureReason(record.outcomeReason) && record.exitCode === null
  && record.supervisorPid === undefined && record.observedExitCode == null;
export const confirmedCommandStartFailure = output => output.status === 'failed' && output.exitCode === null
  && output.evidenceIncomplete === false && startFailureReason(output.outcomeReason);

export function fsyncPrivate(path) {
  const fd = openPrivate(path, constants.O_WRONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readRecord(directory, owner, commandId) {
  privateDirectory(directory);
  const fd = openPrivate(join(directory, 'record.json'), constants.O_RDONLY);
  let record;
  try {
    check(fstatSync(fd).size <= 65536, 'invalid_background_record');
    try { record = JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw new LocalCommandError('invalid_background_record'); }
  } finally { closeSync(fd); }
  check(record && record.schemaVersion === LOCAL_BACKGROUND_CONTRACT && record.owner === owner && record.commandId === commandId
    && validId(owner) && validId(commandId) && validId(record.requestDigest)
    && ['starting', 'running', ...TERMINAL].includes(record.status)
    && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
    && Number.isSafeInteger(record.timeoutMs) && record.timeoutMs > 0
    && (record.exitCode === null || Number.isSafeInteger(record.exitCode)), 'invalid_background_record');
  check((!['starting', 'running', 'unknown'].includes(record.status) || record.exitCode === null)
    && (record.status !== 'completed' || record.exitCode === 0)
    && (record.status !== 'failed' || Number.isSafeInteger(record.exitCode) && record.exitCode !== 0)
    && (record.status !== 'timed_out' || record.exitCode === 124)
    && (record.status !== 'output_limit' || record.exitCode === 122)
    && (record.supervisorPid === undefined || Number.isSafeInteger(record.supervisorPid) && record.supervisorPid > 0)
    && (record.evidenceIncomplete === undefined || typeof record.evidenceIncomplete === 'boolean')
    && (record.observedExitCode === undefined || record.observedExitCode === null || Number.isSafeInteger(record.observedExitCode)),
    'invalid_background_record');
  check(record.commandEvidence === undefined || validCommandEvidence(record.commandEvidence), 'invalid_background_record');
  // Keep the v1 on-disk representation readable after a plugin rollback.
  // The specific, durable pre-spawn reason is stronger evidence than its status.
  return record.status === 'unknown' && preLaunchFailure(record)
    ? { ...record, status: 'failed', evidenceIncomplete: false } : record;
}

/** Requires the supervisor lock and a still-unclaimed launch record. */
export function failCommandStart(directory, record, outcomeReason) {
  check(record.status === 'starting' && startFailureReason(outcomeReason), 'invalid_background_start_failure');
  unknownRecord(directory, record, outcomeReason);
}
