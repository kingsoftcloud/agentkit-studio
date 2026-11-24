/** Host-private local Skill execution under the original caller's authority.
 * Native and DSH have distinct owner contracts; a separate fsynced record precedes staging/process dispatch, and
 * the existing process supervisor retains the original command locator. */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '../contracts/native-values.mjs';
import { parseNativeJson } from '../contracts/native-json.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicPrivate, privateDirectory, openPrivate, tryLock } from '../host/private-state.mjs';
import { LocalCommandStore } from './studio-local-command/local-background.mjs';
import { buildScriptEnvironment, localControlSettings } from './studio-local-command/local-process.mjs';
import { readSkillWorkflowArtifact, createNativeSkillWorkflowExecutor } from './native-skill-workflow.mjs';
import { checkGovernedCommand } from './studio-local-command/local-command-policy.mjs';
import { isTerminalCommandStatus, SKILL_EVENT_FILE } from '../contracts/native-dsh.mjs';
import { createNativeSkillEventJournal, nativeSkillEventEvidence, SKILL_EVENT_BYTES } from './studio-skill-event-journal.mjs';
import { NATIVE_SKILL_RUNTIME, publishArtifacts, stagePackages } from './studio-skill-runtime-files.mjs';

const RECORD_LIMIT = 16 * 1024 ** 2, REQUEST_LIMIT = 2 * 1024 ** 2;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const inside = (path, root) => path === root || path.startsWith(root + sep);
const requestBody = request => Object.fromEntries(Object.keys(request).filter(key => !['signal', 'assertCurrent'].includes(key))
  .map(key => [key, copy(request[key])]));
const unknown = (runtimeId, taskId, error = 'skill_runtime_outcome_unknown') => ({ ok: false, status: 'uncertain', uncertain: true,
  runtime_id: runtimeId, task_id: taskId, error_type: error, exit_code: null,
  instruction: 'Inspect and reconcile this original runtime; do not launch it again.' });

