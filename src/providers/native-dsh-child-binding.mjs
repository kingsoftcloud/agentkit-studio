import { realpathSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { childCommandResource } from '@kingsoftcloud/agentkit-harness-node/native/child-command-resource';
import { STUDIO_NATIVE_CHILD_WORKSPACE_BINDING } from './native-child-workspace-host.mjs';

/** Bind child tools only to the parent's admitted role and isolated resources. */
export function createNativeDshChildBinding({ pinnedRoot, commandNames, commandBackend, a2a, childMcpBinding, childSkillBinding,
  allowed, disclosureNames, mcpContracts, a2aNames, formal, template, memoryNames, hash }) {
  return function (agent, authority) {
      invariant(authority?.scope && authority.store && typeof authority.sessionId === 'string' && authority.sessionId,
        'studio_native_child_tool_binding_missing');
      const isolated = authority.workspaceBinding?.contract === STUDIO_NATIVE_CHILD_WORKSPACE_BINDING
        && typeof authority.workspaceRoot === 'string' && /^[0-9a-f]{64}$/.test(authority.workspaceBinding.isolationId)
        && /^sha256:[0-9a-f]{64}$/.test(authority.workspaceBinding.baseRevision);
      invariant(authority.workspaceRoot === undefined || isolated, 'studio_native_child_workspace_binding_missing');
      if (isolated) {
        const root = realpathSync(authority.workspaceRoot);
        invariant(basename(root) === 'work' && basename(dirname(root)) === authority.workspaceBinding.isolationId
          && hash(dirname(dirname(root))) === authority.workspaceBinding.storageRootDigest
          && hash(pinnedRoot) === authority.workspaceBinding.sourceRootDigest, 'studio_native_child_workspace_binding_changed');
      }
      const childCommands = authority.toolNames?.some(name => commandNames.has(name));
      invariant(!childCommands || isolated && commandBackend === 'local_process' && authority.expectedHostBindingDigest
        && canonical(authority.executionResource) === canonical({
          ...childCommandResource(authority.localExecution?.binding ?? this.commandBinding), workspaceBindingDigest: hash(authority.workspaceBinding) }),
        'studio_native_child_command_resource_changed');
      const inheritsMcp = authority.mcpBinding !== undefined;
      const inheritsA2a = authority.a2aBinding !== undefined;
      invariant(!inheritsA2a || a2a && canonical(authority.a2aBinding) === canonical(this.a2aBinding),
        'studio_native_child_a2a_binding_changed');
      invariant(!inheritsMcp || childMcpBinding && canonical(authority.mcpBinding) === canonical(childMcpBinding),
        'studio_native_child_mcp_binding_changed');
      const inheritedSkills = authority.childSkills;
      if (inheritedSkills) {
        const roles = this.childBindingFor({ childAllocationPolicy: authority.childAllocationPolicy })?.roles ?? [];
        const role = roles.find(item => item.name === inheritedSkills.role?.name);
        invariant(childSkillBinding && role?.inheritSkills === true && typeof inheritedSkills.buildId === 'string'
          && inheritedSkills.buildId.trim() && canonical(inheritedSkills) === canonical({ ...childSkillBinding,
            role, buildId: inheritedSkills.buildId }), 'studio_native_child_skill_binding_changed');
      }
      invariant(Array.isArray(authority.toolNames) && authority.toolNames.every(name => allowed.has(name)
        && (inheritedSkills && disclosureNames.has(name) || inheritsMcp && mcpContracts.has(name)
          || inheritsA2a && a2aNames.has(name) || childCommands && commandNames.has(name) && formal.has(name)
          || formal.has(name) && (formal.get(name).readOnly === true || isolated)
        && template.definitions.some(definition => definition.name === name)
        && !mcpContracts.has(name) && !memoryNames.has(name))),
        'studio_native_child_tools_not_bound');
      const bound = this.forAgent(agent, { ...authority, scope: structuredClone(authority.scope),
        toolNames: [...authority.toolNames], childSessionId: authority.sessionId });
      return { tools: bound.tools, workspace: bound.workspace, ...(childCommands ? { background: bound.background } : {}) };
  };
}
