/** Trusted runtime options, bound to the actual registry Agent and Session.
 * Tool arguments cannot select a user. A changed principal invalidates any
 * pending call which captured the previous context object.
 */
import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
const contexts = new WeakMap();
export function bindDshInvocationContext(agent, { userId, runnerType }) {
  invariant(agent && typeof agent === 'object' && agent.session && typeof agent.session.id === 'string'
    && agent.session.id.trim() && typeof userId === 'string' && userId.trim()
    && ['dsh-native', 'codex'].includes(runnerType), 'dsh_invocation_context_invalid');
  const old = contexts.get(agent);
  if (old?.session === agent.session && old.sessionId === agent.session.id && old.userId === userId && old.runnerType === runnerType) return old;
  const context = Object.freeze({ session: agent.session, sessionId: agent.session.id, userId, runnerType });
  contexts.set(agent, context); return context;
}
export function getDshInvocationContext(agent) { return contexts.get(agent); }
