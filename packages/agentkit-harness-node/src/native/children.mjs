import { createHash } from 'node:crypto';
import { canonical, configure, invariant, submissionOutputFormat, artifactToolDefinitions, isArtifactTool, toolDiscoveryDefinitions,
  TOOL_SEARCH, DEFERRED_TOOL_CALL, TODO_READ, TODO_WRITE, RESPOND_TO_COORDINATOR, CHILD_TASK_POLICY,
  COORDINATOR_RESPONSE_POLICY, todoToolDefinitions, coordinatorResponseDefinition,
  CHILD_PLAN_POLICY, CHILD_PLAN_MODE_POLICY } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeChildOwner, CHILD_ALLOCATION_POLICY, roleAllocationDefaults } from '@kingsoftcloud/agentkit-harness-node/native/child-owner';
import { createNativeChildResultTools } from '@kingsoftcloud/agentkit-harness-node/native/child-readers';
import { nativeChildModelSurface } from './child-model-surface.mjs';
import { createStudioNativeChildMerge } from './child-merge.mjs';
import { previousChildPublication } from '@kingsoftcloud/agentkit-harness-node/native/child-publication';
import { nativeA2aReceiptWaitSource } from './a2a-receipt-source.mjs';
import { nativeA2aToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/a2a-tools';
import { NATIVE_CHILD_WORKSPACE_TOOLS, NATIVE_CHILD_COMMAND_TOOLS } from './child-workspace-tools.mjs';
import { validChildCommandResource } from './child-command-resource.mjs';
import { CHILD_CAPABILITY_POLICY, admitChildCapabilities } from './child-capabilities.mjs';
import { createNativeWorkspaceInstructions } from './workspace-instructions.mjs';
import { nativeWorkspaceContextBinding, validateNativeWorkspaceContext } from './workspace-context.mjs';
import { nativeInstructionTouches } from './instruction-context.mjs';

export const STUDIO_NATIVE_CHILD_CONTRACT = 'agentkit.studio-native-children/v2';
export const STUDIO_NATIVE_CHILD_SKILLS_CONTRACT = 'agentkit.studio-child-borrowed-skills/v1';
const workspaceTools = new Set(NATIVE_CHILD_WORKSPACE_TOOLS);
const commandTools = new Set(NATIVE_CHILD_COMMAND_TOOLS);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function validateInstructionWorkspace(childContext, isolated, parentContext) {
  if (!childContext) return;
  validateNativeWorkspaceContext(childContext);
  const root = isolated?.root ?? parentContext?.workspaceRoot;
  invariant(typeof root === 'string' && childContext.workspaceRoot === nativeWorkspaceContextBinding(root).workspaceRoot,
    'studio_native_child_instruction_workspace_changed');
}
function instructionPorts(reader, { context, input, store, scope, sessionId, tools }) {
  if (!reader) return { context, ...(input ? { input } : {}) };
  const builtinNames = new Set(tools.map(tool => tool.name));
  return { context: { ...context, readSource: request => reader.readSource(request) }, input: { prepare: async request => {
    const result = input ? await input.prepare(request) : { status: 'admitted', messages: [] };
    if (result.status === 'rejected') return result;
    const evidence = store.workspaceTouchEvidence ? store.workspaceTouchEvidence(scope, request.runId) : store.load(scope, request.runId);
    const touches = nativeInstructionTouches(evidence, { sessionId, builtinNames, workspaceToolNames: workspaceTools,
      workspace: reader.workspaceRoot });
    return { ...result, instructionScopes: await reader.scopes(evidence.instructionScopes
      ?? evidence.snapshot?.context.instructionScopes, touches, request.signal) };
  } } };
}
const isDiscoveryControl = name => name === TOOL_SEARCH || name === DEFERRED_TOOL_CALL;
const gatewayToolNames = (tools, artifactPolicy, toolDiscoveryPolicy, childTaskPolicy) => tools.filter(tool => (!artifactPolicy || !isArtifactTool(tool.name))
  && (!toolDiscoveryPolicy || !isDiscoveryControl(tool.name))
  && (!childTaskPolicy || ![TODO_READ, TODO_WRITE, RESPOND_TO_COORDINATOR].includes(tool.name))).map(tool => tool.name);
const parentOutputSchema = contract => {
  const schema = contract?.finalSubmissionSchema, key = contract?.finalSubmissionPayloadKey;
  const output = key ? schema?.properties?.[key] : schema;
  invariant(output?.type === 'object', 'studio_native_child_parent_output_unavailable');
  return structuredClone(output);
};
const outputSchema = (role, args, contract) => {
  invariant(args.output_format === undefined || ['text', 'json_object'].includes(args.output_format), 'studio_native_child_output_format_invalid');
  invariant(args.output_contract === undefined || args.output_contract === 'parent' && args.output_format === 'json_object',
    'studio_native_child_parent_output_invalid');
  invariant(args.output_format !== 'json_object' || role.outputSchema === null || role.outputSchema.type === 'object', 'studio_native_child_output_conflict');
  if (args.output_contract === 'parent') {
    const parent = parentOutputSchema(contract);
    return { schema: role.outputSchema ? { type: 'object', allOf: [structuredClone(role.outputSchema), parent] } : parent,
      parentOutputDigest: hash(parent) };
  }
  return { schema: role.outputSchema ?? (args.output_format === 'json_object' ? { type: 'object' } : null) };
};
const keys = ['name', 'instructions', 'description', 'tools', 'timeoutSeconds', 'maxTurns', 'maxTotalTokens', 'maxArtifacts',
  'maxToolCalls', 'concurrentSafe', 'outputSchema', 'dependsOn', 'failurePolicy', 'maxRetries', 'inheritSkills', 'inheritMcp', 'modelProfileId'];
const camel = key => key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
/** Revision-owned declarations use the same camel/snake aliases as SubAgentBinding.
 *  Under `childAllocationPolicy: 'parent-shared/v1'`, an omitted `maxTurns`/`timeoutSeconds`
 *  defaults to a bounded useful allowance (16 / 900s) instead of the legacy 4 / 120s, so the
 *  child's admission defers to the parent's actual remaining budget. Absent policy keeps
 *  the historical defaults so old normalized role shapes and digests are byte-identical. */
export function nativeChildRoles(spec = {}, { childAllocationPolicy } = {}) {
  const defaults = roleAllocationDefaults(childAllocationPolicy);
  invariant(!(spec.subAgents !== undefined && spec.sub_agents !== undefined), 'studio_native_child_roles_conflict');
  const raw = spec.subAgents ?? spec.sub_agents ?? [];
  invariant(Array.isArray(raw) && raw.length <= 32, 'studio_native_child_roles_invalid');
  const roles = raw.map(value => {
    invariant(value && typeof value === 'object' && !Array.isArray(value), 'studio_native_child_role_invalid');
    const role = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = camel(key);
      invariant(keys.includes(normalized) && !Object.hasOwn(role, normalized), 'studio_native_child_role_option_unsupported');
      role[normalized] = structuredClone(item);
    }
    const result = { description: '', tools: [], timeoutSeconds: defaults.timeoutSeconds, maxTurns: defaults.maxTurns,
      maxTotalTokens: null, maxArtifacts: null, maxToolCalls: defaults.maxToolCalls, concurrentSafe: false, outputSchema: null,
      dependsOn: [], failurePolicy: 'propagate', maxRetries: 0, inheritSkills: true, inheritMcp: false, modelProfileId: null, ...role };
    invariant(typeof result.name === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(result.name)
      && typeof result.instructions === 'string' && result.instructions.trim() && result.instructions.length <= 32768
      && typeof result.description === 'string' && result.description.length <= 1024
      && Array.isArray(result.tools) && result.tools.length <= 64 && new Set(result.tools).size === result.tools.length
      && result.tools.every(name => typeof name === 'string' && name.trim())
      && typeof result.timeoutSeconds === 'number' && Number.isFinite(result.timeoutSeconds) && result.timeoutSeconds > 0 && result.timeoutSeconds <= 3600
      && Number.isSafeInteger(result.maxTurns) && result.maxTurns >= 1 && result.maxTurns <= 32
      && (result.maxToolCalls === null || Number.isSafeInteger(result.maxToolCalls) && result.maxToolCalls >= 0 && result.maxToolCalls <= 100000)
      && ['concurrentSafe', 'inheritSkills', 'inheritMcp'].every(key => typeof result[key] === 'boolean')
      && (result.modelProfileId === null || typeof result.modelProfileId === 'string' && result.modelProfileId.trim())
      && (result.outputSchema === null || result.outputSchema && typeof result.outputSchema === 'object' && !Array.isArray(result.outputSchema)),
    'studio_native_child_role_invalid');
    invariant(result.maxTotalTokens === null && result.maxArtifacts === null && Array.isArray(result.dependsOn)
      && result.dependsOn.length === 0 && result.failurePolicy === 'propagate' && result.maxRetries === 0,
    'studio_native_child_policy_unavailable');
    return result;
  });
  invariant(new Set(roles.map(role => role.name)).size === roles.length, 'studio_native_child_role_duplicate');
  return roles;
}

