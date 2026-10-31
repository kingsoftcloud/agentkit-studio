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
import { canonical, copy, invariant, scopeKey, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { TERMINAL, delay } from './e2b-command-state.mjs';
import { createHash } from 'node:crypto';

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

export const E2B_CODE_TOOLS_CONTRACT = 'agentkit.native-e2b-code-tools/v1';
export const DSH_E2B_CODE_TOOLS_CONTRACT = 'agentkit.dsh-e2b-code-tools/v1';
export function e2bCodeToolDefinitions(timeoutSeconds = 300, name = 'run_code') {
  e2bCommandToolDefinitions(timeoutSeconds); // Same Host timeout bounds.
  invariant(['run_code', 'sandbox_run_code'].includes(name), 'e2b_code_name_invalid');
  return [base(name, 'Execute a Python, JavaScript or Bash snippet in an isolated remote sandbox. Requires E2B; never runs a snippet on the Host. Unknown outcomes require reconciliation of the original task.',
    { code: { type: 'string', minLength: 1 }, language: { type: 'string' }, timeout: schemas.nullableSeconds,
      env: { anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }] } },
    ['code'], true, timeoutSeconds * 1000 + 20000)];
}

function snippetCommand(args, before) {
  const aliases = { py: 'python', python3: 'python', js: 'javascript', node: 'javascript', nodejs: 'javascript', sh: 'bash', shell: 'bash' };
  const selected = (args.language || 'python').trim().toLowerCase(), language = aliases[selected] ?? selected;
  const runner = { python: ['.py', 'python'], javascript: ['.js', 'node'], bash: ['.sh', 'bash'] }[language];
  if (!runner) return null;
  const path = `/tmp/ksadk-run-code-${createHash('sha256').update(before.body).digest('hex')}${runner[0]}`;
  return { path, language, command: `${runner[1]} '${path}'`,
    launch: `chmod 600 '${path}' && exec ${runner[1]} '${path}'` };
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

export function createNativeE2BCommandTools(options = {}) {
  return createNativeTools(options, false);
}
export function createNativeE2BCodeTools(options = {}) {
  return createNativeTools(options, true);
}
function createNativeTools(options, codeOnly) {
  invariant(options.scope, 'e2b_command_scope_required');
  const fixedScope = copy(options.scope); scopeKey(fixedScope);
  return createCommandTools(options, { codeOnly, contract: codeOnly ? E2B_CODE_TOOLS_CONTRACT : E2B_COMMAND_TOOLS_CONTRACT, fields: { scope: fixedScope },
    identity(request) {
      invariant(request.scope && canonical(request.scope) === canonical(fixedScope), 'e2b_command_scope_unbound');
      invariant(['runId','turnId','buildId','taskChainId'].every(k => typeof request[k] === 'string' && request[k].trim()),
        'e2b_command_identity_required');
      invariant(request.parentRunId === null || typeof request.parentRunId === 'string' && request.parentRunId.trim(),
        'e2b_command_parent_run_id_invalid');
      invariant(Number.isSafeInteger(request.executionFence) && request.executionFence > 0, 'e2b_command_fence_required');
      return { scope: copy(request.scope), runId: request.runId, turnId: request.turnId, buildId: request.buildId,
        parentRunId: request.parentRunId, taskChainId: request.taskChainId, executionFence: request.executionFence };
    }, backgroundRef: (before, taskId) => ({ taskId, sourceRunId: before.identity.runId, operationKey: before.operationKey }) });
}

export const DSH_E2B_COMMAND_TOOLS_CONTRACT = 'agentkit.dsh-e2b-command-tools/v1';
/** Share command semantics with Native, using real DSH ownership only. */
export function createDshE2BCommandTools(options = {}) {
  return createDshTools(options, false);
}
export function createDshE2BCodeTools(options = {}) {
  return createDshTools(options, true);
}
function createDshTools(options, codeOnly) {
  const { agentId } = options;
  invariant(typeof agentId === 'string' && agentId.trim(), 'e2b_command_agent_required');
  return createCommandTools(options, { codeOnly, contract: codeOnly ? DSH_E2B_CODE_TOOLS_CONTRACT : DSH_E2B_COMMAND_TOOLS_CONTRACT, fields: { agentId },
    identity(request) {
      invariant(request.agentId === agentId && ['scope','runId','turnId','buildId','taskChainId','parentRunId','executionFence']
        .every(key => request[key] === undefined), 'e2b_command_identity_required');
      return { agentId };
    }, backgroundRef: (before, taskId) => ({ taskId, agentId, sessionId: before.sessionId,
      sourceCallId: before.callId, operationKey: before.operationKey }) });
}

function createCommandTools({ sessionId, owner, storeFactory,
  authorize, assertAuthority, resolveOwnedCommand, artifacts, publishSnippet, maxOutputBytes = 24000,
  allowInternetAccess = false, foregroundTimeoutSeconds = 300, backgroundTimeoutSeconds = 300 }, ownership) {
  invariant(typeof sessionId === 'string' && !!sessionId.trim(), 'e2b_command_scope_required');
  invariant(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 256, 'e2b_command_max_output_bytes_invalid');
  invariant(owner && typeof owner.ensure === 'function' && typeof owner.inspect === 'function', 'e2b_command_owner_required');
  invariant(typeof storeFactory === 'function', 'e2b_command_store_factory_required');
  invariant(!ownership.codeOnly || typeof publishSnippet === 'function', 'e2b_code_publication_required');
  invariant(typeof authorize === 'function', 'e2b_command_authorize_required');
  invariant(typeof assertAuthority === 'function', 'e2b_command_assert_authority_required');
  invariant(typeof resolveOwnedCommand === 'function', 'e2b_command_resolve_owned_required');
  invariant(Number.isSafeInteger(backgroundTimeoutSeconds) && backgroundTimeoutSeconds > 0
    && backgroundTimeoutSeconds <= 86400, 'e2b_command_background_limit_invalid');
  const definitions = ownership.codeOnly ? e2bCodeToolDefinitions(foregroundTimeoutSeconds, ownership.fields.agentId ? 'sandbox_run_code' : 'run_code')
    : e2bCommandToolDefinitions(foregroundTimeoutSeconds);
  const formal = new Map(definitions.map(d => [d.name, copy(d)]));
  let store = null;

  function snapshot(request) {
    invariant(request && request.call && typeof request.call.name === 'string' && typeof request.call.callId === 'string' && request.call.callId.trim(),
      'e2b_command_request_unbound');
    invariant(typeof request.operationKey === 'string' && request.operationKey.trim(), 'e2b_command_operation_key_required');
    const def = formal.get(request.call.name);
    invariant(def, 'e2b_command_tool_unbound');
    invariant(request.definition && canonical(request.definition) === canonical(def), 'e2b_command_definition_unbound');
    invariant(request.signal instanceof AbortSignal, 'e2b_command_signal_unbound');
    invariant(typeof request.sessionId === 'string' && request.sessionId === sessionId, 'e2b_command_session_unbound');
    const identity = ownership.identity(request);
    const { signal: _signal, ...body } = request;
    return { body: canonical(body), signal: request.signal,
      identity, sessionId: request.sessionId, operationKey: request.operationKey,
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
    return { ...copy(before.identity), sessionId: before.sessionId, operationKey: before.operationKey, callId: before.callId,
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
    if (request.resultGovernance === 'runtime-artifacts/v1') return guard(request, before, true, result) ?? result;
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
          contracts: [ownership.contract] } };
      }

      if (request.call.name === 'read_command_output' || request.call.name === 'stop_command') {
        const args = request.call.arguments;
        const guardResult = guard(request, before, false, null);
        if (guardResult) return guardResult;
        const owned = syncValue(resolveOwnedCommand(request, args.task_id));
        invariant(owned?.backend === 'e2b' && owned.ref?.taskId === args.task_id, 'e2b_command_backend_mismatch');
        const afterResolve = guard(request, before, false, null); if (afterResolve) return afterResolve;
        taskId = args.task_id;
        if (!store) store = syncValue(storeFactory({ ...copy(ownership.fields), sessionId }));
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

      // The original durable tool intent surrounds both source publication
      // and its supervised execution. Never put source in a shell argument:
      // even a valid large snippet can exceed the remote OS argv limit.
      const args = request.call.arguments;
      const snippet = ownership.codeOnly ? snippetCommand(args, before) : null;
      if (ownership.codeOnly && !snippet) return errorResult('unsupported_language', { executed: false });
      const command = snippet?.launch ?? args.command.trim();
      if (!command) return errorResult('command_required');
      if (!args.background && args.background_timeout != null) return errorResult('background_timeout_requires_background');

      known = { content: { ...originLocator(before) } };
      const ownerRequest = { ...request, definition: formal.get(request.call.name) };
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

      if (!store) store = syncValue(storeFactory({ ...copy(ownership.fields), sessionId, sandboxId }));
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
      if (snippet) {
        const assertCurrent = () => { invariant(!guard(request, before, dispatched, known), 'e2b_code_authority_lost'); return true; };
        await abortable(publishSnippet({ request, sandboxId, path: snippet.path, source: args.code, assertCurrent }), before.signal);
        const afterPublish = guard(request, before, dispatched, known); if (afterPublish) return afterPublish;
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
        ...(args.background ? { backgroundCommandRef: ownership.backgroundRef(before, taskId) } : {}) };
      const guardResult2 = guard(request, before, dispatched, known);
      if (guardResult2) return guardResult2;

      if (args.background) {
        const observed = syncValue(handle.readOutput());
        const uncertain = observed.status === 'unknown' || observed.evidenceIncomplete;
        known = { status: uncertain ? 'uncertain' : 'ok',
          content: { ok: !uncertain, backend: 'sandbox/e2b', sandbox_id: sandboxId,
            task_id: taskId, ...commandOutput(observed), ...originLocator(before, sandboxId, taskId),
            process_timeout_seconds: timeoutSeconds },
          backgroundCommandRef: ownership.backgroundRef(before, taskId) };
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
        // The model sees a bounded preview, but its artifact must contain all
        // retained foreground output, not just the first 64 KiB cursor window.
        const stdout = [], stderr = []; let stdoutCursor = 0, stderrCursor = 0, bytes = 0;
        for (;;) {
          const rejected = guard(request, before, dispatched, known); if (rejected) return rejected;
          output = syncValue(handle.readOutput({ stdoutCursor, stderrCursor, maxBytes: 65536 }));
          invariant(typeof output.stdout === 'string' && typeof output.stderr === 'string', 'e2b_command_output_invalid');
          bytes += Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
          invariant(bytes <= 16 * 1024 * 1024, 'e2b_command_retained_output_too_large');
          stdout.push(output.stdout); stderr.push(output.stderr);
          if (!output.outputMayBeTruncated) break;
          invariant(Number.isSafeInteger(output.stdoutCursor) && output.stdoutCursor >= stdoutCursor
            && Number.isSafeInteger(output.stderrCursor) && output.stderrCursor >= stderrCursor
            && (output.stdoutCursor > stdoutCursor || output.stderrCursor > stderrCursor), 'e2b_command_output_cursor_stalled');
          stdoutCursor = output.stdoutCursor; stderrCursor = output.stderrCursor;
        }
        output = { ...output, stdout: stdout.join(''), stderr: stderr.join('') };
        const uncertain = output.status === 'unknown' || output.evidenceIncomplete
          || !TERMINAL.has(output.status)
          || (['timed_out', 'canceled'].includes(output.status) && output.exitCode === null);
        known = { status: uncertain ? 'uncertain' : 'ok',
          content: { ok: !uncertain, status: output.status, backend: 'sandbox/e2b', sandbox_id: sandboxId, command,
            ...(snippet ? { execution_model: 'snippet_runner', language: snippet.language, path: snippet.path, command: snippet.command } : {}),
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
    return result.content === undefined || request.resultGovernance === 'runtime-artifacts/v1' ? result : boundResult(result);
  }, contract: ownership.contract });
}
