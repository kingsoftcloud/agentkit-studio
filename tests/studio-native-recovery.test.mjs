import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createNativeRecoveryState } from '../src/client/state/native-recovery.mjs';
import { createStudioHostRemote } from '../src/host-remote.mjs';

const gate = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));

// Product assembly units deliberately use a narrow Agent double. The separate
// mounted-Host proof uses official SessionController, real Agents and HTTP RPC.
async function fixture(t, { fetchModel, maxTokens = 500 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-recovery-unit-')), workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root }), ledger = new MemoryRunStore();
  const record = await agents.create({ name: 'Recovery', runtimeType: 'harness', bindings: { modelProfileIds: ['fixture'] } });
  const events = [], projections = new Map(), requests = [], seen = [], controller = new AbortController();
  let failFlush = true, key = 'secret-before', running = Promise.resolve();
  const session = { id: 'original-session', append(type, data, options) { events.push({ type, data: structuredClone(data), ...options, seq: events.length + 1 }); } };
  session.append('turn/start', { turn: 1 });
  const assembly = { prompt: 'Original system prompt', tools: [], variables: { provider: 'agentkit-studio-fixture', model: 'original' } };
  const agent = { session, options: { maxTokens, provider: 'agentkit-studio-fixture', model: 'original' },
    externalTurns: nativeOwnershipHost(session, events), whenIdle: () => running };
  agent.externalTurns.resume = async (_engine, execute) => {
    const owner = agent.externalTurns.pending();
    running = execute({ ownership: owner, turn: owner.turn, signal: controller.signal,
      prepareInput: async () => ({ kind: 'enter', messages: [], assembly }) });
    const ending = await running;
    session.append('turn/end', { turn: owner.turn, ...ending });
    return ending;
  };
  const binding = { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: {
      definitions: () => [], forAgent: () => ({ tools: { execute: () => assert.fail('No tool was requested') } }),
    } };
  const services = { sessions: { flush: async () => !failFlush }, sessionProjections: {
    register(value) { projections.set(value.key, value); return () => projections.delete(value.key); },
    stateOf: (_, id) => projections.has(id) ? events.reduce(projections.get(id).apply, projections.get(id).init()) : undefined,
  }, sessionController: { resolveAgent: async id => { assert.equal(id, session.id); seen.push('resolve'); return { agent }; } },
  systemPrompt: { assemble: async context => { assert.equal(context.agent, agent); seen.push('assemble'); return assembly; } } };
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'original', baseUrl: 'https://fixture.invalid/v1' }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: key }) } });
  const host = await createStudioNativeHarness({ ctx: { get: id => services[id] }, storeDir: root, workspaceRoot, agents, models, ledger,
    renderPrompt: assembly => `${assembly.prompt} for ${assembly.variables.model}`,
    agentEvents: (_ctx, actual) => { assert.equal(actual, agent); return { serial: async event => {
      assert.equal(event, 'agentkit/native-recovery-binding'); seen.push('query'); return binding;
    } }; }, assembleContextFor: (actual, signal) => ({ agent: actual, scope: actual, signal }),
    fetchImpl: async (_url, options) => {
      requests.push({ body: JSON.parse(options.body), headers: new Headers(options.headers) });
      if (fetchModel) return fetchModel(options.signal);
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Recovered' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent, input: { kind: 'enter', messages: [{ id: 'original-user', role: 'user', content: [{ type: 'text', text: 'Finish original task' }] }], assembly },
    turn: 1, signal: controller.signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly }), binding };
  await assert.rejects(host.executeTurn(payload), /ownership_not_durable/);
  assert.equal(ledger.list({ tenantId: 'local', workspaceId: 'unused', userId: 'local-user', agentId: binding.agentId }).length, 0);
  failFlush = false;
  const request = { agentId: binding.agentId, sessionId: session.id };
  const route = createSessionRoutes({ getNativeHost: async () => host });
  const status = await host.recoveryStatus(request);
  assert.equal(status.state, 'available'); assert.equal(requests.length, 0);
  return { host, ledger, agent, binding, requests, events, services, values, seen, controller, route, assembly,
    request: { ...request, runId: status.runId }, rotate: value => { key = value; } };
}

test('production recovery rebinds the original route/budget and refreshed credentials, not current Agent defaults', async t => {
  const f = await fixture(t); f.agent.options = { provider: 'other', model: 'other', maxTokens: 9999 }; f.rotate('secret-after');
  f.assembly.variables = { provider: 'picker-default', model: 'picker-model' };
  const ack = (await f.route('sessions/native-recovery-resume', f.request)).value;
  assert.equal(ack.runId, f.request.runId); assert.equal(ack.state, 'recovering');
  await f.agent.whenIdle(); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.model, 'original'); assert.equal(f.requests[0].body.max_tokens, 500);
  assert.equal(f.requests[0].body.messages[0].content, 'Original system prompt for original');
  assert.equal(JSON.stringify(f.requests[0].body).includes('picker-model'), false);
  assert.equal(f.requests[0].headers.get('authorization'), 'Bearer secret-after');
  assert.deepEqual(f.seen.slice(-3), ['resolve', 'query', 'assemble']);
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1); assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1);
  assert.equal((await f.host.recoveryStatus(f.request)).state, 'closed');
  assert.equal((await f.host.resumeTurn(f.request)).state, 'closed', 'a reply lost after completion confirms the original Run');
  await tick(); assert.equal(f.requests.length, 1); assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1);
  await assert.rejects(f.host.resumeTurn({ ...f.request, runId: 'foreign-completed-run' }), /studio_native_recovery_turn_not_open/);
});

