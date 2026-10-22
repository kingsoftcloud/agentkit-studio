// Real Skill Service client adapter for the Node Native harness.
//
// Ports ksadk/skills/service_client.py (SkillServiceClient KOP pagination)
// and ksadk/skills/models.py (SkillListResponse, SkillRef, ContentHash) into
// a Node adapter that wraps serverClient.skillAction(action, params, {signal}).
//
// The adapter assumes KOP pagination (PageNumber/PageSize/TotalCount), which
// is the production AICP protocol. Legacy REST endpoints without pagination
// are not inferred from missing TotalCount and are not exposed by this port.
// ListAvailablePremadeSkills is a single-call protocol
// with no pagination (matching Python).
//
// Pagination contract (mirrors Python service_client.py:128-182, enhanced):
//   - Page 1 also validates missing skillId, duplicate id+versionId, len>100
//   - Every page validates SkillSpaceId === requested spaceId
//   - TotalCount drift between pages (including null↔value) → directory_changed
//   - Duplicate skillId+versionId across pages → pagination_repeated
//   - Short page with remaining total → directory_incomplete (no next page)
//   - len > total on any page → directory_changed
//   - Full page (100) with no total → must continue to next page
//   - Page budget exhaustion → page_budget_exhausted + nextPage
//   - is_active: status empty or in {active, available, enabled}
//
// The Studio skillAction transport is explicitly KOP-only. Unlike Python's
// generic SDK this adapter does not guess or offer a legacy REST transport.
// Cross-page version changes are reported as an incomplete directory; URLs
// must be HTTPS at the shared Node archive-download boundary.

