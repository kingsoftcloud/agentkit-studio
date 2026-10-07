/** Mount the frozen-build HTTP transport over public DSH services only. */
import { createNativeAutomationRunner } from './native-automation-runner.mjs';
import { startBuildRuntimeHttp } from './build-runtime-http.mjs';
import { readNativeRequestEvents } from './native-request-history.mjs';

const durableTypes = new Set(['turn/start', 'step/start', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'step/end', 'turn/end']);

export function observeNativeRun(ctx, agent, onFrame) {
  const disposers = [
    ctx.on('agent/assistant-stream', ({ agent: source, frame }) => { if (source === agent) onFrame({ kind: 'assistant', value: frame }); }),
    ctx.on('session/event', (session, event) => { if (session === agent.session && durableTypes.has(event.type)) onFrame({ kind: 'event', value: event }); }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}

export async function startFrozenBuildRuntime({ ctx, build, admit, env = process.env }) {
  const agentId = env.AGENTKIT_RUNTIME_AGENT_ID;
  const buildId = env.AGENTKIT_RUNTIME_BUILD_ID;
  if (!agentId && !buildId) return null;
  const frozen = await build.resolve(agentId, buildId);
  await admit(agentId, frozen);
  const nativeRun = createNativeAutomationRunner({
    getService: name => ctx.get(name), reuseSession: true,
    admit: async () => admit(agentId, await build.resolve(agentId, buildId)),
    observe: (agent, listener) => observeNativeRun(ctx, agent, listener),
  });
  const runner = async request => {
    const controller = ctx.get('sessionController');
    if (await controller.projections({ sessionId: request.sessionId }, request.signal)) {
      try {
        const events = await readNativeRequestEvents(controller, request.sessionId, request.occurrenceId, request.signal);
        const message = events.find(event => event.type === 'user/message' && event.data?.source?.rpcId === request.occurrenceId)?.data;
        const text = (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
        if (text !== request.input) throw Object.assign(new Error('request input conflict'), { code: 'RUNTIME_REQUEST_CONFLICT', status: 409 });
      } catch (error) { if (error?.code !== 'CHANNEL_REQUEST_NOT_FOUND') throw error; }
    }
    return nativeRun(request);
  };
  return startBuildRuntimeHttp({ agentId, buildId, runner, token: env.AGENTKIT_RUNTIME_TOKEN,
    host: env.AGENTKIT_RUNTIME_HOST || '127.0.0.1', port: Number(env.AGENTKIT_RUNTIME_PORT || 8080) });
}
