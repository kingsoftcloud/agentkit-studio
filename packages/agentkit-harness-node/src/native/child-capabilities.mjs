import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const CHILD_CAPABILITY_POLICY = 'required-tools/v1';
export const childRequiredToolsSchema = () => ({ type: 'array', maxItems: 128, uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 256 },
  description: 'Exact tool names needed by this task. Use only capabilities in the selected role directory; [] means no tool requirement. Missing capabilities refuse admission without starting a child.' });

const toolName = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\s\x00-\x1f\x7f]/u.test(value);
const names = values => [...new Set(values)].sort();

/** Derive the directory from already approved definitions and explicit inheritance.
 * This is a view of grants, never a grant resolver or task-language classifier. */
export function childCapabilityDirectory(roles, { tools, mcpToolNames = [], skillToolNames = [] }) {
  const available = new Set(tools.map(tool => typeof tool === 'string' ? tool : tool.name));
  invariant(roles.length <= 32 && roles.every(role => typeof role.name === 'string' && Array.isArray(role.tools)),
    'invalid_child_capability_directory');
  return roles.map(role => ({ role: role.name, tools: names([...role.tools,
    ...(role.inheritMcp ? mcpToolNames : []), ...(role.inheritSkills ? skillToolNames : [])])
    .filter(name => available.has(name)) })).sort((a, b) => a.role.localeCompare(b.role, 'en'));
}

/** Known no-effect refusal. Call only after the parent intent/fence is validated. */
export function admitChildCapabilities(directory, role, requiredTools) {
  if (!Array.isArray(requiredTools) || requiredTools.length > 128 || !requiredTools.every(toolName)
    || new Set(requiredTools).size !== requiredTools.length)
    return { code: 'child_capability_request_invalid', executed: false };
  const selected = directory.find(item => item.role === role);
  if (!selected) return { code: 'child_role_unavailable', executed: false, available_roles: directory.map(item => item.role) };
  const required = names(requiredTools), missing = required.filter(name => !selected.tools.includes(name));
  if (!missing.length) return null;
  return { code: 'child_capability_unavailable', executed: false, role: selected.role,
    missing_tools: missing, available_tools: [...selected.tools], suitable_roles: directory
      .filter(item => required.every(name => item.tools.includes(name))).map(item => item.role) };
}
