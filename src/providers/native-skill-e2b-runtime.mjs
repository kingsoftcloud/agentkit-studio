/** One independently owned E2B sandbox per original Native Skill invocation.
 * Workflow selection remains in Node. Every remote command has its own durable
 * supervisor and is admitted again by the original Native authority. Unfinished
 * calls retain their locators and NEVER create/upload/execute again on reopen. */
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, opendirSync,
  readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { canonical, copy, invariant, parseNativeJson, scopeKey } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, delay, openPrivate, privateDirectory, syncDirectory, TERMINAL, tryLock } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { E2BCommandStore } from '../../packages/agentkit-harness/src/native/e2b-background.mjs';
import { stagePackages, publishArtifacts, NATIVE_SKILL_RUNTIME } from './native-skill-runtime.mjs';
import { createNativeSkillWorkflowExecutor, readSkillWorkflowArtifact } from './native-skill-workflow.mjs';
import { createNativeSkillE2BFiles, NATIVE_SKILL_E2B_FILES } from './native-skill-e2b-files.mjs';

export const NATIVE_SKILL_E2B_RUNTIME = 'agentkit.native-skill-e2b-runtime/v1';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const inside = (path, root) => path === root || path.startsWith(root + sep);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const body = request => Object.fromEntries(Object.keys(request).filter(key => !['signal', 'assertCurrent'].includes(key))
  .map(key => [key, copy(request[key])]));
