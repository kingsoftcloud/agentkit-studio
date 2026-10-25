import { createHash } from 'node:crypto';
import { canonical, configure, invariant, submissionOutputFormat, artifactToolDefinitions, isArtifactTool } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeChildOwner } from '../../packages/agentkit-harness/src/native/child-owner.mjs';
import { createNativeChildResultTools } from '../../packages/agentkit-harness/src/native/child-readers.mjs';
import { nativeGoalContract } from './native-verification.mjs';
import { createStudioNativeChildMerge } from './native-child-merge.mjs';
import { previousChildPublication } from '../../packages/agentkit-harness/src/native/child-publication.mjs';
import { nativeA2aReceiptWaitSource } from './native-a2a-receipt.mjs';
import { nativeA2aToolDefinitions } from '../../packages/agentkit-harness/src/native/a2a-tools.mjs';

export const STUDIO_NATIVE_CHILD_CONTRACT = 'agentkit.studio-native-children/v2';
export const STUDIO_NATIVE_CHILD_SKILLS_CONTRACT = 'agentkit.studio-child-borrowed-skills/v1';
const workspaceTools = new Set(['workspace_status', 'list_workspace_files', 'read_workspace_file', 'lint_workspace_file',
  'search_workspace_files', 'write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
  'multi_edit_workspace_file', 'delete_workspace_file']);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
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
/** Revision-owned declarations use the same camel/snake aliases as SubAgentBinding. */
export function nativeChildRoles(spec = {}) {
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
    const result = { description: '', tools: [], timeoutSeconds: 120, maxTurns: 4, maxTotalTokens: null, maxArtifacts: null,
      maxToolCalls: null, concurrentSafe: false, outputSchema: null, dependsOn: [], failurePolicy: 'propagate', maxRetries: 0,
      inheritSkills: true, inheritMcp: false, modelProfileId: null, ...role };
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
export async function createStudioNativeChildren({ roles, scope, sessionId, store, tools, hasSkills, hasMcp, mcpBinding, skillBinding, skillInstructions,
  resolveModel, bindTools, verificationFactory, fileWorkspaces, isClosed, a2aBinding, waitForChildReceipt, mediaSources = new Map(), artifactPolicy, artifactFactory }) {
  if (!roles.length) return null;
  invariant(artifactPolicy == null || artifactPolicy === 'runtime-artifacts/v1' && typeof artifactFactory === 'function',
    'studio_native_child_artifact_binding_invalid');
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
    const isolatedWrite = granted.some(tool => tool && !tool.readOnly && workspaceTools.has(tool.name));
    invariant(granted.every(tool => tool && !tool.childBudgetPolicy && (workspaceTools.has(tool.name)
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
    bindings.set(role.name, { model, tools: [...granted, ...mcpTools, ...skillTools,
      ...(artifactPolicy ? artifactToolDefinitions() : [])], isolatedWrite,
      ...(childA2a ? { a2aBinding: structuredClone(childA2a) } : {}),
      ...(inheritedSkills ? { skillBinding: structuredClone(skillBinding) } : {}),
      ...(inheritedMcp ? { mcpBinding: structuredClone(mcpBinding) } : {}) });
  }
  const childScope = role => ({ ...scope, agentId: `${scope.agentId}:child:${role.name}` });
  const merge = [...bindings.values()].some(binding => binding.isolatedWrite)
    ? createStudioNativeChildMerge({ scope, sessionId, store, roles, fileWorkspaces, isClosed,
      previousPublication: previousChildPublication, authorize: async () => 'allow' }) : null;
  const readers = createNativeChildResultTools({ scope, childScopes: roles.map(childScope), store, roles: roles.map(role => role.name) });
  const owner = createNativeChildOwner({ scope, childScopes: roles.map(childScope), store,
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
      const child = childScope(role), contract = nativeGoalContract({ sessionId: request.childSessionId, goal: request.task });
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
      const ports = bindTools({ scope: child, store, sessionId: request.childSessionId,
        toolNames: bound.tools.filter(tool => !artifactPolicy || !isArtifactTool(tool.name)).map(tool => tool.name),
        ...(bound.a2aBinding ? { a2aBinding: bound.a2aBinding } : {}),
        ...(childSkills ? { childSkills } : {}),
        ...(bound.mcpBinding ? { mcpBinding: bound.mcpBinding } : {}),
        ...(isolated ? { workspaceRoot: isolated.root, workspaceBinding: isolated.binding } : {}) });
      const verification = await verificationFactory({ scope: child, sessionId: request.childSessionId,
        ...(isolated ? { workspaceRoot: isolated.root } : {}) });
      request.signal.throwIfAborted();
      return { scope: child, configuration: configure({ profile: bound.model.profile, contextPolicy: bound.model.contextPolicy,
        ...(artifactPolicy ? { artifactPolicy } : {}),
        guidancePolicy: 'boundary-guide/v1',
        ...(media.length ? { inputMessages: [{ role: 'user', kind: 'user_input', content: request.task, media }] } : {}),
        instructions: [role.instructions, ...(childSkills ? [skillInstructions] : [])].filter(Boolean).join('\n\n'), contract, tools: bound.tools,
        modelRecoveryPolicy: bound.model.modelRecoveryPolicy ?? 'manual',
        ...(isolated || childSkills ? { hostRecoveryBinding: {
          ...(isolated ? { childWorkspace: isolated.binding } : {}), ...(childSkills ? { childSkills } : {}),
        } } : {}),
        hostBindingDigest: hash({ contract: STUDIO_NATIVE_CHILD_CONTRACT, role, profile: bound.model.profile, scope: child, tools: bound.tools,
          ...(artifactPolicy ? { artifactPolicy } : {}),
          ...(bound.mcpBinding ? { inheritedMcp: bound.mcpBinding } : {}),
          ...(bound.a2aBinding ? { inheritedA2a: bound.a2aBinding } : {}),
          ...(childSkills ? { inheritedSkills: childSkills } : {}),
          ...(isolated ? { childWorkspace: isolated.binding } : {}),
          ...(parentOutputDigest ? { parentOutputDigest } : {}) }),
        delegationDepth: request.depth, limits: { maxModelCalls: role.maxTurns,
          maxToolCalls: role.maxToolCalls ?? (bound.tools.some(tool => !artifactPolicy || !isArtifactTool(tool.name)) ? role.maxTurns * 4 : 0),
          maxRepairs: Math.min(2, role.maxTurns - 1), maxSubagentDepth: request.depth, maxWallMs: role.timeoutSeconds * 1000,
          effectTimeoutMs: Math.max(120000, bound.model.profile.requestTimeoutMs + 10000) } }),
      ports: { ...ports, ...(artifactPolicy ? { artifacts: await artifactFactory(child) } : {}),
        model: bound.model.model, context: bound.model.context, verification } };
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
      // configure() fills retry/output defaults before persisting the profile.
      // Reconstruct the same normalized profile, rather than comparing it to
      // the Host's deliberately partial input and rejecting every live child.
      const profile = bound && configure({ profile: bound.model.profile, contract: configuration.contract,
        hostBindingDigest: configuration.hostBindingDigest }).profile;
      invariant(bound && role && canonical(configuration.tools) === canonical(bound.tools)
        && (configuration.artifactPolicy ?? null) === (artifactPolicy ?? null)
        && canonical(configuration.profile) === canonical(profile)
        && configuration.modelRecoveryPolicy === (bound.model.modelRecoveryPolicy ?? 'manual')
        && configuration.hostBindingDigest === hash({ contract: STUDIO_NATIVE_CHILD_CONTRACT, role,
          profile: bound.model.profile, scope: childScope(role), tools: bound.tools,
          ...(artifactPolicy ? { artifactPolicy } : {}),
          ...(bound.mcpBinding ? { inheritedMcp: bound.mcpBinding } : {}),
          ...(bound.a2aBinding ? { inheritedA2a: bound.a2aBinding } : {}),
          ...(childSkills ? { inheritedSkills: childSkills } : {}),
          ...(isolated ? { childWorkspace: isolated.binding } : {}),
          ...(parentOutputDigest ? { parentOutputDigest } : {}) }), 'studio_native_child_restore_binding_changed');
      return { ...bindTools({ scope: identity.scope, store, sessionId: identity.sessionId,
        toolNames: bound.tools.filter(tool => !artifactPolicy || !isArtifactTool(tool.name)).map(tool => tool.name),
        ...(bound.a2aBinding ? { a2aBinding: bound.a2aBinding } : {}),
        ...(childSkills ? { childSkills } : {}),
        ...(bound.mcpBinding ? { mcpBinding: bound.mcpBinding } : {}),
        ...(isolated ? { workspaceRoot: isolated.root, workspaceBinding: isolated.binding } : {}) }),
        ...(artifactPolicy ? { artifacts: await artifactFactory(identity.scope) } : {}),
        model: bound.model.model, context: bound.model.context,
        verification: await verificationFactory({ scope: identity.scope, sessionId: identity.sessionId,
          ...(isolated ? { workspaceRoot: isolated.root } : {}) }) };
    },
  });
  return { owner, contract: STUDIO_NATIVE_CHILD_CONTRACT, roles: structuredClone(roles),
    execute: request => ['native_start_child', 'native_delegate'].includes(request.call.name) ? owner.start(request)
      : request.call.name === 'native_child_control' ? owner.control(request)
        : request.call.name === 'native_child_merge' && merge ? merge.execute(request) : readers.execute(request) };
}