function readJson(path, max = RECORD_LIMIT) {
  const fd = openPrivate(path, constants.O_RDONLY);
  try { invariant(fstatSync(fd).size <= max, 'SKILL_RUNTIME_RECORD_TOO_LARGE'); return parseNativeJson(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
function saveRecord(path, record) {
  const serialized = canonical(record);
  invariant(Buffer.byteLength(serialized) <= RECORD_LIMIT, 'SKILL_RUNTIME_RECORD_TOO_LARGE');
  atomicPrivate(path, serialized);
}
export function createNativeLocalSkillRuntime(options = {}) {
  scopeKey(options.scope); const scope = copy(options.scope), sessionId = options.sessionId;
  return createLocalSkillRuntime({ ...options, owner: { contract: NATIVE_SKILL_RUNTIME, prefix: 'local-skill', fields: { scope },
    check: request => invariant(canonical(request.scope) === canonical(scope) && request.sessionId === sessionId, 'SKILL_RUNTIME_OWNER_MISMATCH'),
    key: request => ({ scope, sessionId, runId: request.runId, operationKey: request.operationKey }) } });
}

export const DSH_LOCAL_SKILL_RUNTIME = 'agentkit.dsh-local-skill-runtime/v1';
/** DSH supplies its real Agent/Session/call. There is no Native Run or fence. */
export function createDshLocalSkillRuntime(options = {}) {
  const { agentId, sessionId } = options;
  invariant(typeof agentId === 'string' && agentId.trim() && typeof sessionId === 'string' && sessionId.trim(), 'SKILL_RUNTIME_OWNER_MISMATCH');
  return createLocalSkillRuntime({ ...options, owner: { contract: DSH_LOCAL_SKILL_RUNTIME, prefix: 'dsh-local-skill', fields: { agentId },
    check: request => invariant(request.agentId === agentId && request.sessionId === sessionId
      && typeof request.callId === 'string' && request.callId.trim() && request.callId === request.call?.callId
      && typeof request.operationKey === 'string' && request.operationKey.trim()
      && ['scope', 'runId', 'turnId', 'buildId', 'executionFence', 'parentRunId', 'taskChainId'].every(key => request[key] === undefined),
    'SKILL_RUNTIME_OWNER_MISMATCH'),
    key: request => ({ agentId, sessionId, callId: request.callId, operationKey: request.operationKey }) } });
}

function createLocalSkillRuntime({ stateRoot, workspaceRoot, owner, sessionId, bindingDigest,
  settings, env = {}, loadPackages, assertStorage = () => true } = {}) {
  invariant(settings?.backend === 'local_process' && settings.enabled && typeof loadPackages === 'function', 'SKILL_RUNTIME_BINDING_INVALID');
  const workspace = realpathSync(workspaceRoot), root = resolve(stateRoot);
  invariant(!inside(root, workspace) && !inside(workspace, root), 'SKILL_RUNTIME_STATE_OVERLAP'); privateDirectory(root, true);
  const pinnedRoot = lstatSync(root), pinnedWorkspace = lstatSync(workspace), fixedSettings = copy(settings);
  const controls = localControlSettings({ wallSeconds: settings.timeoutSeconds, maxOutputBytes: 2 * 1024 ** 2 });
  const environment = buildScriptEnvironment({ ...env }, { settings: controls });
  const processes = new LocalCommandStore({ stateRoot: join(root, 'processes'), workspaceRoot: workspace, sessionId });
  const storage = () => {
    assertStorage(); privateDirectory(root); const current = lstatSync(root);
    const currentWorkspace = lstatSync(workspaceRoot);
    invariant(current.dev === pinnedRoot.dev && current.ino === pinnedRoot.ino && realpathSync(workspaceRoot) === workspace
      && currentWorkspace.dev === pinnedWorkspace.dev && currentWorkspace.ino === pinnedWorkspace.ino, 'SKILL_RUNTIME_ROOT_CHANGED');
  };
  const binding = { ...copy(owner.fields), sessionId, bindingDigest, settings: fixedSettings, environmentDigest: hash(environment), nodeExecutable: process.execPath };
  function locate(request) {
    owner.check(request);
    const id = hash(owner.key(request));
    return { runtime_id: `${owner.prefix}:${id}`, task_id: processes.commandId(`skill-runtime:${id}`) };
  }
  async function execute(request) {
    const signal = request.signal, authority = request.assertCurrent, original = canonical(requestBody(request));
    invariant(Buffer.byteLength(original) <= REQUEST_LIMIT, 'SKILL_RUNTIME_REQUEST_TOO_LARGE');
    invariant(signal instanceof AbortSignal && typeof authority === 'function', 'SKILL_RUNTIME_AUTHORITY_REQUIRED');
    function guard() {
      storage(); signal.throwIfAborted();
      invariant(request.signal === signal && request.assertCurrent === authority && canonical(requestBody(request)) === original, 'SKILL_RUNTIME_REQUEST_CHANGED');
      owner.check(request);
      invariant(typeof request.operationKey === 'string'
        && request.call?.name === 'execute_skills' && request.callId === request.call.callId, 'SKILL_RUNTIME_OWNER_MISMATCH');
      const verdict = authority(); if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
      invariant(verdict === true, 'SKILL_RUNTIME_AUTHORITY_LOST');
      invariant(request.signal === signal && request.assertCurrent === authority && canonical(requestBody(request)) === original, 'SKILL_RUNTIME_REQUEST_CHANGED'); signal.throwIfAborted(); return true;
    }
    guard();
    const id = hash(owner.key(request));
    const runtimeId = `${owner.prefix}:${id}`, operationKey = `skill-runtime:${id}`, taskId = processes.commandId(operationKey);
    const directory = join(root, id); privateDirectory(directory, true); guard();
    const recordPath = join(directory, 'record.json');
    const matches = previous => invariant(previous.contract === owner.contract && canonical(previous.binding) === canonical(binding)
      && canonical(previous.request) === original && previous.runtimeId === runtimeId && previous.taskId === taskId, 'SKILL_RUNTIME_IDENTITY_CONFLICT');
    const release = tryLock(join(directory, 'owner.sqlite'));
    if (!release) {
      guard(); const previous = readJson(recordPath); matches(previous); guard();
      return previous.phase === 'finished' ? copy(previous.result) : { ...unknown(runtimeId, taskId, 'skill_runtime_in_progress'),
        ...nativeSkillEventEvidence(previous.skillEvents),
        command_ids: previous.commands.map(command => command.taskId) };
    }
    let intent, events, dispatched = false;
    try {
      guard();
      if (existsSync(recordPath)) {
        const previous = readJson(recordPath);
        matches(previous);
        return previous.phase === 'finished' ? copy(previous.result) : { ...unknown(runtimeId, taskId),
          ...nativeSkillEventEvidence(previous.skillEvents),
          command_ids: previous.commands.map(command => command.taskId) };
      }
      intent = { contract: owner.contract, binding, request: requestBody(request), runtimeId, taskId,
        phase: 'executing', commands: [], skillEvents: [], createdAt: Date.now() };
      guard(); saveRecord(recordPath, intent); dispatched = true;
      events = createNativeSkillEventJournal({ runtimeId, request, bindingDigest, events: intent.skillEvents,
        persist: () => { storage(); saveRecord(recordPath, intent); } });
      events.emit('skill.workflow.started', 'running', { attributes: { backend: 'local_process' } });
      const loaded = await loadPackages(request, events); guard();
      const packages = stagePackages(loaded, join(directory, 'packages'), guard), workDir = join(directory, 'work');
      privateDirectory(workDir, true); guard();
      intent.packages = packages.map(pkg => Object.fromEntries(Object.entries({ name: pkg.name, skillId: pkg.skillId,
        versionId: pkg.versionId, spaceId: pkg.spaceId, archiveHash: pkg.archiveHash,
        manifestHash: hash(pkg.body), files: pkg.stagedManifest }).filter(([, value]) => value !== undefined)));
      saveRecord(recordPath, intent); guard();
      const started = performance.now();
      let processCreated = false;
      const workflow = await createNativeSkillWorkflowExecutor({ workDir, projectName: fixedSettings.projectName, events,
        async runCommand({ argv, cwd, env: commandEnv, timeoutSeconds, assertCurrent }) {
          const check = () => { guard(); invariant(assertCurrent() === true, 'SKILL_RUNTIME_WORKFLOW_CHANGED'); return true; };
          check();
          const command = argv.map(quote).join(' ');
          const finding = await checkGovernedCommand(command, { cwd, allowedRoots: [workDir, ...packages.map(pkg => pkg.rootDir)], signal });
          check();
          if (finding) return { exit_code: 126, stdout: '', stderr: finding.rule };
          const timeoutMs = Math.min(timeoutSeconds * 1000, fixedSettings.timeoutSeconds * 1000 - (performance.now() - started));
          invariant(timeoutMs >= 1, 'SKILL_RUNTIME_DEADLINE');
          const commandKey = intent.commands.length ? `${operationKey}:${intent.commands.length}` : operationKey;
          const commandId = processes.commandId(commandKey);
          intent.commands.push({ operationKey: commandKey, taskId: commandId, argv: copy(argv), cwd });
          check(); saveRecord(recordPath, intent); check();
          const handle = await processes.start({ operationKey: commandKey, command, cwd,
            env: buildScriptEnvironment(environment, { settings: controls, required: commandEnv }),
            settings: controls, timeoutMs: Math.floor(timeoutMs), assertCurrent: check });
          check();
          if (!processCreated) { events.emit('sandbox.session.created', 'completed', {
            attributes: { backend: 'local_process', scope: 'process_group' } }); processCreated = true; }
          const cancel = () => { try { handle.requestCancel(); } catch { /* original locator retained */ } };
          signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
          let observed;
          try {
            const until = performance.now() + timeoutMs + 15000;
            while (!isTerminalCommandStatus((observed = handle.readOutput()).status)) { check(); invariant(performance.now() < until, 'SKILL_RUNTIME_DEADLINE'); await delay(20); }
            check(); observed = await handle.wait({ timeoutMs: 100 }); check();
          } catch (error) { cancel(); throw error; }
          finally { signal.removeEventListener('abort', cancel); }
          invariant(!observed.evidenceIncomplete && !observed.outputMayBeTruncated && Number.isSafeInteger(observed.exitCode), 'SKILL_RUNTIME_OUTPUT_INCOMPLETE');
          const sidecar = join(workDir, SKILL_EVENT_FILE);
          if (existsSync(sidecar)) {
            try { const data = readSkillWorkflowArtifact(sidecar, workDir, SKILL_EVENT_BYTES);
              if (data.truncated) events.reject('event_budget_exceeded');
              else events.accept(new TextDecoder('utf-8', { fatal: true }).decode(data.bytes));
            } catch { check(); events.reject(); }
          }
          check();
          return { exit_code: observed.exitCode, stdout: observed.stdout, stderr: observed.stderr, timed_out: observed.status === 'timed_out' };
        } }).execute({ workflowPrompt: request.workflowPrompt, skillNames: request.skillNames, packages, signal, assertCurrent: guard });
      guard();
      if (processCreated) events.emit('sandbox.session.cleaned_up', 'completed', {
        attributes: { backend: 'local_process', cleanup_scope: 'process_group' } });
      let result = publishArtifacts(workflow, workDir, workspace, runtimeId, guard);
      events.artifacts(result, packages);
      // executed refers to completion of this Node workflow evaluator. Script
      // effects are reported separately in commands; instruction-only results
      // deliberately have no invented command or process receipt.
      result = { ...result, workflow_status: workflow.status, exit_code: 0, executed: true,
        ok: workflow.status !== 'failed', ...(workflow.status === 'failed' ? { error_type: workflow.error_type ?? 'skill_workflow_failed' } : {}) };
      guard(); result = { ...result, runtime_id: runtimeId, task_id: taskId, backend: 'local_process', isolated: false,
        command_ids: intent.commands.map(command => command.taskId),
        sandbox: { creation_status: intent.commands.length ? 'completed' : 'not_required',
          instance_status: intent.commands.length ? 'created' : 'not_created',
          cleanup_status: intent.commands.length ? 'completed' : 'not_required' } };
      events.emit(workflow.status === 'failed' ? 'skill.workflow.failed' : 'skill.workflow.completed',
        workflow.status === 'failed' ? 'failed' : 'completed');
      result = { ...result, ...nativeSkillEventEvidence(intent.skillEvents) };
      storage(); saveRecord(recordPath, { ...intent, phase: 'finished', result, completedAt: Date.now() }); return result;
    } catch (error) {
      if (!dispatched) throw error;
      events?.failOpen(); events?.emit('skill.workflow.failed', 'uncertain', { errorCategory: 'outcome_unknown' });
      const result = { ...unknown(runtimeId, taskId, error.code ?? 'skill_runtime_outcome_unknown'),
        ...nativeSkillEventEvidence(intent.skillEvents),
        command_ids: intent.commands.map(command => command.taskId) };
      storage(); saveRecord(recordPath, { ...intent, phase: 'finished', result, completedAt: Date.now() }); return result;
    } finally { release(); }
  }
  return { contract: owner.contract, execute, locate };
}
