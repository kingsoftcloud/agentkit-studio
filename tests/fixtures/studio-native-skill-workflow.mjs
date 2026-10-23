/** Instrumentation only: production packed mount, authenticated preset
 * admission, actual SDK Session/ToolRegistry and Native whole-turn ownership. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';

export const name = 'studio-native-skill-workflow-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];
export async function apply(ctx, options) {
  try { await mountProof(ctx, options); }
  catch (error) {
    await writeFile(join(options.directory, 'fixture-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}
async function mountProof(ctx, options) {
  const home = options.directory, workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  await appendFile(join(home, 'host-processes.jsonl'), JSON.stringify({ pid: process.pid, node: process.version, path: process.env.PATH }) + '\n');
  await writeFile(join(home, 'config.yaml'), JSON.stringify({
    modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned', baseUrl: options.modelUrl,
      default: true, credentialName: 'SKILL_WORKFLOW_PROOF_KEY' }],
    modelProfileKeys: { SKILL_WORKFLOW_PROOF_KEY: 'skill-workflow-model-secret' },
  }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(home, 'studio/agents') });
  const identity = join(home, 'agent-id.json'); let record;
  try { record = await agents.get(JSON.parse(await readFile(identity, 'utf8')).id); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record) {
    record = await agents.create({ name: 'Native Skill workflow proof', runtimeType: 'harness',
      bindings: { modelProfileIds: ['fixture'], tools: ['execute_skills'] } });
    await writeFile(identity, JSON.stringify({ id: record.metadata.id }));
  }
  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, { configurationHome: home, env: {
    AGENTKIT_HOME: home, AGENTKIT_STUDIO_WORKSPACE: workspace,
    AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1',
    KSADK_SKILL_SPACE_IDS: 'workflow-space', KSADK_SKILL_SERVICE_URL: options.skillServiceUrl,
    KSADK_SKILL_SERVICE_TOKEN: 'skill-workflow-service-secret',
    KSADK_SKILL_RUNTIME_BACKEND: 'local_process', KSADK_SKILL_RUNTIME_TIMEOUT: '30', PATH: process.env.PATH,
  } });
  const presetId = dshPresetId(record.metadata.id, record.metadata.revision, record.buildId || '');
  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Skill workflow proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during Native workflow execution'); },
  });
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'skill-workflow-session') return;
    const origin = ctx.webServer.getOrigin();
    const unauthorized = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'host/compatibility', payload: {} }), signal: AbortSignal.timeout(5000) });
    if (unauthorized.status !== 401) throw Error('Unauthenticated Host control accepted'); await unauthorized.text();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error('Host authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method, payload = {}) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(10000) });
      const result = (await response.json()).result;
      if (response.status !== 200 || !result?.ok) throw Error(`Host RPC ${method} failed: ${result?.error?.code}`);
      return result.value;
    };
    if (source !== 'resume') {
      const admitted = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
      if (admitted.presetId !== presetId) throw Error('Wrong admitted preset');
    }
    const deadline = Date.now() + 15000; let rows;
    while (!rows) {
      try { rows = await ctx.agentPresets.pluginsFor(presetId); }
      catch (error) { if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    if (!rows.some(row => row.name === '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin'
      && row.config?.nativeEngineContract === 'agentkit.native-dsh-turn/v1')) throw Error('Production Native preset missing');
    if (source === 'resume') {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId) throw Error('Preset identity lost');
      await ctx.agentPresets.recompose(agent.ctx, presetId);
    } else await ctx.agentPresets.select(agent, presetId);
    const history = agent.session.snapshotEvents();
    await appendFile(join(home, 'host-ready.jsonl'), JSON.stringify({ source, pid: process.pid, presetId,
      historyHasAnswer: JSON.stringify(history).includes('Native Skill workflow delivered exact bytes.'),
      historyHasCompletedTurn: history.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed') }) + '\n');
  });
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent.session.id === 'skill-workflow-session') await appendFile(join(home, 'tool-admissions.jsonl'),
      JSON.stringify({ callId: execution.callId, name: execution.name, arguments: execution.arguments }) + '\n');
    return next();
  });
}
