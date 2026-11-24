import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'studio-workspace-cutover-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];

function runHistory(events, runId) {
  const history = events.filter(event => event.type === 'agentkit/native-engine-event'
    && (!runId || event.data.runId === runId));
  const latest = history.at(-1)?.data.runId;
  assert.ok(latest, 'Expected an original Harness Run inside the Studio history');
  const snapshot = history.filter(event => event.data.runId === latest);
  assert.ok(snapshot.some(({ data }) => data.event.kind === 'run.terminal' && data.event.title === 'completed'));
  return { runId: latest, engineEventSha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export async function apply(ctx, { root, studio, bindings, a2aOrigin, phase, inboundProofPath, inboundTokens }) {
  assert.ok(phase === 'initial' || phase === 'restart');
  for (const part of ['node', 'core', 'ui']) {
    assert.throws(() => import.meta.resolve('@kingsoftcloud/agentkit-harness-' + part), { code: 'ERR_MODULE_NOT_FOUND' });
  }
  const load = relative => import(pathToFileURL(join(studio, 'src', relative)));
  const { mountStudioHost } = await load('host/bootstrap.mjs');
  const { createAgentStore } = await load('agent-store.mjs');
  const { defaultNativeToolBindings } = await load('native-tool-catalog.mjs');
  const { NATIVE_AGENT_POLICY_CONTRACT } = await load('native-agent-policy.mjs');
  const { checkGovernedCommand } = await load('providers/studio-local-command/local-command-policy.mjs');
  const { createInternalA2AControlPlane } = await load('providers/native-a2a-control-plane.mjs');
  const { createA2aGatewayIdentityVerifier } = await load('providers/native-a2a-ingress-identity.mjs');
  const inbound = JSON.parse(await readFile(inboundProofPath, 'utf8'));
  const controlPlane = createInternalA2AControlPlane({ baseUrl: a2aOrigin, tokenProvider: { getToken({ audience, assertCurrent }) {
    assertCurrent();
    assert.ok(Object.hasOwn(inboundTokens, audience), 'Expected an inbound A2A workload audience');
    return inboundTokens[audience];
  } } });
  ctx.effect(() => () => controlPlane.close(), 'inbound proof transport');
  const policyOptions = { cwd: bindings[0].workspace, allowedRoots: [bindings[0].workspace], signal: AbortSignal.timeout(5000) };
  assert.equal(await checkGovernedCommand('printf "literal &"', policyOptions), null);
  assert.ok(await checkGovernedCommand('sleep 1 &', policyOptions));
  const store = createAgentStore({ storeDir: join(root, 'studio/agents') });
  const dshAgent = phase === 'initial' && await store.create({ name: 'DSH tools proof', runtimeType: 'dsh-native',
    bindings: { tools: ['web_fetch', 'sandbox_status', 'execute_skills', 'component_status',
      'write_workspace_file', 'read_workspace_file', 'edit_workspace_file', 'lint_workspace_file'] } });
  const record = phase === 'initial' && await store.create({ name: 'Two-project Native proof', runtimeType: 'harness',
    bindings: { tools: [...defaultNativeToolBindings(), 'component_status', 'list_skill_spaces'],
      nativeAgentPolicy: { contract: NATIVE_AGENT_POLICY_CONTRACT, mode: 'loose' },
      a2a: [{ local_name: 'peer', binding_id: 'proof-binding',
      space_id: 'proof-space', target_agent_id: 'proof-peer', expected_version_id: 'proof-version' }] } });
  await mountStudioHost(ctx, { configurationHome: root, nativeA2aInbound: {
    card: { name: 'Mounted inbound', baseUrl: 'https://native.example' },
    controlPlane,
    verifier: createA2aGatewayIdentityVerifier({ publicKeyPem: inbound.publicKeyPem, targetBinding: inbound.targetBinding }),
    events: { async *subscribe(sessionId, cursor) {
      await appendFile(join(root, 'inbound-event-subscriptions.jsonl'), JSON.stringify({ pid: process.pid, sessionId, cursor }) + '\n');
      for (const row of inbound.rows) if (row.seq > cursor) yield row;
    } },
    assertCurrent: () => ctx.fiber.uid !== null,
  }, env: {
    AGENTKIT_HOME: root, AGENTKIT_STUDIO_WORKSPACE: bindings[0].workspace,
    AGENTKIT_ENGINE_SERVICE_WORKSPACES: JSON.stringify(bindings),
    TEST_ALPHA_TOKEN: 'fixture-alpha-service-token', TEST_BETA_TOKEN: 'fixture-beta-service-token',
    KSADK_A2A_SERVICE_URL: a2aOrigin, KSADK_A2A_ALLOW_PRIVATE: 'true',
    KSADK_SKILL_SERVICE_URL: a2aOrigin + '/skills', KSADK_SKILL_SERVICE_TOKEN: 'fixture-skill-directory-token',
    KSADK_SKILL_SPACE_IDS: 'proof-skills',
    KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}',
    KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'fixture-template',
    E2B_API_KEY: 'fixture-not-a-real-key', E2B_API_URL: 'https://e2b.fixture.invalid', E2B_DOMAIN: 'fixture.invalid',
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
    const resumed = phase === 'restart' && agent.session.id === 'wake-cutover-resume';
    if (!resumed && agent.session.id !== 'wake-cutover-' + phase) return;
    const evidencePath = join(root, resumed ? 'proof-resume.json' : phase === 'initial' ? 'proof.json' : 'proof-restart.json');
    try {
      const origin = ctx.webServer.getOrigin();
      if (!resumed) await appendFile(join(root, 'mounted-inbound-host.jsonl'), JSON.stringify({ pid: process.pid, origin }) + '\n');
      const controller = ctx.get('sessionController');
      async function runProjectTurn(sessionId, index, text) {
        const ack = await controller.prompt({ sessionId, mode: 'queue', requestId: 'cutover-' + index,
          content: [{ type: 'text', text }] }, AbortSignal.timeout(20000));
        assert.equal(ack.accepted, true);
        const owner = ctx.agents.get(sessionId);
        await owner.whenIdle();
        const events = owner.session.snapshotEvents();
        const last = events.findLast(event => event.type === 'assistant/message');
        assert.ok(last, JSON.stringify(events.filter(event => event.type === 'turn/end')));
        return { owner, history: runHistory(events),
          answer: last.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('') };
      }
      if (phase === 'restart') {
        const prior = JSON.parse(await readFile(join(root, 'proof.json'), 'utf8'));
        assert.notEqual(prior.pid, process.pid);
        const alpha = prior.results.find(result => result.model === bindings[0].model);
        assert.ok(alpha, 'Expected the original Alpha session');
        const found = await controller.resolveAgent(alpha.sessionId);
        assert.ifError(found.error);
        assert.equal(found.agent.session.header.cwd, bindings[0].workspace);
        const events = found.agent.session.snapshotEvents();
        assert.ok(events.some(event => event.type === 'assistant/message'
          && event.data.message.content.some(part => part.type === 'text' && part.text === 'alpha complete.')));
        const original = runHistory(events, alpha.runId);
        assert.equal(original.engineEventSha256, alpha.engineEventSha256);
        if (!resumed) await writeFile(evidencePath, JSON.stringify({ pid: process.pid, reopened: original }));
        else {
          const { history, answer } = await runProjectTurn(alpha.sessionId, 2, 'Continue this project.');
          assert.notEqual(history.runId, alpha.runId);
          await writeFile(evidencePath, JSON.stringify({ pid: process.pid, resumed: { ...alpha, ...history, text: answer } }));
        }
        return;
      }
      const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      assert.equal(login.status, 302);
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const rpc = async (method, payload) => {
        const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(10000) });
        return (await response.json()).result;
      };
      const admission = async cwd => (await rpc('agents/ensure-preset', { agentId: record.metadata.id, cwd }));
      assert.equal((await admission(root)).error.code, 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE');
      const results = [];
      for (const [index, binding] of bindings.entries()) {
        const admitted = await admission(binding.workspace);
        assert.ok(admitted.ok, JSON.stringify(admitted.error));
        const { presetId, runtime, modelSelection, workspaceRoot } = admitted.value;
        assert.equal(runtime, 'native-engine');
        assert.equal(workspaceRoot, binding.workspace);
        assert.equal(modelSelection.model, binding.model);
        const { sessionId } = await controller.create({ cwd: binding.workspace, agentPreset: presetId });
        await controller.selectModel({ sessionId, ...modelSelection, saveDefault: false });
        const found = await controller.resolveAgent(sessionId);
        await ctx.get('commands').execute(found.agent, '/permission danger-full-access', [], AbortSignal.timeout(5000));
        const { owner, history, answer } = await runProjectTurn(sessionId, index, 'Create the project proof file.');
        assert.equal(owner.session.header.cwd, binding.workspace);
        const status = await ctx.get('tools').execute({ agent: owner, signal: AbortSignal.timeout(5000),
          calls: [{ id: `status-${index}`, name: 'component_status', arguments: '{}' }] });
        const facts = JSON.parse(status.results[0].result.value.result);
        assert.equal(facts.ok, true);
        assert.equal(facts.summary.model, binding.model);
        assert.equal(facts.workspace.root, binding.workspace);
        assert.deepEqual(facts.skill_space.tools, ['list_skill_spaces']);
        const skills = await ctx.get('tools').execute({ agent: owner, signal: AbortSignal.timeout(5000),
          calls: [{ id: `skills-${index}`, name: 'list_skill_spaces', arguments: '{}' }] });
        const directory = JSON.parse(skills.results[0].result.value.result);
        assert.deepEqual(directory.configured_space_ids, ['proof-skills']);
        assert.equal(directory.spaces[0].space_name, 'Fixture Skill Space');
        results.push({ sessionId, presetId, model: modelSelection.model, ...history, text: answer });
      }
      const web = await rpc('agents/ensure-preset', { agentId: dshAgent.metadata.id, cwd: bindings[0].workspace });
      assert.ok(web.ok, JSON.stringify(web.error));
      assert.equal(web.value.runtime, 'dsh-native');
      const { sessionId } = await controller.create({ cwd: bindings[0].workspace, agentPreset: web.value.presetId });
      const { agent: dshOwner } = await controller.resolveAgent(sessionId);
      const read = await ctx.get('tools').execute({ agent: dshOwner, signal: AbortSignal.timeout(5000),
        calls: [{ id: 'legacy-web', name: 'web_fetch', arguments: JSON.stringify({ url: a2aOrigin + '/studio-proof-web', max_chars: 2 }) }] });
      const page = JSON.parse(read.results[0].result.value.result);
      assert.equal(page.text, '😀证');
      assert.equal(page.next_offset_chars, 2);
      assert.ok(page.persisted?.path);
      const inspection = await ctx.get('tools').execute({ agent: dshOwner, signal: AbortSignal.timeout(5000),
        calls: [{ id: 'legacy-e2b-status', name: 'sandbox_status', arguments: '{}' }] });
      const sandbox = JSON.parse(inspection.results[0].result.value.result);
      assert.equal(sandbox.backend, 'e2b');
      assert.equal(sandbox.sandbox_phase, 'absent');
      const dshStatus = await ctx.get('tools').execute({ agent: dshOwner, signal: AbortSignal.timeout(5000),
        calls: [{ id: 'legacy-skill-status', name: 'component_status', arguments: '{}' }] });
      const skill = JSON.parse(dshStatus.results[0].result.value.result);
      assert.equal(skill.skill_runtime.backend, 'e2b');
      assert.equal(skill.skill_runtime.enabled, true);
      assert.equal(skill.skill_runtime.template_bound, true);
      assert.deepEqual(skill.skill_space.tools, ['execute_skills']);
      await ctx.get('commands').execute(dshOwner, '/permission danger-full-access', [], AbortSignal.timeout(5000));
      async function workspaceTool(name, args) {
        const response = await ctx.get('tools').execute({ agent: dshOwner, signal: AbortSignal.timeout(10000),
          calls: [{ id: 'legacy-' + name, name, arguments: JSON.stringify(args) }] });
        return JSON.parse(response.results[0].result.value.result);
      }
      const path = 'studio-workspace-proof.py';
      const written = await workspaceTool('write_workspace_file', { path, content: 'value = "旧版 😀"\n' });
      assert.equal(written.ok, true, JSON.stringify(written));
      const file = await workspaceTool('read_workspace_file', { path, include_line_numbers: false });
      assert.equal(file.content, 'value = "旧版 😀"');
      const edited = await workspaceTool('edit_workspace_file', { path, old_text: '旧版', new_text: '新版' });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      const lint = await workspaceTool('lint_workspace_file', { path });
      assert.equal(lint.ok, true, JSON.stringify(lint));
      assert.equal(await readFile(join(bindings[0].workspace, path), 'utf8'), 'value = "新版 😀"\n');
      await writeFile(evidencePath, JSON.stringify({
        pid: process.pid, results, unboundRejected: true, skillDirectoryRead: true, dshWebRead: true, dshE2BStatus: true, dshE2BSkillMounted: true,
        dshWorkspaceTools: true, localCommandPolicy: true,
      }));
    } catch (error) {
      await writeFile(evidencePath, JSON.stringify({ error: error.stack || String(error) }));
      throw error;
    }
  });
}
