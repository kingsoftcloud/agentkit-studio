/** DSH-owned lifecycle for the neutral Studio Skill management service. */
import { join } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { skillManagementDefinitions, SKILL_MANAGEMENT_CONTRACT } from '../skill-management.mjs';
import { commandStateRoot, DshNodeCommandLedger } from './dsh-node-command-ledger.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_SKILL_MANAGEMENT = 'agentkit.dsh-skill-management/v1';
const rejected = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
function step(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}
export function createDshNodeSkillManagement({ ctx, agentId, agentRevision = 1, buildId = null,
  workspaceRoot, stateDir, management, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && Number.isSafeInteger(agentRevision) && agentRevision > 0
    && management?.contract === SKILL_MANAGEMENT_CONTRACT && management.binding.agentId === agentId
    && typeof isClosed === 'function' && (hostSignal === undefined || hostSignal instanceof AbortSignal), 'dsh_skill_management_binding_invalid');
  const state = commandStateRoot(join(stateDir, 'skill-management-calls'), workspaceRoot, agentId);
  const definitions = skillManagementDefinitions(), formal = new Map(definitions.map(d => [d.name, d]));
  const binding = { contract: DSH_SKILL_MANAGEMENT, agentId, agentRevision, buildId, management: copy(management.binding) };
  const lifetime = new AbortController(), signal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const active = new Set(), ledgers = new Map(); let closing;
  return { contract: DSH_SKILL_MANAGEMENT, binding: copy(binding), get definitions() { return copy(definitions); },
    supports: name => formal.has(name),
    close() { if (!closing) { lifetime.abort(); closing = Promise.allSettled([...active]).then(() => {}); } return closing; },
    async execute(name, args, exec) {
      let dispatched = false;
      try {
        const definition = formal.get(name); invariant(definition && exec?.name === name && exec?.signal instanceof AbortSignal
          && typeof exec?.agent?.session?.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim(), 'dsh_skill_management_unbound');
        const invalid = toolInputRejection(definition, { name, callId: exec.callId, arguments: args });
        if (invalid) return { status: 'error', content: invalid };
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, body: canonical(args) };
        const request = { agentId, agentRevision, buildId, sessionId: original.sessionId,
          operationKey: `dsh-skill-management:${original.callId}`, call: { name, callId: original.callId, arguments: copy(args) },
          definition: copy(definition), signal: AbortSignal.any([original.signal, signal, AbortSignal.timeout(definition.timeoutMs)]) };
        const guard = () => {
          request.signal.throwIfAborted(); const closed = isClosed();
          if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
          invariant(closed === false && exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === original.sessionId && exec.callId === original.callId && exec.name === name
            && exec.signal === original.signal && canonical(args) === original.body && canonical(exec.arguments) === original.body,
          'dsh_skill_management_authority_lost'); state.guard(); request.signal.throwIfAborted(); return true;
        };
        guard(); await step(() => authorizeNativeBuiltin(ctx, { ...exec, signal: request.signal }, definition), request.signal); guard();
        if (!ledgers.has(original.sessionId)) ledgers.set(original.sessionId, new DshNodeCommandLedger({ root: state.root, agentId,
          sessionId: original.sessionId, assertRoot: state.guard }));
        const pending = ledgers.get(original.sessionId).execute({ request, binding, assertCurrent: guard, dispatch: async () => {
          // The fsynced original DSH intent is already durable. Any loss during
          // publication remains unknown; never convert it to executed:false.
          dispatched = true;
          const content = await management.execute(name, copy(args), { signal: request.signal, assertCurrent: guard }); guard();
          return { status: content.ok === false ? 'error' : 'ok', content };
        } });
        active.add(pending); try { return await pending; } finally { active.delete(pending); }
      } catch (error) {
        // Publication may have succeeded even if the owner/result store failed.
        // Only failures before dispatch can truthfully say executed:false.
        return dispatched ? { status: 'uncertain', content: { ok: false, error_type: 'dsh_node_command_outcome_unknown',
          evidence_incomplete: true, task_id: null, instruction: 'Reconcile this original call; do not automatically relaunch it.' } }
          : rejected(error.code ?? 'dsh_skill_management_rejected');
      }
    },
  };
}