const RECORD_LIMIT = 16 * 1024 ** 2;
function save(path, value) {
  const text = canonical(value); invariant(Buffer.byteLength(text) <= RECORD_LIMIT, 'SKILL_RUNTIME_RECORD_TOO_LARGE'); atomicPrivate(path, text);
}
function read(path) {
  const fd = openPrivate(path, constants.O_RDONLY);
  try { invariant(fstatSync(fd).size <= RECORD_LIMIT, 'SKILL_RUNTIME_RECORD_TOO_LARGE'); return parseNativeJson(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

export function createNativeE2BSkillRuntime({ stateRoot, workspaceRoot, scope, sessionId, bindingDigest,
  settings, prepared, loadPackages, assertStorage = () => true, inProcessTransport = false,
  createFiles = createNativeSkillE2BFiles } = {}) {
  scopeKey(scope);
  invariant(settings?.backend === 'e2b' && settings.enabled && prepared?.binding?.backend === 'e2b'
    && typeof prepared.forSession === 'function' && typeof loadPackages === 'function', 'SKILL_RUNTIME_BINDING_INVALID');
  invariant(typeof sessionId === 'string' && sessionId.trim() && /^[a-f0-9]{64}$/u.test(bindingDigest ?? '')
    && Number.isSafeInteger(settings.timeoutSeconds) && settings.timeoutSeconds >= 1 && settings.timeoutSeconds <= 900,
  'SKILL_RUNTIME_BINDING_INVALID');
  const workspace = realpathSync(workspaceRoot), root = resolve(stateRoot);
  invariant(!inside(root, workspace) && !inside(workspace, root), 'SKILL_RUNTIME_STATE_OVERLAP'); privateDirectory(root, true);
  const pinnedRoot = lstatSync(root), pinnedWorkspace = lstatSync(workspace), fixedScope = copy(scope), fixedSettings = copy(settings);
  const binding = { scope: fixedScope, sessionId, bindingDigest, settings: fixedSettings, e2b: copy(prepared.binding),
    backendContract: NATIVE_SKILL_E2B_RUNTIME, fileContract: NATIVE_SKILL_E2B_FILES };
  const ownerId = hash([workspace, 'e2b', sessionId]);
  const storage = () => {
    invariant(assertStorage() !== false, 'SKILL_RUNTIME_STORAGE_CHANGED'); privateDirectory(root);
    const current = lstatSync(root), currentWorkspace = lstatSync(workspaceRoot);
    invariant(current.dev === pinnedRoot.dev && current.ino === pinnedRoot.ino && realpathSync(workspaceRoot) === workspace
      && currentWorkspace.dev === pinnedWorkspace.dev && currentWorkspace.ino === pinnedWorkspace.ino, 'SKILL_RUNTIME_ROOT_CHANGED');
  };
  function locate(request) {
    invariant(canonical(request.scope) === canonical(fixedScope) && request.sessionId === sessionId, 'SKILL_RUNTIME_OWNER_MISMATCH');
    const id = hash({ scope: fixedScope, sessionId, runId: request.runId, operationKey: request.operationKey });
    return { runtime_id: `e2b-skill:${id}`, task_id: hash([ownerId, `skill-runtime:${id}`]) };
  }
  async function execute(request) {
    const originalSignal = request.signal, authority = request.assertCurrent, original = canonical(body(request));
    invariant(Buffer.byteLength(original) <= 2 * 1024 ** 2, 'SKILL_RUNTIME_REQUEST_TOO_LARGE');
    invariant(originalSignal instanceof AbortSignal && typeof authority === 'function', 'SKILL_RUNTIME_AUTHORITY_REQUIRED');
    const { runtime_id: runtimeId, task_id: taskId } = locate(request);
    const id = runtimeId.slice('e2b-skill:'.length), operationKey = `skill-runtime:${id}`;
    const deadline = new AbortController(), signal = AbortSignal.any([originalSignal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(Object.assign(new Error('Skill runtime deadline exceeded'), { code: 'SKILL_RUNTIME_DEADLINE' })),
      fixedSettings.timeoutSeconds * 1000); timer.unref?.();
    const unchanged = () => invariant(request.signal === originalSignal && request.assertCurrent === authority && canonical(body(request)) === original,
      'SKILL_RUNTIME_REQUEST_CHANGED');
    function guard() {
      storage(); signal.throwIfAborted(); unchanged();
      invariant(canonical(request.scope) === canonical(fixedScope) && request.sessionId === sessionId && typeof request.operationKey === 'string'
        && request.call?.name === 'execute_skills' && request.callId === request.call.callId, 'SKILL_RUNTIME_OWNER_MISMATCH');
      const verdict = authority(); if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
      invariant(verdict === true, 'SKILL_RUNTIME_AUTHORITY_LOST'); unchanged(); signal.throwIfAborted(); return true;
    }
    // A noncooperative SDK callback cannot hold cancellation indefinitely. Its
    // late settlement remains observed; the lifecycle owner retains late IDs.
    async function boundary(effect) {
      guard(); let abort;
      const canceled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      try {
        signal.throwIfAborted();
        const value = await Promise.race([Promise.resolve().then(() => { guard(); return effect(); }), canceled]); guard(); return value;
      } finally { signal.removeEventListener('abort', abort); }
    }
    let release, intent, recordPath, host, remoteId, ownerRequest, dispatched = false, cleanupAttempted = false;
    const unknown = error => ({ ok: false, status: 'uncertain', uncertain: true, runtime_id: runtimeId, task_id: taskId,
      backend: 'e2b', isolated: true, error_type: error, exit_code: null,
      ...(remoteId ? { remote_runtime_id: remoteId, sandbox_id: remoteId } : {}),
      command_ids: (intent?.commands ?? []).map(command => command.taskId),
      instruction: 'Inspect and reconcile this original runtime and sandbox; do not launch it again.' });
    try {
      guard(); const directory = join(root, id); privateDirectory(directory, true); guard(); recordPath = join(directory, 'record.json');
      const matches = previous => invariant(previous.contract === NATIVE_SKILL_RUNTIME && canonical(previous.binding) === canonical(binding)
        && canonical(previous.request) === original && previous.runtimeId === runtimeId && previous.taskId === taskId, 'SKILL_RUNTIME_IDENTITY_CONFLICT');
      release = tryLock(join(directory, 'owner.sqlite'));
      if (!release || existsSync(recordPath)) {
        const previous = read(recordPath); matches(previous); guard(); intent = previous; remoteId = previous.sandboxId;
        return previous.phase === 'finished' ? copy(previous.result) : unknown(release ? 'skill_runtime_outcome_unknown' : 'skill_runtime_in_progress');
      }
      intent = { contract: NATIVE_SKILL_RUNTIME, binding, request: body(request), runtimeId, taskId,
        phase: 'executing', commands: [], sandboxId: null, createdAt: Date.now() };
      guard(); save(recordPath, intent); dispatched = true;
      const packageRequest = { ...body(request), signal };
      const packageGuard = () => {
        guard(); invariant(packageRequest.signal === signal && packageRequest.assertCurrent === packageGuard
          && canonical(body(packageRequest)) === original, 'SKILL_RUNTIME_PACKAGE_REQUEST_CHANGED'); return true;
      };
      packageRequest.assertCurrent = packageGuard;
      const loaded = await boundary(() => loadPackages(packageRequest)); packageGuard();
      const packages = stagePackages(loaded, join(directory, 'packages'), guard), workDir = join(directory, 'work');
      privateDirectory(workDir, true); guard();
      intent.packages = packages.map(pkg => Object.fromEntries(Object.entries({ name: pkg.name, skillId: pkg.skillId,
        versionId: pkg.versionId, spaceId: pkg.spaceId, archiveHash: pkg.archiveHash, manifestHash: hash(pkg.body), files: pkg.stagedManifest })
        .filter(([, value]) => value !== undefined)));
      save(recordPath, intent);
      // The owner is per INVOCATION, rather than the shared interactive command
      // sandbox. No executable content or credentials enter the owner identity.
      host = await boundary(() => prepared.forSession({ scope: fixedScope, sessionId, workspaceRoot: workspace,
        stateRoot: join(directory, 'sandbox'), assertAuthority: guard }));
      ownerRequest = Object.freeze({ ...freeze(body(request)), definition: freeze(copy(request.lockedDefinition)), signal });
      const created = await boundary(() => host.owner.ensure(ownerRequest)); remoteId = created.sandboxId;
      intent.sandboxId = remoteId; save(recordPath, intent); guard();
      const processes = new E2BCommandStore({ stateRoot: join(directory, 'processes'), workspaceRoot: workspace, sessionId,
        sandboxId: remoteId, authority: guard,
        ...(inProcessTransport ? { transport: await boundary(() => host.createTransport()) }
          : { transportModule: new URL('./native-e2b-sdk-transport.mjs', import.meta.url).href, transportConfig: host.transportOptions() }) });
      invariant(processes.commandId(operationKey) === taskId, 'SKILL_RUNTIME_COMMAND_IDENTITY_CHANGED');
      const started = performance.now();
      async function runRemote(command, cwd, env, check = guard, timeoutSeconds = 300) {
        check(); invariant(Buffer.byteLength(command) <= 512 * 1024, 'SKILL_RUNTIME_COMMAND_TOO_LARGE');
        const remaining = Math.min(timeoutSeconds, fixedSettings.timeoutSeconds - (performance.now() - started) / 1000);
        invariant(remaining > 0, 'SKILL_RUNTIME_DEADLINE');
        const commandKey = intent.commands.length ? `${operationKey}:${intent.commands.length}` : operationKey;
        const commandId = processes.commandId(commandKey);
        intent.commands.push({ operationKey: commandKey, taskId: commandId, command, cwd }); check(); save(recordPath, intent); check();
        const handle = await boundary(() => processes.start({ operationKey: commandKey, command, cwd, env,
          timeoutSeconds: Math.max(1, Math.ceil(remaining)), assertCurrent: check }));
        const cancel = () => { try { handle.requestCancel(); } catch { /* original command ID remains in the intent */ } };
        signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
        let observed;
        try {
          while (!TERMINAL.has((observed = handle.readOutput()).status)) { check(); await delay(20); }
          check(); invariant(!observed.evidenceIncomplete && observed.status !== 'unknown', 'SKILL_RUNTIME_OUTPUT_INCOMPLETE');
          const output = await boundary(() => handle.wait({ timeoutMs: 100 })); check();
          invariant(Number.isSafeInteger(output.exitCode), 'SKILL_RUNTIME_OUTPUT_INCOMPLETE');
          return { exit_code: output.exitCode, stdout: output.stdout, stderr: output.stderr, timed_out: observed.status === 'timed_out' };
        } catch (error) { cancel(); throw error; }
        finally { signal.removeEventListener('abort', cancel); }
      }
      const remoteRoot = `/tmp/agentkit-skill-${id}`, remoteWork = `${remoteRoot}/work`;
      const mapPath = path => {
        for (const [from, to] of [[workDir, remoteWork], ...packages.map((pkg, i) => [pkg.rootDir, `${remoteRoot}/packages/${i}`])]) {
          if (inside(path, from)) return to + path.slice(from.length).split(sep).join('/');
        }
        invariant(false, 'SKILL_RUNTIME_REMOTE_PATH_INVALID');
      };
      const directories = new Set([remoteWork, `${remoteWork}/artifacts`, `${remoteRoot}/packages`]);
      for (const pkg of packages) {
        const walk = path => { guard(); directories.add(mapPath(path)); const dir = opendirSync(path);
          try { for (;;) { const item = dir.readSync(); if (!item) break; if (item.isDirectory()) walk(join(path, item.name)); } }
          finally { dir.closeSync(); } };
        walk(pkg.rootDir);
      }
      const preparation = `umask 077; mkdir -m 700 -- ${quote(remoteRoot)} && mkdir -p -- ${[...directories].map(quote).join(' ')}`;
      invariant((await runRemote(preparation, '/tmp', {})).exit_code === 0, 'SKILL_RUNTIME_REMOTE_PREPARATION_FAILED');
      const sandbox = await boundary(() => host.createFileSession(remoteId, { ...body(request), signal, assertCurrent: guard }));
      const files = await boundary(() => createFiles({ sandbox, remoteRoot }));
      const fileRequest = fields => ({ ...body(request), ...fields, signal, assertCurrent: guard });
      const executable = [];
      for (const pkg of packages) for (const item of pkg.stagedManifest) {
        guard(); const path = join(pkg.rootDir, item.path), data = readSkillWorkflowArtifact(path, pkg.rootDir, 20 * 1024 ** 2);
        invariant(!data.truncated && hash(data.bytes) === item.sha256, 'SKILL_RUNTIME_PACKAGE_CHANGED');
        const remote = mapPath(path);
        await boundary(() => files.upload(fileRequest({ files: [{ path: remote, base64: data.bytes.toString('base64'), sha256: item.sha256 }] })));
        if (item.executable) executable.push(remote);
      }
      // Every operand is an absolute path under the exclusive private root, so
      // it cannot become an option. This form also works with BSD chmod.
      if (executable.length) invariant((await runRemote(`chmod 700 ${executable.map(quote).join(' ')}`, remoteWork, {})).exit_code === 0,
        'SKILL_RUNTIME_REMOTE_MODE_FAILED');
      let downloadedBytes = 0, downloadedCount = 0, enumerated = 0;
      const mirrored = new Map();
      const remoteLocal = path => {
        invariant(typeof path === 'string' && posix.normalize(path) === path && path.startsWith(remoteWork + '/')
          && !path.includes('\\') && !path.includes('\0'), 'SKILL_RUNTIME_REMOTE_ARTIFACT_PATH');
        return join(workDir, ...path.slice(remoteWork.length + 1).split('/'));
      };
      async function mirrorFile(path) {
        const target = remoteLocal(path); guard();
        const item = await boundary(() => files.read(fileRequest({ path, maxBytes: mirrored.has(path) ? 20 * 1024 ** 2
          : Math.min(20 * 1024 ** 2, 50 * 1024 ** 2 - downloadedBytes) })));
        invariant(Buffer.isBuffer(item.bytes) && item.size === item.bytes.length && hash(item.bytes) === item.sha256 && !item.truncated,
          'SKILL_RUNTIME_REMOTE_ARTIFACT_INVALID');
        if (mirrored.has(path)) { invariant(mirrored.get(path) === item.sha256, 'SKILL_RUNTIME_REMOTE_ARTIFACT_CHANGED'); return; }
        invariant(++downloadedCount <= 500 && (downloadedBytes += item.size) <= 50 * 1024 ** 2, 'SKILL_RUNTIME_ARTIFACT_SIZE');
        guard(); privateDirectory(dirname(target), true); const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, item.bytes); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(dirname(target)); guard(); mirrored.set(path, item.sha256);
      }
      async function mirrorDirectory(path, depth = 0) {
        invariant(depth <= 10, 'SKILL_RUNTIME_ARTIFACT_DEPTH');
        const listing = await boundary(() => files.list(fileRequest({ path })));
        invariant(Array.isArray(listing.entries), 'SKILL_RUNTIME_REMOTE_LIST_INVALID');
        for (const item of listing.entries) {
          invariant(++enumerated <= 4000, 'SKILL_RUNTIME_ARTIFACT_COUNT'); remoteLocal(item.path);
          if (item.type === 'dir') await mirrorDirectory(item.path, depth + 1);
          else { invariant(item.type === 'file', 'SKILL_RUNTIME_REMOTE_ARTIFACT_INVALID'); await mirrorFile(item.path); }
        }
      }
      const workflow = await createNativeSkillWorkflowExecutor({ workDir, projectName: fixedSettings.projectName,
        async runCommand({ argv, cwd, env, timeoutSeconds, assertCurrent }) {
          const check = () => { guard(); invariant(assertCurrent() === true, 'SKILL_RUNTIME_WORKFLOW_CHANGED'); return true; };
          const remoteArgs = argv.map(value => value.startsWith('/') ? mapPath(value) : value);
          const remoteEnvironment = { KSADK_SKILL_SPACE_IDS: (request.skillSpaceIds ?? []).join(','),
            SKILL_SPACE_ID: request.skillSpaceIds?.[0] ?? '', KSADK_SELECTED_SKILL_NAMES: (request.skillNames ?? []).join(','),
            ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key,
            ['KSADK_SKILL_WORKDIR', 'KSADK_SKILL_OUTPUT_DIR', 'KSADK_SKILL_ROOT_DIR'].includes(key) ? mapPath(value) : value])) };
          const output = await runRemote(remoteArgs.map(quote).join(' '), mapPath(cwd), remoteEnvironment, check, timeoutSeconds); check();
          const generic = argv[1].endsWith('/scripts/run-workflow.sh');
          if (generic) await mirrorDirectory(`${remoteWork}/artifacts`); check();
          // The reference web workflow exports bundle.html, never node_modules.
          const listing = await boundary(() => files.list(fileRequest({ path: remoteWork })));
          const project = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(fixedSettings.projectName) ? fixedSettings.projectName : 'ksadk-artifact';
          if (listing.entries.some(item => item.type === 'dir' && item.name === project)) {
            check(); privateDirectory(join(workDir, project), true);
            const contents = await boundary(() => files.list(fileRequest({ path: `${remoteWork}/${project}` })));
            if (argv[1].endsWith('/scripts/bundle-artifact.sh') && contents.entries.some(item => item.type === 'file' && item.name === 'bundle.html')) {
              await mirrorFile(`${remoteWork}/${project}/bundle.html`);
            }
          }
          const translated = [];
          for (const line of String(output.stdout).split('\n')) {
            if (!generic || !line.startsWith('artifact=')) { translated.push(line); continue; }
            const value = line.slice(9).trim(), path = posix.isAbsolute(value) ? value : posix.join(remoteWork, value);
            invariant(value && !value.split('/').includes('..'), 'SKILL_RUNTIME_REMOTE_ARTIFACT_PATH');
            await mirrorFile(path); translated.push(`artifact=${remoteLocal(path)}`);
          }
          check(); return { ...output, stdout: translated.join('\n') };
        } }).execute({ workflowPrompt: request.workflowPrompt, skillNames: request.skillNames, packages, signal, assertCurrent: guard });
      guard(); const published = publishArtifacts(workflow, workDir, workspace, runtimeId, guard);
      intent.workflow = published; save(recordPath, intent); guard();
      cleanupAttempted = true;
      const closed = await boundary(() => host.owner.close(ownerRequest));
      invariant(closed.confirmed === true, 'SKILL_RUNTIME_CLEANUP_UNKNOWN'); guard();
      const result = { ...published, ...(published.commands ? { commands: published.commands.map(command => ({ ...command, cwd: mapPath(command.cwd) })) } : {}),
        workflow_status: workflow.status, exit_code: 0, executed: true, ok: workflow.status !== 'failed',
        ...(workflow.status === 'failed' ? { error_type: workflow.error_type ?? 'skill_workflow_failed' } : {}),
        runtime_id: runtimeId, task_id: taskId, remote_runtime_id: remoteId, sandbox_id: remoteId, backend: 'e2b', isolated: true,
        command_ids: intent.commands.map(command => command.taskId),
        sandbox: { creation_status: 'completed', instance_status: 'created', cleanup_status: 'completed' } };
      save(recordPath, { ...intent, phase: 'finished', result, completedAt: Date.now() }); return result;
    } catch (error) {
      if (!dispatched) throw error;
      let cleanup = 'not_confirmed';
      try {
        remoteId ??= host?.owner.inspect()?.sandboxId;
        // Best-effort cleanup is still an authorized, durably recorded effect.
        // Cancellation/authority loss leaves the original sandbox for explicit
        // reconciliation; it never grants a fresh cleanup capability.
        guard();
        if (!cleanupAttempted && remoteId && ownerRequest && host.owner.inspect()?.phase === 'ready') {
          cleanupAttempted = true;
          cleanup = (await boundary(() => host.owner.close(ownerRequest))).confirmed === true ? 'completed' : 'not_confirmed';
        }
      } catch { /* durable lifecycle record retains the original uncertain effect */ }
      const result = unknown(error.code ?? 'skill_runtime_outcome_unknown');
      result.sandbox = { creation_status: remoteId ? 'completed' : 'unknown', instance_status: remoteId ? 'created' : 'unknown', cleanup_status: cleanup };
      storage(); save(recordPath, { ...intent, sandboxId: remoteId ?? null, phase: 'finished', result, completedAt: Date.now() }); return result;
    } finally { clearTimeout(timer); release?.(); }
  }
  return Object.freeze({ contract: NATIVE_SKILL_E2B_RUNTIME, execute, locate });
}
