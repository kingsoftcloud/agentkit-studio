import { resolve } from 'node:path';
import { NATIVE_COMPONENT_TOOLS_CONTRACT } from '../../packages/agentkit-harness/src/native/component-tools.mjs';
import { studioNativeMemoryPolicy } from './native-memory.mjs';
import { E2B_COMMAND_TOOLS_CONTRACT } from '../../packages/agentkit-harness/src/native/e2b-command-tools.mjs';
import { STUDIO_NATIVE_E2B_HOST } from './native-e2b-host.mjs';

/** Describe only the resources admitted by this Host and the tools actually
 * present in this Run. A catalog entry or an environment variable cannot make
 * an unmounted executor available. This object participates in the Host pin. */
export function studioNativeComponentStatus({ record, modelName, workspaceRoot, tools, commandBinding, localMemoryBound = false }) {
  const names = new Set(tools.map(tool => tool.name));
  const resources = (record.spec.bindings?.plugins ?? []).filter(plugin => plugin.enabled !== false)
    .map(plugin => plugin.config?.binding?.resource).filter(Boolean);
  const spaces = [...new Set(resources.filter(resource => resource.kind === 'skill-space')
    .map(resource => resource.id || resource.resourceId).filter(id => typeof id === 'string' && id))].sort();
  const workspaceNames = ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
    'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
    'search_workspace_files', 'delete_workspace_file'].filter(name => names.has(name));
  const commandNames = ['sandbox_status', 'run_command', 'read_command_output', 'stop_command', 'run_code']
    .filter(name => names.has(name));
  const commandsEnabled = Boolean(commandBinding && commandNames.length);
  const isolated = commandsEnabled && commandBinding.contract === E2B_COMMAND_TOOLS_CONTRACT
    && commandBinding.backend === 'e2b' && commandBinding.host?.contract === STUDIO_NATIVE_E2B_HOST
    && /^[a-f0-9]{64}$/u.test(commandBinding.host.bindingDigest ?? '') && Boolean(commandBinding.host.template);
  const memory = studioNativeMemoryPolicy(record.spec);
  return { contract: NATIVE_COMPONENT_TOOLS_CONTRACT, status: {
    summary: { model: modelName,
      knowledge_base_bound: resources.some(resource => resource.kind === 'knowledge-base'),
      long_term_memory_bound: memory.enabled && localMemoryBound || record.spec.memory?.enabled !== false
        && resources.some(resource => resource.kind === 'memory-instance'),
      skill_space_bound: spaces.length > 0,
      isolated_execution: isolated ? 'enabled' : 'not_enabled', sandbox_direct_tools: commandsEnabled ? 'enabled' : 'not_enabled' },
    skill_space: { space_ids: spaces, user_space_ids: [], public_space_ids: [],
      service_url: '', aicp_endpoint_mode: 'auto',
      tools: ['list_skills', 'search_skills', 'load_skill', 'execute_skills'].filter(name => names.has(name)) },
    // Local indexed Skills and a command backend do not prove a mounted Skill
    // execution service. Its formal binding will supply its own status later.
    skill_runtime: { backend: 'disabled', enabled: false, template_bound: false },
    sandbox: { backend: commandsEnabled ? commandBinding.backend : 'disabled', enabled: commandsEnabled,
      template_bound: Boolean(isolated), tools: commandsEnabled ? commandNames : [] },
    workspace: { root: resolve(workspaceRoot), tools: workspaceNames },
  } };
}
