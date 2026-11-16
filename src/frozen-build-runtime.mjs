/** Mount the frozen-build HTTP transport over public DSH services only. */
import { createNativeAutomationRunner } from './native-automation-runner.mjs';
import { startBuildRuntimeHttp } from './build-runtime-http.mjs';
import { readNativeRequestEvents } from './native-request-history.mjs';
import { CODEX_TOOL_EVENT } from './providers/codex-tool-events.mjs';
import { frozenModels } from './frozen-models.mjs';
import { RESOURCE_CHECK_EVENT } from './resource-checks.mjs';
import { createManagedRuntimeActions } from './managed-runtime-actions.mjs';
import { join } from 'node:path';
import { createFrozenHostedActions } from './frozen-hosted-actions.mjs';
import { createRuntimeResponsesContract, responsesRequestFingerprint } from './runtime-responses-contract.mjs';
import { createFrozenResponseProjection } from './frozen-response-projection.mjs';
import { createManagedApprovalRegistry } from './managed-runtime-approval.mjs';
import { NATIVE_ENGINE_EVENT } from './providers/native-engine-runtime.mjs';
import { hostedHarnessView } from './harness-view-presentation.mjs';
import { DEFAULT_CLOUD_EXECUTION_MAX, DEFAULT_CLOUD_EXECUTION_MODE, cloudExecutionPolicy, executionModesUpTo, readExecutionMode } from './execution-policy.mjs';

