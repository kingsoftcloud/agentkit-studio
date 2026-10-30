import type { PortContext } from './contracts.mjs';
import { copy, invariant } from './values.mjs';

export const BACKGROUND_COMMAND_CONTRACT = 'agentkit.background-command-observation/v1' as const;
export interface BackgroundCommandRef { taskId: string; sourceRunId: string; operationKey: string }
export interface BackgroundCommandState { ref: BackgroundCommandRef; notified: boolean }
export interface BackgroundCommandRequest extends Omit<PortContext, 'signal'> {
  schemaVersion: typeof BACKGROUND_COMMAND_CONTRACT; cursor: string; refs: BackgroundCommandRef[];
}
export interface BackgroundCommandObservation {
  ref: BackgroundCommandRef;
  status: 'completed' | 'failed' | 'canceled' | 'timed_out' | 'output_limit' | 'unknown' | 'unavailable';
  exitCode: number | null; stdout: string; stderr: string; stdoutCursor: number; stderrCursor: number;
  outputMayBeTruncated: boolean; evidenceIncomplete: boolean; observedExitCode: number | null;
}
export interface BackgroundCommandPort {
  contract: typeof BACKGROUND_COMMAND_CONTRACT;
  /** Observation cannot launch/cancel a process, grant authority or start a model turn. */
  observe(request: BackgroundCommandRequest & { signal: AbortSignal }): Promise<BackgroundCommandObservation[]>;
}
function object(input: unknown): Record<string, unknown> {
  invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid_background_command_object');
  return copy(input) as Record<string, unknown>;
}
export function backgroundCommandRef(input: unknown): BackgroundCommandRef {
  const value = object(input);
  invariant(Object.keys(value).length === 3 && typeof value.taskId === 'string' && /^[a-f0-9]{64}$/.test(value.taskId)
    && typeof value.sourceRunId === 'string' && !!value.sourceRunId.trim()
    && typeof value.operationKey === 'string' && !!value.operationKey.trim(), 'invalid_background_command_ref');
  return { taskId: value.taskId, sourceRunId: value.sourceRunId, operationKey: value.operationKey };
}
export function backgroundCommandObservation(input: unknown): BackgroundCommandObservation {
  const value = object(input), ref = backgroundCommandRef(value.ref);
  invariant(typeof value.status === 'string' && ['completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown', 'unavailable'].includes(value.status),
    'invalid_background_command_status');
  const result = { exitCode: null, stdout: '', stderr: '', stdoutCursor: 0, stderrCursor: 0,
    outputMayBeTruncated: false, evidenceIncomplete: false, observedExitCode: null, ...value, ref };
  invariant(typeof result.stdout === 'string' && [...result.stdout].length <= 8192
    && typeof result.stderr === 'string' && [...result.stderr].length <= 8192, 'invalid_background_command_output');
  for (const cursor of [result.stdoutCursor, result.stderrCursor])
    invariant(Number.isSafeInteger(cursor) && (cursor as number) >= 0, 'invalid_background_command_cursor');
  for (const code of [result.exitCode, result.observedExitCode])
    invariant(code === null || Number.isSafeInteger(code), 'invalid_background_command_exit_code');
  invariant([result.outputMayBeTruncated, result.evidenceIncomplete].every(item => typeof item === 'boolean'), 'invalid_background_command_evidence');
  return { ref, status: value.status as BackgroundCommandObservation['status'], exitCode: result.exitCode as number | null,
    stdout: result.stdout, stderr: result.stderr, stdoutCursor: result.stdoutCursor as number, stderrCursor: result.stderrCursor as number,
    outputMayBeTruncated: result.outputMayBeTruncated as boolean, evidenceIncomplete: result.evidenceIncomplete as boolean,
    observedExitCode: result.observedExitCode as number | null };
}
