import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentStore } from '../../src/agent-store.mjs';
import { createModelService } from '../../src/model-service.mjs';
import { createStudioNativeHarness } from '../../src/host/services/native-harness.mjs';
import { mountRuntimeBridge } from '../../src/host/runtime-bridge.mjs';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';

export const name = 'studio-native-host-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets'];

/** Exercise production Host, preset plugin and ToolRegistry in the shipped CLI. */
export async function apply(ctx, options) {
  try { await applyProof(ctx, options); }
  catch (error) {
    await writeFile(join(options.directory, 'fixture-startup-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}
async function applyProof(ctx, options) {
  // Match bootstrap's public Host import, including portable loader resolution.
  const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { emitAgentEvent } = await import('@deepseek-ai/dsh-agent');
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // Synchronous observation lets the HTTP peer prove a prefix is public
    // before it sends the provider's terminal response.
    appendFileSync(join(options.directory, 'assistant-stream.jsonl'), JSON.stringify({ session: agent.session.id, frame }) + '\n');
  });
  const workspaceRoot = join(options.directory, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const agents = createAgentStore({ storeDir: options.mountHost ? join(options.directory, 'studio/agents') : join(options.directory, 'studio') });
  const identity = join(options.directory, 'agent-id.json');
  let record;
  try { record = await agents.get(JSON.parse(await readFile(identity, 'utf8')).id); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record) {
    record = await agents.create({ name: 'Native Host proof', runtimeType: 'harness',
      bindings: { modelProfileIds: ['fixture'], tools: ['write_workspace_file'] } });
    await writeFile(identity, JSON.stringify({ id: record.metadata.id }));
  }
  let presetId = 'studio-native-proof';
  if (options.mountHost) {
    const home = options.directory;
    const warn = console.warn;
    const captureWarning = (...args) => {
      void appendFile(join(home, 'mounted-host-warnings.log'), args.map(String).join(' ') + '\n').catch(() => {});
      warn(...args);
    };
    console.warn = captureWarning;
    ctx.effect(() => () => { if (console.warn === captureWarning) console.warn = warn; }, 'Studio verification warnings');
    await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
      modelName: 'pinned', baseUrl: options.modelUrl, default: true, credentialName: 'STUDIO_NATIVE_FIXTURE_KEY' }],
      modelProfileKeys: { STUDIO_NATIVE_FIXTURE_KEY: 'sk-studio-fixture-secret' } }), { mode: 0o600 });
    const { mountStudioHost } = await import('../../src/host/bootstrap.mjs');
    await mountStudioHost(ctx, { configurationHome: home, env: { AGENTKIT_HOME: home,
      AGENTKIT_STUDIO_WORKSPACE: workspaceRoot, AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1' } });
    presetId = dshPresetId(record.metadata.id, record.metadata.revision);
  } else {
    const bridge = mountRuntimeBridge(ctx);
    const models = createModelService({
      configuration: { resolve: async () => ({ values: { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
        modelName: 'pinned', baseUrl: options.modelUrl, default: true }] } }) },
      credentials: { resolve: async () => ({ value: 'sk-studio-fixture-secret' }) },
    });
    const native = await createStudioNativeHarness({ ctx, storeDir: join(options.directory, 'studio'),
      workspaceRoot, agents, models, renderPrompt,
      publishStreamFrame: ({ agent }, frame) => emitAgentEvent(ctx, agent, 'agent/assistant-stream', { frame }) });
    ctx.effect(() => () => native.close(), 'Studio Native Host lifetime');
    ctx.effect(() => bridge.setNativeToolsFactory(({ ctx: toolsCtx, config }) => createNativeDshTools({
      ctx: toolsCtx, config, workspaceRoot, stateDir: join(options.directory, 'workspace-state'),
    })), 'Studio Native tool factory');
    ctx.effect(() => bridge.setNativeTurnExecutor(payload => native.executeTurn(payload)), 'Studio Native turn executor');
  }
  let delegate = false;
  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Studio Native proof' }), providerRetryPolicy: () => undefined,
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => {
      if (!delegate) throw Error('DSH model loop entered during Studio Native execution');
      return { model: { provider: 'agentkit-studio-fixture', id: 'pinned', name: 'pinned' }, stream: async function* () {
        await appendFile(join(options.directory, 'default-invocations.jsonl'), '{}\n');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Default engine completed.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Default engine completed.' } };
        yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 17 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  });
  if (!options.mountHost) {
    const disposePreset = await ctx.agentPresets.register({ id: presetId, plugins: [{ id: 'runtime',
      name: pathToFileURL(join(options.repository, 'src/providers/dsh-runtime-plugin.mjs')).href,
      config: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
        nativeEngineContract: 'agentkit.native-dsh-turn/v1',
        toolBindings: ['write_workspace_file'], toolContracts: [{ name: 'write_workspace_file', executor: 'builtin',
          description: 'Write the verification marker', parameters: { type: 'object' } }] },
    }] });
    ctx.effect(() => disposePreset, 'Studio verification preset');
  }
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id === 'native-studio-session') {
      if (options.mountHost) {
        const origin = ctx.webServer.getOrigin();
        const unauthorized = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'host/compatibility', payload: {} }), signal: AbortSignal.timeout(5000) });
        if (unauthorized.status !== 401) throw Error('Mounted Host accepted unauthenticated control RPC');
        await unauthorized.text();
        const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (login.status !== 302) throw Error('Mounted Host connection authentication failed');
        const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const rpc = async (method, payload = {}) => {
          const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
            body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(10000) });
          const result = (await response.json()).result;
          if (response.status !== 200 || !result?.ok) throw Error(`Mounted Host RPC ${method} failed: ${result?.error?.code}`);
          return result.value;
        };
        const compatibility = await rpc('host/compatibility');
        if (!compatibility.features['agent-presets'].available) throw Error('Mounted Host preset compatibility failed');
        const stored = await rpc('agents/local-get', { agentId: record.metadata.id });
        if (stored.metadata.id !== record.metadata.id) throw Error('Mounted Host read a different Agent');
        if (source !== 'resume') {
          const admitted = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
          if (admitted.presetId !== presetId) throw Error('Mounted Host admitted a different preset');
        }
        await appendFile(join(options.directory, 'mounted-host-http.jsonl'), JSON.stringify({ source,
          agentId: record.metadata.id, presetId, unauthorizedStatus: unauthorized.status, compatible: true }) + '\n');
        // The SDK handshake precedes optional Host reconciliation. Wait for the
        // real registration; do not install a substitute preset in this fixture.
        const deadline = Date.now() + 15000;
        let rows;
        while (!rows) {
          try { rows = await ctx.agentPresets.pluginsFor(presetId); }
          catch (error) {
            if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        if (!rows.some(row => row.name === '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin'
          && row.config?.nativeEngineContract === 'agentkit.native-dsh-turn/v1')) throw Error('Production Native preset was not admitted');
      }
      if (source === 'resume') {
        if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId) throw Error('Native preset identity was not persisted');
        await ctx.agentPresets.recompose(agent.ctx, presetId);
      } else await ctx.agentPresets.select(agent, presetId);
    }
  });
  ctx.on('agent/execute-turn', async (payload, next) => {
    if (payload.agent.session.id === 'default-session') delegate = true;
    return next();
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id === 'native-studio-session') {
      await appendFile(join(options.directory, 'tool-admissions.jsonl'), JSON.stringify({ callId: exec.callId, name: exec.name }) + '\n');
      if (exec.arguments.path === 'denied.txt') return { kind: 'deny', reason: 'Verification policy denied this write' };
    }
    return next();
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.agent.session.id !== 'native-studio-session' || result.isError) return next();
    // This really enters the Host's next-step inbox. The Native loop must claim
    // it through prepareInput after the complete tool batch, including policy.
    exec.agent.steer({ id: `live-steer-${exec.arguments.path}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `Live instruction for ${exec.arguments.path}` }] });
    return { kind: 'accept', content: [{ type: 'text', text: `Published ${exec.arguments.path} (policy view)` }],
      additionalContexts: [{ id: `context-${exec.callId}`, role: 'user', source: { kind: 'tool', callId: exec.callId },
        content: [{ type: 'text', text: `Loaded context for ${exec.arguments.path}` }] }] };
  });
}
