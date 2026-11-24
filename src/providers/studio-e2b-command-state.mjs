import { constants, closeSync, fstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminalCommandStatus } from '../contracts/native-dsh.mjs';
import { openPrivate, privateDirectory } from '../host/private-state.mjs';
import { check, LOCAL_BACKGROUND_CONTRACT, LocalCommandError, validId } from './studio-command-state.mjs';

export function readE2BRecord(directory, owner, commandId) {
  privateDirectory(directory);
  const fd = openPrivate(join(directory, 'record.json'), constants.O_RDONLY);
  let record;
  try {
    check(fstatSync(fd).size <= 65536, 'invalid_background_record');
    const text = readFileSync(fd, 'utf8');
    try { record = JSON.parse(text); } catch { throw new LocalCommandError('invalid_background_record'); }
  } finally { closeSync(fd); }
  check(record && record.schemaVersion === LOCAL_BACKGROUND_CONTRACT && record.owner === owner
    && record.commandId === commandId && validId(owner) && validId(commandId) && validId(record.requestDigest)
    && record.backend === 'e2b' && Number.isSafeInteger(record.generation) && record.generation >= 0
    && (['starting', 'running'].includes(record.status) || isTerminalCommandStatus(record.status))
    && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
    && Number.isSafeInteger(record.timeoutMs) && record.timeoutMs >= 0
    && (record.exitCode === null || Number.isSafeInteger(record.exitCode))
    && (!['completed', 'failed'].includes(record.status) || Number.isSafeInteger(record.exitCode))
    && (record.pid === undefined || Number.isSafeInteger(record.pid) && record.pid > 0)
    && (record.sandboxId === undefined || typeof record.sandboxId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(record.sandboxId))
    && (record.recoveryClaimGeneration === undefined || Number.isSafeInteger(record.recoveryClaimGeneration)
      && record.recoveryClaimGeneration > record.generation && Number.isSafeInteger(record.recoveryClaimAt) && record.recoveryClaimAt > 0)
    && (record.supervisorPid === undefined || Number.isSafeInteger(record.supervisorPid) && record.supervisorPid > 0)
    && (record.evidenceIncomplete === undefined || typeof record.evidenceIncomplete === 'boolean')
    && (record.observedExitCode === undefined || record.observedExitCode === null || Number.isSafeInteger(record.observedExitCode)),
    'invalid_background_record');
  // Keep the v1 on-disk verdict for older readers. Only a failed local
  // supervisor spawn with no remote dispatch identity proves non-execution.
  if (record.status === 'unknown' && record.outcomeReason === 'supervisor_launch_failed'
    && record.supervisorPid === undefined && record.pid === undefined
    && record.exitCode === null && record.observedExitCode == null
    && record.generation === 0 && record.recoveryClaimGeneration === undefined) {
    return { ...record, status: 'failed', evidenceIncomplete: false };
  }
  return record;
}
