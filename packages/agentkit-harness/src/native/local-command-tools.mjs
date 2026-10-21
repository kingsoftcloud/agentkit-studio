import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonical, invariant, toolInputRejection } from '../../../agentkit-harness-core/dist/index.mjs';
import { constants as osConstants } from 'node:os';
import { LocalCommandStore, createLocalBackgroundReader } from './local-background.mjs';
import { TERMINAL, delay, readRecord } from './local-command-state.mjs';
import { buildScriptEnvironment, localControlSettings, runBoundedProcess, LOCAL_PROCESS_CONTRACT } from './local-process.mjs';
import { checkGovernedCommand, LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY } from './local-command-policy.mjs';

export const LOCAL_COMMAND_TOOLS_CONTRACT = 'agentkit.local-command-tools/v1';
const schemas = { nullableSeconds: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  cursor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };
const base = (name, properties, required, mutating, timeoutMs) => ({ name,
  description: name === 'run_command' ? 'Run a governed shell command inside the bound local workspace. background=true returns an owned task_id; read_command_output observes it and stop_command requests cancellation. This shares the Host filesystem and network; it is not an isolated OS sandbox.'
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
    backgroundCommandPolicy: 'owned-command-launch/v1' },
    base('read_command_output', { task_id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, stdout_cursor: schemas.cursor,
      stderr_cursor: schemas.cursor, max_bytes: { type: 'integer', minimum: 4, maximum: 65536 },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 600 } }, ['task_id'], false, 610000),
    base('stop_command', { task_id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['task_id'], true, 10000),
  ];
}
const output = result => ({ status: result.status, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode,
  stdout_cursor: result.stdoutCursor, stderr_cursor: result.stderrCursor, cancel_requested: result.cancelRequested,
  output_may_be_truncated: result.outputMayBeTruncated, evidence_incomplete: result.evidenceIncomplete,
  observed_exit_code: result.observedExitCode, ...(result.outcomeReason ? { outcome_reason: result.outcomeReason } : {}) });
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
export function createNativeLocalCommandTools({ workspaceRoot, stateRoot, sessionId, settings = {}, sourceEnv = {},
  authorize, resolveOwnedCommand, captureWorkspace, artifacts } = {}) {
  invariant(typeof authorize === 'function' && typeof resolveOwnedCommand === 'function'
    && typeof captureWorkspace === 'function', 'local_command_host_capabilities_missing');
  const root = realpathSync(workspaceRoot), policy = localControlSettings(settings), definitions = localCommandToolDefinitions(policy);
  const environment = { ...sourceEnv }, formal = new Map(definitions.map(item => [item.name, item]));
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
    let dispatched = false, known;
    try {
      invariant(request.sessionId === sessionId, 'local_command_session_mismatch'); checkRoot(); request.signal.throwIfAborted();
      const definition = formal.get(request.call?.name); invariant(definition, 'local_command_tool_unbound');
      const rejection = toolInputRejection(definition, request.call);
      if (rejection) return { status: 'error', content: rejection };
      const args = structuredClone(request.call.arguments);
      const decision = await authorize(request); request.signal.throwIfAborted(); checkRoot();
      if (decision !== 'allow') return decision?.status === 'approval_required' && typeof decision.interactionId === 'string'
        ? decision : errorResult('policy_denied');
      if (request.call.name === 'sandbox_status') return { status: 'ok', content: { ok: true, backend: 'local_process', enabled: true,
        isolated: false, sandbox_id: `local_process:${sessionId}`, timeout_seconds: policy.wallSeconds,
        boundary: 'Shares Host filesystem, allowlisted environment and network. Not an OS security sandbox.',
        contracts: [LOCAL_COMMAND_TOOLS_CONTRACT, LOCAL_PROCESS_CONTRACT, LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY] } };
      if (request.call.name === 'read_command_output' || request.call.name === 'stop_command') {
        const owned = resolveOwnedCommand(request, args.task_id);
        invariant(owned.backend === 'local_process' && owned.ref.taskId === store.commandId(owned.ref.operationKey), 'local_command_backend_mismatch');
        const handle = store.connect(owned.ref.taskId);
        if (request.call.name === 'stop_command') {
          dispatched = true; known = { status: 'ok', content: { ok: true, task_id: args.task_id, ...output(handle.requestCancel()) } };
        } else {
          const until = performance.now() + (args.wait_seconds ?? 0) * 1000;
          let interval = 50;
          while (!TERMINAL.has(handle.readOutput().status) && performance.now() < until) {
            request.signal.throwIfAborted(); await delay(Math.min(interval, Math.max(0, until - performance.now()))); interval = Math.min(1000, interval * 2);
          }
          request.signal.throwIfAborted();
          known = { status: 'ok', content: { ok: true, task_id: args.task_id, ...output(handle.readOutput({
            stdoutCursor: args.stdout_cursor ?? 0, stderrCursor: args.stderr_cursor ?? 0, maxBytes: args.max_bytes ?? 65536 })) } };
        }
        return await budget(known, request);
      }
      const command = args.command.trim();
      if (!command) return errorResult('command_required');
      if (!args.background && args.background_timeout != null) return errorResult('background_timeout_requires_background');
      const cwd = cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
      const finding = await checkGovernedCommand(command, { cwd, allowedRoots: [root], signal: request.signal });
      if (finding) return errorResult('command_policy_blocked', { finding, exit_code: 126, executed: false });
      request.signal.throwIfAborted(); checkRoot(); cwdFor(args.cwd || args.env?.KSADK_COMMAND_CWD);
      const env = buildScriptEnvironment({ ...environment, ...args.env }, { settings: policy });
      const before = captureWorkspace(request);
      if (args.background) {
        dispatched = true;
        const handle = await store.start({ operationKey: request.operationKey, command, cwd, env, settings: policy,
          timeoutMs: deadline(args.background_timeout) });
        const observed = handle.readOutput();
        known = { status: 'ok', content: { ok: true, backend: 'sandbox/local_process', sandbox_id: `local_process:${sessionId}`,
          task_id: handle.commandId, ...output(observed), process_timeout_seconds: readRecord(handle.directory, store.owner, handle.commandId).timeoutMs / 1000,
          instruction: 'Use read_command_output with task_id; stop_command cancels this task only. Do not relaunch unknown outcomes.' },
        backgroundCommandRef: { taskId: handle.commandId, sourceRunId: request.runId, operationKey: request.operationKey } };
      } else {
        dispatched = true;
        const result = await runBoundedProcess({ argv: ['/bin/sh', '-c', command], cwd, env, settings: policy, signal: request.signal,
          timeoutMs: deadline(args.timeout) });
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
          observed_exit_code: incomplete ? result.exitCode : null, evidence_incomplete: incomplete, controls: result.controls } };
      }
      const after = captureWorkspace(request); known.workspaceChangedPaths = changed(before, after);
      return await budget(known, request);
    } catch (error) {
      // After dispatch, an exception cannot prove that a command did not run.
      // Keep any known result, including its exit code and background locator.
      return dispatched ? { ...known, status: 'uncertain', content: { ...known?.content, ok: false,
        error_type: 'command_evidence_incomplete', evidence_incomplete: true, observed_result: known?.content?.status ?? null } }
        : errorResult(request.signal?.aborted ? 'canceled' : error.code ?? 'local_command_error', { executed: false });
    }
  }
  return Object.freeze({ definitions, execute, reader: createLocalBackgroundReader(store) });
}
