// DSH provider binding for Native Skills builtin tools.
//
// Wires createNativeSkillTools into the Studio Native harness with the
// Host's serverClient (skillAction), skillDiscovery, loadSkillFn, and an
// optional executeWorkflow port. The parent Host is responsible for passing
// these real service adapters at bind time.

import { createHash } from 'node:crypto';
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
  serviceClient: rawServiceClient, skillDiscovery, loadSkillFn, executeWorkflow, authorize,
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

  const serviceClient = rawServiceClient ? wrapServiceClient(rawServiceClient) : null;

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
    serviceClient, skillDiscovery, loadSkillFn, executeWorkflow, authorize,
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

/** Wrap the Host's serverClient.skillAction into the SkillServiceClientPort.
 *
 * The server-client.mjs skillAction returns { data, requestId } where data is
 * the response envelope's Data field. Pagination follows the Python
 * SkillServiceClient pattern with PageNumber/PageSize and TotalCount checking.
 * The signal is passed through to the underlying fetch for cancellation.
 *
 * GAP for parent: server-client.mjs SKILL_SERVICE_ACTIONS currently includes
 * only ListSkillsBySpaceId, GetSkillDownloadUrl, GetPremadeSkillDownloadUrl.
 * ListSkillSpaces and ListAvailablePremadeSkills must be added to the
 * allowlist for full cloud Skill Space listing. */
function wrapServiceClient(serverClient) {
  invariant(typeof serverClient.skillAction === 'function', 'studio_native_skills_service_client_invalid');

  function parseSkillRef(item) {
    const skillId = String(item.SkillId || item.skill_id || item.Id || item.id || '').trim();
    const versionId = String(item.VersionId || item.version_id || item.VersionID || '').trim();
    const name = String(item.Name || item.name || '').trim();
    return {
      name, skillId, versionId,
      version: String(item.Version || item.version || '').trim(),
      description: String(item.Description || item.description || '').trim(),
      aliases: parseList(item.Aliases || item.aliases),
      tags: parseList(item.Tags || item.tags),
      cacheKey: String(item.CacheKey || item.cache_key || skillId || name).trim(),
      contentHash: String(item.ContentHash || item.content_hash || item.Hash || item.hash || '').trim(),
    };
  }

  function parseList(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }

  return {
    async listSkillSpaces({ signal } = {}) {
      return serverClient.skillAction('ListSkillSpaces', {}, { signal });
    },
    async listSkillsBySpaceId(spaceId, { signal, maxPages = 20 } = {}) {
      const allSkills = [];
      let totalCount = null;
      for (let page = 1; page <= maxPages; page++) {
        const payload = await serverClient.skillAction('ListSkillsBySpaceId', { SpaceId: spaceId, PageNumber: page, PageSize: 100 }, { signal });
        const data = payload?.data || payload?.Data || {};
        const raw = data.Skills || data.skills || data.Items || data.items || [];
        if (typeof data.TotalCount === 'number') totalCount = data.TotalCount;
        if (typeof data.totalCount === 'number') totalCount = data.totalCount;
        if (!raw.length) break;
        const pageSkills = raw.filter(item => item && typeof item === 'object').map(parseSkillRef);
        // Deduplicate by skillId+versionId within pagination.
        for (const skill of pageSkills) {
          const dedupKey = `${skill.skillId}:${skill.versionId}`;
          if (!allSkills.some(s => `${s.skillId}:${s.versionId}` === dedupKey)) allSkills.push(skill);
        }
        if (raw.length < 100) break;
        if (totalCount != null && allSkills.length >= totalCount) break;
      }
      return { activeSkills: allSkills, spaceId, truncated: totalCount != null && allSkills.length < totalCount };
    },
    async listAvailablePremadeSkills({ signal } = {}) {
      const payload = await serverClient.skillAction('ListAvailablePremadeSkills', {}, { signal });
      const data = payload?.data || payload?.Data || {};
      const raw = data.PremadeSkills || data.premade_skills || data.Skills || data.skills || data.Items || data.items || [];
      return {
        activeSkills: raw.filter(item => item && typeof item === 'object').map(parseSkillRef),
        spaceId: String(data.SpaceId || data.space_id || 'public'),
      };
    },
    async downloadSkillArchive(skill, { signal } = {}) {
      const action = skill.versionId ? 'GetSkillDownloadUrl' : 'GetPremadeSkillDownloadUrl';
      const payload = await serverClient.skillAction(action, { SkillId: skill.skillId, ...(skill.versionId ? { VersionId: skill.versionId } : {}) }, { signal });
      const data = payload?.data || payload?.Data || {};
      const url = String(data.DownloadUrl || data.download_url || data.Url || data.url || '').trim();
      if (!url) throw Object.assign(new Error('Skill download URL is missing'), { code: 'SKILL_DOWNLOAD_URL_MISSING' });
      return { url, skill };
    },
  };
}
