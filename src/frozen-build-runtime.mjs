/** Mount the frozen-build HTTP transport over public DSH services only. */
import { createNativeAutomationRunner } from './native-automation-runner.mjs';
import { startBuildRuntimeHttp } from './build-runtime-http.mjs';
import { readNativeRequestEvents } from './native-request-history.mjs';
import { CODEX_TOOL_EVENT } from './providers/codex-tool-events.mjs';
import { frozenModels } from './frozen-models.mjs';
import { RESOURCE_CHECK_EVENT } from './resource-checks.mjs';

const durableTypes = new Set(['turn/start', 'step/start', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', CODEX_TOOL_EVENT, RESOURCE_CHECK_EVENT, 'step/end', 'turn/end']);

export function observeNativeRun(ctx, agent, onFrame) {
  const disposers = [
    ctx.on('agent/assistant-stream', ({ agent: source, frame }) => { if (source === agent) onFrame({ kind: 'assistant', value: frame }); }),
    ctx.on('session/event', (session, event) => { if (session === agent.session && durableTypes.has(event.type)) onFrame({ kind: 'event', value: event }); }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}

export async function startFrozenBuildRuntime({ ctx, build, admit, modelService, env = process.env }) {
  const agentId = env.AGENTKIT_RUNTIME_AGENT_ID;
  const buildId = env.AGENTKIT_RUNTIME_BUILD_ID;
  if (!agentId && !buildId) return null;
  const frozen = await build.resolve(agentId, buildId);
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
    admit: async () => admit(agentId, await build.resolve(agentId, buildId)),
    ...(catalog.length ? { selectModel: async key => {
      if (!selections.has(key)) throw Object.assign(new Error('模型不在冻结绑定中'), { code: 'RESPONSES_FROZEN_MODEL_MISMATCH', status: 400 });
      return selections.get(key);
    } } : {}),
    observe: (agent, listener) => observeNativeRun(ctx, agent, listener),
  });
  const runner = async request => {
    const controller = ctx.get('sessionController');
    if (await controller.projections({ sessionId: request.sessionId }, request.signal)) {
      try {
        const events = await readNativeRequestEvents(controller, request.sessionId, request.occurrenceId, request.signal);
        const message = events.find(event => event.type === 'user/message' && event.data?.source?.rpcId === request.occurrenceId)?.data;
        const text = (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
        const selection = events.find(event => event.type === 'studio/runtime-model')?.data?.model;
        if (text !== request.input || (selection && selection !== request.model)) throw Object.assign(new Error('request input conflict'), { code: 'RUNTIME_REQUEST_CONFLICT', status: 409 });
      } catch (error) { if (error?.code !== 'CHANNEL_REQUEST_NOT_FOUND') throw error; }
    }
    return nativeRun(request);
  };
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
  return startBuildRuntimeHttp({ agentId, buildId, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 || '', deploymentVersion: env.AGENTKIT_DEPLOYMENT_VERSION || 'initial', runner, validatePrevious, model, models: catalog.length ? catalog.map(item => item.id) : [model], token: env.AGENTKIT_RUNTIME_TOKEN,
    host: env.AGENTKIT_RUNTIME_HOST || '127.0.0.1', port: Number(env.AGENTKIT_RUNTIME_PORT || 8080) });
}
