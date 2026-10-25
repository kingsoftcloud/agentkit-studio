/** Studio-bindable tool names, pinned to the reference toolset descriptors.
 * This inventory selects diagnostics, not authority: the actual Node port and
 * complete DSH ToolRegistry pipeline must still own every invocation.
 * run_code is registered as sandbox_run_code to preserve DSH's PTC tool.
 */
import { sandboxRegistryName } from './sandbox-code-name.mjs';

export const DSH_NODE_BUILTIN_CATALOG = 'agentkit.dsh-node-builtin-catalog/v1';
const groups = {
  WORKSPACE: ['workspace_status', 'list_workspace_files', 'read_workspace_file',
    'write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
    'multi_edit_workspace_file', 'lint_workspace_file', 'search_workspace_files', 'delete_workspace_file'],
  COMPONENT: ['component_status'],
  COMMAND: ['sandbox_status', 'run_command', 'read_command_output', 'stop_command'],
  SANDBOX_CODE: ['run_code'],
  BROWSER: ['browser_inspect_workspace'],
  SKILL_MANAGEMENT: ['skill_discover_github', 'skill_install', 'skill_bind_agent'],
  SKILL: ['list_skill_spaces', 'list_skills', 'search_skills', 'load_skill', 'preview_skill'],
  SKILL_WORKFLOW: ['execute_skills'],
  WEB: ['web_fetch', 'web_search'],
  A2A: ['list_a2a_agents', 'get_a2a_agent_card', 'call_a2a_agent'],
  // The platform factory adds these to the descriptor registry separately
  // from its single _TOOLSET_DESCRIPTORS entry (component_status).
  KNOWLEDGE: ['search_knowledge_base'],
  MEMORY: ['load_memory', 'save_memory'],
};
const families = new Map(Object.entries(groups).flatMap(([family, names]) =>
  names.map(name => [sandboxRegistryName(name), family])));
// Native's model-facing names precede the DSH registry alias. In particular,
// run_code must not be exported as DSH's sandbox_run_code transport name.
// Native's structured patch port does not change DSH Native's ten-tool workspace contract.
export const NATIVE_NODE_BUILTIN_NAMES = Object.freeze([...Object.values(groups).flat(), 'apply_workspace_patch']);
export const DSH_NODE_BUILTIN_NAMES = Object.freeze([...families.keys()]);
const meta = new Set(['tool_search', 'tool_dispatcher', 'agentengine_tool_dispatcher']);

export function assertConcreteBuiltin(name) {
  if (meta.has(String(name).trim())) throw Object.assign(new Error('调度类工具不能绕过 Agent 的具体工具绑定'), {
    code: 'BUILTIN_META_TOOL_FORBIDDEN', details: { name },
  });
}

export function unavailableNodeBuiltin(name) {
  assertConcreteBuiltin(name);
  const family = families.get(name);
  return Object.assign(new Error(family
    ? `Node ${family.toLowerCase()} environment is unavailable`
    : `内置 Tool ${name} 没有已接入的 Node 实现`), {
    code: family ? `${family}_NODE_PORT_UNAVAILABLE` : 'BUILTIN_TOOL_UNSUPPORTED',
    details: { name, contract: DSH_NODE_BUILTIN_CATALOG },
  });
}