export function createNativeSkillService(serverClient) {
  if (!serverClient || typeof serverClient.skillAction !== 'function') {
    throw Object.assign(new Error('serverClient.skillAction is required'), { code: 'native_skill_service_client_invalid' });
  }

  // --- ContentHash (models.py) ----------------------------------------------

  function parseContentHash(raw) {
    const normalized = String(raw || '').trim();
    if (!normalized) return null;
    if (!normalized.includes(':')) return { algorithm: 'sha256', value: normalized.toLowerCase() };
    const idx = normalized.indexOf(':');
    return { algorithm: normalized.slice(0, idx).trim().toLowerCase(), value: normalized.slice(idx + 1).trim().toLowerCase() };
  }

  // --- parseStringTuple (models.py) -----------------------------------------

  function parseStringTuple(raw) {
    if (raw == null) return [];
    const values = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
    return values.map(v => String(v).trim()).filter(Boolean);
  }

  function parseDictOrNone(raw) {
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : null;
  }

  // --- SkillRef (models.py) -------------------------------------------------

  function parseSkillRef(item) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw Object.assign(new Error('Skill item must be an object'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' });
    }
    const skillId = String(item.SkillId || item.skill_id || '').trim();
    const versionId = String(item.VersionId || item.version_id || '').trim();
    const version = String(item.Version || item.version || '').trim();
    const name = String(item.Name || item.name || '').trim();
    const status = String(item.Status || item.status || '').trim();
    const contentHash = parseContentHash(item.ContentHash || item.content_hash);
    const cacheKey = buildCacheKey(skillId, name, versionId, version, contentHash);
    return {
      skillId, versionId, version, name, status,
      description: String(item.Description || item.description || '').trim(),
      contentHash: contentHash ? `${contentHash.algorithm}:${contentHash.value}` : '',
      archiveUri: String(item.ArchiveUri || item.archive_uri || '').trim(),
      aliases: parseStringTuple(item.Aliases || item.aliases),
      tags: parseStringTuple(item.Tags || item.tags),
      examples: parseStringTuple(item.Examples || item.examples),
      inputSchema: parseDictOrNone(item.InputSchema || item.input_schema),
      runtimeRequirements: parseDictOrNone(item.RuntimeRequirements || item.runtime_requirements),
      cacheKey,
    };
  }

  function buildCacheKey(skillId, name, versionId, version, contentHash) {
    const identity = skillId || name;
    let versionKey = versionId || version;
    if (!versionKey && contentHash) versionKey = contentHash.value;
    return [identity, versionKey].filter(Boolean).map(p => p.replace(/[/]/g, '_').replace(/:/g, '_')).join('__');
  }

  function isSkillActive(skill) {
    return !skill.status || ['active', 'available', 'enabled'].includes(skill.status.toLowerCase());
  }

  // --- SkillListResponse parsing (models.py) --------------------------------

  function parseListResponse(payload, fallbackSpaceId, fallbackSpaceName) {
    const data = payload?.data ?? payload?.Data ?? {};
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw Object.assign(new Error('Skill directory response must contain an object'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' });
    }
    const skillsRaw = data.Skills ?? data.skills ?? data.Items ?? data.items;
    if (skillsRaw === null || skillsRaw === undefined) {
      // null/undefined skills → empty list (Python allows this)
    } else if (!Array.isArray(skillsRaw)) {
      throw Object.assign(new Error('Skill directory items must be an array'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' });
    } else if (skillsRaw.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) {
      throw Object.assign(new Error('Skill directory items must be objects'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' });
    }
    let total = data.TotalCount ?? data.total_count ?? payload?.TotalCount;
    if (total !== undefined && total !== null) {
      if (typeof total === 'string' && /^\d+$/.test(total)) total = parseInt(total, 10);
      if (typeof total !== 'number' || total < 0 || !Number.isSafeInteger(total)) {
        throw Object.assign(new Error('Skill directory total count is invalid'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' });
      }
    } else {
      total = null; // normalize undefined/null to null
    }
    const skills = (skillsRaw || []).map(parseSkillRef);
    return {
      requestId: String(payload?.requestId ?? payload?.RequestId ?? ''),
      spaceId: String(data.SkillSpaceId ?? data.skill_space_id ?? fallbackSpaceId ?? ''),
      spaceName: String(data.SkillSpaceName ?? data.skill_space_name ?? fallbackSpaceName ?? ''),
      skills,
      code: 0, message: '',
      totalCount: total,
    };
  }

  // --- per-page validation (enhanced beyond Python) --------------------------

  function validatePageSkills(pageSkills, seen, versions) {
    if (pageSkills.length > 100) return 'directory_changed';
    const identities = pageSkills.map(s => `${s.skillId}:${s.versionId}`);
    // Missing skillId
    if (identities.some(id => !id.split(':')[0])) return 'pagination_repeated';
    // Duplicate within this page
    if (new Set(identities).size !== identities.length) return 'pagination_repeated';
    // Duplicate across pages
    if (identities.some(id => seen.has(id))) return 'pagination_repeated';
    if (pageSkills.some(skill => versions.has(skill.skillId) && versions.get(skill.skillId) !== skill.versionId))
      return 'directory_changed';
    return null;
  }

  // --- guard: signal + assertCurrent ----------------------------------------

  function preCheck(signal, assertCurrent) {
    if (signal?.aborted) throw Object.assign(new Error('Skill Service request cancelled'), { code: 'REQUEST_CANCELLED' });
    if (typeof assertCurrent === 'function') {
      const result = assertCurrent();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      if (result !== true) throw Object.assign(new Error('Skill Service request authorization expired'), { code: 'SKILL_AUTHORIZATION_EXPIRED' });
    }
  }

  function postCheck(signal, assertCurrent) {
    if (signal?.aborted) throw Object.assign(new Error('Skill Service request cancelled after call'), { code: 'REQUEST_CANCELLED' });
    if (typeof assertCurrent === 'function') {
      const result = assertCurrent();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      if (result !== true) throw Object.assign(new Error('Skill Service request authorization expired after call'), { code: 'SKILL_AUTHORIZATION_EXPIRED' });
    }
  }

  // --- listSkillSpaces ------------------------------------------------------

  async function listSkillSpaces({ signal, assertCurrent } = {}) {
    preCheck(signal, assertCurrent);
    const payload = await serverClient.skillAction('ListSkillSpaces', { PageNumber: 1, PageSize: 100 }, { signal });
    postCheck(signal, assertCurrent);
    return payload; // raw envelope for parseSkillSpaces
  }

  // --- listSkillsBySpaceId (KOP pagination, enhanced) ------------------------

  async function listSkillsBySpaceId(spaceId, { signal, assertCurrent, maxPages = 20 } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
      throw Object.assign(new Error('Skill directory page budget must be 1..1000'), { code: 'SKILL_PAGE_BUDGET_INVALID' });
    }

    let skills = [];
    let total = null; // null = unknown (no TotalCount in response)
    const seen = new Set();
    const versions = new Map();

    for (let page = 1; page <= maxPages; page++) {
      preCheck(signal, assertCurrent);
      const pagePayload = await serverClient.skillAction('ListSkillsBySpaceId', { SpaceId: spaceId, PageNumber: page, PageSize: 100 }, { signal });
      postCheck(signal, assertCurrent);
      const result = parseListResponse(pagePayload, spaceId);

      // Validate membership on every page before adding any returned entries.
      if (result.spaceId !== spaceId) {
        return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'directory_changed', totalCount: total, allSkills: skills };
      }

      // Any total-count transition changes the directory snapshot.
      if (page > 1 && result.totalCount !== total) {
        return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'directory_changed', totalCount: total, allSkills: skills };
      }
      total = result.totalCount;

      // Validate identities on the first page and all subsequent pages.
      const pageError = validatePageSkills(result.skills, seen, versions);
      if (pageError) {
        return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: pageError, totalCount: total, allSkills: skills };
      }

      // More skills than total → directory_changed.
      if (total !== null && result.skills.length > total) {
        return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'directory_changed', totalCount: total, allSkills: skills };
      }
      // Accumulated more than total → directory_changed.
      if (total !== null && skills.length + result.skills.length > total) {
        return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'directory_changed', totalCount: total, allSkills: skills };
      }

      // Add page skills to accumulator.
      for (const s of result.skills) { seen.add(`${s.skillId}:${s.versionId}`); versions.set(s.skillId, s.versionId); }
      skills.push(...result.skills);

      // Completion checks (order matters):
      if (total !== null) {
        if (skills.length === total) {
          return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: false, paginationWarning: '', totalCount: total, allSkills: skills };
        }
        if (skills.length > total) {
          return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'directory_changed', totalCount: total, allSkills: skills };
        }
        // Short page with remaining total → directory_incomplete (don't fetch next).
        if (result.skills.length < 100) {
          return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'directory_incomplete', totalCount: total, allSkills: skills };
        }
      } else {
        // No total: full page (100) → must continue to next page.
        // Short page (<100) → complete (no more pages expected).
        if (result.skills.length < 100) {
          return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: false, paginationWarning: '', totalCount: null, allSkills: skills };
        }
        // Full page with no total → continue to next page.
        if (page === maxPages) {
          return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'page_budget_exhausted', totalCount: null, allSkills: skills, nextPage: maxPages + 1 };
        }
      }
    }

    // Page budget exhausted.
    return { activeSkills: skills.filter(isSkillActive), spaceId, truncated: true, paginationWarning: 'page_budget_exhausted', totalCount: total, allSkills: skills, nextPage: maxPages + 1 };
  }

  // --- listAvailablePremadeSkills (single call, no pagination) ----------------

  async function listAvailablePremadeSkills({ signal, assertCurrent } = {}) {
    preCheck(signal, assertCurrent);
    const payload = await serverClient.skillAction('ListAvailablePremadeSkills', {}, { signal });
    postCheck(signal, assertCurrent);
    const result = parseListResponse(payload, 'public', 'Public Skills');
    if (result.totalCount !== null && result.totalCount > result.skills.length) {
      return { activeSkills: result.skills.filter(isSkillActive), spaceId: result.spaceId || 'public', truncated: true, paginationWarning: 'pagination_unavailable', totalCount: result.totalCount, allSkills: result.skills };
    }
    return { activeSkills: result.skills.filter(isSkillActive), spaceId: result.spaceId || 'public', truncated: false, paginationWarning: '', totalCount: result.totalCount, allSkills: result.skills };
  }

  // --- downloadSkillArchive --------------------------------------------------

  async function downloadSkillArchive(skill, { signal, assertCurrent } = {}) {
    if (!skill?.skillId) throw Object.assign(new Error('Skill skillId is required for download'), { code: 'SKILL_DOWNLOAD_INVALID' });
    preCheck(signal, assertCurrent);
    const action = skill.versionId ? 'GetSkillDownloadUrl' : 'GetPremadeSkillDownloadUrl';
    const payload = await serverClient.skillAction(action, { SkillId: skill.skillId, ...(skill.versionId ? { VersionId: skill.versionId } : {}) }, { signal });
    postCheck(signal, assertCurrent);
    const data = payload?.data ?? payload?.Data ?? {};
    const url = String(data.DownloadUrl ?? data.download_url ?? '').trim();
    if (!url) throw Object.assign(new Error(`Skill Service did not return DownloadUrl for ${skill.skillId}`), { code: 'SKILL_DOWNLOAD_URL_MISSING' });
    // HTTPS only — no http, no credentials in URL, no fragment.
    if (!url.startsWith('https://')) {
      throw Object.assign(new Error('Skill download URL must be HTTPS'), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
    }
    // Reject URLs with credentials (user:pass@host) — they leak secrets.
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        throw Object.assign(new Error('Skill download URL must not contain credentials'), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
      }
      if (parsed.hash) {
        throw Object.assign(new Error('Skill download URL must not contain a fragment'), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
      }
    } catch (error) {
      if (error.code === 'SKILL_DOWNLOAD_URL_INVALID') throw error;
      throw Object.assign(new Error('Skill download URL is malformed'), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
    }
    // Return the verified URL and skill — the parent's actual loader handles
    // the download. This method does not download or produce side effects.
    return { url, skill };
  }

  return { listSkillSpaces, listSkillsBySpaceId, listAvailablePremadeSkills, downloadSkillArchive };
}
