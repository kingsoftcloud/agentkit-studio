import { publicFailureContent } from '../../diagnostic-text.mjs';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, copy, invariant } from '../../contracts/native-values.mjs';
import { toolInputRejection } from '../../contracts/tool-input.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalCommandStore } from './local-background.mjs';
import { TERMINAL, confirmedCommandStartFailure, readRecord } from './local-command-state.mjs';
import { buildScriptEnvironment, localControlSettings, LOCAL_PROCESS_CONTRACT } from './local-process.mjs';
import { checkGovernedCommand, LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY } from './local-command-policy.mjs';
import { commandFailureEvidence, commandExceptionCause } from './local-command-evidence.mjs';
import { captureCommandWorkspace, commandWorkspaceChange } from './command-workspace-observation.mjs';
import { LOCAL_COMMAND_SHELL } from './command-shell.mjs';

export const LOCAL_COMMAND_TOOLS_CONTRACT = 'agentkit.local-command-tools/v1';
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
function utf8Preview(text, maxBytes) {
  return new TextDecoder('utf8', { ignoreBOM: true }).decode(Buffer.from(text).subarray(0, maxBytes), { stream: true });
}

// The DSH adapter authorizes each call and verifies its original claim across awaits.
export function createLocalCommandTransport({ workspaceRoot, stateRoot, sessionId, settings, sourceEnv,
  resolveOwnedCommand, captureWorkspace, artifacts, assertAuthority }) {
  const root = realpathSync(workspaceRoot), policy = localControlSettings(settings), definitions = localCommandToolDefinitions(policy);
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
  async function budget(result, request) {
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
  async function execute(request) {
    let dispatched = false, known, original, sealed;
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
      let command, cwd;
      if (request.call.name === 'run_command') {
        command = args.command.trim();
        if (!command) return errorResult('command_required');
        if (!args.background && args.background_timeout != null) return errorResult('background_timeout_requires_background');
        cwd = cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
        const finding = await checkGovernedCommand(command, { cwd, allowedRoots: [root], signal: request.signal });
        guard();
        if (finding) return errorResult('command_policy_blocked', { finding, exit_code: 126, executed: false, retryable: false });
      }
      guard();
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
      request.signal.throwIfAborted(); checkRoot(); cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
      const env = buildScriptEnvironment({ ...environment, ...args.env }, { settings: policy });
      const before = await captureCommandWorkspace(captureWorkspace, request);
      guard();
      dispatched = true;
      const operationKey = request.operationKey, expectedTaskId = store.commandId(operationKey);
      known = { content: { backend: 'sandbox/local_process', task_id: expectedTaskId } };
      const handle = await store.start({ operationKey, command, cwd, env, settings: policy, shellPolicy: LOCAL_COMMAND_SHELL,
        timeoutMs: deadline(args.background ? args.background_timeout : args.timeout), assertCurrent: guard });
      if (!args.background) {
        const cancel = () => { try { handle.requestCancel(); } catch { /* retain unknown */ } };
        original.addEventListener('abort', cancel, { once: true });
        if (original.aborted) cancel();
        try {
          const until = performance.now() + deadline(args.timeout) + 15000;
          while (performance.now() < until) {
            guard();
            if (TERMINAL.has(handle.readOutput().status)) break;
            await delay(20);
          }
        } catch (error) { cancel(); throw error;
        } finally { original.removeEventListener('abort', cancel); }
      }
      let observed = handle.readOutput();
      if (confirmedCommandStartFailure(observed))
        return errorResult('command_not_started', { executed: false, outcome_reason: observed.outcomeReason });
      if (!args.background && TERMINAL.has(observed.status) && observed.status !== 'unknown')
        observed = await handle.wait({ timeoutMs: 100 });
      const uncertain = observed.status === 'unknown' || observed.evidenceIncomplete
        || !args.background && !TERMINAL.has(observed.status);
      known = { status: uncertain ? 'uncertain' : 'ok', content: { ok: !uncertain, backend: 'sandbox/local_process', sandbox_id: `local_process:${sessionId}`,
        task_id: handle.commandId, ...output(observed), process_timeout_seconds: readRecord(handle.directory, store.owner, handle.commandId).timeoutMs / 1000,
        ...(!args.background ? { command, controls: readRecord(handle.directory, store.owner, handle.commandId).controls ?? null } : {}),
        instruction: 'Use read_command_output with task_id; stop_command cancels this task only. Do not relaunch unknown outcomes.' },
      };
      guard();
      const after = await captureCommandWorkspace(captureWorkspace, request);
      Object.assign(known, commandWorkspaceChange(before, after));
      known.content.workspace_observation = known.workspaceChangeObservation;
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
  return {
    commandId: operationKey => store.commandId(operationKey),
    async execute(request) {
      const result = await execute(request);
      return result.status === 'ok' ? result : publicFailureContent(result);
    },
  };
}
