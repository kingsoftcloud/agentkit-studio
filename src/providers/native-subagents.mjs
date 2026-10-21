import { createHash } from 'node:crypto';
import { canonical, configure, invariant, submissionOutputFormat } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeChildOwner } from '../../packages/agentkit-harness/src/native/child-owner.mjs';
import { createNativeChildResultTools } from '../../packages/agentkit-harness/src/native/child-readers.mjs';
import { nativeGoalContract } from './native-verification.mjs';

export const STUDIO_NATIVE_CHILD_CONTRACT = 'agentkit.studio-native-children/v1';
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
export async function createStudioNativeChildren({ roles, scope, store, tools, hasSkills, hasMcp,
  resolveModel, bindTools, verificationFactory, mediaSources = new Map() }) {
  if (!roles.length) return null;
  const byName = new Map(roles.map(role => [role.name, role]));
  const bindings = new Map();
  for (const role of roles) {
    invariant(!role.inheritSkills || !hasSkills, 'studio_native_child_skill_binding_unavailable');
    invariant(!role.inheritMcp || !hasMcp, 'studio_native_child_mcp_binding_unavailable');
    const granted = role.tools.map(name => tools.find(tool => tool.name === name));
    invariant(granted.every(tool => tool?.readOnly === true && !tool.childBudgetPolicy
      && ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'lint_workspace_file', 'search_workspace_files'].includes(tool.name)),
    'studio_native_child_write_role_requires_isolation');
    const model = await resolveModel(role.modelProfileId);
    bindings.set(role.name, { model, tools: granted });
  }
  const childScope = role => ({ ...scope, agentId: `${scope.agentId}:child:${role.name}` });
  const readers = createNativeChildResultTools({ scope, childScopes: roles.map(childScope), store, roles: roles.map(role => role.name) });
  const owner = createNativeChildOwner({ scope, childScopes: roles.map(childScope), store,
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
      const ports = bindTools({ scope: child, store, sessionId: request.childSessionId, toolNames: role.tools });
      const verification = await verificationFactory({ scope: child, sessionId: request.childSessionId });
      request.signal.throwIfAborted();
      return { scope: child, configuration: configure({ profile: bound.model.profile, contextPolicy: bound.model.contextPolicy,
        guidancePolicy: 'boundary-guide/v1',
        ...(media.length ? { inputMessages: [{ role: 'user', kind: 'user_input', content: request.task, media }] } : {}),
        instructions: role.instructions, contract, tools: bound.tools,
        hostBindingDigest: hash({ contract: STUDIO_NATIVE_CHILD_CONTRACT, role, profile: bound.model.profile, scope: child, tools: bound.tools,
          ...(parentOutputDigest ? { parentOutputDigest } : {}) }),
        delegationDepth: request.depth, limits: { maxModelCalls: role.maxTurns, maxToolCalls: role.maxToolCalls ?? (role.tools.length ? role.maxTurns * 4 : 0),
          maxRepairs: Math.min(2, role.maxTurns - 1), maxSubagentDepth: request.depth, maxWallMs: role.timeoutSeconds * 1000,
          effectTimeoutMs: Math.max(120000, bound.model.profile.requestTimeoutMs + 10000) } }),
      ports: { ...ports, model: bound.model.model, context: bound.model.context, verification } };
    },
    restoreChild: async ({ identity, configuration, binding }) => {
      const bound = bindings.get(binding.role), role = byName.get(binding.role);
      const parent = store.load(binding.parent.scope, binding.parent.runId);
      const call = parent.intents.find(item => item.operationKey === binding.parentOperationKey)?.payload.calls
        ?.find(item => item.callId === binding.parentToolCallId);
      invariant(call && role, 'studio_native_child_restore_binding_changed');
      const { parentOutputDigest } = outputSchema(role, call.arguments, parent.snapshot.taskContract ?? parent.configuration.contract);
      invariant(bound && role && canonical(configuration.tools) === canonical(bound.tools)
        && canonical(configuration.profile) === canonical(bound.model.profile)
        && configuration.hostBindingDigest === hash({ contract: STUDIO_NATIVE_CHILD_CONTRACT, role,
          profile: bound.model.profile, scope: childScope(role), tools: bound.tools,
          ...(parentOutputDigest ? { parentOutputDigest } : {}) }), 'studio_native_child_restore_binding_changed');
      return { ...bindTools({ scope: identity.scope, store, sessionId: identity.sessionId, toolNames: role.tools }),
        model: bound.model.model, context: bound.model.context,
        verification: await verificationFactory({ scope: identity.scope, sessionId: identity.sessionId }) };
    },
  });
  return { owner, contract: STUDIO_NATIVE_CHILD_CONTRACT, roles: structuredClone(roles),
    execute: request => ['native_start_child', 'native_delegate'].includes(request.call.name) ? owner.start(request)
      : request.call.name === 'native_child_control' ? owner.control(request) : readers.execute(request) };
}
