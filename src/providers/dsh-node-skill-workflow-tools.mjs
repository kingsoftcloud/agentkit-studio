/** Durable local Skill workflows admitted by the real DSH ToolRegistry. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeSkillWorkflowToolDefinitions, normalizeSkillNames } from '../../packages/agentkit-harness/src/native/skill-tools.mjs';
import { createDshLocalSkillRuntime, nativeSkillRuntimeSettings } from './native-skill-runtime.mjs';
import { nativeSkillSessionCache, nativeSkillSpaceSettings, loadSkillRuntimePackages } from './native-skill-host.mjs';
import { createStudioNativeSkillSource } from './native-skill-source.mjs';
import { createNativeSkillService } from './native-skill-service.mjs';
import { createNativeSkillLoader } from './native-skill-loader.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_SKILL_WORKFLOW = 'agentkit.dsh-node-skill-workflow/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
function abortable(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(fail('dsh_skill_workflow_canceled')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createDshNodeSkillWorkflowTools({ ctx, agentId, agentRevision = 1, buildId = null, workspaceRoot, stateDir,
  connection, skillSpaceIds = [], skillDefinitions = [], env = {}, fetchImpl, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(ctx && typeof agentId === 'string' && agentId.trim() && typeof isClosed === 'function', 'dsh_skill_workflow_binding_invalid');
  invariant(hostSignal === undefined || hostSignal instanceof AbortSignal, 'dsh_skill_workflow_host_signal_invalid');
  invariant(Number.isSafeInteger(agentRevision) && agentRevision >= 1
    && (buildId === null || typeof buildId === 'string' && buildId.trim()), 'dsh_skill_workflow_revision_invalid');
  const environment = { ...env }, settings = nativeSkillRuntimeSettings(environment);
  invariant(settings.backend === 'local_process' && settings.enabled, 'dsh_skill_workflow_backend_unmounted');
  const { userSpaces, publicSpaces, publicAllowlist } = nativeSkillSpaceSettings({ skillSpaceIds }, environment);
  invariant(!userSpaces.length && !publicSpaces.length || connection?.client && /^[a-f0-9]{64}$/u.test(connection.bindingDigest ?? ''),
    'dsh_skill_workflow_connection_missing');
  const localDefinitions = copy(skillDefinitions).filter(item => item.invocation?.modelInvocable !== false);
  const localSource = localDefinitions.length ? createStudioNativeSkillSource({ definitions: localDefinitions }) : null;
  const binding = { contract: DSH_NODE_SKILL_WORKFLOW, agentId, agentRevision, buildId, runtime: settings,
    userSpaceIds: userSpaces, publicSpaceIds: publicSpaces, publicAllowlist,
    localSourceBinding: localSource?.binding ?? null, serviceBindingDigest: connection?.bindingDigest ?? null };
  const bindingDigest = hash(binding), [definition] = nativeSkillWorkflowToolDefinitions();
  const service = connection?.client ? createNativeSkillService(connection.client) : null;
  const lifetime = new AbortController(), ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const sessions = new Map();
  const assertOpen = () => {
    invariant(!ownerSignal.aborted, 'dsh_skill_workflow_closed');
    const closed = isClosed();
    if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
    invariant(closed === false, closed === true ? 'dsh_skill_workflow_closed' : 'dsh_skill_workflow_lifetime_invalid');
    invariant(!ownerSignal.aborted, 'dsh_skill_workflow_closed');
  };
  function sessionFor(sessionId) {
    if (!sessions.has(sessionId)) {
      const cache = nativeSkillSessionCache({ stateRoot: join(stateDir, 'skill-workflows'), workspaceRoot,
        owner: { contract: DSH_NODE_SKILL_WORKFLOW, agentId, sessionId } });
      const load = service ? createNativeSkillLoader({ serviceClient: service, cacheDir: cache.cacheDir,
        ...(fetchImpl ? { fetchImpl } : {}) }) : undefined;
      const runtime = createDshLocalSkillRuntime({ stateRoot: join(cache.cacheDir, 'runtime'), workspaceRoot,
        agentId, sessionId, bindingDigest, settings, env: environment, assertStorage: cache.assertStorage,
        loadPackages: request => loadSkillRuntimePackages({ request, localSource, localDefinitions,
          userSpaces, publicSpaces, publicAllowlist, service, load, assertStorage: cache.assertStorage }) });
      sessions.set(sessionId, { ...cache, runtime });
    }
    return sessions.get(sessionId);
  }
  return { contract: DSH_NODE_SKILL_WORKFLOW,
    get binding() { return { ...copy(binding), bindingDigest }; },
    get definitions() { return [copy(definition)]; },
    supports: name => name === definition.name,
    close() { lifetime.abort(); sessions.clear(); },
    async execute(name, args, exec) {
      if (name !== definition.name) return errorResult('dsh_skill_workflow_unbound');
      let dispatched = false, locator, assertCurrent, request;
      try {
        invariant(exec?.agent?.session && typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.name === name && exec.signal instanceof AbortSignal,
        'dsh_skill_workflow_exec_unbound');
        const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        invariant(args.workflow_prompt.trim(), 'dsh_skill_workflow_prompt_required');
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          signal: exec.signal, callId: exec.callId, body: canonical(args) };
        const signal = AbortSignal.any([original.signal, ownerSignal, AbortSignal.timeout(settings.timeoutSeconds * 1000)]);
        let session;
        const stable = () => {
          signal.throwIfAborted();
          invariant(exec.agent === original.agent && exec.agent.session === original.session && exec.agent.session.id === original.sessionId
            && exec.callId === original.callId && exec.name === name && exec.signal === original.signal
            && canonical(args) === original.body && canonical(exec.arguments) === original.body, 'dsh_skill_workflow_request_drifted');
          session?.assertStorage();
        };
        assertCurrent = () => { stable(); assertOpen(); stable(); return true; };
        assertCurrent();
        await abortable(authorizeNativeBuiltin(ctx, exec, definition), signal); assertCurrent();
        session = sessionFor(original.sessionId); assertCurrent();
        request = { agentId, sessionId: original.sessionId, callId: original.callId,
          operationKey: `dsh-skill-workflow:${original.callId}`, call: { callId: original.callId, name, arguments: copy(args) },
          workflowPrompt: args.workflow_prompt.trim(), skillNames: normalizeSkillNames(args.skill_names),
          skillSpaceIds: [...userSpaces, ...publicSpaces], env: {}, timeout: settings.timeoutSeconds,
          lockedDefinition: copy(definition), ...(args.approval === undefined ? {} : { approval: copy(args.approval) }), signal, assertCurrent };
        locator = session.runtime.locate(request); assertCurrent(); dispatched = true;
        const result = await abortable(session.runtime.execute(request), signal);
        assertCurrent();
        invariant(result && typeof result === 'object' && result.runtime_id === locator.runtime_id && result.task_id === locator.task_id,
          'dsh_skill_workflow_result_invalid');
        return { status: result.status === 'uncertain' || result.uncertain ? 'uncertain' : result.ok ? 'ok' : 'error', content: result };
      } catch (error) {
        if (dispatched) return { status: 'uncertain', content: { ok: false, status: 'uncertain', uncertain: true, ...locator,
          error_type: 'dsh_skill_workflow_outcome_unknown', instruction: 'Reconcile the original workflow; do not automatically execute it again.' } };
        try { assertCurrent?.(); } catch (current) { error = current; }
        return errorResult(error?.code ?? 'dsh_skill_workflow_failed');
      }
    },
  };
}
