// E2B remote background command ToolPort — Node Native tool definitions + factory.
//
// Key contracts:
// - Uses canonical backgroundCommandPolicy 'owned-command-launch/v1' and ref
//   {taskId, sourceRunId, operationKey}.
// - A UNIFIED guard checks authority+drift+abort using the ORIGINAL snapshot.
// - After a side-effect: uncertain with known locator, NOT executed:false.
// - budget: EVERY return path is bounded so canonical(content) <= maxOutputBytes.
//   If the budget cannot hold the minimal uncertain result with the FULL original
//   identity (operationKey NOT truncated), the command is REJECTED before any
//   ensure/start with executed:false — no remote side-effect, no fake success.
//   A successful background launch preserves status=ok and backgroundCommandRef;
//   only the presentation content is truncated. Identity fields are never
//   truncated or dropped to fit a budget.
import { canonical, copy, invariant, scopeKey, toolInputRejection } from '../../../agentkit-harness-core/dist/index.mjs';
import { TERMINAL, delay } from './e2b-command-state.mjs';

export const E2B_COMMAND_TOOLS_CONTRACT = 'agentkit.native-e2b-command-tools/v1';

const schemas = { nullableSeconds: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  cursor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };

function base(name, description, properties, required, mutating, timeoutMs) {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
    readOnly: !mutating, concurrentSafe: !mutating, permissions: mutating ? [name === 'stop_command' ? 'sandbox:cancel' : 'sandbox:execute'] : [],
    timeoutMs, contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
    ...(!mutating ? { recoveryPolicy: 'safe-read/v1' } : {}) };
}

export function e2bCommandToolDefinitions(foregroundTimeoutSeconds = 300) {
  invariant(Number.isSafeInteger(foregroundTimeoutSeconds) && foregroundTimeoutSeconds > 0
    && foregroundTimeoutSeconds <= 86400, 'e2b_command_foreground_limit_invalid');
  return [
    base('sandbox_status', 'Report the bound E2B remote sandbox backend and its execution boundary.', {}, [], false, 10000),
    { ...base('run_command', 'Run a command inside the bound E2B remote sandbox. background=true returns an owned task_id for non-blocking reads via read_command_output; stop_command requests cancellation. The sandbox is remote — cwd is a remote path, not a host-local one. An unknown outcome is never re-launched.',
      { command: { type: 'string', minLength: 1 }, cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        timeout: schemas.nullableSeconds, env: { anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }] },
        background: { type: 'boolean' }, background_timeout: schemas.nullableSeconds },
      ['command'], true, foregroundTimeoutSeconds * 1000 + 20000), backgroundCommandPolicy: 'owned-command-launch/v1' },
    base('read_command_output', 'Read an owned E2B command status and UTF-8 byte cursors. Reusing a cursor is read-only. Waiting never changes the command deadline. No sandbox creation or command restart.',
      { task_id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, stdout_cursor: schemas.cursor,
        stderr_cursor: schemas.cursor, max_bytes: { type: 'integer', minimum: 4, maximum: 65536 },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600 } }, ['task_id'], false, 610000),
    base('stop_command', 'Request cancellation of one E2B command launched by this Session. Read its output to confirm the final status; a cancel request is not proof of completion.',
      { task_id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['task_id'], true, 10000),
  ];
}

const commandOutput = result => ({ status: result.status, stdout: result.stdout, stderr: result.stderr,
  exit_code: result.exitCode, stdout_cursor: result.stdoutCursor, stderr_cursor: result.stderrCursor,
  cancel_requested: result.cancelRequested, output_may_be_truncated: result.outputMayBeTruncated,
  evidence_incomplete: result.evidenceIncomplete, observed_exit_code: result.observedExitCode,
  ...(result.outcomeReason ? { outcome_reason: result.outcomeReason } : {}) });
