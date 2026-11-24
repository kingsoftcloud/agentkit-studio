/** Compose the Node builtin environments admitted through the existing DSH registry. */
import { copy, invariant } from '../contracts/native-values.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createDshNodeWorkspaceTools } from './dsh-node-workspace-tools.mjs';
import { createDshNodeCommandTools } from './dsh-node-command-tools.mjs';
import { createDshNodeE2BCommandTools } from './dsh-node-e2b-command-tools.mjs';
import { createDshNodeCodeTools } from './dsh-node-code-tools.mjs';
import { sandboxRegistryName, SANDBOX_CODE_NAME } from './sandbox-code-name.mjs';
import { e2bCommandToolDefinitions } from './studio-e2b-command-transport.mjs';
import { createBoundDshComponentTools } from './dsh-node-component-tools.mjs';
import { readDshComponentBindings } from './dsh-component-bindings.mjs';
import { createDshNodeA2aTools, dshA2aAccess } from './dsh-node-a2a-tools.mjs';
import { mountStudioDshPorts } from './studio-dsh-builtins.mjs';
import { DSH_NODE_A2A_NAMES } from './dsh-node-builtin-catalog.mjs';
import { createDshNodeSkillWorkflowTools, DSH_NODE_SKILL_WORKFLOW } from './dsh-node-skill-workflow-tools.mjs';
import { nativeSkillRuntimeSettings } from './studio-skill-runtime-files.mjs';
import { nativeCommandBackend } from './native-command-backend.mjs';
import { supportsLocalProcessPlatform } from './studio-local-command/local-process.mjs';

export function createDshNodeBuiltins({ ctx, workspaceRoot, stateDir, agentId, agentRevision, buildId, isClosed, signal,
  env = process.env, fetchImpl = hostFetch, persistOutput, toolBindings, toolContracts = [], componentBindings, skillConnection,
  skillDefinitions = [], a2aBindings = [], a2aSessionEvents, browserExecutablePath, applicationPreviewOrigin, getSkillManagement, getKnowledgeTools, knowledgeBindings,
  getLegacyMemoryTools, legacyMemoryBindings } = {}) {
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_node_output_store_invalid');
  env = { ...env };
  const facts = readDshComponentBindings(componentBindings);
  const requested = toolBindings === undefined ? null : new Set([
    ...(a2aBindings.length ? DSH_NODE_A2A_NAMES : []),
    ...toolBindings.map(value => typeof value === 'string' ? value : value?.resourceId || value?.id || value?.name),
    ...toolContracts.filter(tool => tool.executor === 'builtin' && tool.enabled !== false).map(tool => tool.name)].map(sandboxRegistryName));
  const workspace = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId, isClosed });
  const commandBackend = nativeCommandBackend(env);
  const wantsCommands = !requested || e2bCommandToolDefinitions().some(tool => requested.has(tool.name));
  const commands = !wantsCommands ? null : commandBackend === 'e2b'
    ? createDshNodeE2BCommandTools({ ctx, workspaceRoot, stateDir, agentId, agentRevision, buildId, isClosed, signal, env, persistOutput })
    : supportsLocalProcessPlatform()
      ? createDshNodeCommandTools({ ctx, workspaceRoot, stateDir, agentId, isClosed, signal, env, persistOutput }) : null;
  const code = !requested || requested.has(SANDBOX_CODE_NAME) ? createDshNodeCodeTools({ ctx, workspaceRoot, stateDir, agentId,
    agentRevision, buildId, isClosed, signal, env, persistOutput }) : null;
  const skillSettings = !requested || requested.has('execute_skills') ? nativeSkillRuntimeSettings(env) : null;
  const workflows = skillSettings?.backend === 'e2b' || skillSettings?.backend === 'local_process' && supportsLocalProcessPlatform()
    ? createDshNodeSkillWorkflowTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir, connection: skillConnection,
      skillSpaceIds: facts.skillSpaceIds, skillDefinitions, env, fetchImpl, isClosed, signal }) : null;
  const a2a = !requested || DSH_NODE_A2A_NAMES.some(name => requested.has(name))
    ? createDshNodeA2aTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir, env, bindings: a2aBindings,
      sessionEvents: a2aSessionEvents,
      fetchImpl, isClosed, signal }) : null;
  const { browser, management, knowledge, memory, skills, web } = mountStudioDshPorts({ ctx, agentId, agentRevision, buildId, workspaceRoot,
    stateDir, browserExecutablePath, applicationPreviewOrigin, getSkillManagement, getKnowledgeTools, knowledgeBindings,
    getLegacyMemoryTools, legacyMemoryBindings, skillConnection, componentBindings: facts, env, fetchImpl, persistOutput, isClosed, signal }, requested, commandBackend);
  const ports = [workspace, web, a2a, browser, management, knowledge, memory, commands, code, skills, workflows].filter(Boolean), owners = new Map();
  ports.push(createBoundDshComponentTools({ agentId, workspaceRoot, componentBindings: facts, isClosed, signal },
    { requested, ports, workspace, commands, code, skills, workflows, commandBackend, workflowProtocol: DSH_NODE_SKILL_WORKFLOW }));
  for (const port of ports) for (const definition of port.definitions) {
    invariant(!owners.has(definition.name), 'dsh_node_builtin_duplicate'); owners.set(definition.name, port);
  }
  let closing;
  return { contract: 'agentkit.dsh-node-builtins/v1',
    get definitions() { return ports.flatMap(port => port.definitions.map(definition => copy(definition))); },
    supports: name => owners.has(name),
    ...dshA2aAccess(a2a),
    execute(name, args, exec) {
      invariant(owners.has(name), 'dsh_node_builtin_unbound');
      return owners.get(name).execute(name, args, exec);
    },
    close() {
      if (closing) return closing;
      const tasks = ports.map(port => { try { return Promise.resolve(port.close()); } catch (error) { return Promise.reject(error); } });
      return closing = Promise.allSettled(tasks).then(results => {
        const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      });
    },
  };
}
