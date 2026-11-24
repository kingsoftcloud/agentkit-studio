/** Read-only component facts under the real DSH Session/ToolRegistry identity. */
import { toolInputRejection } from '../contracts/tool-input.mjs';
import { canonical, copy, invariant } from '../contracts/native-values.mjs';
import { readDshComponentBindings } from './dsh-component-bindings.mjs';

export const DSH_NODE_COMPONENT_TOOLS = 'agentkit.dsh-node-component-tools/v1';
const definition = {
  name: 'component_status',
  description: 'Report the AgentEngine built-in toolset and runtime binding status '
    + '(model, knowledge base, long-term memory, skill space, skill runtime, sandbox, workspace). '
    + 'Read-only: returns the Host-fixed admission snapshot; does not discover bindings, read '
    + 'environment variables, or expose credentials.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 30000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
};
const defaults = {
  summary: { model: '', knowledge_base_bound: false, long_term_memory_bound: false, skill_space_bound: false,
    isolated_execution: 'not_enabled', sandbox_direct_tools: 'not_enabled' },
  skill_space: { space_ids: [], user_space_ids: [], public_space_ids: [], service_url: '', aicp_endpoint_mode: 'auto', tools: [] },
  skill_runtime: { backend: 'disabled', enabled: false, template_bound: false, request_protocol: '--request-file JSON envelope' },
  sandbox: { backend: 'disabled', enabled: false, template_bound: false, tools: [] },
  workspace: { root: '', tools: [], boundary: 'Workspace tools are confined to the AgentEngine UI workspace directory.',
    editing_model: 'write tools support whole-file writes; edit_workspace_file supports exact snippet '
      + 'replacement; lint_workspace_file provides lightweight built-in checks.' },
};

function allowedFields(value, fields, prefix) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'component_status_field_invalid');
  for (const key of Object.keys(value)) invariant(Object.hasOwn(fields, key), `component_status_unknown_field:${prefix}${key}`);
}

const validText = value => typeof value === 'string' && value.length <= 8192;

function statusField(value, fallback) {
  if (typeof fallback === 'boolean') {
    invariant(value === undefined || typeof value === 'boolean', 'component_status_field_invalid');
    return value ?? fallback;
  }
  if (value == null) return fallback;
  if (Array.isArray(fallback)) {
    invariant(Array.isArray(value) && value.length <= 4096 && [...value].every(validText), 'component_status_field_invalid');
    return value;
  }
  if (fallback === 'not_enabled') {
    if (typeof value === 'boolean') return value ? 'enabled' : fallback;
    invariant(value === 'enabled' || value === fallback, 'component_status_field_invalid');
    return value;
  }
  invariant(validText(value), 'component_status_field_invalid');
  return value || fallback;
}

function componentStatusSnapshot(status) {
  allowedFields(status, defaults, '');
  const result = { ok: true };
  for (const [name, fields] of Object.entries(defaults)) {
    const values = status[name] ?? {};
    allowedFields(values, fields, `${name}.`);
    result[name] = Object.fromEntries(Object.entries(fields).map(([key, fallback]) => [key, statusField(values[key], fallback)]));
  }
  invariant(Buffer.byteLength(canonical(result)) <= 64 * 1024, 'component_status_oversized');
  return copy(result);
}

/** Status is derived from the bindings and tool owners for this workspace. */
export function createBoundDshComponentTools(options, { requested, ports = [], workspace, commands, code, skills, workflows,
  commandBackend, workflowProtocol } = {}) {
  const { knowledgeBaseBound, longTermMemoryBound, skillSpaceIds } = readDshComponentBindings(options.componentBindings);
  const names = ports.flatMap(port => port.definitions.map(tool => tool.name)).filter(name => !requested || requested.has(name));
  const skillBinding = skills?.binding ?? workflows?.binding;
  const workflowBinding = workflows?.binding.runtime;
  const spaces = [...new Set([...skillSpaceIds, ...(skillBinding?.userSpaceIds ?? []), ...(skillBinding?.publicSpaceIds ?? [])])].sort();
  const commandNames = names.filter(name => commands?.supports(name) || code?.binding?.backend === 'e2b' && code.supports(name));
  return createDshNodeComponentTools({ ...options, status: {
    summary: { knowledge_base_bound: knowledgeBaseBound, long_term_memory_bound: longTermMemoryBound,
      skill_space_bound: spaces.length > 0,
      isolated_execution: Boolean(workflowBinding?.isolated || commandNames.length && commandBackend === 'e2b'),
      sandbox_direct_tools: commandNames.length > 0 },
    skill_space: { space_ids: spaces, user_space_ids: skillBinding?.userSpaceIds ?? [], public_space_ids: skillBinding?.publicSpaceIds ?? [],
      tools: names.filter(name => skills?.supports(name) || workflows?.supports(name)) },
    skill_runtime: { backend: workflowBinding?.backend ?? 'disabled', enabled: Boolean(workflows), template_bound: Boolean(workflowBinding?.host?.template),
      ...(workflows ? { request_protocol: workflowProtocol } : {}) },
    sandbox: { backend: commandNames.length ? commandBackend : 'disabled', enabled: commandNames.length > 0,
      template_bound: Boolean(commandNames.length && (commands?.binding?.host?.template || code?.binding?.host?.template)), tools: commandNames },
    workspace: { root: options.workspaceRoot, tools: names.filter(name => workspace?.supports(name)) },
  } });
}

const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
// A request header is the model that actually produced this tool call. The
// Agent options are only the fallback before the first recorded request.
const modelFor = agent => agent.session.requestHeader?.()?.config?.model ?? agent.options?.model ?? '';

/** The status snapshot describes this preset's mounted Node ports. The current
 * DSH Agent supplies its selected model. No Native Run/lease or probe is used. */
export function createDshNodeComponentTools({ agentId, status, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && typeof isClosed === 'function', 'dsh_node_component_binding_invalid');
  invariant(hostSignal === undefined || hostSignal instanceof AbortSignal, 'dsh_node_component_host_signal_invalid');
  const snapshot = componentStatusSnapshot(status);
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
