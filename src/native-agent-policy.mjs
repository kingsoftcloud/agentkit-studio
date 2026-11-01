/** An Agent Revision's additional tool constraint. It never grants a Host capability. */
export const NATIVE_AGENT_POLICY_CONTRACT = 'agentkit.native-agent-policy/v1';

const decisions = new Set(['inherit', 'ask', 'deny']);
const modes = new Set(['strict', 'loose', 'custom']);
const validName = name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(name);

export function normalizeNativeAgentPolicy(value) {
  if (value === undefined || value === null) return null; // Older Revisions retain their original Host behavior.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== NATIVE_AGENT_POLICY_CONTRACT || !modes.has(value.mode))
    throw Object.assign(new TypeError('Native Agent permission policy is invalid'), { code: 'STUDIO_NATIVE_AGENT_POLICY_INVALID' });
  const rules = value.rules ?? {};
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)
    || Object.entries(rules).some(([name, decision]) => !validName(name) || !decisions.has(decision))
    || (value.mode !== 'custom' && Object.keys(rules).length)
    || Object.keys(value).some(key => !['contract', 'mode', 'rules'].includes(key)))
    throw Object.assign(new TypeError('Native Agent permission rules are invalid'), { code: 'STUDIO_NATIVE_AGENT_POLICY_INVALID' });
  return { contract: NATIVE_AGENT_POLICY_CONTRACT, mode: value.mode,
    rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))) };
}

/** Historical policyTemplate was a display-only label. Only the versioned
 * contract may change execution, including for an old frozen Build. */
export function nativeAgentPolicyFromSpec(spec) {
  const bindings = spec?.bindings ?? {};
  if (bindings.nativeAgentPolicy !== undefined) return normalizeNativeAgentPolicy(bindings.nativeAgentPolicy);
  return null;
}

export function nativeAgentPolicyDecision(policy, name, readOnly) {
  if (!policy || policy.mode === 'loose') return 'inherit';
  if (policy.mode === 'strict') return readOnly ? 'inherit' : 'ask';
  return Object.hasOwn(policy.rules, name) ? policy.rules[name] : readOnly ? 'inherit' : 'deny';
}
