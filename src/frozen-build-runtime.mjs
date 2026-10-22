/** Mount the frozen-build HTTP transport over public DSH services only. */
import { createNativeAutomationRunner } from './native-automation-runner.mjs';
import { startBuildRuntimeHttp } from './build-runtime-http.mjs';
import { readNativeRequestEvents } from './native-request-history.mjs';
import { CODEX_TOOL_EVENT } from './providers/codex-tool-events.mjs';
import { frozenModels } from './frozen-models.mjs';
import { RESOURCE_CHECK_EVENT } from './resource-checks.mjs';
import { createHash } from 'node:crypto';
import { createPersonalAssistantRuntime } from './personal-assistant-runtime.mjs';
import { createAssistantIdentity } from './assistant-identity.mjs';
import { createManagedRuntimeActions } from './managed-runtime-actions.mjs';
import { join } from 'node:path';
import { createAssistantNativeCarrierService } from './assistant-native-carrier.mjs';
import { createFrozenHostedActions } from './frozen-hosted-actions.mjs';
import { createRuntimeResponsesContract } from './runtime-responses-contract.mjs';
import { createAssistantPermissionModel } from './assistant-permission-model.mjs';
import { createManagedApprovalRegistry } from './managed-runtime-approval.mjs';

const durableTypes = new Set(['turn/start', 'step/start', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', CODEX_TOOL_EVENT, RESOURCE_CHECK_EVENT, 'step/end', 'turn/end']);

export function observeNativeRun(ctx, agent, onFrame) {
  const disposers = [
    ctx.on('agent/assistant-stream', ({ agent: source, frame }) => { if (source === agent) onFrame({ kind: 'assistant', value: frame }); }),
    ctx.on('session/event', (session, event) => { if (session === agent.session && durableTypes.has(event.type)) onFrame({ kind: 'event', value: event }); }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}

export async function startFrozenBuildRuntime({ ctx, build, managedRuntime, managedResourceContext, admit, modelService, hostCompatibility, resources, env = process.env }) {
  const agentId = managedRuntime?.identity.agentId || env.AGENTKIT_RUNTIME_AGENT_ID;
  const buildId = managedRuntime ? undefined : env.AGENTKIT_RUNTIME_BUILD_ID;
  if (!agentId && !buildId && !managedRuntime) return null;
  hostCompatibility?.require('frozen-runtime');
  if (ctx.get('sessionController')?.promptFingerprintVersion !== 1) {
    throw Object.assign(new Error('冻结运行时需要支持请求指纹的 DSH 宿主'), { code: 'RUNTIME_HOST_CAPABILITY_UNAVAILABLE' });
  }
  const resolveDefinition = () => managedRuntime ? Promise.resolve(structuredClone(managedRuntime.agent)) : build.resolve(agentId, buildId);
  const frozen = await resolveDefinition();
  await admit(agentId, frozen);
  const bindings = frozen.spec?.bindings || {}, first = bindings.modelProfileIds?.[0];
  const primary = bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId || first?.id) || '';
  const ids = [...new Set([primary, ...(bindings.modelProfileIds || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id)].filter(Boolean))];
  const catalog = modelService ? frozenModels(await Promise.all(ids.map(async id => ({ ...await modelService.profile(id), id, default: id === primary })))) : [];
  const selections = new Map();
  for (const entry of catalog) {
    const admission = await admit(agentId, { ...frozen, spec: { ...frozen.spec, bindings: { ...bindings, modelProfileId: entry.profileId } } });
    if (!admission.modelSelection) throw Object.assign(new Error('冻结模型没有可用的运行时路由'), { code: 'RUNTIME_MODEL_UNAVAILABLE' });
    selections.set(entry.id, admission.modelSelection);
  }
  const nativeRun = createNativeAutomationRunner({
    getService: name => ctx.get(name), reuseSession: true,
    assertHostCompatible: () => hostCompatibility?.require('frozen-runtime'),
    loadReplay: request => loadFrozenRequestReplay(request, selections.get(request.model)),
    admit: async () => admit(agentId, await resolveDefinition()),
    ...(catalog.length ? { selectModel: async key => {
      if (!selections.has(key)) throw Object.assign(new Error('模型不在冻结绑定中'), { code: 'RESPONSES_FROZEN_MODEL_MISMATCH', status: 400 });
      return selections.get(key);
    } } : {}),
    observe: (agent, listener) => observeNativeRun(ctx, agent, listener),
  });
  const runner = request => nativeRun({ ...request, requestFingerprint: createHash('sha256')
    .update(JSON.stringify({ version: 1, input: request.input, model: request.model ?? null })).digest('hex') });
  const validatePrevious = async (previous, signal) => {
    try {
      const events = await readNativeRequestEvents(ctx.get('sessionController'), previous.sessionId, previous.occurrenceId, signal);
      if (events.at(-1)?.data?.reason?.kind !== 'completed') throw Object.assign(new Error('previous response did not complete'), { code: 'RESPONSES_PREVIOUS_NOT_COMPLETED', status: 409 });
    } catch (error) {
      if (['CHANNEL_REQUEST_NOT_FOUND', 'CHANNEL_TURN_INCOMPLETE'].includes(error.code)) throw Object.assign(new Error('previous response unavailable'), { code: 'RESPONSES_PREVIOUS_NOT_FOUND', status: 404 });
      throw error;
    }
  };
  const model = catalog.find(item => item.default)?.id || catalog[0]?.id || primary;
  const models = catalog.length ? catalog.map(item => item.id) : [model];
  // One bridge owns the interactive approval answerer and the presented
  // interaction records for this Host process.
  const approval = managedRuntime ? createManagedApprovalRegistry({ ctx }) : undefined;
  const platformActions = managedRuntime ? await createManagedRuntimeActions({ ctx, runtime: managedRuntime, admit, model, models,
    directory: join(env.AGENTKIT_HOME, 'managed-sessions'), approval }) : undefined;
  let assistant, hosted;
  if (!managedRuntime) {
    const retirement = await (await import('./assistant-retirement.mjs')).createAssistantRetirement({ ctx, env });
    const identity = await createAssistantIdentity({ directory: env.AGENTKIT_HOME, defaultName: frozen.metadata?.name || '个人助理' });
    // Optional on older Hosts: use only the public non-owner Peer factory. The
    // build credential remains at this HTTP boundary, never a Host owner role.
    const permissionModel = await createAssistantPermissionModel({ ctx, env, agentId,
      profile: frozen.spec?.security?.assistantPermissions?.profile,
      grants: frozen.spec?.security?.assistantPermissions?.grants });
    const connection = ctx.get('connection');
    const nativeCarrier = typeof connection?.createPeer === 'function'
      && typeof ctx.get('typertGateway')?.invoke === 'function'
      && typeof ctx.get('typertGateway')?.wireStream?.open === 'function'
      && typeof ctx.get('remoteAccess')?.registerPolicy === 'function'
      ? createAssistantNativeCarrierService({ ctx, createPeer: options => connection.createPeer(options),
        onSessionDisconnect: sessionId => assistant?.disconnectInteractions(sessionId) }) : undefined;
    assistant = createPersonalAssistantRuntime({ ctx, agentId, buildId, frozen, admit, resources, retirement, identity, nativeCarrier, permissionModel });
    hosted = createFrozenHostedActions({ ctx, agentId, buildId, token: env.AGENTKIT_RUNTIME_TOKEN, frozen, admit, model,
      models, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 || '',
      responses: createRuntimeResponsesContract({ agentId, buildId, token: env.AGENTKIT_RUNTIME_TOKEN, model, models,
        definitionId: undefined, versionId: undefined }) });
  }
  return startBuildRuntimeHttp({ hosted, agentId, buildId, managedIdentity: managedRuntime?.identity, platformActions,
    withResourceContext: managedResourceContext?.run, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 || '',
    deploymentVersion: env.AGENTKIT_DEPLOYMENT_VERSION || 'initial', runner, executionPolicy: nativeRun.executionPolicy,
    validatePrevious, assistant, approval, model, models, token: env.AGENTKIT_RUNTIME_TOKEN,
    host: env.AGENTKIT_RUNTIME_HOST || '127.0.0.1', port: Number(env.AGENTKIT_RUNTIME_PORT || 8080) });
}

async function loadFrozenRequestReplay({ controller, sessionId, occurrenceId, input, model, requestFingerprint, signal }, expectedSelection) {
  let events;
  try { events = await readNativeRequestEvents(controller, sessionId, occurrenceId, signal, { includeRequestHeader: true }); }
  catch (error) { if (error?.code === 'CHANNEL_REQUEST_NOT_FOUND') return null; throw error; }
  const message = events.find(event => event.type === 'user/message' && event.data?.source?.rpcId === occurrenceId)?.data;
  const text = (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
  const fingerprint = message?.source?.requestFingerprint;
  if (text !== input || (fingerprint !== undefined && fingerprint !== requestFingerprint)) {
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