/** Bind every child to a declared role and its own scoped tool state. */
export async function createNativeChildren({ roles, scope, sessionId, store, tools, hasSkills, hasMcp, mcpBinding, skillBinding, skillInstructions, workspaceContext,
  resolveModel, bindTools, verificationFactory, fileWorkspaces, commandResource, isClosed, onStream, a2aBinding, waitForChildReceipt, mediaSources = new Map(), artifactPolicy, artifactFactory, sourceReadPolicy, childTaskPolicy, childPlanPolicy, childAllocationPolicy, childCapabilityPolicy, outputRecoveryPolicy, toolExecutionPolicy, modelSurface, goalContractFactory = ({ goal }) => ({ objective: goal }) }) {
  if (!roles.length) return null;
  if (workspaceContext !== undefined) {
    validateNativeWorkspaceContext(workspaceContext);
    invariant(workspaceContext.instructionSource, 'studio_native_child_instruction_source_unbound');
  }
  invariant(typeof goalContractFactory === 'function', 'native_child_goal_contract_factory_invalid');
  invariant(childAllocationPolicy === undefined || childAllocationPolicy === CHILD_ALLOCATION_POLICY, 'studio_native_child_allocation_policy_invalid');
  invariant(childCapabilityPolicy === undefined || childCapabilityPolicy === CHILD_CAPABILITY_POLICY, 'studio_native_child_capability_policy_invalid');
  invariant(toolExecutionPolicy === undefined || toolExecutionPolicy === 'owner-execution/v1', 'studio_native_child_execution_policy_invalid');
  invariant(outputRecoveryPolicy === undefined || outputRecoveryPolicy === 'response-boundary/v2', 'studio_native_child_output_policy_invalid');
  invariant(childTaskPolicy === undefined || childTaskPolicy === CHILD_TASK_POLICY, 'studio_native_child_task_policy_invalid');
  invariant(childPlanPolicy === undefined || childPlanPolicy === CHILD_PLAN_POLICY, 'studio_native_child_plan_policy_invalid');
  invariant(artifactPolicy == null || artifactPolicy === 'runtime-artifacts/v1' && typeof artifactFactory === 'function',
    'studio_native_child_artifact_binding_invalid');
  invariant(sourceReadPolicy == null || sourceReadPolicy === 'studio-source-read/v1' && artifactPolicy === 'runtime-artifacts/v1',
    'studio_native_child_source_binding_invalid');
  const byName = new Map(roles.map(role => [role.name, role]));
  const bindings = new Map();
  for (const role of roles) {
    const inheritedSkills = role.inheritSkills && hasSkills;
    invariant(!inheritedSkills || skillBinding?.contract === STUDIO_NATIVE_CHILD_SKILLS_CONTRACT
      && /^[a-f0-9]{64}$/.test(skillBinding.bindingDigest) && Array.isArray(skillBinding.toolNames)
      && skillBinding.toolNames.length === 4 && new Set(skillBinding.toolNames).size === 4
      && typeof skillInstructions === 'string', 'studio_native_child_skill_binding_unavailable');
    const inheritedMcp = role.inheritMcp && hasMcp;
    invariant(!inheritedMcp || mcpBinding?.contract === 'agentkit.studio-child-borrowed-mcp/v1'
      && /^[a-f0-9]{64}$/.test(mcpBinding.bindingDigest) && Array.isArray(mcpBinding.toolNames)
      && mcpBinding.toolNames.length && new Set(mcpBinding.toolNames).size === mcpBinding.toolNames.length,
    'studio_native_child_mcp_binding_unavailable');
    const granted = role.tools.map(name => tools.find(tool => tool.name === name));
    const a2aNames = new Set(a2aBinding ? nativeA2aToolDefinitions({ receiptObservation: true }).map(tool => tool.name) : []);
    const childA2a = granted.some(tool => a2aNames.has(tool?.name)) ? a2aBinding : null;
    const usesCommands = granted.some(tool => commandTools.has(tool?.name));
    invariant(!usesCommands || validChildCommandResource(commandResource) && fileWorkspaces && !role.concurrentSafe,
      'studio_native_child_command_resource_unavailable');
    const isolatedWrite = usesCommands || granted.some(tool => tool && !tool.readOnly && workspaceTools.has(tool.name));
    invariant(granted.every(tool => tool && !tool.childBudgetPolicy && (workspaceTools.has(tool.name)
      || usesCommands && commandTools.has(tool.name)
      || a2aNames.has(tool.name) && (!role.concurrentSafe || tool.readOnly))
      && !mcpBinding?.toolNames.includes(tool.name))
      && (!isolatedWrite || fileWorkspaces && !role.concurrentSafe),
    'studio_native_child_write_role_requires_isolation');
    const mcpTools = inheritedMcp ? mcpBinding.toolNames.map(name => tools.find(tool => tool.name === name)) : [];
    invariant(mcpTools.every(tool => tool && !granted.some(item => item.name === tool.name)
      && (!role.concurrentSafe || tool.readOnly === true)), 'studio_native_child_mcp_role_unsafe');
    const model = await resolveModel(role.modelProfileId);
    const skillTools = inheritedSkills ? skillBinding.toolNames.map(name => tools.find(tool => tool.name === name)) : [];
    invariant(skillTools.every(tool => tool?.readOnly === true && tool.concurrentSafe === true
      && !granted.some(item => item.name === tool.name) && !mcpTools.some(item => item.name === tool.name)),
    'studio_native_child_skill_binding_unavailable');
    const toolDiscoveryPolicy = [...granted, ...mcpTools, ...skillTools].some(tool => tool.discovery) ? 'local-tool-search/v1' : undefined;
    const controls = childTaskPolicy ? [...todoToolDefinitions(!!toolDiscoveryPolicy), coordinatorResponseDefinition(!!toolDiscoveryPolicy)] : [];
    invariant(![...granted, ...mcpTools, ...skillTools].some(tool => controls.some(control => control.name === tool.name)),
      'studio_native_child_control_name_conflict');
    bindings.set(role.name, { model, ...(toolDiscoveryPolicy ? { toolDiscoveryPolicy } : {}), tools: [...granted, ...mcpTools, ...skillTools,
      ...controls,
      ...(toolDiscoveryPolicy ? toolDiscoveryDefinitions() : []),
      ...(artifactPolicy ? artifactToolDefinitions() : [])], isolatedWrite,
      ...(usesCommands ? { commandResource: structuredClone(commandResource) } : {}),
      ...(childA2a ? { a2aBinding: structuredClone(childA2a) } : {}),
      ...(inheritedSkills ? { skillBinding: structuredClone(skillBinding) } : {}),
      ...(inheritedMcp ? { mcpBinding: structuredClone(mcpBinding) } : {}) });
  }
  const childScope = role => ({ ...scope, agentId: `${scope.agentId}:child:${role.name}` });
  const merge = [...bindings.values()].some(binding => binding.isolatedWrite)
    ? createStudioNativeChildMerge({ scope, sessionId, store, roles, fileWorkspaces, isClosed,
      previousPublication: previousChildPublication, authorize: async () => 'allow' }) : null;
  const readers = createNativeChildResultTools({ scope, childScopes: roles.map(childScope), store, roles: roles.map(role => role.name) });
  const owner = createNativeChildOwner({ scope, onStream, childScopes: roles.map(childScope), store,
    ...(childCapabilityPolicy ? { admitRequirements: args => admitChildCapabilities(
      [...bindings].map(([role, bound]) => ({ role, tools: bound.tools.map(tool => tool.name).sort() })), args.role, args.required_tools) } : {}),
    ...(childAllocationPolicy ? { childAllocationPolicy } : {}),
    ...(waitForChildReceipt ? { canWaitForReceipt: record => !!nativeA2aReceiptWaitSource(record), waitForIdle: waitForChildReceipt } : {}),
    resolveChild: async request => {
      const role = byName.get(request.role), bound = bindings.get(request.role);
      invariant(role && bound, 'studio_native_child_role_unbound');
      const args = request.call.arguments;
      const refs = args.media ?? [];
      invariant(Array.isArray(refs) && refs.length <= 20 && refs.every(ref => ref && typeof ref === 'object'
        && Object.keys(ref).length === 2 && ref.source === 'parent_user_input' && Number.isSafeInteger(ref.index)
        && ref.index >= 0 && mediaSources.get(ref.index)), 'studio_native_child_media_reference_invalid');
      invariant(!refs.length || bound.model.supportsImages, 'studio_native_child_model_image_unavailable');
      const media = refs.map(ref => structuredClone(mediaSources.get(ref.index)));
      const child = childScope(role), contract = goalContractFactory({ sessionId: request.childSessionId, goal: request.task });
      if (args.continuation_of !== undefined) {
        const source = store.load(child, args.continuation_of).snapshot;
        const inheritedMedia = [...source.messages, ...source.queuedGuidance].some(message => message.media?.length);
        invariant(!inheritedMedia || bound.model.supportsImages, 'child_followup_model_image_unavailable');
      }
      const { schema: output, parentOutputDigest } = outputSchema(role, args, request.parentContract);
      if (output) {
        contract.finalSubmissionSchema = { type: 'object', properties: { output }, required: ['output'], additionalProperties: false };
        contract.finalSubmissionPayloadKey = 'output'; contract.finalOutputFormat = submissionOutputFormat(contract.finalSubmissionSchema, 'output');
      }
      const source = args.continuation_of === undefined ? null : store.load(child, args.continuation_of);
      const childSkills = bound.skillBinding ? { ...bound.skillBinding, role: structuredClone(role), buildId: request.parent.buildId } : null;
      invariant(!source || canonical(source.configuration.hostRecoveryBinding?.childSkills ?? null) === canonical(childSkills),
        'studio_native_child_skill_binding_changed');
      const isolated = bound.isolatedWrite ? fileWorkspaces.bind({ scope: child, sessionId: request.childSessionId, role,
        existing: Boolean(source), ...(source ? { expectedBinding: source.configuration.hostRecoveryBinding?.childWorkspace } : {}) }) : null;
      invariant(!source || !bound.isolatedWrite || source.configuration.hostRecoveryBinding?.childWorkspace,
        'studio_native_child_workspace_binding_changed');
      const childContext = source ? source.configuration.hostRecoveryBinding?.workspaceContext
        : workspaceContext ? nativeWorkspaceContextBinding(isolated?.root ?? workspaceContext.workspaceRoot,
          { instructionRoots: workspaceContext.instructionSource.globalRoots }) : undefined;
      validateInstructionWorkspace(childContext, isolated, workspaceContext);
      const instructionSource = childContext ? createNativeWorkspaceInstructions(childContext) : null;
      const executionResource = bound.commandResource ? { ...bound.commandResource, workspaceBindingDigest: hash(isolated.binding) } : undefined;
      invariant(!source || canonical(source.configuration.hostRecoveryBinding?.childExecutionResource ?? null) === canonical(executionResource ?? null),
        'studio_native_child_command_resource_changed');
      const hostBindingDigest = hash({ contract: STUDIO_NATIVE_CHILD_CONTRACT, role, profile: bound.model.profile, scope: child, tools: bound.tools,
        ...(outputRecoveryPolicy ? { outputRecoveryPolicy } : {}),
        ...(toolExecutionPolicy ? { toolExecutionPolicy } : {}),
        ...(childPlanPolicy ? { childPlanPolicy } : {}),
        ...(childTaskPolicy ? { childTaskPolicy } : {}),
        ...(childAllocationPolicy ? { childAllocationPolicy } : {}),
        ...(artifactPolicy ? { artifactPolicy } : {}),
        ...(sourceReadPolicy ? { sourceReadPolicy } : {}),
        ...(childContext ? { workspaceContext: childContext } : {}),
        ...(bound.mcpBinding ? { inheritedMcp: bound.mcpBinding } : {}),
        ...(bound.a2aBinding ? { inheritedA2a: bound.a2aBinding } : {}),
        ...(childSkills ? { inheritedSkills: childSkills } : {}),
        ...(isolated ? { childWorkspace: isolated.binding } : {}),
        ...(executionResource ? { childExecutionResource: executionResource } : {}),
        ...(parentOutputDigest ? { parentOutputDigest } : {}) });
      const ports = bindTools({ scope: child, store, sessionId: request.childSessionId,
        expectedHostBindingDigest: hostBindingDigest,
        toolNames: gatewayToolNames(bound.tools, artifactPolicy, bound.toolDiscoveryPolicy, childTaskPolicy),
        ...(bound.a2aBinding ? { a2aBinding: bound.a2aBinding } : {}),
        ...(childSkills ? { childSkills } : {}),
        ...(bound.mcpBinding ? { mcpBinding: bound.mcpBinding } : {}),
        ...(isolated ? { workspaceRoot: isolated.root, workspaceBinding: isolated.binding } : {}),
        ...(executionResource ? { executionResource } : {}) });
      const verification = await verificationFactory({ scope: child, sessionId: request.childSessionId,
        ...(isolated ? { workspaceRoot: isolated.root } : {}) });
      request.signal.throwIfAborted();
      return { scope: child, configuration: configure({ profile: bound.model.profile, contextPolicy: bound.model.contextPolicy,
        ...(instructionSource ? { contextSources: [instructionSource.source], inputPolicy: 'before-first-model/v1' } : {}),
        ...(modelSurface ? { modelSurface: nativeChildModelSurface(modelSurface, { workspaceRoot: isolated?.root,
          supportsImages: bound.model.supportsImages, tools: bound.tools }) } : {}),
        ...(childAllocationPolicy ? { childAllocationPolicy } : {}),
        ...(outputRecoveryPolicy ? { outputRecoveryPolicy } : {}),
        ...(toolExecutionPolicy ? { toolExecutionPolicy } : {}),
        ...(executionResource ? { backgroundNotificationPolicy: 'completed-before-model/v1' } : {}),
        ...(childTaskPolicy ? { todoPolicy: 'session-todos/v1', coordinatorResponsePolicy: COORDINATOR_RESPONSE_POLICY } : {}),
        ...(bound.toolDiscoveryPolicy ? { toolDiscoveryPolicy: bound.toolDiscoveryPolicy } : {}),
        ...(artifactPolicy ? { artifactPolicy } : {}),
        ...(sourceReadPolicy ? { sourceReadPolicy } : {}),
        guidancePolicy: 'boundary-guide/v1',
        ...(media.length ? { inputMessages: [{ role: 'user', kind: 'user_input', content: request.task, media }] } : {}),
        instructions: [role.instructions, ...(childSkills ? [skillInstructions] : [])].filter(Boolean).join('\n\n'), contract, tools: bound.tools,
        modelRecoveryPolicy: bound.model.modelRecoveryPolicy ?? 'manual',
        ...(isolated || childSkills || childContext ? { hostRecoveryBinding: {
          ...(childContext ? { workspaceContext: childContext } : {}),
          ...(isolated ? { childWorkspace: isolated.binding } : {}), ...(childSkills ? { childSkills } : {}),
          ...(executionResource ? { childExecutionResource: executionResource } : {}),
        } } : {}),
        hostBindingDigest,
        delegationDepth: request.depth, limits: { maxModelCalls: role.maxTurns,
          maxToolCalls: role.maxToolCalls ?? (bound.tools.some(tool => !artifactPolicy || !isArtifactTool(tool.name)) ? role.maxTurns * 4 : 0),
          maxRepairs: Math.min(2, role.maxTurns - 1), maxSubagentDepth: request.depth, maxWallMs: role.timeoutSeconds * 1000,
          // Dispatcher ceilings must admit the granted tool contracts. The
          // child's separate wall/model/tool budgets still bound execution.
          effectTimeoutMs: Math.max(120000, bound.model.profile.requestTimeoutMs + 10000,
            ...bound.tools.map(tool => tool.timeoutMs + 1)) } }),
      ports: { ...ports, ...(artifactPolicy ? { artifacts: await artifactFactory(child) } : {}),
        model: bound.model.model, ...instructionPorts(instructionSource, { context: bound.model.context,
          input: ports.input, store, scope: child, sessionId: request.childSessionId, tools: bound.tools }), verification } };
    },
    restoreChild: async ({ identity, configuration, binding }) => {
      const bound = bindings.get(binding.role), role = byName.get(binding.role);
      const parent = store.load(binding.parent.scope, binding.parent.runId);
      const call = parent.intents.find(item => item.operationKey === binding.parentOperationKey)?.payload.calls
        ?.find(item => item.callId === binding.parentToolCallId);
      invariant(call && role, 'studio_native_child_restore_binding_changed');
      const { parentOutputDigest } = outputSchema(role, call.arguments, parent.snapshot.taskContract ?? parent.configuration.contract);
      const childSkills = bound?.skillBinding ? { ...bound.skillBinding, role: structuredClone(role), buildId: identity.buildId } : null;
      invariant(canonical(configuration.hostRecoveryBinding?.childSkills ?? null) === canonical(childSkills),
        'studio_native_child_skill_binding_changed');
      const isolated = bound?.isolatedWrite ? fileWorkspaces.bind({ scope: identity.scope, sessionId: identity.sessionId,
        role, existing: true, expectedBinding: configuration.hostRecoveryBinding?.childWorkspace }) : null;
      invariant(!bound?.isolatedWrite || configuration.hostRecoveryBinding?.childWorkspace,
        'studio_native_child_workspace_binding_changed');
      const childContext = configuration.hostRecoveryBinding?.workspaceContext;
      validateInstructionWorkspace(childContext, isolated, workspaceContext);
      const instructionSource = childContext ? createNativeWorkspaceInstructions(childContext) : null;
      const executionResource = bound?.commandResource ? { ...bound.commandResource, workspaceBindingDigest: hash(isolated.binding) } : undefined;
      invariant(canonical(configuration.hostRecoveryBinding?.childExecutionResource ?? null) === canonical(executionResource ?? null)
        && configuration.backgroundNotificationPolicy === (executionResource ? 'completed-before-model/v1' : undefined),
        'studio_native_child_command_resource_changed');
      // configure() fills retry/output defaults before persisting the profile.
      // Reconstruct the same normalized profile, rather than comparing it to
      // the Host's deliberately partial input and rejecting every live child.
      const profile = bound && configure({ profile: bound.model.profile, contract: configuration.contract,
        hostBindingDigest: configuration.hostBindingDigest }).profile;
      invariant(bound && role && canonical(configuration.tools) === canonical(bound.tools)
        && configuration.outputRecoveryPolicy === outputRecoveryPolicy
        && configuration.toolExecutionPolicy === toolExecutionPolicy
        && configuration.inputPolicy === (instructionSource ? 'before-first-model/v1' : undefined)
        && canonical(configuration.contextSources) === canonical(instructionSource ? [instructionSource.source] : [])
        && (configuration.childAllocationPolicy ?? null) === (childAllocationPolicy ?? null)
        && (binding.childAllocationPolicy ?? null) === (childAllocationPolicy ?? null)
        && canonical(configuration.modelSurface ?? null) === canonical(nativeChildModelSurface(modelSurface, {
          workspaceRoot: isolated?.root, supportsImages: bound.model.supportsImages, tools: bound.tools,
          original: configuration.modelSurface }) ?? null)
        && configuration.planModePolicy === (childPlanPolicy ? CHILD_PLAN_MODE_POLICY : undefined)
        && configuration.planModeInitialActive === (childPlanPolicy ? binding.planMode : undefined)
        && configuration.todoPolicy === (childTaskPolicy ? 'session-todos/v1' : undefined)
        && configuration.coordinatorResponsePolicy === (childTaskPolicy ? COORDINATOR_RESPONSE_POLICY : undefined)
        && configuration.toolDiscoveryPolicy === bound.toolDiscoveryPolicy
        && (configuration.artifactPolicy ?? null) === (artifactPolicy ?? null)
        && (configuration.sourceReadPolicy ?? null) === (sourceReadPolicy ?? null)
        && canonical(configuration.profile) === canonical(profile)
        && configuration.modelRecoveryPolicy === (bound.model.modelRecoveryPolicy ?? 'manual')
        && configuration.hostBindingDigest === hash({ contract: STUDIO_NATIVE_CHILD_CONTRACT, role,
          profile: bound.model.profile, scope: childScope(role), tools: bound.tools,
          ...(outputRecoveryPolicy ? { outputRecoveryPolicy } : {}),
          ...(toolExecutionPolicy ? { toolExecutionPolicy } : {}),
          ...(childPlanPolicy ? { childPlanPolicy } : {}),
          ...(childTaskPolicy ? { childTaskPolicy } : {}),
          ...(childAllocationPolicy ? { childAllocationPolicy } : {}),
          ...(artifactPolicy ? { artifactPolicy } : {}),
          ...(sourceReadPolicy ? { sourceReadPolicy } : {}),
          ...(childContext ? { workspaceContext: childContext } : {}),
          ...(bound.mcpBinding ? { inheritedMcp: bound.mcpBinding } : {}),
          ...(bound.a2aBinding ? { inheritedA2a: bound.a2aBinding } : {}),
          ...(childSkills ? { inheritedSkills: childSkills } : {}),
          ...(isolated ? { childWorkspace: isolated.binding } : {}),
          ...(executionResource ? { childExecutionResource: executionResource } : {}),
          ...(parentOutputDigest ? { parentOutputDigest } : {}) }), 'studio_native_child_restore_binding_changed');
      const restoredPorts = bindTools({ scope: identity.scope, store, sessionId: identity.sessionId,
        expectedHostBindingDigest: configuration.hostBindingDigest,
        toolNames: gatewayToolNames(bound.tools, artifactPolicy, bound.toolDiscoveryPolicy, childTaskPolicy),
        ...(bound.a2aBinding ? { a2aBinding: bound.a2aBinding } : {}),
        ...(childSkills ? { childSkills } : {}),
        ...(bound.mcpBinding ? { mcpBinding: bound.mcpBinding } : {}),
        ...(isolated ? { workspaceRoot: isolated.root, workspaceBinding: isolated.binding } : {}),
        ...(executionResource ? { executionResource } : {}) });
      return { ...restoredPorts,
        ...(artifactPolicy ? { artifacts: await artifactFactory(identity.scope) } : {}),
        model: bound.model.model, ...instructionPorts(instructionSource, { context: bound.model.context,
          input: restoredPorts.input, store, scope: identity.scope, sessionId: identity.sessionId, tools: bound.tools }),
        verification: await verificationFactory({ scope: identity.scope, sessionId: identity.sessionId,
          ...(isolated ? { workspaceRoot: isolated.root } : {}) }) };
    },
  });
  return { owner, contract: STUDIO_NATIVE_CHILD_CONTRACT, roles: structuredClone(roles),
    execute: request => ['native_start_child', 'native_delegate'].includes(request.call.name) ? owner.start(request)
      : request.call.name === 'native_child_control' ? owner.control(request)
        : request.call.name === 'native_child_merge' && merge ? merge.execute(request) : readers.execute(request) };
}
