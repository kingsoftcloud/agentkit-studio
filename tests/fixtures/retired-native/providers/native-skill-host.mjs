/** Historical in-process Native Skill host used by recovery fixtures. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '../../../../src/contracts/native-values.mjs';
import { hostFetch } from '../../../../src/http-fetch.mjs';
import { createNativeSkillService } from '../../../../src/providers/native-skill-service.mjs';
import { createNativeSkillLoader } from '../../../../src/providers/native-skill-loader.mjs';
import { createStudioNativeSkills } from './native-dsh-skills.mjs';
import { SKILL_TOOL_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/skill-tools';
import { STUDIO_NATIVE_REMOTE_SKILLS } from '../../../../src/providers/native-skill-connection.mjs';
import { createNativeLocalSkillRuntime } from '../../../../src/providers/native-skill-runtime.mjs';
import { nativeSkillRuntimeSettings } from '../../../../src/providers/studio-skill-runtime-files.mjs';
import { createStudioNativeSkillSource } from '../../../../src/providers/native-skill-source.mjs';
import { prepareNativeE2BHost } from './native-e2b-host.mjs';
import { createNativeE2BSkillRuntime, NATIVE_SKILL_E2B_RUNTIME } from '../../../../src/providers/native-skill-e2b-runtime.mjs';
import { NATIVE_SKILL_E2B_FILES } from '../../../../src/providers/native-skill-e2b-files.mjs';
import { NATIVE_SKILL_INPUT_FILES, normalizeSkillInputFiles } from '../../../../src/providers/native-skill-inputs.mjs';
import { nativeSkillSessionCache, nativeSkillSpaceSettings, loadSkillRuntimePackages } from '../../../../src/providers/native-skill-host.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

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
