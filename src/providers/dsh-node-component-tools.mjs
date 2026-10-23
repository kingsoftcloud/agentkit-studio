/** Read-only component facts under the real DSH Session/ToolRegistry identity. */
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { componentStatusSnapshot, nativeComponentToolDefinitions } from '../../packages/agentkit-harness/src/native/component-tools.mjs';

export const DSH_NODE_COMPONENT_TOOLS = 'agentkit.dsh-node-component-tools/v1';
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
// A request header is the model that actually produced this tool call. The
// Agent options are only the fallback before the first recorded request.
const modelFor = agent => agent.session.requestHeader?.()?.config?.model ?? agent.options?.model ?? '';

/** The status snapshot describes this preset's mounted Node ports. The current
 * DSH Agent supplies its selected model. No Native Run/lease or probe is used. */
export function createDshNodeComponentTools({ agentId, status, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && typeof isClosed === 'function', 'dsh_node_component_binding_invalid');
  invariant(hostSignal === undefined || hostSignal instanceof AbortSignal, 'dsh_node_component_host_signal_invalid');
  const snapshot = componentStatusSnapshot(status), [definition] = nativeComponentToolDefinitions();
  const lifetime = new AbortController(), ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  return { contract: DSH_NODE_COMPONENT_TOOLS,
    get definitions() { return [copy(definition)]; },
    supports: name => name === definition.name,
    close() { lifetime.abort(); },
    async execute(name, args, exec) {
      if (name !== definition.name) return errorResult('dsh_node_component_unbound');
      try {
        const rejection = toolInputRejection(definition, { callId: exec?.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        invariant(exec?.agent?.session && typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.name === name
          && exec.signal instanceof AbortSignal, 'dsh_node_component_exec_unbound');
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, options: exec.agent.options, model: modelFor(exec.agent) };
        const body = canonical(args);
        const guard = () => {
          invariant(!ownerSignal.aborted, 'dsh_node_component_closed');
          invariant(!original.signal.aborted, 'dsh_node_component_canceled');
          invariant(exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === original.sessionId && exec.callId === original.callId
            && exec.name === name && exec.signal === original.signal && exec.agent.options === original.options
            && modelFor(exec.agent) === original.model
            && canonical(args) === body && canonical(exec.arguments) === body, 'dsh_node_component_request_drifted');
        };
        guard();
        const closed = isClosed();
        if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
        invariant(closed === false, closed === true ? 'dsh_node_component_closed' : 'dsh_node_component_is_closed_invalid');
        guard(); // A synchronous lifetime hook may replace the caller identity.
        const result = componentStatusSnapshot({ ...snapshotInput(snapshot), summary: { ...snapshot.summary, model: original.model } });
        guard();
        return { status: 'ok', content: copy(result) };
      } catch (error) { return errorResult(error?.message?.startsWith('dsh_node_component_')
        ? error.message : 'dsh_node_component_invalid'); }
    },
  };
}

function snapshotInput({ ok: _, ...status }) { return status; }
