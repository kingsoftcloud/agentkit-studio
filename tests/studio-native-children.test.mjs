import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { nativeChildRoles } from '../src/providers/native-subagents.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';

async function setup(t, { sqlite = false, role = {}, forged = false, control = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-children-')), workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot); await writeFile(join(workspaceRoot, 'proof.txt'), 'Actual child evidence');
  const roles = [{ name: 'reader', instructions: 'Read the requested workspace evidence.', tools: ['read_workspace_file'],
    modelProfileId: 'child-profile', maxTurns: 3, maxToolCalls: 2, ...role }];
  const agents = createAgentStore({ storeDir: join(root, 'agents') });
  const record = await agents.create({ name: 'Parent', runtimeType: 'harness', spec: { subAgents: roles,
    bindings: { modelProfileIds: ['parent-profile', 'child-profile'], tools: ['read_workspace_file'] } } });
  const ledger = sqlite ? new SqliteRunStore(join(root, 'runs.sqlite')) : new MemoryRunStore();
  const events = [], registered = new Map(), projections = new Map(), dispatches = [], requests = [];
  const session = { id: 'parent-session', append(type, data, options) { events.push({ type, data, ...options, seq: events.length + 1 }); } };
  session.append('turn/start', { turn: 1 });
  const services = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, sessions: { flush: async () => true }, llm: {},
    sessionProjections: { register: definition => { projections.set(definition.key, definition); return () => projections.delete(definition.key); },
      stateOf: (_session, key) => { const projection = projections.get(key); return events.reduce(projection.apply, projection.init()); } } };
  const ctx = { get: name => services[name], effect: install => install(), tools: {
    register: definition => { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
    execute: async request => {
      dispatches.push({ name: request.name, callId: request.callId, agent: request.agent });
      const definition = registered.get(request.name), value = await definition.execute(request.arguments, request);
      return { isError: false, content: definition.output.render(request.arguments, value) };
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { subAgents: roles, toolBindings: ['read_workspace_file'] },
    workspaceRoot, stateDir: join(root, 'tools') });
  const values = { modelProfiles: [{ id: 'parent-profile', provider: 'openai-compatible', modelName: 'parent-model', baseUrl: 'https://parent.invalid/v1' },
    { id: 'child-profile', provider: 'openai-compatible', modelName: 'child-model', baseUrl: 'https://child.invalid/v1' }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: 'fixture-secret' }) } });
  let parentModels = 0, childModels = 0;
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, models, ledger,
    renderPrompt: () => 'Delegate a bounded read; use its evidence without treating it as parent acceptance.',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, body });
      const child = body.model === 'child-model';
      let call, text;
      if (child) {
        childModels++;
        assert.equal(url, 'https://child.invalid/v1/chat/completions');
        assert.deepEqual(body.tools.map(item => item.function.name), ['read_workspace_file']);
        if (childModels === 1) call = { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
        else {
          assert.match(JSON.stringify(body.messages.filter(item => item.role === 'tool')), /Actual child evidence/);
          text = 'Child read actual workspace evidence';
        }
      } else {
        parentModels++;
        if (parentModels === 1) call = { name: 'native_start_child', arguments: { role: 'reader', task: 'Read proof.txt',
          ...(forged ? { model_profile_id: 'unbound-profile' } : {}) } };
        else if (control && parentModels === 2) {
          const serialized = JSON.stringify(body.messages);
          const childId = /native-child-[a-f0-9]{64}/.exec(serialized)?.[0];
          assert.ok(childId); call = { name: 'native_child_control', arguments: { child_run_id: childId, action: 'wait', wait_seconds: 1 } };
        } else text = 'Parent delivery';
      }
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
      return new Response(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta,
        finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await gateway.close(); ledger.close?.(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent: { session, options: { provider: 'agentkit-studio-parent-profile', model: 'parent-model' } },
    signal: new AbortController().signal, turn: 1,
    input: { kind: 'enter', messages: [{ id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Use the bounded reader' }] }],
      assembly: { tools: [...registered.values()] } },
    binding: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: gateway },
  };
  payload.prepareInput = async () => ({ kind: 'enter', messages: [], assembly: payload.input.assembly });
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
    userId: 'local-user', agentId: record.metadata.id };
  return { host, payload, ledger, gateway, roles, requests, dispatches, record, scope, childModels: () => childModels };
}
for (const sqlite of [false, true]) {
  test(`${sqlite ? 'sqlite' : 'memory'}: production Studio assembly runs an approved child model and scoped workspace read`, { timeout: 15000 }, async t => {
    const fixture = await setup(t, { sqlite, control: true });
    await fixture.host.executeTurn(fixture.payload);
    assert.equal(fixture.childModels(), 2);
    const parent = fixture.ledger.sessionHead(fixture.scope, 'parent-session');
    assert.equal(parent.phase, 'completed'); assert.equal(parent.childRunIds.length, 1);
    assert.equal(parent.descendantUsage.modelCalls, 2); assert.equal(parent.descendantUsage.toolCalls, 1);
    const reservation = parent.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
    const child = fixture.ledger.load(reservation.childScope, reservation.childRunId);
    assert.equal(child.snapshot.phase, 'completed'); assert.equal(child.configuration.profile.profileId, 'child-profile');
    assert.equal(child.configuration.childOwnerBinding.role, 'reader'); assert.equal(child.snapshot.parentRunId, null);
    assert.equal(child.configuration.limits.maxModelCalls, 3); assert.equal(child.configuration.limits.maxToolCalls, 2);
    assert.equal(fixture.ledger.events(fixture.scope, parent.runId).filter(event => event.kind === 'usage.reported'
      && event.payload.source === 'descendant_runs').length, 1);
    assert.equal(fixture.dispatches.filter(item => item.name === 'read_workspace_file').length, 1);
    const childRequest = fixture.requests.find(item => item.body.model === 'child-model');
    assert.match(childRequest.body.messages[0].content, /Read the requested workspace evidence/);
    assert.equal(JSON.stringify(childRequest.body.messages).includes('Delegate a bounded read'), false);
    assert.equal(JSON.stringify(fixture.gateway.childBinding.roles).includes('fixture-secret'), false);
    assert.ok(fixture.dispatches.some(item => item.name === 'native_child_control'));
  });
}
test('model arguments cannot select an unbound child profile', async t => {
  const fixture = await setup(t, { forged: true });
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.childModels(), 0); assert.equal(fixture.dispatches.length, 0);
});
for (const role of [{ modelProfileId: 'foreign' }, { tools: ['write_workspace_file'] }, { maxTotalTokens: 1000 }, { maxArtifacts: 1 }]) {
  test(`unsupported or unauthorized role bindings fail before model work: ${JSON.stringify(role)}`, async t => {
    if (role.maxTotalTokens || role.maxArtifacts) { assert.throws(() => nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Read', ...role }] }), /child_policy_unavailable/); return; }
    const fixture = await setup(t, { role });
    await assert.rejects(fixture.host.executeTurn(fixture.payload), /child_(model_unbound|write_role_requires_isolation)/);
    assert.equal(fixture.requests.length, 0);
  });
}
