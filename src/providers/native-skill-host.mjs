/** Host-owned remote Skills assembly. Discovery/download use the existing
 * authenticated Node Skill Service; loading does not execute a workflow. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { privateDirectory } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';
import { createAgentEngineClient } from '../server-client.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createNativeSkillService } from './native-skill-service.mjs';
import { createNativeSkillLoader } from './native-skill-loader.mjs';
import { createStudioNativeSkills } from './native-dsh-skills.mjs';
import { SKILL_TOOL_CONTRACT, matchSkillRefs } from '@kingsoftcloud/agentkit-harness-node/native/skill-tools';
import { nativeSkillConnectionSettings, createExplicitNativeSkillClient } from './native-skill-connection.mjs';
import { createNativeLocalSkillRuntime, nativeSkillRuntimeSettings } from './native-skill-runtime.mjs';
import { createStudioNativeSkillSource } from './native-skill-source.mjs';
import { prepareNativeE2BHost } from './native-e2b-host.mjs';
import { createNativeE2BSkillRuntime, NATIVE_SKILL_E2B_RUNTIME } from './native-skill-e2b-runtime.mjs';
import { NATIVE_SKILL_E2B_FILES } from './native-skill-e2b-files.mjs';
import { NATIVE_SKILL_INPUT_FILES, normalizeSkillInputFiles } from './native-skill-inputs.mjs';

export const STUDIO_NATIVE_REMOTE_SKILLS = 'agentkit.studio-native-remote-skills/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fields = ['cloudAccessKey', 'cloudSecretKey', 'cloudSessionToken', 'cloudRegion', 'cloudAccountId', 'cloudServerUrl', 'cloudCustomSource'];

/** Snapshot at Host activation, including credentials in a private closure.
 * A later global configuration edit cannot redirect an already pinned Run. */
export async function createNativeSkillConnection({ configuration, env = {}, fetchImpl = hostFetch, innerKopUrl = '', innerIamUrl = '' }) {
  const resolved = await configuration.resolve();
  const values = Object.fromEntries(fields.map(key => [key, resolved.values[key] ?? '']));
  invariant(Object.values(values).every(value => typeof value === 'string'), 'NATIVE_SKILL_CONNECTION_INVALID');
  const explicit = nativeSkillConnectionSettings(values, { ...env });
  const client = explicit ? createExplicitNativeSkillClient(explicit, fetchImpl)
    : createAgentEngineClient({ configuration: { resolve: async () => ({ values: copy(values) }) }, fetchImpl, innerKopUrl, innerIamUrl });
  return Object.freeze({ client, bindingDigest: hash({ contract: STUDIO_NATIVE_REMOTE_SKILLS, values, explicit, innerKopUrl, innerIamUrl }) });
}

function ids(values) {
  invariant(Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === 'string'
    && value.trim() && Buffer.byteLength(value) <= 4096), 'NATIVE_SKILL_SPACES_INVALID');
  return [...new Set(values.map(value => value.trim()))];
}
const csv = (env, key) => {
  const value = env[key] ?? ''; invariant(typeof value === 'string', 'NATIVE_SKILL_ENV_INVALID');
  return value.split(',').map(value => value.trim()).filter(Boolean);
};

