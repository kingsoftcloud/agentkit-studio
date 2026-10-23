/** Host-private local Skill execution under the original caller's authority.
 * Native and DSH have distinct owner contracts; a separate fsynced record precedes staging/process dispatch, and
 * the existing process supervisor retains the original command locator. */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, privateDirectory, openPrivate, tryLock, syncDirectory, TERMINAL, delay } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { LocalCommandStore } from '../../packages/agentkit-harness/src/native/local-background.mjs';
import { buildScriptEnvironment, localControlSettings } from '../../packages/agentkit-harness/src/native/local-process.mjs';
import { readSkillWorkflowArtifact, NATIVE_SKILL_WORKFLOW, createNativeSkillWorkflowExecutor } from './native-skill-workflow.mjs';
import { checkGovernedCommand } from '../../packages/agentkit-harness/src/native/local-command-policy.mjs';

export const NATIVE_SKILL_RUNTIME = 'agentkit.native-skill-runtime/v1';
const RECORD_LIMIT = 16 * 1024 ** 2, REQUEST_LIMIT = 2 * 1024 ** 2;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const inside = (path, root) => path === root || path.startsWith(root + sep);
const requestBody = request => Object.fromEntries(Object.keys(request).filter(key => !['signal', 'assertCurrent'].includes(key))
  .map(key => [key, copy(request[key])]));
const unknown = (runtimeId, taskId, error = 'skill_runtime_outcome_unknown') => ({ ok: false, status: 'uncertain', uncertain: true,
  runtime_id: runtimeId, task_id: taskId, error_type: error, exit_code: null,
  instruction: 'Inspect and reconcile this original runtime; do not launch it again.' });

