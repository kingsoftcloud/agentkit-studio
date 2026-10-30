/** Compose the Node builtin environments admitted through the existing DSH registry. */
import { copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { isBlockedAddress } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';
import { hostFetch } from '../http-fetch.mjs';
import { createDshNodeWorkspaceTools } from './dsh-node-workspace-tools.mjs';
import { createDshNodeWebTools } from './dsh-node-web-tools.mjs';
import { createDshNodeToolOutputStore } from './dsh-node-tool-output-store.mjs';
import { createDshNodeCommandTools } from './dsh-node-command-tools.mjs';
import { createDshNodeE2BCommandTools } from './dsh-node-e2b-command-tools.mjs';
import { createDshNodeCodeTools } from './dsh-node-code-tools.mjs';
import { sandboxRegistryName, SANDBOX_CODE_NAME } from './sandbox-code-name.mjs';
import { e2bCommandToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/e2b-command-tools';
import { createDshNodeComponentTools } from './dsh-node-component-tools.mjs';
import { readDshComponentBindings } from './dsh-component-bindings.mjs';
import { createDshNodeA2aTools } from './dsh-node-a2a-tools.mjs';
import { createDshNodeBrowserTools } from './dsh-node-browser-tools.mjs';
import { createDshNodeSkillManagement } from './dsh-node-skill-management.mjs';
import { skillManagementDefinitions } from '../skill-management.mjs';
import { createDshNodeKnowledgeTools } from './dsh-node-knowledge-tools.mjs';
import { knowledgeToolDefinitions } from '../knowledge-tools.mjs';
import { createDshNodeLegacyMemory } from './dsh-node-legacy-memory.mjs';
import { legacyMemoryToolDefinitions } from '../legacy-memory-tools.mjs';
import { nativeA2aToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/a2a-tools';
import { createDshNodeSkillTools } from './dsh-node-skill-tools.mjs';
import { createDshNodeSkillWorkflowTools, DSH_NODE_SKILL_WORKFLOW } from './dsh-node-skill-workflow-tools.mjs';
import { nativeSkillRuntimeSettings } from './native-skill-runtime.mjs';
import { nativeSkillReadToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/skill-tools';
import { nativeCommandBackend } from './native-e2b-host.mjs';
import { supportsLocalProcessPlatform } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { createSsrfPinnedFetch, resolveWebSearchConfig, resolveWebSsrfPolicy } from './native-dsh-web.mjs';

export function createDshNodeBuiltins({ ctx, workspaceRoot, stateDir, agentId, agentRevision, buildId, isClosed, signal,
  env = process.env, fetchImpl = hostFetch, persistOutput, toolBindings, toolContracts = [], componentBindings, skillConnection,
  skillDefinitions = [], a2aBindings = [], a2aSessionEvents, browserExecutablePath, getSkillManagement, getKnowledgeTools, knowledgeBindings,
  getLegacyMemoryTools, legacyMemoryBindings } = {}) {
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_node_output_store_invalid');
  env = { ...env };
  const facts = readDshComponentBindings(componentBindings);
  const requested = toolBindings === undefined ? null : new Set([
    ...(a2aBindings.length ? nativeA2aToolDefinitions().map(tool => tool.name) : []),
    ...toolBindings.map(value => typeof value === 'string' ? value : value?.resourceId || value?.id || value?.name),
    ...toolContracts.filter(tool => tool.executor === 'builtin' && tool.enabled !== false).map(tool => tool.name)].map(sandboxRegistryName));
  const workspace = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId, isClosed });
  const output = persistOutput === undefined ? createDshNodeToolOutputStore({ directory: stateDir, agentId, isClosed, signal }) : null;
  const ssrf = resolveWebSsrfPolicy(env);
  const ssrfPolicy = { allowPrivate: ssrf.allowPrivate === true || ssrf.allow_private === true };
  const pinned = createSsrfPinnedFetch({ fetchImpl, ssrfBlockCheck: ssrfPolicy.allowPrivate ? null : isBlockedAddress });
  const web = createDshNodeWebTools({ agentId, isClosed, signal, fetchImpl: pinned.fetch, searchFetch: fetchImpl,
    providerConfig: resolveWebSearchConfig(env), ssrfPolicy, persistOutput: persistOutput ?? output?.persistOutput });
  const commandBackend = nativeCommandBackend(env);
  const wantsCommands = !requested || e2bCommandToolDefinitions().some(tool => requested.has(tool.name));
  const commands = !wantsCommands ? null : commandBackend === 'e2b'
    ? createDshNodeE2BCommandTools({ ctx, workspaceRoot, stateDir, agentId, agentRevision, buildId, isClosed, signal, env, persistOutput })
    : supportsLocalProcessPlatform()
      ? createDshNodeCommandTools({ ctx, workspaceRoot, stateDir, agentId, isClosed, signal, env, persistOutput }) : null;
  const code = !requested || requested.has(SANDBOX_CODE_NAME) ? createDshNodeCodeTools({ ctx, workspaceRoot, stateDir, agentId,
    agentRevision, buildId, isClosed, signal, env, persistOutput }) : null;
  const skills = skillConnection && (!requested || nativeSkillReadToolDefinitions().some(tool => requested.has(tool.name)))
    ? createDshNodeSkillTools({ agentId, workspaceRoot, stateDir, connection: skillConnection,
      skillSpaceIds: facts.skillSpaceIds, env, fetchImpl, isClosed, signal }) : null;
  const skillSettings = !requested || requested.has('execute_skills') ? nativeSkillRuntimeSettings(env) : null;
  const workflows = skillSettings?.backend === 'e2b' || skillSettings?.backend === 'local_process' && supportsLocalProcessPlatform()
    ? createDshNodeSkillWorkflowTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir, connection: skillConnection,
      skillSpaceIds: facts.skillSpaceIds, skillDefinitions, env, fetchImpl, isClosed, signal }) : null;
  const a2a = !requested || nativeA2aToolDefinitions().some(tool => requested.has(tool.name))
    ? createDshNodeA2aTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir, env, bindings: a2aBindings,
      sessionEvents: a2aSessionEvents,
      fetchImpl, isClosed, signal }) : null;
  const browser = !requested || requested.has('browser_inspect_workspace')
    ? createDshNodeBrowserTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir, browserExecutablePath, backend: commandBackend, isClosed, signal }) : null;
  const management = getSkillManagement && (!requested || skillManagementDefinitions().some(tool => requested.has(tool.name)))
    ? createDshNodeSkillManagement({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir,
      management: getSkillManagement(agentId), isClosed, signal }) : null;
  const knowledge = getKnowledgeTools && (!requested || knowledgeToolDefinitions().some(tool => requested.has(tool.name)))
    ? createDshNodeKnowledgeTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir,
      knowledge: getKnowledgeTools({ agentId, knowledgeBindings }), isClosed, signal }) : null;
  const memory = getLegacyMemoryTools && (!requested || legacyMemoryToolDefinitions().some(tool => requested.has(tool.name)))
    ? createDshNodeLegacyMemory({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir,
      memory: getLegacyMemoryTools({ agentId, legacyMemoryBindings }), isClosed, signal }) : null;
  const ports = [workspace, web, ...(a2a ? [a2a] : []), ...(browser ? [browser] : []), ...(management ? [management] : []), ...(knowledge ? [knowledge] : []), ...(memory ? [memory] : []), ...(commands ? [commands] : []), ...(code ? [code] : []), ...(skills ? [skills] : []), ...(workflows ? [workflows] : [])], owners = new Map();
  const admitted = requested ?? new Set(ports.flatMap(port => port.definitions.map(tool => tool.name)));
  const names = ports.flatMap(port => port.definitions.map(tool => tool.name)).filter(name => admitted.has(name));
  const skillBinding = skills?.binding ?? workflows?.binding;
  const workflowBinding = workflows?.binding.runtime;
  const spaces = [...new Set([...facts.skillSpaceIds, ...(skillBinding?.userSpaceIds ?? []), ...(skillBinding?.publicSpaceIds ?? [])])].sort();
  const commandNames = names.filter(name => commands?.supports(name) || code?.binding?.backend === 'e2b' && code.supports(name));
  ports.push(createDshNodeComponentTools({ agentId, isClosed, signal, status: {
    summary: { model: '', knowledge_base_bound: facts.knowledgeBaseBound, long_term_memory_bound: facts.longTermMemoryBound,
      skill_space_bound: spaces.length > 0, isolated_execution: workflowBinding?.isolated || commandNames.length && commandBackend === 'e2b'
        ? 'enabled' : 'not_enabled',
      sandbox_direct_tools: commandNames.length ? 'enabled' : 'not_enabled' },
    skill_space: { space_ids: spaces, user_space_ids: skillBinding?.userSpaceIds ?? [], public_space_ids: skillBinding?.publicSpaceIds ?? [],
      tools: names.filter(name => skills?.supports(name) || workflows?.supports(name)) },
    skill_runtime: { backend: workflowBinding?.backend ?? 'disabled', enabled: Boolean(workflows), template_bound: Boolean(workflowBinding?.host?.template),
      ...(workflows ? { request_protocol: DSH_NODE_SKILL_WORKFLOW } : {}) },
    sandbox: { backend: commandNames.length ? commandBackend : 'disabled', enabled: commandNames.length > 0,
      template_bound: Boolean(commandNames.length && (commands?.binding?.host?.template || code?.binding?.host?.template)), tools: commandNames },
    workspace: { root: workspaceRoot, tools: names.filter(name => workspace.supports(name)) },
  } }));
  for (const port of ports) for (const definition of port.definitions) {
    invariant(!owners.has(definition.name), 'dsh_node_builtin_duplicate'); owners.set(definition.name, port);
  }
  let closing;
  return { contract: 'agentkit.dsh-node-builtins/v1',
    get definitions() { return ports.flatMap(port => port.definitions.map(definition => copy(definition))); },
    supports: name => owners.has(name),
    a2aTaskHistory(request, assertCurrent) {
      invariant(a2a, 'DSH_A2A_UNAVAILABLE'); return a2a.taskHistory(request, assertCurrent);
    },
    controlA2aTask(request, authority) {
      invariant(a2a, 'DSH_A2A_UNAVAILABLE'); return a2a.controlTask(request, authority);
    },
    execute(name, args, exec) {
      invariant(owners.has(name), 'dsh_node_builtin_unbound');
      return owners.get(name).execute(name, args, exec);
    },
    close() {
      if (closing) return closing;
      const tasks = ports.map(port => { try { return Promise.resolve(port.close()); } catch (error) { return Promise.reject(error); } });
      output?.close();
      return closing = Promise.allSettled([...tasks, pinned.close()]).then(results => {
        const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      });
    },
  };
}