export function prepareNativeSkillHost({ config, env = {}, connection, fetchImpl = hostFetch, loadSdk, inputFiles = [] }) {
  const fixedInputs = normalizeSkillInputFiles(inputFiles);
  const { userSpaces, publicSpaces, publicAllowlist } = nativeSkillSpaceSettings(config, env);
  const localDefinitions = copy(config.skillDefinitions ?? []).filter(item => item.invocation?.modelInvocable !== false), environment = { ...env };
  if (!userSpaces.length && !publicSpaces.length && !localDefinitions.length) return null;
  const selectedRuntime = nativeSkillRuntimeSettings(env);
  const e2b = selectedRuntime.backend === 'e2b' ? prepareNativeE2BHost({ env: { ...environment,
    KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TIMEOUT: String(selectedRuntime.timeoutSeconds) }, ...(loadSdk ? { loadSdk } : {}) }) : null;
  const runtimeSettings = Object.freeze({ ...selectedRuntime, ...(e2b ? { host: e2b.binding,
    backendContract: NATIVE_SKILL_E2B_RUNTIME, fileContract: NATIVE_SKILL_E2B_FILES } : {}) });
  if (!userSpaces.length && !publicSpaces.length && !(runtimeSettings.enabled && localDefinitions.length)) return null;
  invariant(!userSpaces.length && !publicSpaces.length || connection?.client && /^[a-f0-9]{64}$/u.test(connection.bindingDigest), 'NATIVE_SKILL_CONNECTION_REQUIRED');
  const agentRevision = config.agentRevision ?? 1;
  const localSource = localDefinitions.length ? createStudioNativeSkillSource({ definitions: localDefinitions }) : null;
  const binding = Object.freeze({ contract: STUDIO_NATIVE_REMOTE_SKILLS, toolContract: SKILL_TOOL_CONTRACT, userSpaceIds: userSpaces,
    publicSpaceIds: publicSpaces, publicAllowlist, serviceBindingDigest: connection?.bindingDigest ?? null,
    localSkillBindingDigest: localSource ? hash(localSource.binding) : null,
    runtime: runtimeSettings, ...(fixedInputs.length ? { inputs: { contract: NATIVE_SKILL_INPUT_FILES, digest: hash(fixedInputs) } } : {}) });
  const bindingDigest = hash(binding), lifetime = new AbortController();
  const provider = (loadSkillFn, executeWorkflow, locateWorkflow) => createStudioNativeSkills({ serviceClient: connection?.client,
    loadSkillFn, executeWorkflow, locateWorkflow, authorize: async () => 'allow', agentId: config.agentId, agentRevision,
    buildId: config.buildId ?? null, skillSpaceIds: userSpaces, publicSpaceIds: publicSpaces,
    publicAllowlist, backendBindingDigest: bindingDigest, sealedBinding: { serviceBindingDigest: connection?.bindingDigest ?? null } });
  const definitions = provider(undefined).definitions;
  function forSession({ agent, scope, sessionId, stateRoot, workspaceRoot, assertCurrent }) {
    scopeKey(scope);
    const { workspace, cacheDir, assertStorage } = nativeSkillSessionCache({ stateRoot, workspaceRoot, owner: { scope, sessionId } });
    const sessionLifetime = new AbortController();
    const service = connection?.client ? createNativeSkillService(connection.client) : null;
    const load = service ? createNativeSkillLoader({ serviceClient: service, cacheDir, fetchImpl }) : undefined;
    const createRuntime = e2b ? createNativeE2BSkillRuntime : createNativeLocalSkillRuntime;
    const runtime = runtimeSettings.enabled ? createRuntime({ stateRoot: join(cacheDir, 'runtime'),
      workspaceRoot: workspace, scope, sessionId, bindingDigest, settings: runtimeSettings, env: environment,
      ...(e2b ? { prepared: e2b, inProcessTransport: Boolean(loadSdk) } : {}),
      assertStorage, loadPackages: (request, events) => loadSkillRuntimePackages({ request, events, localSource, localDefinitions,
        userSpaces, publicSpaces, publicAllowlist, service, load, assertStorage }) }) : null;
    const bound = provider(load && (request => {
      assertStorage();
      const authority = request.assertCurrent;
      return load({ ...request, assertCurrent: () => { assertStorage(); return authority(); } });
    }), runtime && (request => runtime.execute(fixedInputs.length ? { ...request, inputFiles: copy(fixedInputs) } : request)),
    runtime?.locate).forAgent(agent, { scope, sessionId, agentRevision, assertCurrent });
    return { execute(request) {
      assertStorage();
      const signal = AbortSignal.any([request.signal, lifetime.signal, sessionLifetime.signal]);
      return bound.tools.execute({ ...request, signal });
    }, close: () => sessionLifetime.abort(new Error('NATIVE_SKILL_SESSION_CLOSED')) };
  }
  return { definitions, binding: { ...copy(binding), bindingDigest }, forSession,
    close: () => lifetime.abort(new Error('NATIVE_SKILL_HOST_CLOSED')) };
}

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
