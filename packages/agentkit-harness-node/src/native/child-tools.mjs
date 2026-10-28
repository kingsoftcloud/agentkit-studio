import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_CHILD_TOOLS_CONTRACT = 'agentkit.native-child-tools/v1';
export function nativeChildToolDefinitions(roles, startTimeoutMs = 120000) {
  invariant(Array.isArray(roles) && roles.length > 0 && roles.length <= 32
    && roles.every(role => typeof role === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(role))
    && new Set(roles).size === roles.length, 'native_child_roles_invalid');
  const base = { readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 120000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
  invariant(Number.isSafeInteger(startTimeoutMs) && startTimeoutMs >= 120000, 'native_child_timeout_invalid');
  const definitions = [{ ...base, timeoutMs: startTimeoutMs, name: 'native_start_child', childBudgetPolicy: 'start/v1',
    description: 'Start a bounded approved child, in the background by default. background=false waits for its delivery. continuation_of reuses a terminal, collected child Session from this parent Session with a fresh Run and budget; collect it first. An early startup receipt reserves budget and is not findings.',
    parameters: { type: 'object', additionalProperties: false, required: ['role', 'task'], properties: {
      role: { type: 'string', enum: [...roles] }, task: { type: 'string', minLength: 1, maxLength: 32000 },
      background: { type: 'boolean', default: true }, model_call_limit: { type: 'integer', minimum: 1, default: 4 },
      tool_call_limit: { type: 'integer', minimum: 0, default: 8 },
      output_format: { type: 'string', enum: ['text', 'json_object'] }, output_contract: { type: 'string', enum: ['parent'] },
      continuation_of: { type: 'string', minLength: 1, maxLength: 256 },
      media: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['source', 'index'],
        properties: { source: { type: 'string', enum: ['parent_user_input'] }, index: { type: 'integer', minimum: 0 } } },
        description: 'Original content-part indices of images in the current admitted parent user input. Pass references only.' },
    } } }, { ...base, name: 'native_child_control', childBudgetPolicy: 'settle/v1',
    description: 'Send guidance, stop, or wait up to 30 seconds for a child owned by this parent. A running response is not completion. Sealed terminal results settle actual usage once.',
    parameters: { type: 'object', additionalProperties: false, required: ['child_run_id', 'action'], properties: {
      child_run_id: { type: 'string', minLength: 1, maxLength: 256 }, action: { type: 'string', enum: ['wait', 'send', 'stop'] },
      message: { type: 'string', minLength: 1, maxLength: 32000 }, wait_seconds: { type: 'number', minimum: 0, maximum: 30, default: 15 },
    } } }];
  const delegate = structuredClone(definitions[0]);
  delegate.name = 'native_delegate'; delegate.childBudgetPolicy = 'delegate/v1';
  delegate.description = 'Run a bounded approved child and wait for its original delivery. continuation_of reuses a terminal, collected child Session with a fresh Run and budget. Its findings do not verify the parent task. background=true returns a budget reservation instead.';
  delegate.parameters.properties.background.default = false;
  for (const key of ['model_call_limit', 'tool_call_limit']) delete delegate.parameters.properties[key];
  return [...definitions, delegate];
}
