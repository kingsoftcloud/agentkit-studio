import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, copy, invariant } from '../contracts/native-values.mjs';
import { toolInputRejection } from '../contracts/tool-input.mjs';
import { redactDiagnosticText } from '../diagnostic-text.mjs';
import { matchSkillRefs, studioSkillReadDefinitions } from './studio-skill-tool-contracts.mjs';

const formal = new Map(studioSkillReadDefinitions().map(tool => [tool.name, tool]));
const folded = value => value.trim().toLowerCase();
const failure = (error_type, error_message) => ({ ok: false, error_type, error_message });

function untilAborted(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function visibleSpaces(payload) {
  const data = payload?.data ?? payload?.Data ?? {};
  const spaces = data.SkillSpaces ?? data.skill_spaces ?? data.Spaces ?? data.spaces ?? data.Items ?? data.items;
  return Array.isArray(spaces) ? spaces.filter(item => item && typeof item === 'object').map(item => ({
    space_id: String(item.SkillSpaceId || item.skill_space_id || item.SpaceId || item.space_id || ''),
    space_name: String(item.SkillSpaceName || item.skill_space_name || item.SpaceName || item.space_name || ''),
    description: String(item.Description || item.description || ''),
  })) : [];
}

const oneLine = text => String(text ?? '').trim().replace(/\s+/gu, ' ').slice(0, 240).trimEnd();
const manifest = ({ skill, spaceId }) => ({ name: skill.name.trim(), description: oneLine(skill.description),
  version: String(skill.version ?? '').trim(), space_id: spaceId,
  ...(skill.aliases?.length ? { aliases: oneLine(skill.aliases.join(', ')) } : {}),
  ...(skill.tags?.length ? { tags: oneLine(skill.tags.join(', ')) } : {}) });

async function scriptFiles(root, assertCurrent) {
  const files = [];
  async function scan(directory, depth) {
    if (depth > 3 || files.length >= 20) return;
    const info = await lstat(join(root, ...directory)).catch(() => null);
    assertCurrent();
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    const entries = await readdir(join(root, ...directory), { withFileTypes: true }).catch(() => []);
    assertCurrent();
    for (const entry of entries) {
      if (files.length >= 20) break;
      const parts = [...directory, entry.name];
      if (entry.isDirectory()) await scan(parts, depth + 1);
      if (!entry.isFile()) continue;
      const info = await lstat(join(root, ...parts)).catch(() => null);
      assertCurrent();
      if (info?.isFile() && info.size <= 64 * 1024) files.push(parts.join('/'));
    }
  }
  if (root) await scan(['scripts'], 0);
  return files;
}

/** Skill reads use Studio's authenticated directory and verified archive loader. */
export function createStudioSkillReads({ serviceClient, loadSkill, userSpaces = [], publicSpaces = [], publicAllowlist = [] }) {
  const users = new Set(userSpaces), publics = new Set(publicSpaces), allowlist = new Set(publicAllowlist.map(folded));
  const configured = new Set([...users, ...publics]);
  const all = [...configured];

  async function matchingSpaces(input, context) {
    const key = input?.trim();
    const publicSelected = key === 'public' || publics.has(key);
    invariant(input == null || (publicSelected ? publics.size > 0 : users.has(key)), 'SKILL_SPACE_NOT_BOUND');
    const selectedUsers = input == null ? [...users] : publicSelected ? [] : [key];
    const entries = [];
    for (const spaceId of selectedUsers) {
      const listing = await serviceClient.listSkillsBySpaceId(spaceId, context);
      context.assertCurrent();
      invariant(!listing.truncated, 'SKILL_LISTING_INCOMPLETE');
      for (const skill of listing.activeSkills ?? []) entries.push({ spaceId, skill });
    }
    if (publics.size && (input == null || publicSelected)) {
      const listing = await serviceClient.listAvailablePremadeSkills(context);
      context.assertCurrent();
      invariant(!listing.truncated, 'SKILL_LISTING_INCOMPLETE');
      const spaceId = listing.spaceId || 'public';
      invariant(publics.has(spaceId) && (!key || key === 'public' || spaceId === key), 'SKILL_SPACE_NOT_BOUND');
      for (const skill of listing.activeSkills ?? []) {
        if (skill.name && (!allowlist.size || allowlist.has(folded(skill.name)))) entries.push({ spaceId, skill });
      }
    }
    return entries;
  }

  const handlers = {
    async list_skill_spaces(_args, context) {
      let spaces = [];
      try { spaces = visibleSpaces(await serviceClient.listSkillSpaces(context)); }
      catch { /* retain the locally configured inventory during a directory outage */ }
      context.assertCurrent();
      if (!spaces.length) spaces = all.map(space_id => ({ space_id, space_name: '', description: '' }));
      return { ok: true, configured_space_ids: [...all], spaces: spaces.map(entry => ({ ...entry, configured: configured.has(entry.space_id) })) };
    },
    async list_skills({ space_id }, context) {
      const skill_space_ids = space_id ? [space_id] : [...all];
      try {
        const entries = await matchingSpaces(space_id, context), skills = [], names = new Set();
        for (const entry of entries) {
          if (!entry.skill.name || names.has(folded(entry.skill.name))) continue;
          names.add(folded(entry.skill.name));
          skills.push(manifest(entry));
          if (skills.length === 30) break;
        }
        return { ok: true, skills, truncated: entries.length > skills.length, skill_space_ids, space_id: space_id ?? null };
      } catch (error) {
        context.assertCurrent();
        return { ...readFailure(error), skill_space_ids, space_id: space_id ?? null };
      }
    },
    async search_skills({ query, max_results = 10, space_id }, context) {
      query = query.trim();
      if (!query) return { ok: false, error_message: 'query is required' };
      const entries = await matchingSpaces(space_id, context);
      const spaceOf = new Map(entries.map(({ skill, spaceId }) => [skill, spaceId]));
      const matches = matchSkillRefs(entries.map(entry => entry.skill), query, { limit: max_results });
      return { ok: true, query, space_id: space_id ?? null, results: matches.map(({ skill, score, reason }) => ({
        name: skill.name, description: skill.description, version: skill.version, score, reason,
        aliases: skill.aliases ?? [], tags: skill.tags ?? [], space_id: spaceOf.get(skill),
      })) };
    },
    load_skill: (args, context) => describeSkill(args, context, false),
    preview_skill: (args, context) => describeSkill(args, context, true),
  };

  async function describeSkill({ skill_name, space_id }, context, preview) {
    const target = folded(skill_name);
    if (!target) return { ok: false, error_message: 'skill_name is required' };
    const entries = await matchingSpaces(space_id, context);
    const entry = entries.find(({ skill }) => folded(skill.name) === target);
    if (!entry) return { ok: false, error_message: redactDiagnosticText(`Skill not found: ${skill_name}`, 1024), space_id: space_id ?? null,
      available_skills: entries.map(({ skill }) => skill.name).filter(Boolean) };
    const { skill, spaceId } = entry;
    const { skillId, versionId, name, contentHash } = skill;
    const data = { ok: true, name, description: skill.description || '', space_id: spaceId, skill_id: skillId || '',
      version_id: versionId || '', version: skill.version || '' };
    if (preview) return { ...data, execution_context: 'manifest_preview', cache_hit: false, has_scripts_dir: false,
      script_files: [], instructions: data.description, usage: 'Manifest-level preview. For full SKILL.md instructions, use load_skill.' };
    if (!loadSkill) return { ...failure('SKILL_LOADER_UNAVAILABLE', 'No skill loader is configured on this Host.'),
      space_id: spaceId, skill_id: data.skill_id, version_id: data.version_id };
    const loaded = await loadSkill({ skillId, versionId, name, contentHash: contentHash || '', spaceId, ...context });
    context.assertCurrent();
    if (!loaded?.content) return { ...failure('SKILL_MANIFEST_MISSING', 'The selected Skill did not provide a SKILL.md manifest.'),
      space_id: spaceId, skill_id: data.skill_id, version_id: data.version_id };
    if (loaded.skillId !== skillId || loaded.versionId !== versionId || loaded.spaceId !== spaceId || contentHash && loaded.contentHash !== contentHash)
      return failure('SKILL_LOADER_IDENTITY_MISMATCH', 'The loader did not attest the selected Skill identity, version and content hash.');
    const root = loaded.rootDir || '', scripts = await scriptFiles(root, context.assertCurrent);
    return { ...data, execution_context: 'outer_agent', cache_hit: Boolean(loaded.cacheHit), root_dir: root,
      has_scripts_dir: scripts.length > 0, script_files: scripts, instructions: loaded.content,
      usage: "Read these instructions and complete the user's task in the outer agent unless the skill explicitly requires isolated execution." };
  }

  return { async execute(request) {
    const definition = formal.get(request?.call?.name);
    if (!definition) return { ok: false, error_type: 'skill_read_tool_unbound', executed: false };
    const rejection = toolInputRejection(definition, request.call);
    if (rejection) return { ...rejection, ok: false, executed: false };
    const { signal, assertCurrent: authority } = request;
    invariant(signal instanceof AbortSignal && typeof authority === 'function', 'skill_read_authority_required');
    const body = ({ signal: _, assertCurrent: __, ...json }) => canonical(json);
    const identity = body(request), args = copy(request.call.arguments), handler = handlers[definition.name];
    const stable = () => {
      signal.throwIfAborted();
      invariant(request.signal === signal && request.assertCurrent === authority && body(request) === identity, 'skill_read_request_drifted');
    };
    const assertCurrent = () => {
      stable();
      const current = authority();
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      invariant(current === true, 'skill_read_authority_expired');
      stable();
      return true;
    };
    try {
      const result = await untilAborted(() => { assertCurrent(); return handler(args, { signal, assertCurrent }); }, signal);
      assertCurrent();
      return result;
    } catch (error) {
      return { ...readFailure(error), executed: false };
    }
  } };
}

function readFailure(error) {
  if (error?.code === 'SKILL_SPACE_NOT_BOUND') return failure(error.code, 'The selected Skill Space is not bound.');
  if (error?.code === 'SKILL_LISTING_INCOMPLETE') return failure(error.code, 'Skill Space listing is incomplete.');
  const code = /^(?:NATIVE_)?SKILL_[A-Z0-9_]{1,70}$/u.test(error?.code ?? '') ? error.code : 'SKILL_READ_FAILED';
  return failure(code, 'Unable to read the selected Skill resource.');
}