const durableTypes = new Set(['turn/start', 'step/start', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', CODEX_TOOL_EVENT, RESOURCE_CHECK_EVENT, NATIVE_ENGINE_EVENT, 'step/end', 'turn/end']);

// The automation runner's local default is intentionally strict, but a
// managed/frozen Runtime must also cover a foreground tool command that gets
// promoted to a background job at its own five-minute yield boundary. Keeping
// this outer budget at 15 minutes avoids reintroducing the same 300s cliff at
// the runner layer while retaining a bounded request lifetime. Deployments can
// tune it through the explicitly allowlisted environment variable.
export const DEFAULT_FROZEN_RUNTIME_TIMEOUT_MS = 900_000;
const MAX_FROZEN_RUNTIME_TIMEOUT_MS = 86_400_000;

export function frozenRuntimeTimeoutMs(env = process.env) {
  const configured = Number(env?.AGENTKIT_RUNTIME_TIMEOUT_MS);
  if (!Number.isSafeInteger(configured) || configured < 1_000) return DEFAULT_FROZEN_RUNTIME_TIMEOUT_MS;
  return Math.min(configured, MAX_FROZEN_RUNTIME_TIMEOUT_MS);
}

export function observeNativeRun(ctx, agent, onFrame) {
  const disposers = [
    ctx.on('agent/assistant-stream', ({ agent: source, frame }) => { if (source === agent) onFrame({ kind: 'assistant', value: frame }); }),
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session || !durableTypes.has(event.type)) return;
      if (event.type === NATIVE_ENGINE_EVENT) {
        const view = hostedHarnessView(event);
        if (view) onFrame({ kind: 'event', value: { type: event.type, data: { view: view.sha256, event: view.event } } });
        return;
      }
      onFrame({ kind: 'event', value: event });
    }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}

export async function startFrozenBuildRuntime({ ctx, build, managedRuntime, managedResourceContext, admit, modelService, hostCompatibility, resources,
  nativeEngineRuntime, env = process.env, createAutomationRunner = createNativeAutomationRunner }) {
  const agentId = managedRuntime?.identity.agentId || env.AGENTKIT_RUNTIME_AGENT_ID;
  const buildId = managedRuntime ? undefined : env.AGENTKIT_RUNTIME_BUILD_ID;
  if (!agentId && !buildId && !managedRuntime) return null;
  hostCompatibility?.require('frozen-runtime');
  if (ctx.get('sessionController')?.promptFingerprintVersion !== 1) {
    throw Object.assign(new Error('冻结运行时需要支持请求指纹的 DSH 宿主'), { code: 'RUNTIME_HOST_CAPABILITY_UNAVAILABLE' });
  }
  const resolveDefinition = () => managedRuntime ? Promise.resolve(structuredClone(managedRuntime.agent)) : build.resolve(agentId, buildId);
  const frozen = await resolveDefinition();
  const runtimeAdmission = await admit(agentId, frozen);
  const harnessModel = managedRuntime?.harnessModelSelection ?? (runtimeAdmission?.serviceOwnedModel ? runtimeAdmission.modelSelection : undefined);
  const bindings = frozen.spec?.bindings || {}, first = bindings.modelProfileIds?.[0];
  const primary = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId || first?.id) || '';
  const ids = [...new Set([primary, ...(bindings.modelProfileIds || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id)].filter(Boolean))];
  const catalog = harnessModel || !modelService ? [] : frozenModels(await Promise.all(ids.map(async id => ({ ...await modelService.profile(id), id, default: id === primary }))));
  const selections = new Map();
  if (harnessModel) selections.set(harnessModel.model, harnessModel);
  for (const entry of catalog) {
    const admission = await admit(agentId, { ...frozen, spec: { ...frozen.spec, bindings: { ...bindings, modelProfileId: entry.profileId } } });
    if (!admission.modelSelection) throw Object.assign(new Error('冻结模型没有可用的运行时路由'), { code: 'RUNTIME_MODEL_UNAVAILABLE' });
    selections.set(entry.id, admission.modelSelection);
  }
  // The image declares the default conversation policy. A deployment may narrow
  // the ceiling later through its environment; image defaults keep parity with
  // Local DSH sessions (workspace-write) while allowing every mode to be chosen.
  const executionModeDefault = readExecutionMode(env.AGENTKIT_EXECUTION_POLICY_DEFAULT) || DEFAULT_CLOUD_EXECUTION_MODE;
  const executionModeMax = readExecutionMode(env.AGENTKIT_EXECUTION_POLICY_MAX) || DEFAULT_CLOUD_EXECUTION_MAX;
  const declaredPolicy = cloudExecutionPolicy(executionModeDefault);
  const nativeRun = createAutomationRunner({
    getService: name => ctx.get(name), reuseSession: true, executionPolicy: declaredPolicy,
    timeoutMs: frozenRuntimeTimeoutMs(env),
    assertHostCompatible: () => hostCompatibility?.require('frozen-runtime'),
    loadReplay: request => loadFrozenRequestReplay(request, selections.get(request.model)),
    admit: async () => admit(agentId, await resolveDefinition()),
    ...(selections.size ? { selectModel: async key => {
      if (!selections.has(key)) throw Object.assign(new Error('模型不在冻结绑定中'), { code: 'RESPONSES_FROZEN_MODEL_MISMATCH', status: 400 });
      return selections.get(key);
    } } : {}),
    observe: (agent, listener) => observeNativeRun(ctx, agent, listener),
  });
  const runner = request => nativeRun({ ...request, requestFingerprint: responsesRequestFingerprint(request) });
  const validatePrevious = async (previous, signal) => {
    try {
      const events = await readNativeRequestEvents(ctx.get('sessionController'), previous.sessionId, previous.occurrenceId, signal);
      if (events.at(-1)?.data?.reason?.kind !== 'completed') throw Object.assign(new Error('previous response did not complete'), { code: 'RESPONSES_PREVIOUS_NOT_COMPLETED', status: 409 });
    } catch (error) {
      if (['CHANNEL_REQUEST_NOT_FOUND', 'CHANNEL_TURN_INCOMPLETE'].includes(error.code)) throw Object.assign(new Error('previous response unavailable'), { code: 'RESPONSES_PREVIOUS_NOT_FOUND', status: 404 });
      throw error;
    }
  };
  const model = harnessModel?.model || catalog.find(item => item.default)?.id || catalog[0]?.id || primary;
  const models = catalog.length ? catalog.map(item => item.id) : [model];
  // One bridge owns the interactive approval answerer and the presented
  // interaction records for this Host process.
  const approval = managedRuntime ? createManagedApprovalRegistry({ ctx }) : undefined;
  // The Hosted UI renders exactly the modes this image declares; admission
  // validates a requested mode against the same list.
  const allowedPermissionModes = executionModesUpTo(executionModeMax);
  const platformActions = managedRuntime ? await createManagedRuntimeActions({ ctx, runtime: managedRuntime, admit, model, models,
    // Session ownership is Agent state, not deployment-version state: the Host
    // exports AGENTKIT_MANAGED_SESSIONS outside the version directory so an
    // accepted UpdateAgent keeps listing the Sessions it already recorded.
    directory: env.AGENTKIT_MANAGED_SESSIONS || join(env.AGENTKIT_HOME, 'managed-sessions'),
    approval, executionPolicy: declaredPolicy, allowedPermissionModes }) : undefined;
  let hosted;
  if (!managedRuntime) {
    hosted = createFrozenHostedActions({ ctx, agentId, buildId, token: env.AGENTKIT_RUNTIME_TOKEN, frozen, admit, model,
      models, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 || '',
      responses: createRuntimeResponsesContract({ agentId, buildId, token: env.AGENTKIT_RUNTIME_TOKEN, model, models,
        definitionId: undefined, versionId: undefined }) });
  }
  return startBuildRuntimeHttp({ hosted, agentId, buildId, managedIdentity: managedRuntime?.identity, platformActions,
    // Absent on Hosts without a managed observability bundle; undefined keeps the old behavior.
    observability: ctx.get('studioManagedObservability'),
    withResourceContext: managedResourceContext?.run, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 || '',
    deploymentVersion: env.AGENTKIT_DEPLOYMENT_VERSION || 'initial', runner, executionPolicy: declaredPolicy, executionPolicyMax: executionModeMax,
    validatePrevious, responseProjection: createFrozenResponseProjection({ getService: name => ctx.get(name) }), approval, model, models, token: env.AGENTKIT_RUNTIME_TOKEN,
    ...(managedRuntime && nativeEngineRuntime?.usesService ? { harnessView: nativeEngineRuntime.resolveView, allowImages: Boolean(harnessModel) } : {}),
    host: env.AGENTKIT_RUNTIME_HOST || '127.0.0.1', port: Number(env.AGENTKIT_RUNTIME_PORT || 8080) });
}

