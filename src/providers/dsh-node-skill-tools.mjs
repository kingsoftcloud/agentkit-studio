/** DSH Skill discovery/loading under real Session and call identities. */
import { join } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createSkillReadTransport, nativeSkillReadToolDefinitions } from '../../packages/agentkit-harness/src/native/skill-tools.mjs';
import { createNativeSkillService } from './native-skill-service.mjs';
import { createNativeSkillLoader } from './native-skill-loader.mjs';
import { nativeSkillSessionCache, nativeSkillSpaceSettings } from './native-skill-host.mjs';

export const DSH_NODE_SKILL_READ = 'agentkit.dsh-node-skill-read/v1';
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });

/** Connection/settings are Host-fixed, never selected from tool arguments.
 * Only five read tools are exposed. Workflow execution remains a separate
 * effectful backend; loading a package cannot install, bind or execute it. */
export function createDshNodeSkillTools({ agentId, workspaceRoot, stateDir, connection, skillSpaceIds = [],
  env = {}, fetchImpl, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && typeof isClosed === 'function', 'dsh_node_skill_binding_invalid');
  invariant(connection?.client && /^[a-f0-9]{64}$/u.test(connection.bindingDigest ?? ''), 'dsh_node_skill_connection_invalid');
  invariant(hostSignal === undefined || hostSignal instanceof AbortSignal, 'dsh_node_skill_host_signal_invalid');
  const settings = nativeSkillSpaceSettings({ skillSpaceIds: copy(skillSpaceIds) }, { ...env });
  const definitions = nativeSkillReadToolDefinitions(), formal = new Map(definitions.map(definition => [definition.name, definition]));
  const serviceClient = createNativeSkillService(connection.client), sessions = new Map(), lifetime = new AbortController();
  const ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const assertOpen = () => {
    invariant(!ownerSignal.aborted, 'dsh_node_skill_closed');
    const closed = isClosed();
    if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
    invariant(closed === false, closed === true ? 'dsh_node_skill_closed' : 'dsh_node_skill_is_closed_invalid');
    invariant(!ownerSignal.aborted, 'dsh_node_skill_closed');
  };
  function sessionFor(sessionId) {
    if (!sessions.has(sessionId)) {
      const cache = nativeSkillSessionCache({ stateRoot: join(stateDir, 'skills'), workspaceRoot,
        owner: { contract: DSH_NODE_SKILL_READ, agentId, sessionId } });
      const loadSkillFn = createNativeSkillLoader({ serviceClient, cacheDir: cache.cacheDir, ...(fetchImpl ? { fetchImpl } : {}) });
      sessions.set(sessionId, { ...cache, transport: createSkillReadTransport({ serviceClient, loadSkillFn,
        skillSpaceIds: settings.userSpaces, publicSpaceIds: settings.publicSpaces, publicAllowlist: settings.publicAllowlist }) });
    }
    return sessions.get(sessionId);
  }
  return { contract: DSH_NODE_SKILL_READ,
    get definitions() { return copy(definitions); },
    get binding() { return { contract: DSH_NODE_SKILL_READ, serviceBindingDigest: connection.bindingDigest,
      userSpaceIds: copy(settings.userSpaces), publicSpaceIds: copy(settings.publicSpaces) }; },
    supports: name => formal.has(name),
    close() { lifetime.abort(); sessions.clear(); },
    async execute(name, args, exec) {
      const definition = formal.get(name);
      if (!definition) return errorResult('dsh_node_skill_unbound');
      let assertCurrent, original;
      try {
        invariant(exec?.agent?.session && typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.name === name && exec.signal instanceof AbortSignal,
        'dsh_node_skill_exec_unbound');
        const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          signal: exec.signal, callId: exec.callId, body: canonical(args) };
        const signal = AbortSignal.any([original.signal, ownerSignal]);
        let session;
        const stable = () => {
          signal.throwIfAborted();
          invariant(exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === original.sessionId && exec.callId === original.callId
            && exec.name === name && exec.signal === original.signal && canonical(args) === original.body
            && canonical(exec.arguments) === original.body, 'dsh_node_skill_request_drifted');
          session?.assertStorage();
        };
        assertCurrent = () => { stable(); assertOpen(); stable(); return true; };
        assertCurrent(); session = sessionFor(original.sessionId); assertCurrent();
        const result = await session.transport.execute({ agentId, sessionId: original.sessionId,
          call: { callId: original.callId, name, arguments: copy(args) }, signal, assertCurrent });
        assertCurrent();
        invariant(result && typeof result === 'object', 'dsh_node_skill_output_invalid');
        return { status: result.ok === false ? 'error' : 'ok', content: result };
      } catch (error) {
        try { assertCurrent?.(); } catch (current) { error = current; }
        if (ownerSignal.aborted) return errorResult('dsh_node_skill_closed');
        if (original?.signal.aborted) return errorResult('dsh_node_skill_canceled');
        return errorResult(/^dsh_node_skill_|^NATIVE_SKILL_CACHE_/u.test(error?.code ?? '') ? error.code : 'dsh_node_skill_failed');
      }
    },
  };
}
