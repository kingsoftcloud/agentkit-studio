import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { constants as osConstants } from 'node:os';
import { LocalCommandStore, createLocalBackgroundReader } from './local-background.mjs';
import { TERMINAL, delay, readRecord } from './local-command-state.mjs';
import { buildScriptEnvironment, localControlSettings, runBoundedProcess, LOCAL_PROCESS_CONTRACT } from './local-process.mjs';
import { localEnvironmentPolicy, localOutputPolicy, resolveOutputPolicy } from './local-output-policy.mjs';
import { checkGovernedCommand, LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY } from './local-command-policy.mjs';
import { checkPlanCommand, PLAN_COMMAND_POLICY } from './command-plan.mjs';
import { commandFailureEvidence, commandExceptionCause } from './local-command-evidence.mjs';
import { captureCommandWorkspace, commandWorkspaceChange } from './command-workspace-observation.mjs';
import { LOCAL_COMMAND_SHELL, shellCommandArgv } from './command-shell.mjs';

export const LOCAL_COMMAND_TOOLS_CONTRACT = 'agentkit.local-command-tools/v1';
export const LOCAL_COMMAND_PROGRESS_CONTRACT = 'agentkit.local-command-progress/v1';
const schemas = { nullableSeconds: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  cursor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };
const base = (name, properties, required, mutating, timeoutMs) => ({ name,
  description: name === 'run_command' ? 'Run a governed Bash command inside the bound local workspace. background=true returns an owned task_id; read_command_output observes it and stop_command requests cancellation. This shares the Host filesystem and network; it is not an isolated OS sandbox.'
    : name === 'read_command_output' ? 'Read an owned command status and UTF-8 byte cursors. Reusing a cursor is read-only. Waiting never changes the command deadline.'
      : name === 'stop_command' ? 'Request cancellation of one command launched by this Session. Read its output to confirm the final status; a cancel request is not proof of completion.'
        : 'Report the bound command backend and its execution boundary.',
  parameters: { type: 'object', properties, required, additionalProperties: false },
  readOnly: !mutating, concurrentSafe: !mutating, permissions: mutating ? [name === 'stop_command' ? 'sandbox:cancel' : 'sandbox:execute'] : [],
  timeoutMs, contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
  ...(!mutating ? { recoveryPolicy: 'safe-read/v1' } : {}) });
export function localCommandToolDefinitions(settings = {}) {
  const limits = localControlSettings(settings);
  return [
    base('sandbox_status', {}, [], false, 10000),
    { ...base('run_command', { command: { type: 'string', minLength: 1 }, cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      timeout: schemas.nullableSeconds, env: { anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }] },
      background: { type: 'boolean' }, background_timeout: schemas.nullableSeconds }, ['command'], true, limits.wallSeconds * 1000 + 15000),
    backgroundCommandPolicy: 'owned-command-launch/v1', workspaceChangePolicy: 'observed-command/v1' },
    base('read_command_output', { task_id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, stdout_cursor: schemas.cursor,
      stderr_cursor: schemas.cursor, max_bytes: { type: 'integer', minimum: 4, maximum: 65536 },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 600 } }, ['task_id'], false, 610000),
    base('stop_command', { task_id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['task_id'], true, 10000),
  ];
}
const output = result => ({ status: result.status, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode,
  stdout_cursor: result.stdoutCursor, stderr_cursor: result.stderrCursor, cancel_requested: result.cancelRequested,
  output_may_be_truncated: result.outputMayBeTruncated, evidence_incomplete: result.evidenceIncomplete,
  observed_exit_code: result.observedExitCode, ...(result.outcomeReason ? { outcome_reason: result.outcomeReason } : {}),
  ...(result.commandEvidence ? { command_evidence: result.commandEvidence } : {}) });
const errorResult = (code, extra = {}) => ({ status: 'error', content: { ok: false, error_type: code, ...extra } });
const changed = (before, after) => [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])]
  .filter(path => before.entries[path] !== after.entries[path]).sort();
function utf8Preview(text, maxBytes) {
  return new TextDecoder('utf8', { ignoreBOM: true }).decode(Buffer.from(text).subarray(0, maxBytes), { stream: true });
}

