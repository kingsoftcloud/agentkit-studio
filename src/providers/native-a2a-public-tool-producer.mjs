/** Explicit trusted disclosure policy; never loaded from a request or model. */
import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { a2aIdentity } from './native-a2a-events.mjs';
import { A2A_TOOL_ACTIVITY_URI, a2aActivityJson, buildA2aPublicToolActivity } from './native-a2a-tool-activity.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const check = condition => invariant(condition, 'A2A_PUBLIC_TOOL_POLICY_INVALID');
const name = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value);
export function compileA2aPublicToolPolicy(raw = { tools: {} }) {
  check(object(raw) && Object.keys(raw).length === 1 && object(raw.tools) && Object.keys(raw.tools).length <= 100);
  const policy = copy(raw);
  for (const [privateName, rule] of Object.entries(policy.tools)) {
    check(name(privateName) && object(rule) && name(rule.name)
      && Object.keys(rule).every(key => ['name', 'arguments', 'results'].includes(key)));
    for (const field of ['arguments', 'results']) {
      rule[field] ??= [];
      check(Array.isArray(rule[field]) && rule[field].length <= 100 && new Set(rule[field]).size === rule[field].length
        && rule[field].every(key => typeof key === 'string' && key.length > 0 && key.length <= 256));
    }
  }
  return policy;
}

/** Mutates only the caller's uncommitted Task shadow; publication is atomic with its fact cursor. */
export function projectA2aPublicTools(record, fact, updates, policy) {
  const event = fact.payload;
  if (fact.family !== 'runtime' || !['item.started', 'item.updated', 'item.snapshot_replaced', 'item.completed'].includes(event.event_type)
    || !['tool_call', 'tool_result'].includes(event.item_kind)) return;
  const state = record.publicToolActivity ??= { calls: {}, items: {}, seen: {}, bytes: 0, exhausted: false };
  if (state.exhausted) return;
  const parts = (event.snapshot ?? event.initial)?.parts ?? (event.update ? [event.update] : []);
  invariant(Array.isArray(parts), 'A2A_INBOUND_TASK_INVALID');
  function select(value, keys) {
    const result = {};
    if (object(value)) for (const key of keys) if (Object.hasOwn(value, key))
      Object.defineProperty(result, key, { value: copy(value[key]), enumerable: true });
    return result;
  }
  function publish(common, operation, partId) {
    if (state.exhausted) return;
    const eventId = a2aIdentity('event', 'a2a-tool', fact.event_id, partId, operation);
    if (Object.hasOwn(state.seen, eventId)) return;
    let value = buildA2aPublicToolActivity({ ...common, event_id: eventId, operation });
    let size = Buffer.byteLength(a2aActivityJson(value, { pydantic: true }));
    const exhausted = state.bytes + size > 1024 * 1024 - 16 * 1024;
    if (exhausted) {
      value = buildA2aPublicToolActivity({ ...value, arguments: null, result: null, truncated: true });
      size = Buffer.byteLength(a2aActivityJson(value, { pydantic: true }));
    }
    const closed = ['completed', 'failed'].includes(operation), artifact = {
      artifactId: value.item_id, name: 'public-tool-activity', parts: [{ data: value, metadata: { extension_uri: A2A_TOOL_ACTIVITY_URI } }],
      metadata: { event_id: eventId, extension_uri: A2A_TOOL_ACTIVITY_URI },
    };
    const previous = record.task.artifacts.findIndex(item => item.artifactId === artifact.artifactId);
    if (previous < 0) record.task.artifacts.push(artifact); else record.task.artifacts[previous] = artifact;
    state.items[artifact.artifactId] = { artifactId: artifact.artifactId, closed };
    updates.push({ artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId,
      artifact: copy(artifact), append: false, lastChunk: closed } });
    state.bytes += size; state.seen[eventId] = true; state.exhausted = exhausted;
  }
  for (const part of parts) {
    if (!['tool_call', 'tool_result'].includes(part?.content_type)) continue;
    invariant(typeof part.call_id === 'string' && part.call_id && typeof part.part_id === 'string' && part.part_id
      && typeof event.item_id === 'string' && event.item_id, 'A2A_INBOUND_TASK_INVALID');
    const key = canonical([event.scope_id, part.call_id]), call = part.content_type === 'tool_call';
    invariant(call || part.is_error === undefined || typeof part.is_error === 'boolean', 'A2A_INBOUND_TASK_INVALID');
    if (call) {
      if (!Object.hasOwn(policy.tools, part.name)) continue;
      state.calls[key] = policy.tools[part.name];
    }
    const rule = state.calls[key]; if (!rule) continue;
    const isError = !call && part.is_error === true, complete = event.event_type === 'item.completed';
    const operation = isError ? 'failed' : complete ? 'completed' : 'updated';
    const common = { item_id: a2aIdentity('item', 'a2a-tool', event.scope_id, event.item_id),
      call_id: a2aIdentity('item', 'a2a-tool', event.scope_id, part.call_id), item_kind: call ? 'tool_call' : 'tool_result',
      execution_status: isError ? 'failed' : complete && !call ? 'completed' : 'running', name: call ? rule.name : null,
      arguments: call ? select(part.arguments, rule.arguments) : null, result: call ? null : select(part.result, rule.results), is_error: isError };
    if (call && complete) publish({ ...common, execution_status: 'running' }, 'started', part.part_id);
    publish(common, operation, part.part_id);
  }
}
