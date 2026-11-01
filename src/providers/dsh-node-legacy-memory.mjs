import { canonical, copy, invariant, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { commandStateRoot } from './dsh-node-command-ledger.mjs';
import { getDshInvocationContext } from './dsh-invocation-context.mjs';
import { LEGACY_MEMORY_TOOLS } from '../legacy-memory-tools.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_LEGACY_MEMORY = 'agentkit.dsh-node-legacy-memory/v1';
function abortable(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}
export function createDshNodeLegacyMemory({ ctx, agentId, agentRevision, buildId = '', workspaceRoot, stateDir, memory,
  isClosed = () => false, signal: hostSignal }) {
  invariant(memory?.contract === LEGACY_MEMORY_TOOLS && memory.binding?.agentId === agentId
    && Number.isSafeInteger(agentRevision) && agentRevision > 0 && typeof buildId === 'string', 'dsh_memory_binding_invalid');
  const state = commandStateRoot(stateDir, workspaceRoot, agentId), formal = new Map(memory.definitions.map(tool => [tool.name, tool])),
    binding = { contract: DSH_NODE_LEGACY_MEMORY, agentId, agentRevision, buildId, memory: memory.binding },
    lifetime = new AbortController(), active = new Set(); let closing;
  return { contract: DSH_NODE_LEGACY_MEMORY, binding: copy(binding), get definitions() { return copy([...formal.values()]); },
    supports: name => formal.has(name),
    close() { if (!closing) { lifetime.abort(); closing = memory.close().then(() => Promise.allSettled([...active])).then(() => {}); } return closing; },
    async execute(name, args, exec) {
      const pending = (async () => {
        const definition = formal.get(name), trusted = getDshInvocationContext(exec?.agent);
        invariant(definition && exec?.name === name && exec?.signal instanceof AbortSignal && typeof exec.callId === 'string'
          && exec.callId.trim() && trusted && trusted.session === exec.agent.session && trusted.sessionId === exec.agent.session.id,
        'dsh_memory_invocation_unbound');
        const invalid = toolInputRejection(definition, { name, callId: exec.callId, arguments: args });
        if (invalid) return { status: 'error', content: invalid };
        const original = { agent: exec.agent, session: exec.agent.session, signal: exec.signal, callId: exec.callId, arguments: canonical(args) },
          signal = AbortSignal.any([original.signal, lifetime.signal, ...(hostSignal ? [hostSignal] : []), AbortSignal.timeout(definition.timeoutMs)]),
          context = { agentId, userId: trusted.userId, sessionId: trusted.sessionId, runnerType: trusted.runnerType },
          owner = { kind: 'dsh', identity: { agentId, sessionId: trusted.sessionId, callId: original.callId },
            request: { agentId, agentRevision, buildId, sessionId: trusted.sessionId, call: { name, callId: original.callId, arguments: copy(args) },
              definition: copy(definition), binding: copy(binding) } };
        const guard = () => {
          signal.throwIfAborted(); const closed = isClosed();
          if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
          invariant(closed === false && exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === trusted.sessionId && exec.signal === original.signal && exec.name === name
            && exec.callId === original.callId && canonical(args) === original.arguments && canonical(exec.arguments) === original.arguments
            && getDshInvocationContext(exec.agent) === trusted, 'dsh_memory_authority_lost');
          state.guard(); signal.throwIfAborted(); return true;
        };
        guard(); await abortable(() => authorizeNativeBuiltin(ctx, { ...exec, signal }, definition), signal); guard();
        return memory.execute(name, copy(args), { context, owner, signal, assertCurrent: guard });
      })();
      active.add(pending); try { return await pending; } finally { active.delete(pending); }
    },
  };
}
