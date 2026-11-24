import { invariant } from '../contracts/native-values.mjs';
import { knowledgeToolDefinitions } from '../knowledge-tools.mjs';
import { legacyMemoryToolDefinitions } from '../legacy-memory-tools.mjs';
import { skillManagementDefinitions } from '../skill-management.mjs';
import { createDshNodeBrowserTools, dshBrowserDefinition } from './dsh-node-browser-tools.mjs';
import { createDshNodeKnowledgeTools } from './dsh-node-knowledge-tools.mjs';
import { createDshNodeLegacyMemory } from './dsh-node-legacy-memory.mjs';
import { createDshNodeSkillManagement } from './dsh-node-skill-management.mjs';
import { createDshNodeA2aTools, dshA2aAccess } from './dsh-node-a2a-tools.mjs';
import { createBoundDshComponentTools } from './dsh-node-component-tools.mjs';
import { DSH_NODE_A2A_NAMES, DSH_NODE_COMMAND_NAMES, DSH_NODE_WORKSPACE_NAMES } from './dsh-node-builtin-catalog.mjs';
import { readDshComponentBindings } from './dsh-component-bindings.mjs';
import { DSH_SKILL_READ_NAMES } from './studio-skill-tool-contracts.mjs';
import { createDshNodeSkillTools } from './dsh-node-skill-tools.mjs';
import { createDshNodeSkillWorkflowTools, DSH_NODE_SKILL_WORKFLOW } from './dsh-node-skill-workflow-tools.mjs';
import { nativeSkillRuntimeSettings } from './studio-skill-runtime-files.mjs';
import { DSH_WEB_TOOL_NAMES, mountDshNodeWebTools } from './dsh-node-web-tools.mjs';
import { createDshNodeE2BCommandTools } from './dsh-node-e2b-command-tools.mjs';
import { createDshNodeCodeTools } from './dsh-node-code-tools.mjs';
import { createDshNodeWorkspaceTools } from './dsh-node-workspace-tools.mjs';
import { SANDBOX_CODE_NAME } from './sandbox-code-name.mjs';

const studioToolNames = new Set([dshBrowserDefinition(), ...knowledgeToolDefinitions(),
  ...legacyMemoryToolDefinitions(), ...skillManagementDefinitions()].map(tool => tool.name)
  .concat(DSH_NODE_A2A_NAMES, DSH_SKILL_READ_NAMES, DSH_WEB_TOOL_NAMES, DSH_NODE_WORKSPACE_NAMES, SANDBOX_CODE_NAME, 'component_status'));

export function onlyStudioDshTools(names, backend, env) {
  return [...names].every(name => studioToolNames.has(name)
    || backend === 'e2b' && DSH_NODE_COMMAND_NAMES.includes(name)
    || name === 'execute_skills' && nativeSkillRuntimeSettings(env).backend === 'e2b');
}

/** These tools act through Studio-owned workspace or platform services. */
export function mountStudioDshPorts(options, requested, backend) {
  const { agentId, getSkillManagement, getKnowledgeTools, knowledgeBindings, getLegacyMemoryTools, legacyMemoryBindings, skillConnection } = options;
  const wants = definitions => !requested || definitions.some(tool => requested.has(tool.name));
  const browser = wants([dshBrowserDefinition()]) ? createDshNodeBrowserTools({ ...options, backend,
    ...(backend !== 'local_process' ? { applicationPreviewOrigin: undefined } : {}) }) : null;
  const management = getSkillManagement && wants(skillManagementDefinitions())
    ? createDshNodeSkillManagement({ ...options, management: getSkillManagement(agentId) }) : null;
  const knowledge = getKnowledgeTools && wants(knowledgeToolDefinitions())
    ? createDshNodeKnowledgeTools({ ...options, knowledge: getKnowledgeTools({ agentId, knowledgeBindings }) }) : null;
  const memory = getLegacyMemoryTools && wants(legacyMemoryToolDefinitions())
    ? createDshNodeLegacyMemory({ ...options, memory: getLegacyMemoryTools({ agentId, legacyMemoryBindings }) }) : null;
  const skills = skillConnection && (!requested || DSH_SKILL_READ_NAMES.some(name => requested.has(name)))
    ? createDshNodeSkillTools({ ...options, connection: skillConnection,
      skillSpaceIds: readDshComponentBindings(options.componentBindings).skillSpaceIds }) : null;
  const web = !requested || DSH_WEB_TOOL_NAMES.some(name => requested.has(name)) ? mountDshNodeWebTools(options) : null;
  return { browser, management, knowledge, memory, skills, web };
}

export function createStudioDshBuiltins(options, requested, backend) {
  const studioPorts = mountStudioDshPorts(options, requested, backend);
  const ports = Object.values(studioPorts).filter(Boolean);
  const a2a = DSH_NODE_A2A_NAMES.some(name => requested.has(name)) ? createDshNodeA2aTools({ ...options,
    bindings: options.a2aBindings, sessionEvents: options.a2aSessionEvents }) : null;
  const commands = backend === 'e2b' && DSH_NODE_COMMAND_NAMES.some(name => requested.has(name)) ? createDshNodeE2BCommandTools(options) : null;
  const code = requested.has(SANDBOX_CODE_NAME) ? createDshNodeCodeTools(options) : null;
  const workspace = DSH_NODE_WORKSPACE_NAMES.some(name => requested.has(name))
    ? createDshNodeWorkspaceTools({ ...options, requested }) : null;
  if (workspace) ports.unshift(workspace);
  const workflows = requested.has('execute_skills') ? createDshNodeSkillWorkflowTools({ ...options,
    connection: options.skillConnection, skillSpaceIds: readDshComponentBindings(options.componentBindings).skillSpaceIds }) : null;
  if (a2a) ports.push(a2a);
  if (commands) ports.push(commands);
  if (code) ports.push(code);
  if (workflows) ports.push(workflows);
  if (requested.has('component_status')) ports.push(createBoundDshComponentTools(options, { requested, ports,
    workspace, skills: studioPorts.skills, commands, code, workflows, commandBackend: backend, workflowProtocol: DSH_NODE_SKILL_WORKFLOW }));
  const owners = new Map(ports.flatMap(port => port.definitions.map(tool => [tool.name, port])));
  let closing;
  return {
    get definitions() { return ports.flatMap(port => port.definitions); },
    supports: name => owners.has(name),
    ...dshA2aAccess(a2a),
    execute(name, args, exec) {
      invariant(owners.has(name), 'dsh_node_builtin_unbound');
      return owners.get(name).execute(name, args, exec);
    },
    close() {
      return closing ??= Promise.allSettled(ports.map(port => Promise.resolve().then(() => port.close())))
        .then(results => {
          const failure = results.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
        });
    },
  };
}