async function loadFrozenRequestReplay({ controller, sessionId, occurrenceId, input, images, model, requestFingerprint, signal }, expectedSelection) {
  let events;
  try { events = await readNativeRequestEvents(controller, sessionId, occurrenceId, signal, { includeRequestHeader: true }); }
  catch (error) { if (error?.code === 'CHANNEL_REQUEST_NOT_FOUND') return null; throw error; }
  const message = events.find(event => event.type === 'user/message' && event.data?.source?.rpcId === occurrenceId)?.data;
  const text = (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
  const fingerprint = message?.source?.requestFingerprint;
  if (text !== input || (fingerprint === undefined ? images?.length : fingerprint !== requestFingerprint)) {
    throw Object.assign(new Error('request input conflict'), { code: 'RUNTIME_REQUEST_CONFLICT', status: 409 });
  }
  if (fingerprint === undefined) {
    // Native request headers reconstruct the route used for legacy responses.
    // Optional UI events cannot establish or override a request identity.
    const firstOutput = events.findIndex(event => ['assistant/attempt', 'assistant/message'].includes(event.type));
    const selection = events.slice(0, firstOutput < 0 ? events.length : firstOutput)
      .findLast(event => event.type === 'request/header')?.data?.header?.config;
    if (model !== undefined && (!expectedSelection || !selection)) {
      throw Object.assign(new Error('legacy request model metadata unavailable'), { code: 'RUNTIME_REQUEST_METADATA_UNAVAILABLE', status: 409 });
    }
    if (model !== undefined && (selection.provider !== expectedSelection.provider || selection.model !== expectedSelection.model)) {
      throw Object.assign(new Error('request model conflict'), { code: 'RUNTIME_REQUEST_CONFLICT', status: 409 });
    }
  }
  return events;
}