const errorResult = (code, extra = {}) => ({ status: 'error', content: { ok: false, error_type: code, ...extra } });
function utf8Preview(text, maxBytes) {
  return new TextDecoder('utf8', { ignoreBOM: true }).decode(Buffer.from(text).subarray(0, maxBytes), { stream: true });
}

function syncValue(value) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    invariant(false, 'e2b_command_sync_contract_invalid');
  }
  return value;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

export function createNativeE2BCommandTools({ scope, sessionId, owner, storeFactory,
  authorize, assertAuthority, resolveOwnedCommand, artifacts, maxOutputBytes = 24000,
  allowInternetAccess = false, foregroundTimeoutSeconds = 300, backgroundTimeoutSeconds = 300 } = {}) {
  invariant(scope && typeof sessionId === 'string' && !!sessionId.trim(), 'e2b_command_scope_required');
  invariant(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 256, 'e2b_command_max_output_bytes_invalid');
  invariant(owner && typeof owner.ensure === 'function' && typeof owner.inspect === 'function', 'e2b_command_owner_required');
  invariant(typeof storeFactory === 'function', 'e2b_command_store_factory_required');
  invariant(typeof authorize === 'function', 'e2b_command_authorize_required');
  invariant(typeof assertAuthority === 'function', 'e2b_command_assert_authority_required');
  invariant(typeof resolveOwnedCommand === 'function', 'e2b_command_resolve_owned_required');
  invariant(Number.isSafeInteger(backgroundTimeoutSeconds) && backgroundTimeoutSeconds > 0
    && backgroundTimeoutSeconds <= 86400, 'e2b_command_background_limit_invalid');
  const definitions = e2bCommandToolDefinitions(foregroundTimeoutSeconds);
  const formal = new Map(definitions.map(d => [d.name, copy(d)]));
  const fixedScope = copy(scope);
  scopeKey(fixedScope);
  let store = null;

  function snapshot(request) {
    invariant(request && request.call && typeof request.call.name === 'string' && typeof request.call.callId === 'string' && request.call.callId.trim(),
      'e2b_command_request_unbound');
    invariant(typeof request.operationKey === 'string' && request.operationKey.trim(), 'e2b_command_operation_key_required');
    const def = formal.get(request.call.name);
    invariant(def, 'e2b_command_tool_unbound');
    invariant(request.definition && canonical(request.definition) === canonical(def), 'e2b_command_definition_unbound');
    invariant(request.scope && canonical(request.scope) === canonical(fixedScope), 'e2b_command_scope_unbound');
    invariant(request.signal instanceof AbortSignal, 'e2b_command_signal_unbound');
    invariant(typeof request.sessionId === 'string' && request.sessionId === sessionId, 'e2b_command_session_unbound');
    invariant(['runId','turnId','buildId','taskChainId'].every(k => typeof request[k] === 'string' && request[k].trim()),
      'e2b_command_identity_required');
    invariant(request.parentRunId === null || typeof request.parentRunId === 'string' && request.parentRunId.trim(),
      'e2b_command_parent_run_id_invalid');
    invariant(Number.isSafeInteger(request.executionFence) && request.executionFence > 0, 'e2b_command_fence_required');
    const { signal: _signal, ...body } = request;
    return { body: canonical(body), signal: request.signal,
      runId: request.runId, sessionId: request.sessionId, operationKey: request.operationKey,
      scope: copy(request.scope), turnId: request.turnId, buildId: request.buildId,
      parentRunId: request.parentRunId, taskChainId: request.taskChainId, executionFence: request.executionFence,
      callId: request.call.callId };
  }

  function drifted(request, before) {
    if (before.signal !== request.signal) return true;
    const { signal: _signal, ...body } = request;
    return before.body !== canonical(body);
  }

  function checkAuthority(request) {
    const result = assertAuthority(request);
    if (result === true) return true;
    if (result && typeof result.then === 'function')
      result.then(() => {}, () => {});
    return false;
  }

  // The full original identity — NEVER truncated or dropped. This is the
  // minimum that must fit in maxOutputBytes for any uncertain/error result
  // to be representable. If it does not fit, the command is rejected before
  // any side-effect.
  function originLocator(before, sandboxId, taskId) {
    return { scope: copy(before.scope), sessionId: before.sessionId, runId: before.runId,
      turnId: before.turnId, buildId: before.buildId, parentRunId: before.parentRunId,
      taskChainId: before.taskChainId, operationKey: before.operationKey,
      executionFence: before.executionFence, callId: before.callId,
      ...(sandboxId ? { sandbox_id: sandboxId } : {}),
      ...(taskId ? { task_id: taskId } : {}) };
  }

  // Reserve complete ownership plus the largest validated remote identifiers
  // and fixed receipt fields BEFORE any owner/command effect. A rejected call
  // has no external locator to preserve; its full request remains in the intent.
  function minimalUncertainBudget(before) {
    const sample = { ok: false, error_type: 'e2b_command_evidence_incomplete',
      evidence_incomplete: true, observed_result: 'output_limit',
      ...originLocator(before, 's'.repeat(128), 'a'.repeat(64)) };
    return Buffer.byteLength(canonical(sample)) + 512;
  }

  function uncertainResult(known, before, reason, sandboxId, taskId) {
    const loc = originLocator(before, sandboxId ?? known?.content?.sandbox_id, taskId ?? known?.content?.task_id);
    const code = typeof reason === 'string' && /^[a-z0-9_]{1,96}$/.test(reason)
      ? reason : 'e2b_command_evidence_incomplete';
    const content = { ok: false, error_type: code, evidence_incomplete: true,
      observed_result: TERMINAL.has(known?.content?.status) ? known.content.status : null, ...loc };
    const bgRef = known?.backgroundCommandRef;
    return { status: 'uncertain', content, ...(bgRef ? { backgroundCommandRef: bgRef } : {}) };
  }

  // Enforce budget on shrinkable content fields only (command, stdout, stderr).
  // Identity fields (operationKey, runId, scope, etc.) are NEVER truncated.
  function enforceBudget(content) {
    const keys = ['command', 'stdout', 'stderr', 'instruction', 'outcome_reason'];
    for (let iter = 0; iter < 40; iter++) {
      if (Buffer.byteLength(canonical(content)) <= maxOutputBytes) return true;
      let largest = null, largestLen = 0;
      for (const key of keys) {
        const len = typeof content[key] === 'string' ? Buffer.byteLength(content[key]) : 0;
        if (len > largestLen) { largest = key; largestLen = len; }
      }
      if (!largest || largestLen <= 1) { if (largest) content[largest] = ''; break; }
      content[largest] = utf8Preview(content[largest], Math.floor(largestLen / 2));
    }
    return Buffer.byteLength(canonical(content)) <= maxOutputBytes;
  }

  // Every return is bounded. Admission reserves the complete fixed receipt;
  // only presentation text may be shortened after dispatch.
  function boundResult(result) {
    if (Buffer.byteLength(canonical(result.content)) <= maxOutputBytes) return result;
    const content = { ...result.content };
    if (enforceBudget(content)) return { ...result, content };
    invariant(false, 'e2b_command_result_budget_contract_violation');
  }

  async function budget(result, request, before, sandboxId, taskId) {
    const body = canonical(result.content);
    if (Buffer.byteLength(body) <= maxOutputBytes) return result;
    const guardResult = guard(request, before, true, result);
    if (guardResult) return guardResult;
    const content = { ...result.content };
    if (typeof artifacts?.write === 'function') {
      try {
        const ref = await abortable(artifacts.write({ ...request, operationKey: `${request.operationKey}:command-output`,
          content: body, mediaType: 'application/json', metadata: { toolName: request.call.name, sessionId } }), before.signal);
        const guardResult2 = guard(request, before, true, result);
        if (guardResult2) return guardResult2;
        content.output_budget = { truncated: true, artifact_uri: ref.uri, size_bytes: ref.sizeBytes };
        if (enforceBudget(content)) return { ...result, content, artifactRefs: [...result.artifactRefs ?? [], ref] };
        content.output_budget = { truncated: true };
        if (enforceBudget(content)) return { ...result, content, artifactRefs: [...result.artifactRefs ?? [], ref] };
      } catch {
        const guardResult3 = guard(request, before, true, result);
        if (guardResult3) return guardResult3;
      }
    }
    content.output_budget = { truncated: true };
    if (enforceBudget(content)) return { ...result, content };
    return boundResult(result);
  }

  function guard(request, before, dispatched, known) {
    before.signal.throwIfAborted();
    if (drifted(request, before)) return dispatched
      ? uncertainResult(known, before, 'e2b_command_request_drifted')
      : { status: 'error', content: { code: 'e2b_command_request_drifted', executed: false } };
    if (!checkAuthority(request)) return dispatched
      ? uncertainResult(known, before, 'e2b_command_authority_lost')
      : { status: 'error', content: { error_type: 'e2b_command_authority_unproven', executed: false } };
    // The synchronous authority callback is also an external boundary.
    before.signal.throwIfAborted();
    if (drifted(request, before)) return dispatched
      ? uncertainResult(known, before, 'e2b_command_request_drifted')
      : { status: 'error', content: { code: 'e2b_command_request_drifted', executed: false } };
    return null;
  }

  async function execute(request) {
    let dispatched = false, known, sandboxId, taskId;
    let before;
    try {
      before = snapshot(request);
      const minBudget = minimalUncertainBudget(before);
      if (minBudget > maxOutputBytes) return errorResult('e2b_command_budget_below_minimum_identity',
        { executed: false, required_bytes: minBudget, max_output_bytes: maxOutputBytes });
      request.signal.throwIfAborted();
      const rejection = toolInputRejection(formal.get(request.call.name), request.call);
      if (rejection) return Buffer.byteLength(canonical(rejection)) <= maxOutputBytes
        ? { status: 'error', content: rejection } : errorResult('e2b_command_arguments_invalid', { executed: false });
      request.signal.throwIfAborted();

      const decision = await abortable(authorize(request), before.signal);
      const guardResult = guard(request, before, false, null);
      if (guardResult) return guardResult;
      if (decision !== 'allow') return decision?.status === 'approval_required' && typeof decision.interactionId === 'string'
        ? decision : errorResult('policy_denied');

      if (request.call.name === 'sandbox_status') {
        const guardResult = guard(request, before, false, null);
        if (guardResult) return guardResult;
        const inspect = syncValue(owner.inspect());
        invariant(!inspect || (inspect.sandboxId == null || typeof inspect.sandboxId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(inspect.sandboxId))
          && ['absent','creating','ready','closing','closed','unknown'].includes(inspect.phase), 'e2b_owner_status_invalid');
        const afterInspect = guard(request, before, false, null); if (afterInspect) return afterInspect;
        return { status: 'ok', content: { ok: true, backend: 'e2b', enabled: true, isolated: true,
          sandbox_id: inspect?.sandboxId ?? null, sandbox_phase: inspect?.phase ?? 'absent',
          allow_internet_access: allowInternetAccess,
          boundary: 'Remote E2B sandbox. The Host filesystem is not shared.',
          contracts: [E2B_COMMAND_TOOLS_CONTRACT] } };
      }

      if (request.call.name === 'read_command_output' || request.call.name === 'stop_command') {
        const args = request.call.arguments;
        const guardResult = guard(request, before, false, null);
        if (guardResult) return guardResult;
        const owned = syncValue(resolveOwnedCommand(request, args.task_id));
        invariant(owned?.backend === 'e2b' && owned.ref?.taskId === args.task_id, 'e2b_command_backend_mismatch');
        const afterResolve = guard(request, before, false, null); if (afterResolve) return afterResolve;
        taskId = args.task_id;
        if (!store) store = syncValue(storeFactory({ scope: copy(fixedScope), sessionId }));
        invariant(typeof store.commandId === 'function'
          && syncValue(store.commandId(owned.ref.operationKey)) === taskId, 'e2b_command_owned_operation_mismatch');
        const handle = syncValue(store.connect(owned.ref.taskId));
        const afterConnect = guard(request, before, false, null); if (afterConnect) return afterConnect;
        known = { content: { task_id: args.task_id, ...originLocator(before, undefined, taskId) } };
        if (request.call.name === 'stop_command') {
          dispatched = true;
          const cancelOutput = syncValue(handle.requestCancel());
          const guardResult = guard(request, before, dispatched, known);
          if (guardResult) return guardResult;
          const uncertain = cancelOutput.status === 'unknown' || cancelOutput.evidenceIncomplete;
          known = { status: uncertain ? 'uncertain' : 'ok', content: { ok: !uncertain, task_id: args.task_id,
            ...commandOutput(cancelOutput), ...originLocator(before, undefined, taskId) } };
        } else {
          const until = performance.now() + (args.wait_seconds ?? 0) * 1000;
          let interval = 50;
          while (!TERMINAL.has(syncValue(handle.readOutput()).status) && performance.now() < until) {
            const guardResult = guard(request, before, false, known);
            if (guardResult) return guardResult;
            await delay(Math.min(interval, Math.max(0, until - performance.now())));
            interval = Math.min(1000, interval * 2);
          }
          const guardResult = guard(request, before, false, known);
          if (guardResult) return guardResult;
          const output = handle.readOutput({ stdoutCursor: args.stdout_cursor ?? 0,
            stderrCursor: args.stderr_cursor ?? 0, maxBytes: args.max_bytes ?? 65536 });
          const uncertain = output.status === 'unknown' || output.evidenceIncomplete;
          known = { status: uncertain ? 'uncertain' : 'ok', content: { ok: !uncertain, task_id: args.task_id,
            ...commandOutput(output), ...originLocator(before, undefined, taskId) } };
        }
        const afterRead = guard(request, before, dispatched, known); if (afterRead) return afterRead;
        return await budget(known, request, before, undefined, taskId);
      }

      // run_command — PRE-CHECK budget before any side-effect.
      const args = request.call.arguments;
      const command = args.command.trim();
      if (!command) return errorResult('command_required');
      if (!args.background && args.background_timeout != null) return errorResult('background_timeout_requires_background');

      known = { content: { ...originLocator(before) } };
      const ownerRequest = { ...request, definition: formal.get('run_command') };
      const guardResult0 = guard(request, before, false, known);
      if (guardResult0) return guardResult0;
      let ensured;
      dispatched = true;
      try { ensured = await abortable(owner.ensure(ownerRequest), before.signal); }
      catch (error) {
        if (error?.uncertain) return uncertainResult(known, before, 'e2b_sandbox_outcome_unknown');
        throw error;
      }
      invariant(typeof ensured?.sandboxId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ensured.sandboxId), 'e2b_sandbox_identity_invalid');
      sandboxId = ensured.sandboxId;
      known = { content: { ...originLocator(before, sandboxId) } };
      const guardResult1 = guard(request, before, dispatched, known);
      if (guardResult1) return guardResult1;

      if (!store) store = syncValue(storeFactory({ scope: copy(fixedScope), sessionId, sandboxId }));
      const suppliedTimeout = args.background ? (args.background_timeout ?? backgroundTimeoutSeconds)
        : (args.timeout ?? foregroundTimeoutSeconds);
      const maximum = args.background ? 86400 : foregroundTimeoutSeconds;
      const timeoutSeconds = Number(suppliedTimeout > maximum ? maximum : suppliedTimeout);
      const afterFactory = guard(request, before, dispatched, known); if (afterFactory) return afterFactory;
      if (typeof store.commandId === 'function') {
        taskId = syncValue(store.commandId(before.operationKey));
        invariant(typeof taskId === 'string' && /^[a-f0-9]{64}$/.test(taskId), 'e2b_command_identity_invalid');
        known = { content: { ...originLocator(before, sandboxId, taskId) } };
        const afterId = guard(request, before, dispatched, known); if (afterId) return afterId;
      }
      const handle = await abortable(store.start({ operationKey: before.operationKey, command,
        cwd: args.cwd ?? null, env: args.env ?? null, timeoutSeconds,
        assertCurrent: () => {
          const rejected = guard(request, before, dispatched, known);
          invariant(!rejected, 'e2b_command_authority_lost'); return true;
        } }), before.signal);
      invariant(typeof handle?.commandId === 'string' && /^[a-f0-9]{64}$/.test(handle.commandId), 'e2b_command_identity_invalid');
      invariant(taskId === undefined || taskId === handle.commandId, 'e2b_command_identity_changed');
      taskId = handle.commandId;
      known = { content: { ...originLocator(before, sandboxId, taskId) },
        ...(args.background ? { backgroundCommandRef: { taskId, sourceRunId: before.runId, operationKey: before.operationKey } } : {}) };
      const guardResult2 = guard(request, before, dispatched, known);
      if (guardResult2) return guardResult2;

      if (args.background) {
        const observed = syncValue(handle.readOutput());
        const uncertain = observed.status === 'unknown' || observed.evidenceIncomplete;
        known = { status: uncertain ? 'uncertain' : 'ok',
          content: { ok: !uncertain, backend: 'sandbox/e2b', sandbox_id: sandboxId,
            task_id: taskId, ...commandOutput(observed), ...originLocator(before, sandboxId, taskId),
            process_timeout_seconds: timeoutSeconds },
          backgroundCommandRef: { taskId, sourceRunId: before.runId, operationKey: before.operationKey } };
      } else {
        const until = performance.now() + timeoutSeconds * 1000 + 15000;
        let output;
        while (!TERMINAL.has((output = handle.readOutput()).status) && performance.now() < until) {
          const guardResult = guard(request, before, dispatched, known);
          if (guardResult) return guardResult;
          await delay(50);
        }
        const guardResult3 = guard(request, before, dispatched, known);
        if (guardResult3) return guardResult3;
        output = handle.readOutput({ stdoutCursor: 0, stderrCursor: 0, maxBytes: 65536 });
        const uncertain = output.status === 'unknown' || output.evidenceIncomplete
          || !TERMINAL.has(output.status)
          || (['timed_out', 'canceled'].includes(output.status) && output.exitCode === null);
        known = { status: uncertain ? 'uncertain' : 'ok',
          content: { ok: !uncertain, backend: 'sandbox/e2b', sandbox_id: sandboxId, command,
            task_id: taskId, ...originLocator(before, sandboxId, taskId),
            stdout: output.stdout, stderr: output.stderr,
            exit_code: uncertain ? null : output.exitCode,
            observed_exit_code: uncertain ? output.exitCode : null,
            evidence_incomplete: uncertain,
            ...(output.outcomeReason ? { outcome_reason: output.outcomeReason } : {}) } };
      }
      const afterOutput = guard(request, before, dispatched, known); if (afterOutput) return afterOutput;
      return await budget(known, request, before, sandboxId, taskId);
    } catch (error) {
      if (!before) return errorResult('e2b_command_request_invalid', { executed: false });
      const originalAborted = before.signal.aborted;
      return dispatched
        ? uncertainResult(known, before, originalAborted ? 'e2b_command_aborted' : (error?.code ?? 'e2b_command_evidence_incomplete'), sandboxId, taskId)
        : errorResult(originalAborted ? 'canceled' : 'e2b_command_error', { executed: false });
    }
  }

  return Object.freeze({ definitions: copy(definitions), async execute(request) {
    const result = await execute(request);
    return result.content === undefined ? result : boundResult(result);
  }, contract: E2B_COMMAND_TOOLS_CONTRACT });
}
