import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'studio-workspace-cutover-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];
export async function apply(ctx, { root, studio, bindings }) {
  const load = relative => import(pathToFileURL(join(studio, 'src', relative)));
  const { mountStudioHost } = await load('host/bootstrap.mjs');
  const { createAgentStore } = await load('agent-store.mjs');
  const record = await createAgentStore({ storeDir: join(root, 'studio/agents') }).create({ name: 'Two-project Native proof', runtimeType: 'harness' });
  await mountStudioHost(ctx, { configurationHome: root, env: {
    AGENTKIT_HOME: root, AGENTKIT_STUDIO_WORKSPACE: bindings[0].workspace,
    AGENTKIT_ENGINE_SERVICE_WORKSPACES: JSON.stringify(bindings),
    TEST_ALPHA_TOKEN: 'fixture-alpha-service-token', TEST_BETA_TOKEN: 'fixture-beta-service-token',
  } });
  ctx.llm.registerAdapter(['wake-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Wake fixture' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'wake', name: 'wake' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => ({ model: { provider: 'wake-fixture', id: 'wake', name: 'wake' }, stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Fixture ready.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture ready.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }),
  });
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.id !== 'wake-cutover') return;
    try {
      const origin = ctx.webServer.getOrigin();
      const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      assert.equal(login.status, 302);
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const rpc = async (method, payload) => {
        const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(10000) });
        return (await response.json()).result;
      };
      const controller = ctx.get('sessionController');
      const admission = async cwd => (await rpc('agents/ensure-preset', { agentId: record.metadata.id, cwd }));
      assert.equal((await admission(root)).error.code, 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE');
      const sessions = new Map(), results = [];
      for (const [index, binding] of [bindings[0], bindings[1], bindings[0]].entries()) {
        const admitted = await admission(binding.workspace);
        assert.ok(admitted.ok, JSON.stringify(admitted.error));
        const { presetId, runtime, modelSelection, workspaceRoot } = admitted.value;
        assert.equal(runtime, 'native-engine');
        assert.equal(workspaceRoot, binding.workspace);
        assert.equal(modelSelection.model, binding.model);
        let sessionId = sessions.get(binding.workspace);
        if (!sessionId) {
          const created = await controller.create({ cwd: binding.workspace, agentPreset: presetId });
          sessionId = created.sessionId;
          await controller.selectModel({ sessionId, ...modelSelection, saveDefault: false });
          sessions.set(binding.workspace, sessionId);
          const found = await controller.resolveAgent(sessionId);
          await ctx.get('commands').execute(found.agent, '/permission danger-full-access', [], new AbortController().signal);
        }
        const text = index === 2 ? 'Continue this project.' : 'Create the project proof file.';
        const ack = await controller.prompt({ sessionId, mode: 'queue', requestId: 'cutover-' + index, content: [{ type: 'text', text }] }, AbortSignal.timeout(20000));
        assert.equal(ack.accepted, true);
        const owner = ctx.agents.get(sessionId);
        await owner.whenIdle();
        const events = owner.session.snapshotEvents();
        const last = events.findLast(event => event.type === 'assistant/message');
        assert.ok(last, JSON.stringify(events.filter(event => event.type === 'turn/end')));
        assert.ok(events.some(event => event.type === 'agentkit/native-engine-event'));
        assert.equal(owner.session.header.cwd, binding.workspace);
        results.push({ sessionId, presetId, model: modelSelection.model, text: last.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('') });
      }
      await writeFile(join(root, 'proof.json'), JSON.stringify({ results, unboundRejected: true }));
    } catch (error) {
      await writeFile(join(root, 'proof.json'), JSON.stringify({ error: error.stack || String(error) }));
      throw error;
    }
  });
}
