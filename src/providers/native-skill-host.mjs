/** Host-owned remote Skills assembly. Discovery/download use the existing
 * authenticated Node Skill Service; loading does not execute a workflow. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonical, invariant } from '../contracts/native-values.mjs';
import { privateDirectory } from '../host/private-state.mjs';
import { matchSkillRefs } from './studio-skill-tool-contracts.mjs';

export { createNativeSkillConnection, STUDIO_NATIVE_REMOTE_SKILLS } from './native-skill-connection.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function ids(values) {
  invariant(Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === 'string'
    && value.trim() && Buffer.byteLength(value) <= 4096), 'NATIVE_SKILL_SPACES_INVALID');
  return [...new Set(values.map(value => value.trim()))];
}
const csv = (env, key) => {
  const value = env[key] ?? ''; invariant(typeof value === 'string', 'NATIVE_SKILL_ENV_INVALID');
  return value.split(',').map(value => value.trim()).filter(Boolean);
};

/** Shared Host-private cache boundary; owner is the caller's actual identity. */
export function nativeSkillSessionCache({ stateRoot, workspaceRoot, owner }) {
  // Canonicalize the trusted Host's existing prefix once (e.g. macOS /var
  // aliases /private/var). New private descendants still reject links, and
  // every later operation revalidates the original supplied path too.
  let ancestor = resolve(stateRoot); const missing = [];
  while (!existsSync(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const lexical = join(realpathSync(ancestor), ...missing), workspace = realpathSync(workspaceRoot);
  invariant(lexical !== workspace && !lexical.startsWith(workspace + sep), 'NATIVE_SKILL_CACHE_INSIDE_WORKSPACE');
  privateDirectory(lexical, true);
  const root = realpathSync(lexical);
  const cacheDir = join(root, hash(owner)); privateDirectory(cacheDir, true);
  const pinned = lstatSync(cacheDir);
  const assertStorage = () => {
    invariant(realpathSync(stateRoot) === root && realpathSync(lexical) === root
      && realpathSync(workspaceRoot) === workspace, 'NATIVE_SKILL_CACHE_CHANGED');
    privateDirectory(cacheDir);
    const current = lstatSync(cacheDir);
    invariant(current.ino === pinned.ino && current.dev === pinned.dev, 'NATIVE_SKILL_CACHE_CHANGED');
  };
  return { workspace, cacheDir, assertStorage };
}

export function nativeSkillSpaceSettings(config = {}, env = {}) {
  const userSpaces = ids([...(config.skillSpaceIds ?? []), ...csv(env, 'KSADK_SKILL_SPACE_IDS'),
    ...(!env.KSADK_SKILL_SPACE_IDS ? csv(env, 'SKILL_SPACE_ID') : [])]);
  const publicSpaces = ids(csv(env, 'KSADK_PUBLIC_SKILL_SPACE_IDS'));
  return { userSpaces, publicSpaces, publicAllowlist: ids(csv(env, 'KSADK_PUBLIC_SKILL_ALLOWLIST')) };
}

/** Shared package selection under the caller's actual runtime authority. */
export async function loadSkillRuntimePackages({ request, localSource, localDefinitions = [], userSpaces = [], publicSpaces = [],
  publicAllowlist = [], service, load, assertStorage, events }) {
  const check = () => { assertStorage(); return request.assertCurrent(); };
  // Reuse the admitted SkillSource's complete content/mode digest. A
  // later edit cannot silently change an already pinned workflow.
  for (const ref of localSource?.source.refs ?? []) { check(); await localSource.source.fullText(ref); check(); }
  const packages = localDefinitions.filter(item => item.resourceBase?.kind === 'directory')
    .map(item => ({ name: item.name, body: item.content, rootDir: item.resourceBase.path }));
  const seen = new Set(packages.map(item => item.name.toLowerCase()));
  const select = async (skills, spaceId, publicOnly = false) => {
    const allowed = publicOnly ? skills.filter(skill => !publicAllowlist.length
      || publicAllowlist.some(name => name.toLowerCase() === skill.name.toLowerCase())) : skills;
    const matches = publicOnly ? allowed.map(skill => ({ skill }))
      : matchSkillRefs(allowed, request.workflowPrompt, { skillNames: request.skillNames });
    for (const { skill } of matches) {
      if (seen.has(skill.name.toLowerCase())) continue;
      check();
      const pkg = { skillId: skill.skillId, versionId: skill.versionId, name: skill.name, contentHash: skill.contentHash ?? '' };
      events?.emit('skill.load.started', 'running', { pkg });
      let loaded;
      try {
        loaded = await load({ ...pkg, spaceId, signal: request.signal, assertCurrent: check }, { events });
        check(); events?.emit('skill.load.completed', 'completed', { pkg: { ...pkg, archiveHash: loaded.archiveHash } });
      } catch (error) { events?.emit('skill.load.failed', 'failed', { pkg, errorCategory: 'load_failed' }); throw error; }
      check(); seen.add(skill.name.toLowerCase());
      packages.push({ name: loaded.name, body: loaded.content, rootDir: loaded.rootDir,
        skillId: loaded.skillId, versionId: loaded.versionId, spaceId: loaded.spaceId, archiveHash: loaded.archiveHash });
    }
  };
  for (const spaceId of userSpaces) {
    const listing = await service.listSkillsBySpaceId(spaceId, { signal: request.signal, assertCurrent: check }); check();
    invariant(!listing.truncated, 'SKILL_RUNTIME_DIRECTORY_INCOMPLETE');
    await select(listing.activeSkills, spaceId);
  }
  if (publicSpaces.length) {
    const listing = await service.listAvailablePremadeSkills({ signal: request.signal, assertCurrent: check }); check();
    invariant(!listing.truncated && publicSpaces.includes(listing.spaceId), 'SKILL_RUNTIME_PUBLIC_DIRECTORY_INVALID');
    await select(listing.activeSkills, listing.spaceId, true);
  }
  return packages;
}
