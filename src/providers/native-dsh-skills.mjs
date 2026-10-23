// DSH provider binding for Native Skills builtin tools.
//
// Wires createNativeSkillTools into the Studio Native harness with the
// Host's serverClient (skillAction), skillDiscovery, loadSkillFn, and an
// optional executeWorkflow port. The parent Host is responsible for passing
// these real service adapters at bind time.

import { createHash } from 'node:crypto';
import { createNativeSkillService } from './native-skill-service.mjs';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeSkillTools, SKILL_TOOL_CONTRACT } from '../../packages/agentkit-harness/src/native/skill-tools.mjs';

export const STUDIO_NATIVE_SKILLS_BINDING = 'agentkit.studio-native-skills/v1';

/** Create the DSH Skill tools provider for one Agent binding.
 *
 * All configuration is deep-cloned and snapshotted at bind time. The
 * bindingDigest is an opaque sha256 hash that includes publicAllowlist,
 * boundSkillNames, and the Host-provided backend binding digest; it never
 * contains credentials or function source code. */
export function createStudioNativeSkills({
  serviceClient: rawServiceClient, skillDiscovery, loadSkillFn, executeWorkflow, locateWorkflow, authorize,
  skillSpaceIds = [], publicSpaceIds = [], publicAllowlist = [], boundSkillNames = [], manifestLimit = 30,
  agentId, agentRevision, buildId = null, sealedBinding = {}, backendBindingDigest = '',
} = {}) {
  invariant(typeof authorize === 'function', 'studio_native_skills_authorize_required');
  invariant(typeof agentId === 'string' && agentId.trim(), 'studio_native_skills_agent_id_required');
  invariant(Number.isSafeInteger(agentRevision) && agentRevision > 0, 'studio_native_skills_agent_revision_required');
  invariant(!(loadSkillFn || executeWorkflow) || typeof backendBindingDigest === 'string' && backendBindingDigest.trim(),
    'studio_native_skills_backend_binding_required');

  const sealedSkillSpaceIds = copy(skillSpaceIds);
  const sealedPublicSpaceIds = copy(publicSpaceIds);
  const sealedPublicAllowlist = copy(publicAllowlist);
  const sealedBoundSkillNames = copy(boundSkillNames);
  const sealedBindingCopy = copy(sealedBinding);

  const serviceClient = rawServiceClient ? createNativeSkillService(rawServiceClient) : null;

  // Fix #6: bindingDigest includes publicAllowlist, boundSkillNames, and a
  // Host-provided backendBindingDigest (not function.toString()). The
  // sealedBinding identity is also included. No credentials.
  const bindingDigest = createHash('sha256').update(canonical({
    contract: STUDIO_NATIVE_SKILLS_BINDING, toolContract: SKILL_TOOL_CONTRACT, agentId, agentRevision, buildId,
    skillSpaceIds: sealedSkillSpaceIds, publicSpaceIds: sealedPublicSpaceIds,
    publicAllowlist: sealedPublicAllowlist, boundSkillNames: sealedBoundSkillNames,
    manifestLimit, hasExecuteWorkflow: typeof executeWorkflow === 'function',
    backendBindingDigest: backendBindingDigest || null,
    sealedBinding: sealedBindingCopy,
  })).digest('hex');

  const tools = createNativeSkillTools({
    serviceClient, skillDiscovery, loadSkillFn, executeWorkflow, locateWorkflow, authorize,
    skillSpaceIds: sealedSkillSpaceIds, publicSpaceIds: sealedPublicSpaceIds,
    publicAllowlist: sealedPublicAllowlist, boundSkillNames: sealedBoundSkillNames,
    manifestLimit, binding: { ...sealedBindingCopy, agentId, agentRevision, buildId },
  });

  return {
    definitions: copy(tools.definitions),
    forAgent: (agent, authority) => tools.forAgent(agent, authority),
    bindingDigest,
    contract: STUDIO_NATIVE_SKILLS_BINDING,
  };
}