export function nativeSkillRuntimeSettings(env = {}) {
  const value = env.KSADK_SKILL_RUNTIME_BACKEND ?? env.KSADK_SANDBOX_BACKEND
    ?? (env.KSADK_SANDBOX_TEMPLATE_ID || env.KSADK_SKILL_RUNTIME_TEMPLATE_ID ? 'e2b' : 'disabled');
  invariant(typeof value === 'string', 'SKILL_RUNTIME_BACKEND_INVALID');
  const backend = value.trim().toLowerCase();
  invariant(['', 'disabled', 'none', 'off', 'local_process', 'e2b'].includes(backend), 'SKILL_RUNTIME_BACKEND_INVALID');
  const timeout = env.KSADK_SKILL_RUNTIME_TIMEOUT ?? '900';
  invariant(typeof timeout === 'string' && /^\d+$/u.test(timeout) && Number.isSafeInteger(Number(timeout))
    && Number(timeout) >= 1 && Number(timeout) <= 900, 'SKILL_RUNTIME_TIMEOUT_INVALID');
  invariant(env.KSADK_SKILL_PROJECT_NAME === undefined || typeof env.KSADK_SKILL_PROJECT_NAME === 'string', 'SKILL_RUNTIME_PROJECT_INVALID');
  invariant(env.KSADK_SKILL_ARTIFACT_PROJECT === undefined || typeof env.KSADK_SKILL_ARTIFACT_PROJECT === 'string', 'SKILL_RUNTIME_PROJECT_INVALID');
  return Object.freeze({ contract: NATIVE_SKILL_RUNTIME, workflowContract: NATIVE_SKILL_WORKFLOW,
    backend: backend === 'local_process' ? backend : backend === 'e2b' ? 'e2b' : 'disabled',
    enabled: ['local_process', 'e2b'].includes(backend), isolated: backend === 'e2b', timeoutSeconds: Number(timeout),
    projectName: env.KSADK_SKILL_PROJECT_NAME || env.KSADK_SKILL_ARTIFACT_PROJECT || 'ksadk-artifact',
    environmentBindingDigest: hash(buildScriptEnvironment(env)) });
}
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
// Trusted Host helpers shared by local and remote runtimes. Neither is a model
// tool; both require the original runtime's synchronous authority guard.
export function stagePackages(packages, root, guard) {
  invariant(Array.isArray(packages) && packages.length <= 100, 'SKILL_RUNTIME_PACKAGES_INVALID');
  let count = 0, total = 0;
  return packages.map((pkg, index) => {
    invariant(pkg && typeof pkg.name === 'string' && pkg.name && typeof pkg.body === 'string' && typeof pkg.rootDir === 'string', 'SKILL_RUNTIME_PACKAGE_INVALID');
    guard(); privateDirectory(root, true);
    const source = resolve(pkg.rootDir), destination = join(root, String(index)); privateDirectory(destination, true);
    const manifest = [];
    function walk(from, to, depth) {
      invariant(depth <= 32, 'SKILL_RUNTIME_PACKAGE_DEPTH'); guard();
      // readSkillWorkflowArtifact checks every ancestor for each file. Empty
      // directories also reject links before enumeration.
      for (let part = from;; part = dirname(part)) {
        const stat = lstatSync(part); invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'SKILL_RUNTIME_PACKAGE_SYMLINK');
        if (part === dirname(part)) break;
      }
      const dir = opendirSync(from);
      try {
        for (;;) {
          const entry = dir.readSync(); if (!entry) break;
          invariant(++count <= 4000 && !entry.isSymbolicLink(), 'SKILL_RUNTIME_PACKAGE_ENTRIES'); guard();
          const input = join(from, entry.name), output = join(to, entry.name);
          if (entry.isDirectory()) { privateDirectory(output, true); walk(input, output, depth + 1); }
          else {
            invariant(entry.isFile(), 'SKILL_RUNTIME_PACKAGE_FILE_INVALID');
            const item = readSkillWorkflowArtifact(input, source, 50 * 1024 ** 2 - total);
            invariant(!item.truncated, 'SKILL_RUNTIME_PACKAGE_SIZE'); total += item.size;
            const executable = lstatSync(input).mode & 0o111;
            guard(); const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, executable ? 0o700 : 0o600);
            try { writeFileSync(fd, item.bytes); fsyncSync(fd); } finally { closeSync(fd); }
            manifest.push({ path: relative(source, input), sha256: hash(item.bytes), executable: Boolean(executable) });
          }
        }
      } finally { dir.closeSync(); }
      syncDirectory(to);
    }
    walk(source, destination, 0); guard();
    return { ...copy(pkg), rootDir: destination, stagedManifest: manifest };
  });
}
export function publishArtifacts(result, workDir, workspace, runtimeId, guard) {
  const paths = [...new Set([...(result.artifacts ?? []), ...(result.output_files ?? [])])];
  invariant(paths.length <= 500, 'SKILL_RUNTIME_ARTIFACT_COUNT');
  if (!paths.length) return { ...result, artifacts: [], output_files: [], artifact_metadata: [] };
  const target = join(workspace, '.agentkit', 'skill-results', hash(runtimeId));
  function ensure(path) {
    if (path === workspace) return;
    invariant(inside(path, workspace), 'SKILL_RUNTIME_ARTIFACT_PATH'); ensure(dirname(path)); guard();
    if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
    invariant(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'SKILL_RUNTIME_ARTIFACT_PATH');
  }
  ensure(target); let total = 0;
  const mapping = new Map(), metadata = [];
  for (let i = 0; i < paths.length; i++) {
    guard(); const item = readSkillWorkflowArtifact(paths[i], workDir, 50 * 1024 ** 2 - total);
    invariant(!item.truncated, 'SKILL_RUNTIME_ARTIFACT_SIZE'); total += item.size;
    const filename = `${i}-${basename(item.path)}`, output = join(target, filename); ensure(target); guard();
    const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, item.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(target); guard(); mapping.set(paths[i], output);
    metadata.push({ path: output, sha256: hash(item.bytes), size_bytes: item.size, source_path: relative(workDir, item.path) });
  }
  return { ...result, artifacts: paths.map(path => mapping.get(path)),
    output_files: (result.output_files ?? []).map(path => mapping.get(path)), artifact_metadata: metadata };
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
        command_ids: previous.commands.map(command => command.taskId) };
    }
    let intent, dispatched = false;
    try {
      guard();
      if (existsSync(recordPath)) {
        const previous = readJson(recordPath);
        matches(previous);
        return previous.phase === 'finished' ? copy(previous.result) : { ...unknown(runtimeId, taskId),
          command_ids: previous.commands.map(command => command.taskId) };
      }
      intent = { contract: owner.contract, binding, request: requestBody(request), runtimeId, taskId,
        phase: 'executing', commands: [], createdAt: Date.now() };
      guard(); saveRecord(recordPath, intent); dispatched = true;
      const loaded = await loadPackages(request); guard();
      const packages = stagePackages(loaded, join(directory, 'packages'), guard), workDir = join(directory, 'work');
      privateDirectory(workDir, true); guard();
      intent.packages = packages.map(pkg => Object.fromEntries(Object.entries({ name: pkg.name, skillId: pkg.skillId,
        versionId: pkg.versionId, spaceId: pkg.spaceId, archiveHash: pkg.archiveHash,
        manifestHash: hash(pkg.body), files: pkg.stagedManifest }).filter(([, value]) => value !== undefined)));
      saveRecord(recordPath, intent); guard();
      const started = performance.now();
      const workflow = await createNativeSkillWorkflowExecutor({ workDir, projectName: fixedSettings.projectName,
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
          const cancel = () => { try { handle.requestCancel(); } catch { /* original locator retained */ } };
          signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
          let observed;
          try {
            const until = performance.now() + timeoutMs + 15000;
            while (!TERMINAL.has((observed = handle.readOutput()).status)) { check(); invariant(performance.now() < until, 'SKILL_RUNTIME_DEADLINE'); await delay(20); }
            check(); observed = await handle.wait({ timeoutMs: 100 }); check();
          } catch (error) { cancel(); throw error; }
          finally { signal.removeEventListener('abort', cancel); }
          invariant(!observed.evidenceIncomplete && !observed.outputMayBeTruncated && Number.isSafeInteger(observed.exitCode), 'SKILL_RUNTIME_OUTPUT_INCOMPLETE');
          return { exit_code: observed.exitCode, stdout: observed.stdout, stderr: observed.stderr, timed_out: observed.status === 'timed_out' };
        } }).execute({ workflowPrompt: request.workflowPrompt, skillNames: request.skillNames, packages, signal, assertCurrent: guard });
      guard();
      let result = publishArtifacts(workflow, workDir, workspace, runtimeId, guard);
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
      storage(); saveRecord(recordPath, { ...intent, phase: 'finished', result, completedAt: Date.now() }); return result;
    } catch (error) {
      if (!dispatched) throw error;
      const result = { ...unknown(runtimeId, taskId, error.code ?? 'skill_runtime_outcome_unknown'),
        command_ids: intent.commands.map(command => command.taskId) };
      storage(); saveRecord(recordPath, { ...intent, phase: 'finished', result, completedAt: Date.now() }); return result;
    } finally { release(); }
  }
  return { contract: owner.contract, execute, locate };
}
