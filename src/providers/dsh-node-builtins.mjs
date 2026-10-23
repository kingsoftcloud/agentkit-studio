/** Compose the Node builtin environments admitted through the existing DSH registry. */
import { copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { isBlockedAddress } from '../../packages/agentkit-harness/src/native/web-tools.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createDshNodeWorkspaceTools } from './dsh-node-workspace-tools.mjs';
import { createDshNodeWebTools } from './dsh-node-web-tools.mjs';
import { createDshNodeToolOutputStore } from './dsh-node-tool-output-store.mjs';
import { createDshNodeCommandTools } from './dsh-node-command-tools.mjs';
import { createDshNodeComponentTools } from './dsh-node-component-tools.mjs';
import { readDshComponentBindings } from './dsh-component-bindings.mjs';
import { createDshNodeSkillTools } from './dsh-node-skill-tools.mjs';
import { createDshNodeSkillWorkflowTools, DSH_NODE_SKILL_WORKFLOW } from './dsh-node-skill-workflow-tools.mjs';
import { nativeSkillRuntimeSettings } from './native-skill-runtime.mjs';
import { nativeSkillReadToolDefinitions } from '../../packages/agentkit-harness/src/native/skill-tools.mjs';
import { nativeCommandBackend } from './native-e2b-host.mjs';
import { supportsLocalProcessPlatform } from '../../packages/agentkit-harness/src/native/local-process.mjs';
import { createSsrfPinnedFetch, resolveWebSearchConfig, resolveWebSsrfPolicy } from './native-dsh-web.mjs';

export function createDshNodeBuiltins({ ctx, workspaceRoot, stateDir, agentId, agentRevision, buildId, isClosed, signal,
  env = process.env, fetchImpl = hostFetch, persistOutput, toolBindings, toolContracts = [], componentBindings, skillConnection,
  skillDefinitions = [] } = {}) {
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_node_output_store_invalid');
  env = { ...env };
  const facts = readDshComponentBindings(componentBindings);
  const requested = toolBindings === undefined ? null : new Set([
    ...toolBindings.map(value => typeof value === 'string' ? value : value?.resourceId || value?.id || value?.name),
    ...toolContracts.filter(tool => tool.executor === 'builtin' && tool.enabled !== false).map(tool => tool.name)]);
  const workspace = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId, isClosed });
  const output = persistOutput === undefined ? createDshNodeToolOutputStore({ directory: stateDir, agentId, isClosed, signal }) : null;
  const ssrf = resolveWebSsrfPolicy(env);
  const ssrfPolicy = { allowPrivate: ssrf.allowPrivate === true || ssrf.allow_private === true };
  const pinned = createSsrfPinnedFetch({ fetchImpl, ssrfBlockCheck: ssrfPolicy.allowPrivate ? null : isBlockedAddress });
  const web = createDshNodeWebTools({ agentId, isClosed, signal, fetchImpl: pinned.fetch, searchFetch: fetchImpl,
    providerConfig: resolveWebSearchConfig(env), ssrfPolicy, persistOutput: persistOutput ?? output?.persistOutput });
  // Explicit E2B remains on its existing backend until its neutral adapter is
  // complete. Never execute an E2B-selected call on the Host by falling back.
  const commands = nativeCommandBackend(env) === 'local_process' && supportsLocalProcessPlatform()
    ? createDshNodeCommandTools({ ctx, workspaceRoot, stateDir, agentId, isClosed, signal, env, persistOutput }) : null;
  const skills = skillConnection && (!requested || nativeSkillReadToolDefinitions().some(tool => requested.has(tool.name)))
    ? createDshNodeSkillTools({ agentId, workspaceRoot, stateDir, connection: skillConnection,
      skillSpaceIds: facts.skillSpaceIds, env, fetchImpl, isClosed, signal }) : null;
  const skillSettings = !requested || requested.has('execute_skills') ? nativeSkillRuntimeSettings(env) : null;
  const workflows = skillSettings?.backend === 'local_process' && supportsLocalProcessPlatform()
    ? createDshNodeSkillWorkflowTools({ ctx, agentId, agentRevision, buildId, workspaceRoot, stateDir, connection: skillConnection,
      skillSpaceIds: facts.skillSpaceIds, skillDefinitions, env, fetchImpl, isClosed, signal }) : null;
  const ports = [workspace, web, ...(commands ? [commands] : []), ...(skills ? [skills] : []), ...(workflows ? [workflows] : [])], owners = new Map();
  const admitted = requested ?? new Set(ports.flatMap(port => port.definitions.map(tool => tool.name)));
  const names = ports.flatMap(port => port.definitions.map(tool => tool.name)).filter(name => admitted.has(name));
  const skillBinding = skills?.binding ?? workflows?.binding;
  const spaces = [...new Set([...facts.skillSpaceIds, ...(skillBinding?.userSpaceIds ?? []), ...(skillBinding?.publicSpaceIds ?? [])])].sort();
  const commandNames = commands ? names.filter(name => commands.supports(name)) : [];
  ports.push(createDshNodeComponentTools({ agentId, isClosed, signal, status: {
    summary: { model: '', knowledge_base_bound: facts.knowledgeBaseBound, long_term_memory_bound: facts.longTermMemoryBound,
      skill_space_bound: spaces.length > 0, isolated_execution: 'not_enabled',
      sandbox_direct_tools: commandNames.length ? 'enabled' : 'not_enabled' },
    skill_space: { space_ids: spaces, user_space_ids: skillBinding?.userSpaceIds ?? [], public_space_ids: skillBinding?.publicSpaceIds ?? [],
      tools: names.filter(name => skills?.supports(name) || workflows?.supports(name)) },
    skill_runtime: { backend: workflows ? 'local_process' : 'disabled', enabled: Boolean(workflows), template_bound: false,
      ...(workflows ? { request_protocol: DSH_NODE_SKILL_WORKFLOW } : {}) },
    sandbox: { backend: commandNames.length ? 'local_process' : 'disabled', enabled: commandNames.length > 0,
      template_bound: false, tools: commandNames },
    workspace: { root: workspaceRoot, tools: names.filter(name => workspace.supports(name)) },
  } }));
  for (const port of ports) for (const definition of port.definitions) {
    invariant(!owners.has(definition.name), 'dsh_node_builtin_duplicate'); owners.set(definition.name, port);
  }
  let closing;
  return { contract: 'agentkit.dsh-node-builtins/v1',
    get definitions() { return ports.flatMap(port => port.definitions.map(definition => copy(definition))); },
    supports: name => owners.has(name),
    execute(name, args, exec) {
      invariant(owners.has(name), 'dsh_node_builtin_unbound');
      return owners.get(name).execute(name, args, exec);
    },
    close() {
      if (closing) return closing;
      for (const port of ports) port.close();
      output?.close();
      return closing = Promise.resolve(pinned.close());
    },
  };
}
