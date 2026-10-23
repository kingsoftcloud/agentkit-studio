/** Host-owned remote Skills assembly. Discovery/download use the existing
 * authenticated Node Skill Service; loading does not execute a workflow. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { privateDirectory } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { createAgentEngineClient } from '../server-client.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createNativeSkillService } from './native-skill-service.mjs';
import { createNativeSkillLoader } from './native-skill-loader.mjs';
import { createStudioNativeSkills } from './native-dsh-skills.mjs';
import { SKILL_TOOL_CONTRACT } from '../../packages/agentkit-harness/src/native/skill-tools.mjs';
import { nativeSkillConnectionSettings, createExplicitNativeSkillClient } from './native-skill-connection.mjs';

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

export function prepareNativeSkillHost({ config, env = {}, connection, fetchImpl = hostFetch }) {
  const userSpaces = ids([...(config.skillSpaceIds ?? []), ...csv(env, 'KSADK_SKILL_SPACE_IDS'),
    ...(!env.KSADK_SKILL_SPACE_IDS ? csv(env, 'SKILL_SPACE_ID') : [])]);
  const publicSpaces = ids(csv(env, 'KSADK_PUBLIC_SKILL_SPACE_IDS'));
  if (!userSpaces.length && !publicSpaces.length) return null;
  invariant(connection?.client && /^[a-f0-9]{64}$/u.test(connection.bindingDigest), 'NATIVE_SKILL_CONNECTION_REQUIRED');
  const publicAllowlist = ids(csv(env, 'KSADK_PUBLIC_SKILL_ALLOWLIST'));
  const agentRevision = config.agentRevision ?? 1;
  const binding = Object.freeze({ contract: STUDIO_NATIVE_REMOTE_SKILLS, toolContract: SKILL_TOOL_CONTRACT, userSpaceIds: userSpaces,
    publicSpaceIds: publicSpaces, publicAllowlist, serviceBindingDigest: connection.bindingDigest,
    runtime: { backend: 'disabled', enabled: false } });
  const bindingDigest = hash(binding), lifetime = new AbortController();
  const provider = loadSkillFn => createStudioNativeSkills({ serviceClient: connection.client,
    loadSkillFn, authorize: async () => 'allow', agentId: config.agentId, agentRevision,
    buildId: config.buildId ?? null, skillSpaceIds: userSpaces, publicSpaceIds: publicSpaces,
    publicAllowlist, backendBindingDigest: bindingDigest, sealedBinding: { serviceBindingDigest: connection.bindingDigest } });
  const definitions = provider(undefined).definitions;
  function forSession({ agent, scope, sessionId, stateRoot, workspaceRoot, assertCurrent }) {
    scopeKey(scope);
    // Canonicalize the trusted Host's existing prefix once (e.g. macOS /var
    // aliases /private/var). New private descendants still reject links, and
    // every later operation revalidates the original supplied path too.
    let ancestor = resolve(stateRoot); const missing = [];
    while (!existsSync(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    const lexical = join(realpathSync(ancestor), ...missing), workspace = realpathSync(workspaceRoot);
    invariant(lexical !== workspace && !lexical.startsWith(workspace + sep), 'NATIVE_SKILL_CACHE_INSIDE_WORKSPACE');
    privateDirectory(lexical, true);
    const root = realpathSync(lexical);
    const cacheDir = join(root, hash({ scope, sessionId })); privateDirectory(cacheDir, true);
    const pinned = lstatSync(cacheDir), sessionLifetime = new AbortController();
    const assertStorage = () => {
      invariant(realpathSync(stateRoot) === root && realpathSync(lexical) === root
        && realpathSync(workspaceRoot) === workspace, 'NATIVE_SKILL_CACHE_CHANGED');
      privateDirectory(cacheDir);
      const current = lstatSync(cacheDir);
      invariant(current.ino === pinned.ino && current.dev === pinned.dev, 'NATIVE_SKILL_CACHE_CHANGED');
    };
    const load = createNativeSkillLoader({ serviceClient: createNativeSkillService(connection.client), cacheDir, fetchImpl });
    const bound = provider(request => {
      assertStorage();
      const authority = request.assertCurrent;
      return load({ ...request, assertCurrent: () => { assertStorage(); return authority(); } });
    }).forAgent(agent, { scope, sessionId, agentRevision, assertCurrent });
    return { execute(request) {
      assertStorage();
      const signal = AbortSignal.any([request.signal, lifetime.signal, sessionLifetime.signal]);
      return bound.tools.execute({ ...request, signal });
    }, close: () => sessionLifetime.abort(new Error('NATIVE_SKILL_SESSION_CLOSED')) };
  }
  return { definitions, binding: { ...copy(binding), bindingDigest }, forSession,
    close: () => lifetime.abort(new Error('NATIVE_SKILL_HOST_CLOSED')) };
}
