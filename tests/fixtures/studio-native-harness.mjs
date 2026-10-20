import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentStore } from '../../src/agent-store.mjs';
import { createModelService } from '../../src/model-service.mjs';
import { createStudioNativeHarness } from '../../src/host/services/native-harness.mjs';
import { mountRuntimeBridge } from '../../src/host/runtime-bridge.mjs';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';

export const name = 'studio-native-host-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets'];

/** Exercise production Host, preset plugin and ToolRegistry in the shipped CLI. */
export async function apply(ctx, options) {
  // Match bootstrap's public Host import, including portable loader resolution.
  const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const bridge = mountRuntimeBridge(ctx), workspaceRoot = join(options.directory, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const agents = createAgentStore({ storeDir: join(options.directory, 'studio') });
  const identity = join(options.directory, 'agent-id.json');
  let record;
  try { record = await agents.get(JSON.parse(await readFile(identity, 'utf8')).id); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record) {
    record = await agents.create({ name: 'Native Host proof', runtimeType: 'harness',
      bindings: { modelProfileIds: ['fixture'], tools: ['write_workspace_file'] } });
    await writeFile(identity, JSON.stringify({ id: record.metadata.id }));
  }
  const models = createModelService({
    configuration: { resolve: async () => ({ values: { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
      modelName: 'pinned', baseUrl: options.modelUrl, default: true }] } }) },
    credentials: { resolve: async () => ({ value: 'sk-studio-fixture-secret' }) },
  });
  const native = await createStudioNativeHarness({ ctx, storeDir: join(options.directory, 'studio'),
    workspaceRoot, agents, models, renderPrompt });
  ctx.effect(() => () => native.close(), 'Studio Native Host lifetime');
  ctx.effect(() => bridge.setNativeToolsFactory(({ ctx: toolsCtx, config }) => createNativeDshTools({
    ctx: toolsCtx, config, workspaceRoot, stateDir: join(options.directory, 'workspace-state'),
  })), 'Studio Native tool factory');
  ctx.effect(() => bridge.setNativeTurnExecutor(payload => native.executeTurn(payload)), 'Studio Native turn executor');
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
  const disposePreset = await ctx.agentPresets.register({ id: 'studio-native-proof', plugins: [{ id: 'runtime',
    name: pathToFileURL(join(options.repository, 'src/providers/dsh-runtime-plugin.mjs')).href,
    config: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1',
      toolBindings: ['write_workspace_file'], toolContracts: [{ name: 'write_workspace_file', executor: 'builtin',
        description: 'Write the verification marker', parameters: { type: 'object' } }] },
  }] });
  ctx.effect(() => disposePreset, 'Studio verification preset');
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id === 'native-studio-session') {
      if (source === 'resume') {
        if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== 'studio-native-proof') throw Error('Native preset identity was not persisted');
        await ctx.agentPresets.recompose(agent.ctx, 'studio-native-proof');
      } else await ctx.agentPresets.select(agent, 'studio-native-proof');
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