test('recovery refuses an explicit pending model switch instead of treating it as a changed default', async t => {
  const f = await fixture(t), stateOf = f.services.sessionProjections.stateOf;
  f.services.sessionProjections.stateOf = (session, id) => id === 'modelSelection'
    ? { pending: { provider: 'other', model: 'other' } } : stateOf(session, id);
  await assert.rejects(f.host.resumeTurn(f.request), /studio_native_recovery_model_selection_changed/);
  await tick(); assert.equal(f.requests.length, 0); assert.equal(f.events.filter(e => e.type === 'turn/end').length, 0);
  assert.equal((await f.host.recoveryStatus(f.request)).phase, 'admitted');
});

test('recovery keeps current prompt changes fenced before executing the original Run', async t => {
  const f = await fixture(t);
  // Change a non-model contribution, which route restoration cannot hide.
  f.assembly.prompt = 'Changed instructions';
  await assert.rejects(f.host.resumeTurn(f.request), /studio_native_recovery_prompt_changed/);
  assert.equal(f.requests.length, 0); assert.ok(f.agent.externalTurns.pending());
});

for (const change of ['revision', 'profile', 'permission']) test(`production recovery refuses ${change} drift without model or Run creation`, async t => {
  const f = await fixture(t);
  if (change === 'revision') f.binding.agentRevision++;
  if (change === 'profile') f.values.modelProfiles[0].baseUrl = 'https://changed.invalid/v1';
  if (change === 'permission') f.binding.nativeTools.permissionContract = 'changed-policy/v1';
  await assert.rejects(f.host.resumeTurn(f.request), /recovery_(preset_changed|configuration_changed)/);
  await tick(); assert.equal(f.requests.length, 0); assert.equal(f.events.filter(e => e.type === 'turn/end').length, 0);
  assert.ok(f.agent.externalTurns.pending());
  assert.equal((await f.host.recoveryStatus(f.request)).state, 'failed');
});

test('recovery rejects another Agent or Run and invalid control requests before dispatch', async t => {
  const f = await fixture(t);
  for (const request of [{ ...f.request, agentId: 'other' }, { ...f.request, runId: 'other' }])
    await assert.rejects(f.host.resumeTurn(request), /recovery_identity_mismatch/);
  for (const request of [{}, { ...f.request, binding: {} }, { ...f.request, runId: '' }])
    await assert.rejects(f.route('sessions/native-recovery-resume', request), { code: 'STUDIO_NATIVE_RECOVERY_INVALID' });
  assert.equal(f.requests.length, 0);
});

test('duplicate recovery shares the installed original control and Host close aborts its worker', async t => {
  const entered = gate();
  const f = await fixture(t, { fetchModel: signal => new Promise((_, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const [a, b] = await Promise.all([f.host.resumeTurn(f.request), f.host.resumeTurn(f.request)]);
  assert.deepEqual(a, b); await entered.promise;
  const active = await f.host.recoveryStatus(f.request);
  assert.equal(active.canResume, false); assert.equal(active.state, 'recovering');
  assert.equal(f.requests.length, 1);
  await f.host.close(); await tick();
  assert.equal(f.agent.externalTurns.pending(), null);
  assert.equal(f.events.findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
});

test('UI refresh never resumes; an unconfirmed recovery retries only the same Run on both transports', async () => {
  const calls = [], identity = { agentId: 'a', sessionId: 's' };
  let current = 'original', fail = true;
  const status = () => ({ contract: 'agentkit.studio-native-recovery/v1', ...identity, runId: current, state: 'available', canResume: true });
  const state = createNativeRecoveryState({ ...identity, hostRemote: {
    nativeRecoveryStatus: async () => status(), resumeNativeRun: async request => {
      calls.push(request); if (fail) { fail = false; throw Error('Response lost'); } return { ...status(), runId: request.runId, state: 'recovering', canResume: false };
    },
  } });
  await state.refresh(); assert.equal(calls.length, 0); await state.resume(); current = 'later'; await state.refresh(); await state.retry();
  assert.deepEqual(calls, [{ ...identity, runId: 'original' }, { ...identity, runId: 'original' }]); state.dispose();
  for (const connection of [false, true]) {
    const seen = [], remote = createStudioHostRemote(connection ? { connection: { rpc: { call: async (_channel, operation, payload) => {
      seen.push([operation, payload]); return { ok: true, value: status() };
    } } } } : { fetchImpl: async (_url, init) => { const input = JSON.parse(init.body); seen.push([input.method, input.payload]); return new Response(JSON.stringify({ result: { ok: true, value: status() } })); } });
    await remote.nativeRecoveryStatus(identity); await remote.resumeNativeRun({ ...identity, runId: 'original' });
    assert.deepEqual(seen.map(row => row[0]), ['sessions/native-recovery-status', 'sessions/native-recovery-resume']);
  }
});
