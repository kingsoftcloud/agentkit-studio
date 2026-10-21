import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { mountStudioHost } from '../../src/host/bootstrap.mjs';

export const name = 'studio-native-children-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];
export async function apply(ctx, options) {
  const home = options.directory, workspaceRoot = join(home, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'proof.txt'), 'Evidence from the actual child workspace');
  await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [
    { id: 'parent-profile', provider: 'openai-compatible', modelName: 'parent-proof', baseUrl: options.modelUrl, default: true,
      credentialName: 'CHILD_PROOF_KEY' },
    { id: 'child-profile', provider: 'openai-compatible', modelName: 'child-proof', baseUrl: options.modelUrl, credentialName: 'CHILD_PROOF_KEY' },
  ], modelProfileKeys: { CHILD_PROOF_KEY: 'child-proof-secret' } }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(home, 'studio/agents') });
  let record;
  try { const saved = JSON.parse(await readFile(join(home, 'identity.json'), 'utf8')); record = await agents.get(saved.agentId); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record) {
    record = await agents.create({ name: 'Native child proof', runtimeType: 'harness', spec: {
      subAgents: [{ name: 'reader', instructions: 'CHILD_WORKSPACE_READER: read proof.txt and report its evidence.',
        tools: ['read_workspace_file'], modelProfileId: 'child-profile', maxTurns: 3, maxToolCalls: 2 }],
      bindings: { tools: ['read_workspace_file'], modelProfileIds: ['parent-profile', 'child-profile'] },
    } });
    await writeFile(join(home, 'identity.json'), JSON.stringify({ agentId: record.metadata.id }));
  }
  await mountStudioHost(ctx, { configurationHome: home, env: { AGENTKIT_HOME: home,
    AGENTKIT_STUDIO_WORKSPACE: workspaceRoot, AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1' } });
  const presetId = dshPresetId(record.metadata.id, record.metadata.revision);
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'native-child-parent') return;
    const origin = ctx.webServer.getOrigin();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual' });
    if (login.status !== 302) throw Error('Child proof authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'agents/ensure-preset', payload: { agentId: record.metadata.id } }) });
    const result = (await response.json()).result;
    if (response.status !== 200 || !result?.ok || result.value.presetId !== presetId) throw Error('Child proof preset admission failed');
    const deadline = Date.now() + 15000;
    while (true) {
      try { await ctx.agentPresets.pluginsFor(presetId); break; }
      catch (error) { if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    if (source === 'resume') {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId) throw Error('Child proof persisted preset changed');
      await ctx.agentPresets.recompose(agent.ctx, presetId);
    } else await ctx.agentPresets.select(agent, presetId);
  });
  // Any entry into the DSH model loop would violate Native loop ownership.
  ctx.llm.registerAdapter(['agentkit-studio-parent-profile'], {
    providerInfo: provider => ({ id: provider, name: 'Native child proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'parent-proof', name: 'parent-proof' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during Native child proof'); },
  });
}
