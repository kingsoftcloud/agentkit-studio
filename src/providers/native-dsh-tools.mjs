import { createNativeDshContextBinding } from './native-dsh-context-binding.mjs';
import { createNativeDshChildBinding } from './native-dsh-child-binding.mjs';
import { createNativeDshAgentTools } from './native-dsh-agent-tools.mjs';
import { nativeLocalExecutionMethods } from './native-local-execution.mjs';
import { nativeSkillDirectory } from './native-instruction-context.mjs';
import { nativeToolModelGuidance } from '@kingsoftcloud/agentkit-harness-node/native/tool-guidance';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonical, invariant, parseNativeJson, matchesToolExecutionContract } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { committedWorkspaceCheckpoint } from '@kingsoftcloud/agentkit-harness-node/native/workspace-checkpoints';
import { NATIVE_PYTHON_SYNTAX } from '@kingsoftcloud/agentkit-harness-node/native/python-syntax';
import { createNativeLocalCommandTools, localCommandToolDefinitions, LOCAL_COMMAND_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/local-command-tools';
import { createOwnedCommandResolver, createOwnedCommandOutputReader } from '@kingsoftcloud/agentkit-harness-node/native/owned-command';
import { createBackgroundCommandPort } from '@kingsoftcloud/agentkit-harness-node/native/background-command-port';
import { createNativeConversationCommandControl } from '@kingsoftcloud/agentkit-harness-node/native/conversation-command-control';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { buildScriptEnvironment, localControlSettings, LOCAL_PROCESS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY, LOCAL_COMMAND_SHELL } from '@kingsoftcloud/agentkit-harness-node/native/local-command-policy';
import { DIRECTORY_MODEL_DESCRIPTION, DIRECTORY_SCOPE_MODEL_DESCRIPTION } from './native-directory-observation.mjs';
import { NATIVE_DSH_OUTPUT_SCHEMA, nativeDshBuiltinOutput, renderNativeDshBuiltinOutput } from './native-output.mjs';
import { nativeConversationWorkspaceCheckpoint } from './native-conversation-workspace.mjs';
import { nativeConversationRewindMarkers } from './native-conversation-rewind.mjs';
import { createNativeDshBrowserTools } from './native-dsh-browser.mjs';
import { createNativeVerificationAuthority } from '@kingsoftcloud/agentkit-harness-node/native/verification-authority';
import { createNativeDshWebTools } from './native-dsh-web.mjs';
import { nativeWebToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';
import { nativeMcpOutcome } from './native-mcp-output.mjs';
import { NATIVE_MCP_JSON_CODEC } from './native-mcp-json.mjs';
import { bindNativeMcpSchema, bindNativeMcpPlanAccess, NATIVE_MCP_SCHEMA_CONTRACT } from './native-mcp-schema.mjs';
import { authorizeNativeBuiltin, STUDIO_NATIVE_TOOL_PERMISSION_CONTRACT } from './native-tool-policy.mjs';
import { hasNativeBoundApproval } from './native-bound-policy.mjs';
import { createNativeDurableApproval, NATIVE_DURABLE_APPROVAL, HOST_PREFLIGHT_DEFER } from './native-durable-approval.mjs';
import { nativeAgentPolicyDecision } from '../native-agent-policy.mjs';
import { nativeChildToolDefinitions, NATIVE_CHILD_TOOLS_CONTRACT, CHILD_CAPABILITY_POLICY,
  childCapabilityDirectory, childRequiredToolsSchema } from '@kingsoftcloud/agentkit-harness-node/native/child-tools';
import { nativeChildReaderDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/child-readers';
import { nativeChildRoles, STUDIO_NATIVE_CHILD_SKILLS_CONTRACT } from './native-subagents.mjs';
import { createNativeToolAuthority } from './native-tool-authority.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { WORKSPACE_MUTATION_LOCK } from '@kingsoftcloud/agentkit-harness-node/native/workspace-mutation-lock';
import { nativeChildMergeDefinition } from './native-child-merge.mjs';
import { nativeComponentToolDefinitions, NATIVE_COMPONENT_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/component-tools';
import { nativeSkillDisclosureDefinitions, SKILL_DISCLOSURE_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/skill-disclosure';
import { createStudioNativeSkillSource } from './native-skill-source.mjs';
import { e2bCommandToolDefinitions, e2bCodeToolDefinitions, E2B_COMMAND_TOOLS_CONTRACT, E2B_CODE_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/e2b-command-tools';
import { nativeCommandBackend, prepareNativeE2BHost } from './native-e2b-host.mjs';
import { createNativeDshE2BCommands, createNativeDshE2BCodeTools } from './native-dsh-e2b-commands.mjs';
import { prepareNativeA2AHost } from './native-a2a-host.mjs';
import { createNativeA2aQuestionTerminator, NATIVE_A2A_RECEIPT_WAIT } from './native-a2a-receipt.mjs';
import { nativeA2aToolDefinitions, NATIVE_A2A_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/a2a-tools';
import { prepareNativeSkillHost } from './native-skill-host.mjs';
import { sandboxRegistryName, SANDBOX_CODE_NAME_CONTRACT } from './sandbox-code-name.mjs';
import { skillManagementDefinitions, SKILL_MANAGEMENT_CONTRACT } from '../skill-management.mjs';
import { knowledgeToolDefinitions, STUDIO_KNOWLEDGE_TOOLS } from '../knowledge-tools.mjs';
import { legacyMemoryToolDefinitions, LEGACY_MEMORY_TOOLS } from '../legacy-memory-tools.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const names = values => (values ?? []).map(value => typeof value === 'string' ? value : value?.resourceId || value?.name || value?.id).filter(Boolean);
const WORKSPACE_REPAIR_TOOL = 'native_repair_workspace_operation';
const repairDefinition = { name: WORKSPACE_REPAIR_TOOL, readOnly: false, description: 'Explicitly undo the unconfirmed original workspace operation using its private preimages.',
  permissions: ['workspace:read', 'workspace:write', 'workspace:delete'], parameters: { type: 'object', additionalProperties: false,
    required: ['original_operation_key'], properties: { original_operation_key: { type: 'string' } } } };
export function createNativeDshTools({ ctx, config, workspaceRoot, stateDir, createBrowser, browserExecutablePath, executeMcpTool,
  commandSettings = {}, commandEnvironment = process.env, webEnvironment = commandEnvironment, webFetch, e2bLoadSdk, a2aFetch, a2aSessionEvents,
  instructionRoots = [resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')),
    resolve(process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), '.agents'))],
  skillConnection, skillFetch, skillInputFiles = [], getSkillManagement, getKnowledgeTools, getLegacyMemoryTools }) {
  invariant(typeof ctx.tools?.register === 'function' && typeof ctx.tools?.execute === 'function', 'studio_native_tools_unavailable');
  invariant(config.nativeEngineContract !== NATIVE_DSH_TURN_CONTRACT
    || typeof ctx.tools.guard === 'function' && typeof ctx.tools.dispatchGuard === 'function',
    'studio_native_tool_guard_unavailable');
  const argumentEncoding = ctx.tools.argumentEncodings?.includes('dsh.raw-json-number/v1') ? 'dsh.raw-json-number/v1' : null;
  const resultRetention = ctx.tools.resultRetentions?.includes('caller/v1') ? 'caller/v1' : null;
  const workspace = resolve(workspaceRoot), states = new WeakMap(), calls = new Map();
  const durableApproval = createNativeDurableApproval({ ctx, calls });
  const visionTimeouts = new Map();
  const pinnedRoot = realpathSync(workspace), hasSkills = Boolean(config.skillDefinitions?.length);
  const skillSource = hasSkills ? createStudioNativeSkillSource({ definitions: structuredClone(config.skillDefinitions) }) : null;
  const disclosureNames = new Set(skillSource?.source.refs.length ? nativeSkillDisclosureDefinitions().map(tool => tool.name) : []);
  const disclosureBindingDigest = disclosureNames.size ? hash({ contract: SKILL_DISCLOSURE_CONTRACT, source: skillSource.binding }) : null;
  const childSkillBinding = disclosureBindingDigest ? { contract: STUDIO_NATIVE_CHILD_SKILLS_CONTRACT,
    bindingDigest: disclosureBindingDigest, toolNames: [...disclosureNames] } : null;
  // DSH's complete pre/guard/around/post pipeline owns authorization. This
  // callback runs only inside an accepted registry invocation bound below.
  const state = (agent, sessionId = String(agent.session.id)) => {
    invariant(agent?.session?.id, 'studio_native_tool_agent_missing');
    invariant(realpathSync(workspace) === pinnedRoot, 'workspace_root_changed');
    if (!states.has(agent)) states.set(agent, new Map());
    const sessions = states.get(agent);
    if (!sessions.has(sessionId)) sessions.set(sessionId, createNativeWorkspaceTools({ workspaceRoot: workspace,
      stateDir, sessionId, authorize: async () => 'allow', enablePatches: true, enableRewind: true }));
    return sessions.get(sessionId);
  };
  const template = createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir: join(stateDir, 'definitions'), sessionId: 'definitions', enablePatches: true, enableRewind: true });
  const workspaceToolNames = new Set(template.definitions.map(definition => definition.name));
  const formal = new Map(template.definitions.map(definition => [definition.name, definition]));
  const managementDefinitions = skillManagementDefinitions();
  const wantsManagement = managementDefinitions.some(tool => names(config.toolBindings).includes(tool.name)
    || config.toolContracts?.some(contract => contract.executor === 'builtin' && contract.enabled !== false && contract.name === tool.name));
  const management = wantsManagement && getSkillManagement ? getSkillManagement(config.agentId) : null;
  invariant(!management || management.contract === SKILL_MANAGEMENT_CONTRACT && management.binding.agentId === config.agentId,
    'studio_native_skill_management_binding_invalid');
  const managementNames = new Set(management ? managementDefinitions.map(tool => { formal.set(tool.name, tool); return tool.name; }) : []);
  const knowledgeDefinitions = knowledgeToolDefinitions();
  const wantsKnowledge = knowledgeDefinitions.some(tool => names(config.toolBindings).includes(tool.name)
    || config.toolContracts?.some(contract => contract.executor === 'builtin' && contract.enabled !== false && contract.name === tool.name));
  const knowledge = wantsKnowledge && getKnowledgeTools ? getKnowledgeTools(config) : null;
  invariant(!knowledge || knowledge.contract === STUDIO_KNOWLEDGE_TOOLS && knowledge.binding.agentId === config.agentId,
    'studio_native_knowledge_binding_invalid');
  const knowledgeNames = new Set(knowledge ? knowledgeDefinitions.map(tool => { formal.set(tool.name, tool); return tool.name; }) : []);
  const legacyMemoryDefinitions = legacyMemoryToolDefinitions();
  const wantsLegacyMemory = legacyMemoryDefinitions.some(tool => names(config.toolBindings).includes(tool.name)
    || config.toolContracts?.some(contract => contract.executor === 'builtin' && contract.enabled !== false && contract.name === tool.name));
  const legacyMemory = wantsLegacyMemory && getLegacyMemoryTools ? getLegacyMemoryTools(config) : null;
  invariant(!legacyMemory || legacyMemory.contract === LEGACY_MEMORY_TOOLS && legacyMemory.binding.agentId === config.agentId,
    'studio_native_legacy_memory_binding_invalid');
  const legacyMemoryNames = new Set(legacyMemory ? legacyMemoryDefinitions.map(tool => { formal.set(tool.name, tool); return tool.name; }) : []);
  for (const definition of nativeComponentToolDefinitions()) formal.set(definition.name, definition);
  for (const definition of nativeSkillDisclosureDefinitions()) if (disclosureNames.has(definition.name)) formal.set(definition.name, definition);
  const commandEnvironmentSnapshot = { ...commandEnvironment }, commandBackend = nativeCommandBackend(commandEnvironmentSnapshot);
  const remoteSkills = prepareNativeSkillHost({ config, env: commandEnvironmentSnapshot, connection: skillConnection, inputFiles: skillInputFiles,
    ...(e2bLoadSdk ? { loadSdk: e2bLoadSdk } : {}),
    ...(skillFetch ? { fetchImpl: skillFetch } : {}) });
  const remoteSkillNames = new Set((remoteSkills?.definitions ?? []).map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }));
  const a2a = prepareNativeA2AHost({ env: commandEnvironmentSnapshot, bindings: config.a2aBindings ?? [],
    ...(a2aSessionEvents ? { sessionEvents: a2aSessionEvents } : {}),
    ...(a2aFetch ? { fetchImpl: a2aFetch } : {}) });
  a2a?.restoreEvents({ stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace });
  const a2aNames = new Set(a2a ? nativeA2aToolDefinitions({ receiptObservation: true }).map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }) : []);
  const controls = commandBackend === 'local_process' ? localControlSettings(commandSettings) : null;
  const commandEnv = controls ? buildScriptEnvironment(commandEnvironmentSnapshot, { settings: controls }) : null;
  const commandNames = new Set((controls ? localCommandToolDefinitions(controls) : e2bCommandToolDefinitions()).map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }));
  const codeNames = new Set(e2bCodeToolDefinitions().map(definition => { formal.set(definition.name, definition); return definition.name; }));
  const browserTools = createNativeDshBrowserTools({ workspaceRoot: workspace, createBrowser, browserExecutablePath, environment: commandEnvironmentSnapshot,
    toolTimeoutForSession: sessionId => visionTimeouts.get(sessionId)?.timeoutMs ?? 110000,
    evidenceRoot: join(stateDir, 'browser-evidence') });
  const browserName = browserTools.definition.name;
  formal.set(browserName, browserTools.definition);
  const webNames = new Set(nativeWebToolDefinitions().map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }));
  const childRoles = nativeChildRoles({ subAgents: config.subAgents ?? [] });
  const childNames = new Set(childRoles.length ? [...nativeChildToolDefinitions(childRoles.map(role => role.name),
    Math.max(120000, ...childRoles.map(role => role.timeoutSeconds * 1000 + 15000))),
    ...nativeChildReaderDefinitions(), ...(childRoles.some(role => role.tools.some(name => formal.get(name)?.readOnly === false))
      ? [nativeChildMergeDefinition()] : [])].map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }) : []);
  const declared = structuredClone(config.toolContracts ?? []);
  const contracts = new Map(declared.filter(contract => contract.enabled !== false).map(contract => [contract.name, contract]));
  invariant([...disclosureNames].every(name => !contracts.has(name) || contracts.get(name).executor === 'builtin'),
    'studio_native_skill_tool_collision');
  const boundNames = names(config.toolBindings).flatMap(ref => {
    const matching = declared.filter(contract => contract.name === ref || contract.resourceId === ref);
    return matching.length ? matching.filter(contract => contract.enabled !== false).map(contract => contract.name) : [ref];
  });
  const allowed = new Set([...boundNames, ...contracts.keys(), ...childNames, ...disclosureNames, ...a2aNames, ...remoteSkillNames]);
  invariant([...childNames].every(name => !contracts.has(name)), 'studio_native_child_tool_collision');
  invariant([...a2aNames].every(name => !contracts.has(name) || contracts.get(name).executor === 'builtin'), 'studio_native_a2a_tool_collision');
  invariant([...remoteSkillNames].every(name => !contracts.has(name) || contracts.get(name).executor === 'builtin'), 'studio_native_skill_tool_collision');
  invariant([...managementNames].every(name => !contracts.has(name) || contracts.get(name).executor === 'builtin'), 'studio_native_skill_management_collision');
  invariant([...knowledgeNames].every(name => !contracts.has(name) || contracts.get(name).executor === 'builtin'), 'studio_native_knowledge_collision');
  invariant([...legacyMemoryNames].every(name => !contracts.has(name) || contracts.get(name).executor === 'builtin'), 'studio_native_legacy_memory_collision');
  const builtin = [...allowed].filter(name => contracts.get(name)?.executor === 'builtin'
    || formal.has(name) && contracts.get(name)?.executor !== 'mcp');
  const builtinNames = new Set(builtin);
  invariant(!builtinNames.has('run_code') || !allowed.has(sandboxRegistryName('run_code')), 'studio_native_code_registry_collision');
  const e2b = commandBackend === 'e2b' && [...commandNames, ...codeNames].some(name => builtinNames.has(name))
    ? prepareNativeE2BHost({ env: commandEnvironmentSnapshot, ...(e2bLoadSdk ? { loadSdk: e2bLoadSdk } : {}) }) : null;
  if (e2b) for (const definition of e2bCommandToolDefinitions(e2b.binding.timeoutSeconds)) formal.set(definition.name, definition);
  if (e2b) for (const definition of e2bCodeToolDefinitions(e2b.binding.timeoutSeconds)) formal.set(definition.name, definition);
  // Sample the environment once per preset, including its SSRF policy. A later
  // environment edit cannot change an already admitted Build's tool behavior.
  const webEnvironmentSnapshot = { ...webEnvironment };
  const webTemplate = [...webNames].some(name => builtinNames.has(name))
    ? createNativeDshWebTools({ config: { env: webEnvironmentSnapshot, sessionId: 'definitions', inlineMaxChars: 6000, authorize: async () => 'allow' },
      ...(webFetch ? { fetch: webFetch } : {}) }) : null;
  const webOwners = new Map();
  const closeWebSession = async sessionId => {
    const owners = webOwners.get(sessionId);
    if (!owners) return;
    webOwners.delete(sessionId);
    const results = await Promise.allSettled([...owners].map(async owner => (await owner).close()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  };
  const mcpContracts = new Map([...contracts].filter(([name, contract]) => allowed.has(name) && contract.executor === 'mcp'
    && String(contract.mcpResourceId || contract.resourceId || '').trim()));
  invariant(!mcpContracts.size || typeof executeMcpTool === 'function', 'studio_native_mcp_executor_unavailable');
  const mcpPlanAccess = new Map([...mcpContracts].filter(([, contract]) => contract.nativeMcpPlanAccess !== undefined)
    .map(([name, contract]) => [name, bindNativeMcpPlanAccess(contract.nativeMcpPlanAccess)]));
  const mcpSchemas = new Map([...mcpContracts].filter(([, contract]) => contract.nativeMcpSchema !== undefined)
    .map(([name, contract]) => [name, bindNativeMcpSchema(contract.nativeMcpSchema)]));
  const mcpBindingDigest = mcpContracts.size ? hash([...mcpContracts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, contract]) => ({
    name, resourceId: String(contract.mcpResourceId || contract.resourceId).trim(),
    schema: contract.nativeMcpSchema ?? { parameters: contract.parameters ?? { type: 'object', properties: {} } },
    ...(mcpPlanAccess.has(name) ? { planModeAccess: mcpPlanAccess.get(name) } : {}),
  }))) : null;
  const childMcpBinding = mcpContracts.size ? { contract: 'agentkit.studio-child-borrowed-mcp/v1',
    bindingDigest: mcpBindingDigest, toolNames: [...mcpContracts.keys()].sort() } : null;
  // Memory tool names are registered ONCE (shared across the preset's sessions)
  // but each active session owns its own Memory owner; a call routes to the
  // owner bound for ITS session via the registered execute closure, and
  // definitions() selects the caller-session's locked formal. The preset
  // gateway is shared across sessions, so this map is keyed by sessionId.
  const memoryNames = new Set();
  const a2aOwners = new Map();
  const remoteSkillOwners = new Map();
  const componentOwners = new Map();
  const disclosureOwners = new Map();
  const memoryOwners = new Map(); // sessionId -> { memoryHost, definitions: Map }
  let memoryRegistered = false, memoryDisposers = [];
  let closed = false, closing, disposers = [];
  const close = () => {
    if (closing) return closing;
    closed = true;
    const unregistering = disposers.map(dispose => {
      try { return Promise.resolve(dispose?.()); } catch (error) { return Promise.reject(error); }
    });
    disposers = [];
    // Close every active session's Memory owner host so a deferred approval that
    // resolves after gateway close cannot commit a write (the host guard checks
    // its own closed flag). Just dropping the routing entry is NOT enough — a
    // Memory body mid-approval holds the host. Collect close failures rather
    // than swallow them; releaseResources later close() is idempotent.
    const memoryClosing = [...memoryOwners.values()].map(({ memoryHost }) => {
      try { return Promise.resolve(memoryHost.close()); } catch (error) { return Promise.reject(error); }
    });
    memoryOwners.clear();
    const memoryUnregistering = [];
    for (const dispose of memoryDisposers) { try { memoryUnregistering.push(Promise.resolve(dispose?.())); } catch (error) { memoryUnregistering.push(Promise.reject(error)); } }
    memoryDisposers = []; memoryRegistered = false;
    const webClosing = [...webOwners.keys()].map(closeWebSession);
    if (webTemplate) webClosing.push(webTemplate.close());
    for (const owners of componentOwners.values()) for (const owner of owners) owner.close();
    componentOwners.clear();
    for (const owners of a2aOwners.values()) for (const owner of owners) owner.close();
    a2aOwners.clear();
    for (const owners of remoteSkillOwners.values()) for (const owner of owners) owner.close();
    remoteSkillOwners.clear();
    remoteSkills?.close();
    for (const owners of disclosureOwners.values()) for (const owner of owners) owner.close();
    disclosureOwners.clear();
    return closing = Promise.allSettled([...unregistering, ...memoryUnregistering, ...memoryClosing, ...webClosing, browserTools.close(), a2a?.close(), knowledge?.close(), legacyMemory?.close()]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
  };
  const install = () => {
    invariant(!allowed.has(WORKSPACE_REPAIR_TOOL), 'studio_native_repair_tool_collision');
    disposers = [...builtin, ...mcpContracts.keys()].map(name => {
      const definition = mcpContracts.has(name) ? mcpContracts.get(name) : formal.get(name) ?? contracts.get(name);
      const parameters = structuredClone(mcpSchemas.get(name)?.registryParameters ?? definition.parameters ?? { type: 'object', properties: {} });
      // The shared registry accepts both frozen generations. Native validates
      // the exact advertised schema before dispatch; the owner checks its policy.
      if (['start/v1', 'delegate/v1'].includes(definition.childBudgetPolicy))
        parameters.properties.required_tools = childRequiredToolsSchema();
      return ctx.tools.register({ name: codeNames.has(name) ? sandboxRegistryName(name) : name, description: definition.description ?? '',
        parameters,
        output: { schema: NATIVE_DSH_OUTPUT_SCHEMA, render: renderNativeDshBuiltinOutput },
        execute: async (args, exec) => {
          const invocation = calls.get(String(exec.callId));
          invariant(!closed, 'studio_native_tools_closed');
          invariant(invocation && invocation.agent === exec.agent && invocation.request.call.name === name
            && canonical(invocation.argumentEncoding ? parseNativeJson(JSON.stringify(args)) : args)
              === canonical(invocation.request.call.arguments), 'studio_native_tool_authority_missing');
          exec.signal.throwIfAborted();
          invariant(!invocation.dispatched, 'studio_native_tool_already_dispatched');
          if (formal.has(name) && !mcpContracts.has(name)) {
            try { await authorizeNativeBuiltin(ctx, exec, formal.get(name), {
              requireApproval: name === 'call_a2a_agent' && (config.a2aBindings ?? []).find(spec => [spec.local_name, spec.target_agent_id]
                .some(value => typeof args.agent === 'string' && value.trim().toLowerCase().replace(/^a2a-agent-/u, '')
                  === args.agent.trim().toLowerCase().replace(/^a2a-agent-/u, '')))?.policy_ref === 'policy://a2a/strict',
            }); }
            catch (error) {
              invocation.outcome = { status: 'error', content: { code: error.code || 'STUDIO_NATIVE_PERMISSION_DENIED', executed: false } };
              throw error;
            }
          }
          exec.signal.throwIfAborted();
          // The registry guard ran before this body. A separate builtin
          // approval may have waited long enough for the Native lease to end.
          if (config.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT)
            invariant(invocation.assertCurrent?.(invocation.request) === true, 'studio_native_tool_authority_stale');
          invocation.assertMcpCurrent?.();
          invocation.executionLifecycle?.dispatched();
          invocation.dispatched = true;
          let outcome;
          if (invocation.verificationDispatch) {
            const observation = await invocation.verificationDispatch(exec.signal);
            invocation.observation = structuredClone(observation);
            const content = { entry_path: args.path, status: observation.status, status_code: observation.statusCode,
              body_text_preview: Array.from(observation.text).slice(0, 2000).join(''),
              page_errors: observation.pageErrors, console: observation.console, request_failures: observation.networkFailures };
            outcome = { status: observation.status, content, context: { content: canonical(content),
              ...(observation.screenshot ? { media: [observation.screenshot.contentBlock] } : {}) } };
          } else if (mcpContracts.has(name)) {
            const contract = mcpContracts.get(name);
            outcome = nativeMcpOutcome(await executeMcpTool({ agentId: config.agentId,
              resourceId: String(contract.mcpResourceId || contract.resourceId).trim(), name,
              arguments: args, signal: exec.signal, callId: exec.callId, agent: exec.agent, resultFormat: 'mcp-result/v1',
              ...(invocation.assertMcpCurrent ? { assertCurrent: invocation.assertMcpCurrent } : {}) }),
              { validateOutput: mcpSchemas.get(name)?.validateOutput, deduplicateStructured: invocation.splitModelObservation });
          } else if (childNames.has(name)) {
            invariant(typeof invocation.children?.execute === 'function', 'studio_native_child_ledger_unavailable');
            outcome = await invocation.children.execute({ ...invocation.request, signal: exec.signal });
          } else if (commandNames.has(name)) {
            invariant(typeof invocation.commands === 'function', 'studio_native_command_ledger_unavailable');
            const observation = invocation.commandProgress?.begin({ request: invocation.request, agent: exec.agent,
              signal: exec.signal, assertCurrent: invocation.assertCurrent });
            try {
              outcome = await (await invocation.commands()).execute({ ...invocation.request, signal: exec.signal },
                observation ? { onProgress: observation.observe } : undefined);
            } finally { observation?.close(); }
          } else if (codeNames.has(name)) {
            invocation.assertCurrent(invocation.request);
            outcome = commandBackend === 'e2b'
              ? await (await invocation.code()).execute({ ...invocation.request, signal: exec.signal })
              : { status: 'error', content: { ok: false, error_type: 'isolated_sandbox_required', backend: 'local_process',
                executed: false, boundary: 'run_code requires an isolated sandbox; local snippet execution is disabled.' } };
          } else if (webNames.has(name)) {
            const web = await invocation.web();
            if (config.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT)
              invariant(invocation.assertCurrent?.(invocation.request) === true, 'studio_native_tool_authority_stale');
            outcome = await web.execute({ ...invocation.request, signal: exec.signal,
              ...(config.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT
                ? { assertCurrent: () => invocation.assertCurrent?.(invocation.request) === true } : {}) });
          } else if (a2aNames.has(name)) {
            invariant(invocation.a2a, 'studio_native_a2a_binding_missing');
            outcome = await invocation.a2a.execute({ ...invocation.request, signal: exec.signal });
          } else if (remoteSkillNames.has(name)) {
            invariant(invocation.remoteSkills, 'studio_native_skill_binding_missing');
            outcome = await invocation.remoteSkills.execute({ ...invocation.request, signal: exec.signal });
          } else if (managementNames.has(name) || knowledgeNames.has(name) || legacyMemoryNames.has(name)) {
            invariant(typeof invocation.assertCurrent === 'function', 'studio_native_skill_management_authority_missing');
            const original = invocation.request, originalSignal = original.signal, executionSignal = exec.signal,
              sealed = canonical(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'signal'))),
              registryCall = { name: exec.name, callId: exec.callId, arguments: canonical(args), session: exec.agent.session,
                sessionId: String(exec.agent.session.id) };
            const guard = () => {
              exec.signal.throwIfAborted();
              originalSignal.throwIfAborted();
              invariant(!closed && exec.signal === executionSignal && original.signal === originalSignal && exec.agent === invocation.agent
                && exec.name === registryCall.name && exec.callId === registryCall.callId
                && exec.agent.session === registryCall.session && String(exec.agent.session.id) === registryCall.sessionId
                && canonical(args) === registryCall.arguments && canonical(exec.arguments) === registryCall.arguments
                && canonical(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'signal'))) === sealed
                && invocation.assertCurrent(original) === true, 'studio_native_skill_management_authority_lost'); return true;
            };
            guard();
            if (legacyMemoryNames.has(name)) outcome = await legacyMemory.execute(name, structuredClone(args), {
              signal: exec.signal, assertCurrent: guard,
              context: { agentId: config.agentId, userId: original.scope.userId, sessionId: original.sessionId, runnerType: 'native-harness' },
              owner: { kind: 'native', identity: { scope: structuredClone(original.scope), runId: original.runId,
                sessionId: original.sessionId, operationKey: original.operationKey, callId: original.call.callId }, request: parseNativeJson(sealed) },
            });
            else if (knowledgeNames.has(name)) outcome = await knowledge.execute(name, structuredClone(args), { signal: exec.signal, assertCurrent: guard });
            else {
              const content = await management.execute(name, structuredClone(args), { signal: exec.signal, assertCurrent: guard });
              outcome = { status: content.ok === false ? 'error' : 'ok', content };
            }
            guard();
          } else if (name === 'component_status') {
            invariant(invocation.components, 'studio_native_component_binding_missing');
            outcome = await invocation.components.execute({ ...invocation.request, signal: exec.signal });
          } else if (disclosureNames.has(name)) {
            invariant(invocation.disclosure, 'studio_native_skill_binding_missing');
            outcome = await invocation.disclosure.execute({ ...invocation.request, signal: exec.signal });
          } else outcome = name === browserName ? await browserTools.forSession(String(exec.agent.session.id)).execute({ ...invocation.request, signal: exec.signal,
            ...(config.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT
              ? { assertCurrent: () => invocation.assertCurrent?.(invocation.request) === true } : {}) })
            : formal.has(name) ? await invocation.workspaceTools.execute({ ...invocation.request, signal: exec.signal },
              { assertCurrent: invocation.assertCurrent, checkpointCommitted: invocation.checkpointCommitted })
            : { status: 'error', content: { code: 'STUDIO_NATIVE_BUILTIN_UNAVAILABLE', name } };
          invocation.outcome = structuredClone(outcome);
          return nativeDshBuiltinOutput(mcpContracts.has(name) ? { ...outcome, content: outcome.context.content } : outcome,
            { signal: exec.signal, attachments: () => ctx.get?.('attachments') });
        },
      });
    });
    if ([...builtinNames].some(name => workspaceToolNames.has(name) && !formal.get(name).readOnly)) disposers.push(ctx.tools.register({
      ...structuredClone(repairDefinition), output: { schema: NATIVE_DSH_OUTPUT_SCHEMA, render: renderNativeDshBuiltinOutput },
      execute: async (args, exec) => {
        const invocation = calls.get(String(exec.callId));
        invariant(!closed && invocation?.repair && invocation.agent === exec.agent && !invocation.dispatched
          && canonical(args) === canonical({ original_operation_key: invocation.request.originalOperationKey }), 'studio_native_repair_authority_missing');
        const executionSignal = exec.signal, registryCallId = exec.callId;
        const assertCurrent = request => {
          exec.signal.throwIfAborted();
          return exec.signal === executionSignal && exec.callId === registryCallId && exec.name === WORKSPACE_REPAIR_TOOL
            && exec.agent === invocation.agent && canonical(args) === canonical(exec.arguments)
            && canonical(args) === canonical({ original_operation_key: invocation.request.originalOperationKey })
            && invocation.assertCurrent(request);
        };
        await authorizeNativeBuiltin(ctx, exec, repairDefinition);
        exec.signal.throwIfAborted();
        invocation.dispatched = true;
        const repaired = await invocation.workspaceTools.repairWorkspace({ ...invocation.request,
          signal: AbortSignal.any([exec.signal, invocation.request.signal]) }, { assertCurrent });
        invocation.outcome = repaired.result;
        return nativeDshBuiltinOutput(repaired.result, { signal: exec.signal, attachments: () => ctx.get?.('attachments') });
      },
    }));
    // A Skill's DSH-owned shell body is outside our builtin/MCP wrappers. The
    // registry guard runs after approval waits and immediately before dispatch,
    // so a retired Native intent cannot enter that body on a stale lease.
    const ownedGuard = exec => {
      const invocation = calls.get(String(exec.callId));
      if (!invocation) return undefined;
      if (invocation.agent !== exec.agent) return 'Native tool execution authority expired';
      if (closed || exec.signal.aborted || invocation.request.signal?.aborted)
        return 'Native tool execution authority expired';
      // DSH-owned extensions have no Node builtin wrapper. Seal every owned
      // registry call to the Native intent, including third-party tools whose
      // pre-execute listeners can otherwise replace arguments before dispatch.
      const expectedName = invocation.repair ? WORKSPACE_REPAIR_TOOL
        : codeNames.has(invocation.request.call?.name) ? sandboxRegistryName(invocation.request.call.name)
        : invocation.request.call?.name;
      const expectedArguments = invocation.repair
        ? { original_operation_key: invocation.request.originalOperationKey }
        : invocation.request.call?.arguments;
      if (exec.name !== expectedName || canonical(invocation.argumentEncoding
        ? parseNativeJson(JSON.stringify(exec.arguments)) : exec.arguments) !== canonical(expectedArguments))
        return 'Native tool execution authority expired';
      try {
        if (typeof invocation.assertCurrent === 'function'
          && invocation.assertCurrent(invocation.request) !== true)
          return 'Native tool execution authority expired';
      } catch { return 'Native tool execution authority expired'; }
      // `tools/execute` wrappers run after guards. DSH deep-freezes the value
      // but leaves this property writable until result notification; pin it
      // now so an around-dispatch wrapper cannot swap arguments after approval.
      try { Object.defineProperty(exec, 'arguments', { value: exec.arguments, writable: false, configurable: false }); }
      catch { return 'Native tool execution authority expired'; }
      return undefined;
    };
    if (typeof ctx.tools.guard === 'function') disposers.push(ctx.tools.guard(ownedGuard));
    if (typeof ctx.tools.dispatchGuard === 'function') disposers.push(ctx.tools.dispatchGuard(ownedGuard));
    return close;
  };
  ctx.effect(install, 'agentkit-studio: Native builtin tool bindings');
  /** Trusted Memory binding entry. The parent composes the per-Build Memory
   * owner (definitions + provider + consent + planner) and binds it here so
   * the Memory tools enter the real DSH pre/guard/around/post pipeline. The
   * preset gateway is SHARED across sessions, so each active session owns its
   * own Memory owner keyed by sessionId; the Memory tool NAMES are registered
   * ONCE (shared) and a call routes to the owner bound for ITS session — never
   * the model's args, and never a single global owner. A session's release
   * (releaseResources) only drops ITS owner entry; it must NOT unregister the
   * shared Memory tool registrations (that would interrupt a sibling session
   * mid-approval) — only the gateway close() unregisters them. definitions()
   * selects the caller-session's locked Memory formal. The Host never executes
   * Memory directly. Returns a disposer the caller runs from releaseResources;
   * it drops this session's routing entry; releaseResources closes the owner. */
  const ownerKey = memoryHost => {
    invariant(typeof memoryHost?.sessionId === 'string' && memoryHost.sessionId, 'studio_native_memory_session_unbound');
    return memoryHost.sessionId;
  };
  // Fixed, per-tool Memory parameter schemas used for the SHARED registry
  // registration. These are the union of every policy variant's real schema
  // (all Memory scopes, the full action enum, every field), so the shared DSH
  // input validation admits any legitimate Memory call while the per-call
  // locked formal (from the caller-session owner) still enforces the exact
  // Build-bound schema + locked digest. Never a loose {additionalProperties:true}.
  const MEMORY_SHARED_SCHEMAS = Object.freeze({
    read_memory: { type: 'object', additionalProperties: false, required: ['memory_id'],
      properties: { memory_id: { type: 'string', minLength: 1, maxLength: 256 } } },
    search_memory: { type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 4096 } } },
    manage_memory: { type: 'object', additionalProperties: false, required: ['action', 'scope'],
      properties: { action: { type: 'string', enum: ['remember', 'correct', 'forget'] },
        scope: { type: 'string', enum: ['tenant', 'workspace', 'agent', 'user'] },
        content: { type: 'string', maxLength: 8192 },
        memory_id: { type: 'string', minLength: 1, maxLength: 256 },
        expected_version: { type: 'integer', minimum: 1 } } },
  });
  const MEMORY_DESCRIPTIONS = Object.freeze({
    read_memory: 'Read one durable long-term memory_id in this Agent\'s locked scopes, including its current version, status, content hash, scope and TTL.',
    search_memory: 'Search durable long-term Memory in this Agent\'s locked scopes by a specific query, including current memory_id, version and provenance.',
    manage_memory: 'Remember, correct, or forget one durable long-term fact in a locked scope. A proposal without a recognized explicit user request needs exact-call approval.',
  });
  const ensureMemoryRegistered = () => {
    if (memoryRegistered) return;
    // Collision/safety: the shared Memory names must not collide with workspace,
    // MCP, child or already-registered tool names. Reject before registering.
    for (const name of Object.keys(MEMORY_SHARED_SCHEMAS)) {
      invariant(!formal.has(name) && !contracts.has(name) && !childNames.has(name),
        'studio_native_memory_tool_collision');
    }
    const pendingDisposers = [];
    try {
      for (const [name, schema] of Object.entries(MEMORY_SHARED_SCHEMAS)) {
        pendingDisposers.push(ctx.tools.register({
          name, description: MEMORY_DESCRIPTIONS[name],
          parameters: structuredClone(schema),
          output: { schema: NATIVE_DSH_OUTPUT_SCHEMA, render: renderNativeDshBuiltinOutput },
          execute: async (args, exec) => {
            const invocation = calls.get(String(exec.callId));
            invariant(!closed, 'studio_native_tools_closed');
            invariant(invocation && invocation.agent === exec.agent && invocation.request.call.name === name
              && canonical(invocation.argumentEncoding ? parseNativeJson(JSON.stringify(args)) : args)
                === canonical(invocation.request.call.arguments), 'studio_native_tool_authority_missing');
            exec.signal.throwIfAborted();
            invariant(!invocation.dispatched, 'studio_native_tool_already_dispatched');
            // Resolve THIS call's Memory owner from the invocation's session. A call
            // never executes against another session's owner; a missing owner is a
            // hard error (no write), not a fallback to a global/last owner.
            const session = String(exec.agent.session.id);
            const entry = memoryOwners.get(session);
            invariant(entry, 'studio_native_memory_owner_unbound');
            const memoryHost = entry.memoryHost;
            const lockedFormal = entry.definitions.get(invocation.request.call.name);
            invariant(lockedFormal, 'studio_native_memory_definition_unbound');
            // The complete DSH pre/guard/around/post pipeline already authorized
            // this call. Enforce the standing Node builtin policy (memory:write is
            // not a workspace write; the Memory tool's own consent runs below).
            try { await authorizeNativeBuiltin(ctx, exec, lockedFormal); }
            catch (error) {
              invocation.outcome = { status: 'error', content: { code: error.code || 'STUDIO_NATIVE_PERMISSION_DENIED', executed: false } };
              throw error;
            }
            exec.signal.throwIfAborted();
            invocation.dispatched = true;
            // Per-call dispatch context on AsyncLocalStorage: read-only Memory tools
            // are concurrentSafe and may run in parallel, so the consent, the token
            // planner and the ledger guard observe THIS call's agent / original
            // signal / complete request, not a shared mutable ref. The Memory tool
            // body runs entirely inside this dispatch bound to THIS session's owner.
            return memoryHost.withDispatch({ request: invocation.request, agent: exec.agent, signal: exec.signal,
              boundPolicyApproved: hasNativeBoundApproval(ctx, exec) },
              async () => {
                try {
                  const outcome = await memoryHost.port.execute({ ...invocation.request, signal: exec.signal });
                  invocation.outcome = structuredClone(outcome);
                } catch (error) {
                  // A ledger/fence/capsule guard failure thrown by the applyMutation
                  // wrapper is a known no-write rejection: convert to a clean error
                  // outcome so the kernel sees 'error', not 'uncertain'. Others throw.
                  if (error?.code === 'memory_dispatch_unbound' || error?.code === 'memory_host_closed'
                    || (typeof error?.code === 'string' && error.code.startsWith('memory_execution_'))) {
                    invocation.outcome = { status: 'error', content: { code: error.code, executed: false } };
                  } else throw error;
                }
                return nativeDshBuiltinOutput(invocation.outcome,
                  { signal: exec.signal, attachments: () => ctx.get?.('attachments') });
              });
          } }));
      }
    } catch (error) {
      // A half-way shared registration failure rolls back what registered so a
      // later bind can register cleanly; memoryRegistered stays false.
      for (const dispose of pendingDisposers) { try { dispose?.(); } catch { /* best-effort */ } }
      throw error;
    }
    // Commit only after every registration succeeded.
    memoryDisposers = pendingDisposers;
    for (const name of Object.keys(MEMORY_SHARED_SCHEMAS)) { allowed.add(name); builtinNames.add(name); memoryNames.add(name); }
    memoryRegistered = true;
  };
  const bindMemory = memoryHost => {
    invariant(!closed && memoryHost?.port && Array.isArray(memoryHost.port.definitions)
      && typeof memoryHost.withDispatch === 'function' && typeof memoryHost.close === 'function',
    'studio_native_memory_binding_invalid');
    const session = ownerKey(memoryHost);
    // Validate + snapshot the owner's definitions BEFORE touching any existing
    // entry: no unknown names, no duplicates, and a deep snapshot so a later
    // mutation of the owner's external object cannot change the locked formal.
    const knownNames = new Set(Object.keys(MEMORY_SHARED_SCHEMAS));
    const seen = new Set();
    const ownDefinitions = new Map();
    for (const definition of memoryHost.port.definitions) {
      invariant(typeof definition?.name === 'string' && knownNames.has(definition.name),
        'studio_native_memory_definition_unknown');
      invariant(!seen.has(definition.name), 'studio_native_memory_definition_duplicate');
      seen.add(definition.name);
      ownDefinitions.set(definition.name, structuredClone(definition));
    }
    // Register the shared Memory tools (once); a failure here throws before any
    // existing session entry is touched. Only after validation + registration
    // succeed do we replace the prior SAME-session entry (rebind). A DIFFERENT
    // session's owner is never touched.
    ensureMemoryRegistered();
    const prior = memoryOwners.get(session);
    const entry = { memoryHost, definitions: ownDefinitions };
    memoryOwners.set(session, entry);
    // A prior same-session owner is replaced only after the new one is committed.
    if (prior && prior.memoryHost !== memoryHost) { try { prior.memoryHost.close(); } catch { /* best-effort */ } }
    const dispose = () => {
      // Drop only THIS session's owner entry. Do NOT unregister the shared
      // Memory tool names (a sibling session may be mid-approval) and do NOT
      // touch other sessions' owners. The provider lifetime is closed by the
      // caller (releaseResources) via memoryHost.close(); this dispose only
      // removes the routing entry so the session no longer accepts calls.
      if (memoryOwners.get(session) === entry) memoryOwners.delete(session);
    };
    return dispose;
  };
  const commandToolsFor = async (agent, authority, workspaceTools) => {
    invariant(!closed, 'studio_native_tools_closed');
    invariant(authority?.scope && authority?.store, 'studio_native_command_ledger_unavailable');
    const child = Boolean(authority.childSessionId);
    invariant(!child || commandBackend === 'local_process' && authority.workspaceRoot
      && authority.executionResource && typeof workspaceTools?.capture === 'function', 'studio_native_child_command_resource_unavailable');
    const commandRoot = child ? authority.workspaceRoot : workspace;
    const artifacts = await createNativeArtifactStore({ directory: join(stateDir, 'command-artifacts'), scope: authority.scope });
    invariant(!closed, 'studio_native_tools_closed');
    if (commandBackend === 'e2b') return createNativeDshE2BCommands({ prepared: e2b, workspaceRoot: workspace, stateDir,
      scope: authority.scope, sessionId: authority.childSessionId ?? String(agent.session.id), store: authority.store,
      artifacts, isClosed: () => closed, inProcessTransport: Boolean(e2bLoadSdk) });
    return createNativeLocalCommandTools({ workspaceRoot: commandRoot, stateRoot: join(stateDir, 'background-commands'),
      sessionId: authority.childSessionId ?? String(agent.session.id),
      settings: authority.localExecution?.settings ?? controls, sourceEnv: authority.localExecution?.environment ?? commandEnv,
      ...(authority.localExecution?.outputPolicy ? { outputPolicy: authority.localExecution.outputPolicy } : {}),
      ...(authority.localExecution?.environmentPolicy ? { environmentPolicy: authority.localExecution.environmentPolicy } : {}),
      artifacts, authorize: async () => 'allow',
      assertAuthority: createNativeToolAuthority({ ...authority,
        sessionId: authority.childSessionId ?? String(agent.session.id), isClosed: () => closed }),
      captureWorkspace: request => (workspaceTools ?? state(agent)).capture(request), resolveOwnedCommand: createOwnedCommandResolver(authority) });
  };
  const codeToolsFor = async (agent, authority) => {
    invariant(!closed && authority?.scope && authority?.store && e2b, 'studio_native_code_ledger_unavailable');
    const artifacts = await createNativeArtifactStore({ directory: join(stateDir, 'code-artifacts'), scope: authority.scope });
    invariant(!closed, 'studio_native_tools_closed');
    return createNativeDshE2BCodeTools({ prepared: e2b, workspaceRoot: workspace, stateDir, scope: authority.scope,
      sessionId: authority.childSessionId ?? String(agent.session.id), store: authority.store,
      artifacts, isClosed: () => closed, inProcessTransport: Boolean(e2bLoadSdk) });
  };
  return {
    durableApproval,
    ...nativeLocalExecutionMethods({ enabled: !!controls && builtinNames.has('run_command'), settings: commandSettings,
      sourceEnv: commandEnvironmentSnapshot, workspaceRoot: pinnedRoot,
      commandBackend: commandNames.has('run_command') && builtinNames.has('run_command') ? commandBackend : 'none' }),
    executionCapabilities() {
      return builtinNames.has(browserName) ? [browserTools.capability] : [];
    },
    get durableApprovalContract() {
      return ctx.tools?.preflightDeferContract === HOST_PREFLIGHT_DEFER && config.boundToolPolicy ? NATIVE_DURABLE_APPROVAL : null;
    },
    policyDefinition(agent, registryName) {
      const name = registryName === sandboxRegistryName('run_code') ? 'run_code' : registryName;
      if (name === WORKSPACE_REPAIR_TOOL) return repairDefinition;
      // External and Skill shell tools have unknown effects. A catalog hint
      // cannot turn them into verified reads for the enterprise policy.
      if (mcpContracts.has(name)) return null;
      return memoryOwners.get(String(agent?.session?.id))?.definitions.get(name) ?? formal.get(name) ?? null;
    },
    close,
    bindMemory,
    bindVision({ sessionId, requestTimeoutMs }) {
      invariant(!closed && typeof sessionId === 'string' && sessionId.trim()
        && Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0
        && Number.isSafeInteger(110000 + requestTimeoutMs + 1000), 'studio_native_vision_timeout_invalid');
      invariant(!visionTimeouts.has(sessionId), 'studio_native_vision_session_already_bound');
      const owner = { timeoutMs: 110000 + requestTimeoutMs + 1000 };
      visionTimeouts.set(sessionId, owner);
      return () => { if (visionTimeouts.get(sessionId) === owner) visionTimeouts.delete(sessionId); };
    },
    argumentEncoding,
    permissionContract: STUDIO_NATIVE_TOOL_PERMISSION_CONTRACT,
    componentContract: builtinNames.has('component_status') ? NATIVE_COMPONENT_TOOLS_CONTRACT : null,
    a2aBinding: a2a ? { ...a2a.binding, toolContract: NATIVE_A2A_TOOLS_CONTRACT, receiptWaitContract: NATIVE_A2A_RECEIPT_WAIT } : null,
    settleA2aQuestions({ scope, sessionId, runId, store }) {
      invariant(!closed && a2a && scope?.agentId === config.agentId && typeof store?.load === 'function',
        'studio_native_a2a_cleanup_unavailable');
      createNativeA2aQuestionTerminator({ a2a, scope, sessionId, store,
        stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace, isClosed: () => closed })(store.load(scope, runId).snapshot);
    },
    async controlA2aTask({ scope, sessionId, ...request }, { assertControl, authorizeControl, parentScope }) {
      const child = parentScope && parentScope.agentId === config.agentId
        && ['tenantId', 'workspaceId', 'userId'].every(key => scope?.[key] === parentScope[key])
        && typeof scope?.agentId === 'string' && scope.agentId.startsWith(`${config.agentId}:child:`);
      invariant(!closed && a2a && (scope?.agentId === config.agentId || child), 'studio_native_a2a_control_unavailable');
      invariant(typeof assertControl === 'function' && typeof authorizeControl === 'function', 'A2A_CONTROL_AUTHORITY_REQUIRED');
      const owner = a2a.forSession({ scope, sessionId, stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace,
        // A product control owns new authority, never the retired tool fence.
        assertCurrent: () => false, assertControl: input => { invariant(!closed, 'studio_native_tools_closed'); return assertControl(input); },
        authorizeControl });
      try { return await owner.control.execute(request); }
      finally { owner.close(); }
    },
    inspectA2aTask({ scope, sessionId, operation_locator, authority, signal }, { assertControl, parentScope }) {
      const child = parentScope?.agentId === config.agentId
        && ['tenantId', 'workspaceId', 'userId'].every(key => scope?.[key] === parentScope[key])
        && scope?.agentId?.startsWith(`${config.agentId}:child:`);
      invariant(!closed && a2a && (scope?.agentId === config.agentId || child), 'studio_native_a2a_control_unavailable');
      const owner = a2a.forSession({ scope, sessionId, stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace,
        assertCurrent: () => false, assertControl: input => { invariant(!closed, 'studio_native_tools_closed'); return assertControl(input); },
        authorizeControl: () => { invariant(false, 'A2A_CONTROL_AUTHORITY_REQUIRED'); } });
      try { return owner.control.inspect({ operation_locator, authority, signal }); }
      finally { owner.close(); }
    },
    remoteSkillBinding: remoteSkills?.binding ?? null,
    skillManagementBinding: management ? structuredClone(management.binding) : null,
    knowledgeBinding: knowledge ? structuredClone(knowledge.binding) : null,
    legacyMemoryBinding: legacyMemory ? structuredClone(legacyMemory.binding) : null,
    skillDisclosureBindingDigest: disclosureBindingDigest,
    get childSkillBinding() { return structuredClone(childSkillBinding); },
    skillInstructions(signal, { completeDirectory = false } = {}) {
      return nativeSkillDirectory({ source: skillSource?.source, signal, enabled: disclosureNames.size > 0, completeDirectory });
    },
    childBinding: childRoles.length ? { contract: NATIVE_CHILD_TOOLS_CONTRACT, roles: structuredClone(childRoles) } : null,
    childBindingFor({ childAllocationPolicy } = {}) {
      const roles = nativeChildRoles({ subAgents: config.subAgents ?? [] }, { childAllocationPolicy });
      return roles.length ? { contract: NATIVE_CHILD_TOOLS_CONTRACT, roles } : null;
    },
    childCapabilities: { skills: hasSkills, mcp: mcpContracts.size > 0 },
    childMcpBinding: structuredClone(childMcpBinding),
    workspaceSyntax: builtinNames.has('lint_workspace_file') ? NATIVE_PYTHON_SYNTAX : null,
    workspaceMutationContract: [...builtinNames].some(name => ['write_workspace_file', 'write_workspace_files',
      'edit_workspace_file', 'multi_edit_workspace_file', 'delete_workspace_file', 'apply_workspace_patch', 'rewind_workspace_files'].includes(name)) ? WORKSPACE_MUTATION_LOCK : null,
    webBinding: webTemplate ? { contract: webTemplate.contract, bindingDigest: webTemplate.bindingDigest } : null,
    codeBinding: [...codeNames].some(name => builtinNames.has(name))
      ? { contract: E2B_CODE_TOOLS_CONTRACT, backend: commandBackend, registryNameContract: SANDBOX_CODE_NAME_CONTRACT,
        registryName: sandboxRegistryName('run_code'), ...(e2b ? { host: { ...e2b.binding } } : {}) } : null,
    commandBinding: [...commandNames].some(name => builtinNames.has(name)) ? e2b ? {
      contract: E2B_COMMAND_TOOLS_CONTRACT, backend: 'e2b', host: { ...e2b.binding },
    } : {
      contract: LOCAL_COMMAND_TOOLS_CONTRACT, controls: { contract: LOCAL_PROCESS_CONTRACT, settings: controls, shellPolicy: LOCAL_COMMAND_SHELL },
      risk: [LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY], backend: 'local_process', environmentDigest: hash(commandEnv),
    } : null,
    conversationWorkspaceRecovery(agent) {
      const accepted = nativeConversationRewindMarkers(agent.session.snapshotEvents())
        .filter(event => agent.session.isOwnSeq(event.seq)).map(event => event.data.source.nativeRewind);
      return state(agent).pendingConversationRewind(accepted);
    },
    assertConversationWorkspaceSettled(agent) {
      const accepted = nativeConversationRewindMarkers(agent.session.snapshotEvents())
        .filter(event => agent.session.isOwnSeq(event.seq)).map(event => event.data.source.nativeRewind);
      invariant(!state(agent).pendingConversationRewind(accepted), 'studio_native_workspace_control_recovery_required');
    },
    conversationWorkspace(agent, authority) {
      invariant(!closed && authority?.scope?.agentId === config.agentId && authority.store && agent?.session?.id,
        'studio_native_conversation_workspace_unbound');
      const sessionId = String(agent.session.id), workspaceTools = state(agent, sessionId);
      const options = request => ({ signal: request.signal,
        assertCurrent: () => { invariant(!closed && String(agent.session?.id) === sessionId, 'studio_native_conversation_workspace_unbound'); return request.assertCurrent(); },
        checkpointCommitted: row => committedWorkspaceCheckpoint(row, { store: authority.store, scope: authority.scope, sessionId }),
        selectCheckpoint: checkpoints => nativeConversationWorkspaceCheckpoint({ ...request, checkpoints, store: authority.store, scope: authority.scope }) });
      return { preview: (control, request) => workspaceTools.previewConversationRewind(control, options(request)),
        apply: (control, request) => workspaceTools.rewindConversation(control, options(request)) };
    },
    conversationCommands(agent, authority) {
      invariant(!closed && commandBackend === 'local_process' && authority?.scope?.agentId === config.agentId
        && authority.store && agent?.session?.id, 'studio_native_conversation_commands_unbound');
      return createNativeConversationCommandControl({ workspaceRoot: workspace, stateRoot: join(stateDir, 'background-commands'),
        scope: authority.scope, store: authority.store, sessionId: String(agent.session.id), isClosed: () => closed });
    },
    commandOutputObserver(agent, authority) {
      invariant(!closed && authority?.scope?.agentId === config.agentId && authority.store && agent?.session?.id
        && [...commandNames].some(name => builtinNames.has(name)), 'studio_native_command_output_unbound');
      const fixed = { scope: structuredClone(authority.scope), store: authority.store }, sessionId = String(agent.session.id);
      let commands;
      const port = createOwnedCommandOutputReader({ ...fixed, isClosed: () => closed, readers: { [commandBackend]: async request => {
        invariant(!closed && request.sessionId === sessionId, 'studio_native_command_output_unbound');
        commands ||= commandToolsFor(agent, fixed);
        return (await commands).reader(request);
      } } });
      return Object.freeze({ contract: port.contract, read(request) {
        invariant(!closed && request.sessionId === sessionId, 'studio_native_command_output_unbound');
        return port.read(request);
      } });
    },
    backgroundObserver(agent, authority) {
      invariant(!closed, 'studio_native_tools_closed');
      invariant(authority?.scope?.agentId === config.agentId && authority.store && agent?.session?.id
        && [...commandNames].some(name => builtinNames.has(name)), 'studio_native_background_observer_unbound');
      const fixed = { scope: structuredClone(authority.scope), store: authority.store };
      const sessionId = String(agent.session.id);
      let commands;
      const port = createBackgroundCommandPort({ ...fixed, readers: { [commandBackend]: async request => {
        invariant(!closed && request.sessionId === sessionId, 'studio_native_background_observer_unbound');
        commands ||= commandToolsFor(agent, fixed);
        const result = await (await commands).reader(request);
        invariant(!closed, 'studio_native_tools_closed');
        return result;
      } } });
      // This port exposes only completion reads, without executable tools,
      // Session disclosure owners or a model/command launch capability.
      return Object.freeze({ contract: port.contract, observeCompletion: request => {
        invariant(!closed && request.sessionId === sessionId, 'studio_native_background_observer_unbound');
        return port.observeCompletion(request);
      } });
    },
    mcpResultContract: mcpContracts.size ? 'mcp-result/v1' : null,
    mcpJsonCodec: mcpContracts.size ? NATIVE_MCP_JSON_CODEC : null,
    mcpSchemaContract: mcpSchemas.size ? NATIVE_MCP_SCHEMA_CONTRACT : null,
    mcpBindingDigest,
    async releaseSession(request) {
      const skillSessions = remoteSkillOwners.get(request.sessionId);
      if (skillSessions) { for (const owner of skillSessions) owner.close(); remoteSkillOwners.delete(request.sessionId); }
      const a2aSessions = a2aOwners.get(request.sessionId);
      if (a2aSessions) {
        await Promise.allSettled([...a2aSessions].map(owner => owner.eventDelivery?.flushSession?.({ raiseOnError: false })));
        for (const owner of a2aSessions) owner.close(); a2aOwners.delete(request.sessionId);
      }
      const skillOwners = disclosureOwners.get(request.sessionId);
      if (skillOwners) { for (const owner of skillOwners) owner.close(); disclosureOwners.delete(request.sessionId); }
      const owners = componentOwners.get(request.sessionId);
      if (owners) { for (const owner of owners) owner.close(); componentOwners.delete(request.sessionId); }
      const results = await Promise.allSettled([browserTools.releaseSession(request), closeWebSession(request.sessionId)]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
    retireBrowserResources(request) {
      invariant(request.definition && matchesToolExecutionContract(request.definition,
        {...browserTools.definition,timeoutMs:request.definition.timeoutMs}), 'studio_native_browser_retirement_definition_mismatch');
      return browserTools.forSession(request.sessionId).retireResources(request);
    },
    /** Trusted verifier only: every concrete cold action still runs the DSH permission pipeline. */
    async verifyBrowserPage(agent, request, authority) {
      invariant(!closed && builtinNames.has(browserName), 'studio_native_browser_verification_unavailable');
      const sessionId = String(agent.session.id);
      invariant(request.sessionId === sessionId, 'studio_native_tool_not_bound');
      const governed = config.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT;
      invariant(!governed || authority?.store, 'studio_native_verification_authority_missing');
      const allowed = authority?.store ? createNativeVerificationAuthority({ ...authority, sessionId, toolName: browserName,
        isClosed: () => closed }) : null;
      const entryPath = request.entryPath, originalSignal = request.signal;
      const assertCurrent = allowed ? () => request.signal === originalSignal && request.entryPath === entryPath && allowed(request) : undefined;
      if (assertCurrent) invariant(assertCurrent(), 'studio_native_verification_authority_stale');
      return browserTools.forSession(sessionId).verifyPage({ ...request, ...(assertCurrent ? { assertCurrent } : {}),
        executeAction: async ({ entryPath, action }, dispatch) => {
        request.signal.throwIfAborted();
        if (assertCurrent) invariant(assertCurrent(), 'studio_native_verification_authority_stale');
        invariant(['navigate', 'screenshot', 'click'].includes(action.kind), 'studio_native_browser_verification_action_unavailable');
        const arguments_ = { path: entryPath, wait_ms: 0, actions: action.kind === 'click'
          ? [{ type: 'click', selector: action.selector }] : [] };
        const callId = `ak-native-verify-${hash({ scope: request.scope, runId: request.runId,
          operationKey: request.operationKey, candidateId: request.candidateId, actionId: action.actionId })}`;
        invariant(!calls.has(callId), 'studio_native_tool_already_executing');
        const invocation = { agent, request: { ...request, call: { callId, name: browserName, arguments: arguments_ } },
          assertCurrent, verificationDispatch: dispatch };
        calls.set(callId, invocation);
        try {
          const result = await ctx.tools.execute({ callId, name: browserName, arguments: arguments_, signal: request.signal, agent });
          request.signal.throwIfAborted();
          if (assertCurrent) invariant(assertCurrent(), 'studio_native_verification_authority_stale');
          invariant(result?.isError === false && !result.concludesTurn && invocation.dispatched && invocation.observation,
            'studio_native_browser_verification_policy_blocked');
          return invocation.observation;
        } finally { calls.delete(callId); }
      } });
    },
    async artifactsFor(scope) {
      const primary = await createNativeArtifactStore({ directory: join(stateDir, 'result-artifacts'), scope });
      let commands;
      return { ...primary, read: async request => {
        try { return await primary.read(request); }
        catch (error) {
          if (error.code !== 'artifact_ref_unknown') throw error;
          commands ??= await createNativeArtifactStore({ directory: join(stateDir, 'command-artifacts'), scope });
          return commands.read(request);
        }
      } };
    },
    definitions(agent, assemblyTools, { deadlineDelivery = false, wallDeliveryPolicy, exactContentPolicy = false, directoryObservationPolicy, sourceObservationPolicy, toolDiscoveryPolicy, workspaceMediaPolicy, modelSurfacePolicy, childAllocationPolicy, childCapabilityPolicy, planModeMcpAccess = false, planModeCommandPolicy, workspaceEditPolicy, workspaceCheckpointDefinitions, executionTimeoutDefinitions, executionTimeoutPolicy, approvalPolicy, approvalDefinitions } = {}) {
      invariant(childCapabilityPolicy === undefined || childCapabilityPolicy === CHILD_CAPABILITY_POLICY, 'studio_native_child_capability_policy_invalid');
      invariant(modelSurfacePolicy === undefined || modelSurfacePolicy === 'bound-model-surface/v1', 'studio_native_model_surface_policy_invalid');
      invariant(childAllocationPolicy === undefined || childAllocationPolicy === 'parent-shared/v1', 'studio_native_child_allocation_policy_invalid');
      invariant(workspaceMediaPolicy === undefined || workspaceMediaPolicy === 'bounded-image-read/v1', 'studio_native_workspace_media_policy_invalid');
      invariant(workspaceCheckpointDefinitions === undefined || Array.isArray(workspaceCheckpointDefinitions), 'studio_native_checkpoint_definitions_invalid');
      invariant(workspaceEditPolicy === undefined || ['zcode-match/v1', 'zcode-match/v2'].includes(workspaceEditPolicy), 'studio_native_workspace_edit_policy_invalid');
      invariant(planModeCommandPolicy === undefined || planModeCommandPolicy === 'zcode-posix-readonly/v1', 'studio_native_plan_command_policy_invalid');
      invariant(typeof planModeMcpAccess === 'boolean' || Array.isArray(planModeMcpAccess)
        && planModeMcpAccess.every(name => typeof name === 'string'), 'studio_native_mcp_plan_selection_invalid');
      invariant(toolDiscoveryPolicy === undefined || toolDiscoveryPolicy === 'local-tool-search/v1', 'studio_native_tool_discovery_policy_invalid');
      invariant(sourceObservationPolicy === undefined || sourceObservationPolicy === 'workspace-source-model/v1', 'studio_native_source_policy_invalid');
      invariant(directoryObservationPolicy === undefined || /^studio-directory-observation\/v[1-3]$/.test(directoryObservationPolicy),
        'studio_native_directory_policy_invalid');
      invariant(wallDeliveryPolicy === undefined || typeof wallDeliveryPolicy === 'string'
        && /^deadline-delivery\/v[1-7]$/.test(wallDeliveryPolicy), 'studio_native_deadline_policy_invalid');
      const schemas = new Map((assemblyTools ?? []).map(schema => [schema.name, schema]));
      // Resolve THIS agent's session Memory owner so the caller-session's LOCKED
      // Memory formal is selected — not a global/last-bound one. The preset
      // gateway is shared across sessions; Memory tool definitions are
      // per-session (per-Build), so they must NOT live in the shared formal map.
      // When this session has NO Memory owner bound (e.g. base-bundle sampling
      // before bindMemory), Memory names are EXCLUDED entirely — no fallback to
      // a prompt-assembly Memory schema or another session's defs.
      const sessionOwner = memoryOwners.get(String(agent?.session?.id));
      const sessionMemoryDefs = sessionOwner?.definitions;
      const selected = new Set(allowed);
      // Exclude Memory names unless THIS session has a bound owner that actually
      // carries each name (a disabled write must not surface manage_memory, etc.).
      for (const name of memoryNames) { if (!sessionMemoryDefs?.has(name)) selected.delete(name); }
      if (hasSkills) {
        for (const name of ['skill', 'bash', 'pwsh']) if (schemas.has(name)) selected.add(name);
      }
      const version = wallDeliveryPolicy ? Number(wallDeliveryPolicy.at(-1)) : null;
      const allocatedRoles = childAllocationPolicy || childCapabilityPolicy ? this.childBindingFor({ childAllocationPolicy })?.roles ?? [] : [];
      const capabilities = childCapabilityPolicy ? childCapabilityDirectory(allocatedRoles, {
        tools: [...selected].map(name => ({ name })),
        mcpToolNames: childMcpBinding?.toolNames ?? [], skillToolNames: childSkillBinding?.toolNames ?? [],
      }) : undefined;
      const allocatedDefinitions = new Map(allocatedRoles.length ? nativeChildToolDefinitions(allocatedRoles.map(role => role.name),
        Math.max(120000, ...allocatedRoles.map(role => role.timeoutSeconds * 1000 + 15000)), { childCapabilityPolicy, capabilities }).map(definition => {
          for (const key of ['model_call_limit', 'tool_call_limit'])
            if (childAllocationPolicy && definition.parameters.properties[key]) delete definition.parameters.properties[key].default;
          return [definition.name, definition];
        }) : []);
      const deliveryEditor = version === null || version >= 5 && builtinNames.has('edit_workspace_file')
        && selected.has('edit_workspace_file') && formal.get('edit_workspace_file')?.readOnly === false;
      const deliverySelfRead = version === null || version >= 6 && deliveryEditor;
      return [...selected].map(name => {
        // Memory tools: select THIS session's owner locked formal only.
        if (memoryNames.has(name)) {
          const memDef = sessionMemoryDefs?.get(name);
          if (memDef) return structuredClone(memDef);
        }
        const exact = builtinNames.has(name) && formal.has(name) ? structuredClone(allocatedDefinitions.get(name) ?? formal.get(name)) : null;
        if (exact && workspaceToolNames.has(name) && !exact.readOnly && workspaceCheckpointDefinitions !== undefined) {
          const original = workspaceCheckpointDefinitions.find(tool => tool.name === name);
          for (const key of ['workspaceCheckpointPolicy', 'recoveryPolicy', 'workspaceRepairPolicy']) {
            delete exact[key]; if (original?.[key] !== undefined) exact[key] = original[key];
          }
        }
        const timeoutPolicy = executionTimeoutDefinitions === undefined
          ? (workspaceToolNames.has(name) || commandNames.has(name)) && executionTimeoutPolicy
          : executionTimeoutDefinitions.find(tool => tool.name === name)?.executionTimeoutPolicy;
        if (exact) return { ...structuredClone(exact),
          ...(name === 'read_workspace_file' && workspaceMediaPolicy ? { workspaceMediaPolicy,
            description: exact.description.replace('Read a UTF-8 workspace file.', 'Read workspace text or PNG, JPEG, GIF and WebP images. Images are bounded binary observations sent only to image-capable models.') } : {}),
          ...(['dispatch/v1', 'dispatch/v2'].includes(timeoutPolicy) ? { executionTimeoutPolicy: timeoutPolicy } : {}),
          ...(workspaceEditPolicy && ['edit_workspace_file', 'multi_edit_workspace_file'].includes(name) ? { workspaceEditPolicy } : {}),
          ...(workspaceEditPolicy === 'zcode-match/v2' && name === 'edit_workspace_file' ? {
            description: exact.description + ' Use empty old_text to create a missing file or replace an existing whitespace-only file after a full fresh read. Empty old_text cannot overwrite nonblank content.',
          } : {}),
          ...(name === 'run_command' && commandBackend === 'local_process' && planModeCommandPolicy
            ? { planModeCommandPolicy } : {}),
          ...(sourceObservationPolicy && exact.readOnly && exact.contextRole === 'workspace_read'
            ? { sourceObservationPolicy, resultArchivePolicy: 'archived-model-view/v5' } : {}),
          ...(directoryObservationPolicy && exact.readOnly && exact.contextRole === 'workspace_list' ? {
            directoryObservationPolicy, resultArchivePolicy: 'archived-model-view/v4',
            description: exact.description + (directoryObservationPolicy.endsWith('/v3') ? DIRECTORY_SCOPE_MODEL_DESCRIPTION : DIRECTORY_MODEL_DESCRIPTION),
          } : {}),
          ...(exactContentPolicy && !exact.readOnly && (name === 'write_workspace_file' || name === 'edit_workspace_file' && deadlineDelivery && deliveryEditor)
            ? { exactContentPolicy: name === 'write_workspace_file' ? 'current-goal-utf8/v1' : 'complete-write-only/v1' } : {}),
          ...(deadlineDelivery && formal.has(name)
          ? name === 'read_workspace_file' && deliverySelfRead && exact.readOnly && exact.contextRole === 'workspace_read' ? { deliveryArtifactRole: 'read' }
            : (name === 'write_workspace_file' || name === 'edit_workspace_file' && deliveryEditor) && !exact.readOnly
              ? { deliveryWrite: true, ...(deliverySelfRead ? { deliveryArtifactRole: 'write' } : {}) } : {} : {}),
          ...(deadlineDelivery && deliveryEditor && ['write_workspace_file', 'edit_workspace_file'].includes(name)
            ? { description: exact.description + (name === 'write_workspace_file'
              ? ' Keep each call within the model output limit. For a large deliverable, write a complete first portion, then use the bound edit_workspace_file in later calls to replace a known unique tail or marker with the next portion. Wait for each successful receipt; incomplete calls wrote nothing. A partial file does not complete the task.'
              : ' This Build permits exact edits during deadline delivery when this tool is admitted. Extend an already successfully written deliverable in bounded portions using an exact unique tail or marker; do not resend its whole body. Approval, current file revision and replacement checks still apply.') } : {}),
          ...(name === browserName && visionTimeouts.has(String(agent?.session?.id))
          ? { timeoutMs: visionTimeouts.get(String(agent.session.id)).timeoutMs } : {}) };
        const schema = schemas.get(name);
        invariant(schema, `studio_native_tool_schema_missing:${name}`);
        const mcpSchema = mcpSchemas.get(name);
        if (mcpSchema) invariant(canonical(schema.parameters) === canonical(mcpSchema.registryParameters), 'studio_native_mcp_schema_binding_changed');
        return {
          name, description: schema.description || '', parameters: structuredClone(mcpSchema?.input ?? schema.parameters),
          ...(toolDiscoveryPolicy ? { discovery: { deferred: true,
            ...(mcpContracts.has(name) ? { searchHint: `MCP ${String(mcpContracts.get(name).mcpResourceId || mcpContracts.get(name).resourceId)}` } : {}) } } : {}),
          // Unknown external effects are serialized and never granted safe-read
          // recovery from a catalog hint. Actual permissions remain in DSH.
          readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 60_000,
          ...(mcpPlanAccess.has(name) && (planModeMcpAccess === true || Array.isArray(planModeMcpAccess) && planModeMcpAccess.includes(name))
            ? { planModeAccess: structuredClone(mcpPlanAccess.get(name)) } : {}),
          contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
        };
      }).map(tool => {
        const permission = approvalDefinitions === undefined ? approvalPolicy
          : approvalDefinitions.find(original => original.name === tool.name)?.approvalPolicy;
        if (!permission) return tool;
        invariant(permission === NATIVE_DURABLE_APPROVAL && this.durableApprovalContract === permission,
          'studio_native_durable_approval_host_unavailable');
        return { ...tool, approvalPolicy: permission,
          concurrentSafe: tool.concurrentSafe && nativeAgentPolicyDecision(config.boundToolPolicy, tool.name, tool.readOnly) !== 'ask' };
      }).map(tool => {
        if (!modelSurfacePolicy || !builtinNames.has(tool.name)) return tool;
        const modelGuidance = nativeToolModelGuidance(tool, { commandBackend });
        return modelGuidance.length ? { ...tool, modelGuidance } : tool;
      });
    },
    ...createNativeDshContextBinding({ ctx, workspace, pinnedRoot, instructionRoots, builtinNames, workspaceToolNames, isClosed: () => closed }),
    forChild: createNativeDshChildBinding({ pinnedRoot, commandNames, commandBackend, a2a, childMcpBinding, childSkillBinding,
      allowed, disclosureNames, mcpContracts, a2aNames, formal, template, memoryNames, hash }),
    forAgent(agent, commandAuthority) {
      return createNativeDshAgentTools({ isClosed: () => closed,
        WORKSPACE_REPAIR_TOOL, a2a, a2aOwners, allowed, argumentEncoding, browserName,
        browserTools, builtinNames, calls, codeNames, codeToolsFor, commandBackend,
        commandNames, commandToolsFor, componentOwners, ctx, disclosureNames, disclosureOwners,
        formal, hasSkills, hash, mcpContracts, memoryOwners, remoteSkillOwners,
        remoteSkills, resultRetention, skillSource, state, stateDir, webEnvironmentSnapshot, webFetch, durableApproval,
        webOwners, workspace, workspaceToolNames, durableApprovalContract: this.durableApprovalContract
      }, agent, commandAuthority);
    },
  };
}
