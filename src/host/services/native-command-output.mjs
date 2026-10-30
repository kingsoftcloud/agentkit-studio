import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { OWNED_COMMAND_OUTPUT_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/owned-command';
import { assertNativeRecoveryPreset, readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';

/** Operator presentation stays separate from tool receipts and model context. */
export function createStudioNativeCommandPreview({ ctx, projectCommandPreview }) {
  return async (source, execution) => {
    const policy = ctx.get('studioNativeCommandOutputPolicy');
    if (policy) return typeof policy.projectPreview === 'function' ? policy.projectPreview(source, execution) : null;
    if (projectCommandPreview) return projectCommandPreview(source, execution);
    return { kind: 'command_preview', stdout: source.stdout, stderr: source.stderr };
  };
}

async function withinLifetime(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function validateNativeCommandOutputRequest(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['agentId', 'sessionId', 'taskId', 'stdoutCursor', 'stderrCursor', 'maxBytes'].includes(key))
    && ['agentId', 'sessionId'].every(key => typeof value[key] === 'string' && value[key].trim() && value[key].length <= 256)
    && typeof value.taskId === 'string' && /^[a-f0-9]{64}$/.test(value.taskId)
    && ['stdoutCursor', 'stderrCursor'].every(key => value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0)
    && (value.maxBytes === undefined || Number.isSafeInteger(value.maxBytes) && value.maxBytes >= 4 && value.maxBytes <= 65536),
  'studio_native_command_output_invalid');
}

/** Operator output is a read model, never another tool receipt or model turn. */
export function createStudioNativeCommandOutput({ ctx, store, recovery, agentEvents, lifetime, project }) {
  invariant(typeof project === 'function', 'studio_native_command_output_policy_missing');
  return async (request, callerSignal) => {
    validateNativeCommandOutputRequest(request);
    const body = structuredClone(request), sealed = canonical(body);
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    const inspect = await recovery.inspect({ agentId: body.agentId, sessionId: body.sessionId }, signal);
    const { agent, scope, record } = inspect;
    signal.throwIfAborted();
    invariant(!inspect.managed && record && agent?.session?.id === body.sessionId, 'studio_native_command_output_unavailable');
    const capsule = readNativeRecoveryBinding(record, { agentId: body.agentId, sessionId: body.sessionId, runId: record.snapshot.runId });
    const binding = await withinLifetime(() => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {}), signal);
    assertNativeRecoveryPreset(capsule, binding);
    const assertCurrent = () => {
      signal.throwIfAborted();
      invariant(canonical(request) === sealed, 'studio_native_command_output_request_changed');
      const head = store.sessionHead(scope, body.sessionId);
      invariant(head?.runId === record.snapshot.runId
        && head.backgroundCommands.some(row => row.ref.taskId === body.taskId), 'studio_native_command_output_owner_changed');
      binding.nativeTools?.assertConversationWorkspaceSettled?.(agent);
    };
    assertCurrent();
    invariant(typeof binding.nativeTools?.commandOutputObserver === 'function', 'studio_native_command_output_unavailable');
    const observer = binding.nativeTools.commandOutputObserver(agent, { scope, store });
    invariant(observer?.contract === OWNED_COMMAND_OUTPUT_CONTRACT && typeof observer.read === 'function', 'studio_native_command_output_unavailable');
    const execution = { contract: OWNED_COMMAND_OUTPUT_CONTRACT, scope, runId: record.snapshot.runId, sessionId: body.sessionId,
      taskId: body.taskId, stdoutCursor: body.stdoutCursor ?? 0, stderrCursor: body.stderrCursor ?? 0, maxBytes: body.maxBytes ?? 65536 };
    const source = await withinLifetime(() => observer.read({ ...execution, signal }), signal); assertCurrent();
    const display = await withinLifetime(() => project(structuredClone(source), { ...structuredClone(execution), signal }), signal); assertCurrent();
    // Withholding does not consume bytes: the next poll reads the same cursor.
    const allowed = display?.kind === 'command_preview' && typeof display.stdout === 'string' && typeof display.stderr === 'string'
      && Buffer.byteLength(display.stdout) <= 65536 && Buffer.byteLength(display.stderr) <= 65536;
    return { contract: 'agentkit.studio-command-output/v1', runId: execution.runId, sessionId: body.sessionId, taskId: body.taskId,
      command: source.command ?? '', status: source.status, exitCode: source.exitCode, observedExitCode: source.observedExitCode,
      evidenceIncomplete: source.evidenceIncomplete, outputMayBeTruncated: source.outputMayBeTruncated,
      stdout: allowed ? display.stdout : '', stderr: allowed ? display.stderr : '',
      stdoutCursor: allowed ? source.stdoutCursor : execution.stdoutCursor,
      stderrCursor: allowed ? source.stderrCursor : execution.stderrCursor, withheld: !allowed };
  };
}