/** Execute only after Host authorization. resolveOwnedCommand must validate
 * canonical ledger receipts; a bare task ID or a backend environment switch
 * grants no access. The caller keeps the surrounding Native intent/lease.
 */
export function createLocalCommandTransport({ workspaceRoot, stateRoot, sessionId, settings = {}, sourceEnv = {},
  authorize, resolveOwnedCommand, captureWorkspace, artifacts, assertAuthority = () => true,
  durableForeground = false, outputPolicy = null, environmentPolicy = null } = {}) {
  invariant(typeof authorize === 'function' && typeof resolveOwnedCommand === 'function'
    && typeof captureWorkspace === 'function' && typeof assertAuthority === 'function'
    && typeof durableForeground === 'boolean', 'local_command_host_capabilities_missing');
  // Validate raw policy inputs at this public entrypoint. The output policy
  // forces the durable foreground path: full output lives in supervisor-owned
  // files located by task_id/cursors, so an in-process runBoundedProcess receipt
  // (which holds only a preview under persisted-stream/v1) must never be used.
  const outPolicy = localOutputPolicy(outputPolicy);
  const envPolicy = localEnvironmentPolicy(environmentPolicy);
  if (outPolicy) durableForeground = true;
  const root = realpathSync(workspaceRoot), policy = localControlSettings(settings), definitions = localCommandToolDefinitions(policy);
  // Under persisted-stream/v1 the automatic foreground receipt uses a bounded
  // window matching previewBytes (clamped to the 4..65536 UTF-8 cursor range).
  // Explicit read_command_output retains its own independent pagination.
  const previewWindow = outPolicy
    ? Math.min(65536, Math.max(4, resolveOutputPolicy(policy, outPolicy).previewBytes)) : null;
  const environment = { ...sourceEnv }, formal = new Map(definitions.map(item => [item.name, copy(item)]));
  // Exact model integers may be bigint. Clamp before converting rather than
  // throwing after claiming a dispatch for an otherwise valid large timeout.
  const deadline = seconds => (seconds == null || seconds > policy.wallSeconds ? policy.wallSeconds : Number(seconds)) * 1000;
  // Canonicalize trusted Host state paths (e.g. macOS /var -> /private/var)
  // before entering the backend's strict no-symlink private-directory guard.
  const lexicalState = resolve(stateRoot);
  invariant(lexicalState !== root && !lexicalState.startsWith(root + sep), 'background_state_inside_workspace');
  mkdirSync(lexicalState, { recursive: true, mode: 0o700 });
  const store = new LocalCommandStore({ stateRoot: realpathSync(lexicalState), workspaceRoot: root, sessionId });
  const checkRoot = () => invariant(realpathSync(workspaceRoot) === root, 'workspace_root_changed');
  function cwdFor(value) {
    const cwd = value ? isAbsolute(value) ? resolve(value) : resolve(root, value) : root;
    const rel = relative(root, cwd);
    invariant(cwd === root || rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel), 'command_cwd_outside_workspace');
    let part = root;
    for (const name of rel.split(sep).filter(Boolean)) { part = join(part, name); invariant(!lstatSync(part).isSymbolicLink(), 'command_cwd_symlink'); }
    invariant(lstatSync(cwd).isDirectory(), 'command_cwd_not_directory'); return cwd;
  }
  async function checkPlanMode(request) {
    try {
      checkRoot();
      invariant(request.planMode === 'session-plan/v1' && request.definition.planModeCommandPolicy === PLAN_COMMAND_POLICY
        && request.call.name === 'run_command', 'plan_command_binding_invalid');
      request.signal.throwIfAborted();
      invariant(assertAuthority(request) === true, 'local_command_authority_stale');
      const args = request.call.arguments, cwd = cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
      const { KSADK_COMMAND_CWD: _routing, ...env } = args.env ?? {};
      const allowed = await checkPlanCommand(args.command, { cwd, workspaceRoot: root, env, signal: request.signal });
      request.signal.throwIfAborted(); checkRoot();
      return allowed && assertAuthority(request) === true;
    } catch { return false; }
  }
  async function budget(result, request) {
    if (request.resultGovernance === 'runtime-artifacts/v1') return result;
    const text = canonical(result.content);
    if (Buffer.byteLength(text) <= 24000) return result;
    invariant(typeof artifacts?.write === 'function', 'command_output_artifact_store_missing');
    const ref = await artifacts.write({ ...request, operationKey: `${request.operationKey}:command-output`,
      content: text, mediaType: 'application/json', metadata: { toolName: request.call.name, sessionId } });
    const content = { ...result.content };
    for (const key of ['command', 'stdout', 'stderr']) if (typeof content[key] === 'string') content[key] = utf8Preview(content[key], 4000);
    content.output_budget = { truncated: true, artifact_uri: ref.uri, size_bytes: ref.sizeBytes,
      instruction: 'The complete retained result is in the artifact. Output byte cursors refer to the backend stream, not this preview.' };
    return { ...result, content, artifactRefs: [...result.artifactRefs ?? [], ref] };
  }
  // Observation is an execution-local Host capability, outside the immutable
  // request and the final receipt. It is never published to a client here:
  // the Host must authorize/project these bytes before displaying a preview.
  async function execute(request, { onProgress } = {}) {
    let dispatched = false, known, original, sealed;
    let progressSequence = 0;
    const guard = () => {
      checkRoot();
      invariant(request.signal === original && !original.aborted, 'local_command_signal_stale');
      const { signal: _, ...body } = request;
      invariant(canonical(body) === sealed, 'local_command_request_drifted');
      const current = assertAuthority(request);
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      invariant(current === true, 'local_command_authority_stale');
      const { signal: liveSignal, ...live } = request;
      invariant(liveSignal === original && canonical(live) === sealed, 'local_command_request_drifted');
      original.throwIfAborted(); return true;
    };
    const progress = (channel, text) => {
      if (typeof onProgress !== 'function' || !text || original?.aborted) return;
      try {
        guard();
        const observed = onProgress(Object.freeze({ contract: LOCAL_COMMAND_PROGRESS_CONTRACT,
          sequence: ++progressSequence, channel, text }));
        // A presentation consumer cannot delay or fail the command, including
        // when it returns a rejecting promise instead of throwing directly.
        Promise.resolve(observed).catch(() => {});
      } catch { /* unavailable/stale observations grant no execution outcome */ }
    };
    try {
      invariant(request.signal instanceof AbortSignal, 'local_command_signal_required');
      original = request.signal;
      const { signal: _, ...body } = request; sealed = canonical(body);
      invariant(request.sessionId === sessionId, 'local_command_session_mismatch'); checkRoot(); request.signal.throwIfAborted();
      guard();
      const definition = formal.get(request.call?.name); invariant(definition, 'local_command_tool_unbound');
      const rejection = toolInputRejection(definition, request.call);
      if (rejection) return { status: 'error', content: rejection };
      const args = structuredClone(request.call.arguments);
      const decision = await authorize(request); guard();
      if (decision !== 'allow') return decision?.status === 'approval_required' && typeof decision.interactionId === 'string'
        ? decision : errorResult('policy_denied');
      if (request.call.name === 'sandbox_status') return { status: 'ok', content: { ok: true, backend: 'local_process', enabled: true,
        isolated: false, sandbox_id: `local_process:${sessionId}`, timeout_seconds: policy.wallSeconds,
        boundary: 'Shares Host filesystem, allowlisted environment and network. Not an OS security sandbox.',
        shell: '/bin/bash', shell_policy: LOCAL_COMMAND_SHELL,
        contracts: [LOCAL_COMMAND_TOOLS_CONTRACT, LOCAL_PROCESS_CONTRACT, LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY] } };
      if (request.call.name === 'read_command_output' || request.call.name === 'stop_command') {
        const owned = resolveOwnedCommand(request, args.task_id);
        guard();
        invariant(owned.backend === 'local_process' && owned.ref.taskId === store.commandId(owned.ref.operationKey), 'local_command_backend_mismatch');
        const handle = store.connect(owned.ref.taskId);
        if (request.call.name === 'stop_command') {
          guard();
          dispatched = true; known = { status: 'ok', content: { ok: true, task_id: args.task_id, ...output(handle.requestCancel()) } };
        } else {
          const until = performance.now() + (args.wait_seconds ?? 0) * 1000;
          let interval = 50;
          while (!TERMINAL.has(handle.readOutput().status) && performance.now() < until) {
            guard(); await delay(Math.min(interval, Math.max(0, until - performance.now()))); interval = Math.min(1000, interval * 2);
          }
          request.signal.throwIfAborted();
          known = { status: 'ok', content: { ok: true, task_id: args.task_id, ...output(handle.readOutput({
            stdoutCursor: args.stdout_cursor ?? 0, stderrCursor: args.stderr_cursor ?? 0, maxBytes: args.max_bytes ?? 65536 })) } };
        }
        guard(); const result = await budget(known, request); guard(); return result;
      }
      const command = args.command.trim();
      if (!command) return errorResult('command_required');
      if (!args.background && args.background_timeout != null) return errorResult('background_timeout_requires_background');
      const cwd = cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
      const finding = await checkGovernedCommand(command, { cwd, allowedRoots: [root], signal: request.signal });
      guard();
      if (finding) return errorResult('command_policy_blocked', { finding, exit_code: 126, executed: false });
      if (request.planMode !== undefined && !await checkPlanMode(request))
        return { status: 'error', content: { code: 'plan_mode_write_denied', executed: false } };
      guard();
      request.signal.throwIfAborted(); checkRoot(); cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
      const env = buildScriptEnvironment({ ...environment, ...args.env }, { settings: policy, environmentPolicy: envPolicy });
      const observedChanges = request.definition?.workspaceChangePolicy === 'observed-command/v1';
      const before = observedChanges ? await captureCommandWorkspace(captureWorkspace, request) : captureWorkspace(request);
      guard();
      if (args.background || durableForeground) {
        dispatched = true;
        const operationKey = request.operationKey, expectedTaskId = store.commandId(operationKey);
        known = { content: { backend: 'sandbox/local_process', task_id: expectedTaskId } };
        const handle = await store.start({ operationKey, command, cwd, env, settings: policy, shellPolicy: LOCAL_COMMAND_SHELL,
          outputPolicy: outPolicy, environmentPolicy: envPolicy,
          timeoutMs: deadline(args.background ? args.background_timeout : args.timeout), assertCurrent: guard });
        if (!args.background) {
          const cancel = () => { try { handle.requestCancel(); } catch { /* retain unknown */ } };
          original.addEventListener('abort', cancel, { once: true });
          if (original.aborted) cancel();
          try {
            const until = performance.now() + deadline(args.timeout) + 15000;
            let stdoutCursor = 0, stderrCursor = 0;
            while (performance.now() < until) {
              guard();
              const view = handle.readOutput({ stdoutCursor, stderrCursor });
              const advanced = view.stdoutCursor > stdoutCursor || view.stderrCursor > stderrCursor;
              if (typeof onProgress === 'function') {
                progress('stdout', view.stdout); progress('stderr', view.stderr);
                stdoutCursor = view.stdoutCursor; stderrCursor = view.stderrCursor;
              }
              // A completed producer may still have several retained windows.
              // Drain them before closing the observation, without deriving a
              // successful receipt from the preview's terminal status.
              if (TERMINAL.has(view.status) && (typeof onProgress !== 'function' || !advanced)) break;
              await delay(20);
            }
          } catch (error) { cancel(); throw error;
          } finally { original.removeEventListener('abort', cancel); }
        }
        // The automatic foreground receipt is a bounded PREVIEW under the new
        // policy (previewWindow bytes); full output stays cursor-readable via
        // read_command_output's independent pagination. wait() reads the whole
        // file in legacy mode only — under the policy it must not pull the full
        // output into the receipt, so re-read with the bounded window instead.
        let observed = previewWindow ? handle.readOutput({ maxBytes: previewWindow })
          : handle.readOutput();
        if (!args.background && TERMINAL.has(observed.status) && observed.status !== 'unknown'
          && !previewWindow)
          observed = await handle.wait({ timeoutMs: 100 });
        const uncertain = observed.status === 'unknown' || observed.evidenceIncomplete
          || !args.background && !TERMINAL.has(observed.status);
        known = { status: uncertain ? 'uncertain' : 'ok', content: { ok: !uncertain, backend: 'sandbox/local_process', sandbox_id: `local_process:${sessionId}`,
          task_id: handle.commandId, ...output(observed), process_timeout_seconds: readRecord(handle.directory, store.owner, handle.commandId).timeoutMs / 1000,
          ...(!args.background ? { command, controls: readRecord(handle.directory, store.owner, handle.commandId).controls ?? null } : {}),
          instruction: 'Use read_command_output with task_id; stop_command cancels this task only. Do not relaunch unknown outcomes.' },
        ...(args.background ? { launchedCommand: { taskId: handle.commandId, operationKey } } : {}) };
      } else {
        dispatched = true;
        const result = await runBoundedProcess({ argv: shellCommandArgv(command, LOCAL_COMMAND_SHELL), cwd, env, settings: policy, signal: request.signal,
          timeoutMs: deadline(args.timeout), onOutput: progress });
        const incomplete = result.controls.status === 'failed' || !!result.cleanupError;
        const resourceReason = result.exitCode === -osConstants.signals.SIGXCPU ? 'cpu_time'
          : result.exitCode === -osConstants.signals.SIGXFSZ ? 'file_size' : null;
        const diagnostics = [result.timedOut ? 'command timed out' : '', result.outputLimitExceeded ? 'command output limit exceeded' : '',
          resourceReason ? `command resource limit exceeded: ${resourceReason}` : '',
          incomplete ? 'command process supervision or cleanup failed' : ''].filter(Boolean).join('; ');
        known = { status: incomplete ? 'uncertain' : 'ok', content: { ok: true, backend: 'sandbox/local_process',
          sandbox_id: `local_process:${sessionId}`, command, stdout: result.stdout,
          stderr: result.stderr + (diagnostics ? (result.stderr ? '\n' : '') + diagnostics : ''),
          exit_code: incomplete ? null : result.timedOut ? 124 : result.outputLimitExceeded ? 122 : result.exitCode,
          observed_exit_code: incomplete ? result.exitCode : null, evidence_incomplete: incomplete, controls: result.controls,
          ...(incomplete ? { command_evidence: commandFailureEvidence('execute', { result }) } : {}) } };
      }
      guard();
      const after = observedChanges ? await captureCommandWorkspace(captureWorkspace, request) : captureWorkspace(request);
      if (observedChanges) {
        Object.assign(known, commandWorkspaceChange(before, after));
        known.content.workspace_observation = known.workspaceChangeObservation;
      } else known.workspaceChangedPaths = changed(before, after);
      guard(); const result = await budget(known, request); guard(); return result;
    } catch (error) {
      // After dispatch, an exception cannot prove that a command did not run.
      // Keep any known result, including its exit code and background locator.
      return dispatched ? { ...known, status: 'uncertain', content: { ...known?.content, ok: false,
        error_type: 'command_evidence_incomplete', evidence_incomplete: true, observed_result: known?.content?.status ?? null,
        command_evidence: commandFailureEvidence('transport', { previous: known?.content?.command_evidence,
          result: { exitCode: known?.content?.observed_exit_code ?? known?.content?.exit_code ?? null },
          failures: [commandExceptionCause(error, 'transport_exception')] }) } }
        : errorResult(request?.signal?.aborted ? 'canceled' : error.code ?? 'local_command_error', { executed: false });
    }
  }
  return Object.freeze({ get definitions() { return copy(definitions); }, execute, checkPlanMode,
    commandId: operationKey => store.commandId(operationKey), reader: createLocalBackgroundReader(store) });
}

/** Native adds its real launch Run only here. The shared transport also serves
 * DSH/Codex calls with their actual Session/call identity, without a fake Run. */
export function createNativeLocalCommandTools(options = {}) {
  const transport = createLocalCommandTransport(options);
  return Object.freeze({ get definitions() { return transport.definitions; }, reader: transport.reader, checkPlanMode: transport.checkPlanMode,
    async execute(request, observations) {
      const sourceRunId = request?.runId;
      const { launchedCommand, ...result } = await transport.execute(request, observations);
      return { ...result, ...(launchedCommand ? { backgroundCommandRef: { ...launchedCommand, sourceRunId } } : {}) };
    } });
}
