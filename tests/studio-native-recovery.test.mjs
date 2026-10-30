import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore } from '@kingsoftcloud/agentkit-harness-core';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createNativeRecoveryState } from '../src/client/state/native-recovery.mjs';
import { createStudioHostRemote } from '../src/host-remote.mjs';
import { nativeDeliveryProjection } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { nativeLocalExecutionMethods } from '../src/providers/native-local-execution.mjs';

const gate = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('recovery client admits scoped auxiliary Memory usage and rejects foreign or malformed job status', async () => {
  const job = { jobId: 'memory-job', parentRunId: 'original-run', status: 'success', errorCode: null,
    createdAt: 1, updatedAt: 2, usage: { modelCalls: 2, toolCalls: 1, inputTokens: 22, outputTokens: 14, cost: 0 } };
  const extraction = { contract: 'agentkit.studio-native-memory-extraction/v1', agentId: 'agent', sessionId: 'session',
    cursor: 'native-message://run#message=2', jobs: [job] };
  const response = { contract: 'agentkit.studio-native-recovery/v1', agentId: 'agent', sessionId: 'session',
    runId: 'original-run', state: 'closed', canResume: false, memoryExtraction: extraction };
  let value = response;
  const client = createNativeRecoveryState({ agentId: 'agent', sessionId: 'session',
    hostRemote: { nativeRecoveryStatus: async () => structuredClone(value) } });
  try {
    await client.refresh(); assert.deepEqual(client.getSnapshot().status.memoryExtraction, extraction);
    for (const broken of [{ ...extraction, sessionId: 'foreign' }, { ...extraction, jobs: [{ ...job, status: 'forged' }] },
      { ...extraction, jobs: [{ ...job, usage: { ...job.usage, modelCalls: -1 } }] }]) {
      value = { ...response, memoryExtraction: broken }; await client.refresh();
      assert.ok(client.getSnapshot().error); assert.deepEqual(client.getSnapshot().status.memoryExtraction, extraction);
    }
    value = { ...response, error: { code: 'INVALID ERROR', message: 'untrusted status' } };
    await client.refresh(); assert.match(client.getSnapshot().error, /恢复状态读取失败/);
    assert.deepEqual(client.getSnapshot().status.memoryExtraction, extraction);
  } finally { client.dispose(); }
});

// Product assembly units deliberately use a narrow Agent double. The separate
// mounted-Host proof uses official SessionController, real Agents and HTTP RPC.
async function fixture(t, { fetchModel, maxTokens = 500, localExecutionMode } = {}) {
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
  const localExecutions = [], localMethods = nativeLocalExecutionMethods({ enabled: true, settings: {},
    sourceEnv: { PATH: '/usr/bin:/bin' }, workspaceRoot, commandBackend: 'local_process' });
  if (localExecutionMode) {
    const historical = options => localExecutionMode === 'historical' ? { modern: options.modern } : options;
    const execute = binding.nativeTools.forAgent;
    Object.assign(binding.nativeTools, {
      localExecution: options => localMethods.localExecution(historical(options)),
      executionEnvironment: options => localMethods.executionEnvironment(historical(options)),
      forAgent: (agent, authority) => { localExecutions.push(authority.localExecution); return execute(agent, authority); } });
  }
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
  return { host, ledger, agent, binding, requests, events, services, values, seen, controller, route, assembly, session, workspaceRoot,
    localExecutions, localMethods, request: { ...request, runId: status.runId }, rotate: value => { key = value; } };
}

for (const historical of [false, true]) test(`production recovery keeps ${historical ? 'historical' : 'new'} local resource admission and actual model facts`, async t => {
  const f = await fixture(t, { localExecutionMode: historical ? 'historical' : 'new' });
  assert.equal(f.localExecutions[0].settings.maxFileBytes, historical ? 64 * 1024 ** 2 : 1024 ** 3);
  // Reconstruct with the current owner, including an old admission which has
  // no resource-profile field. The public recovery path must not upgrade it.
  Object.assign(f.binding.nativeTools, f.localMethods);
  await f.host.resumeTurn(f.request); await f.agent.whenIdle(); await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.localExecutions.length, 2);
  assert.deepEqual(f.localExecutions[1].settings, f.localExecutions[0].settings);
  assert.equal((await f.host.recoveryStatus(f.request)).state, 'closed');
  const serialized = JSON.stringify(f.requests[0].body);
  assert.equal(serialized.includes('commandResources'), !historical);
  // The actual HTTP runtime_environment carries the same requested bound.
  if (!historical) {
    const row = f.requests[0].body.messages.find(message => typeof message.content === 'string' && message.content.includes('agentkit.execution-environment/v1'));
    assert.equal(JSON.parse(row.content).commandResources.requestedLimits.maxFileBytes, f.localExecutions[1].settings.maxFileBytes);
  }
});

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
  const closed = await f.host.recoveryStatus(f.request);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.workspace.contract, 'agentkit.native-execution-workspace/v1');
  assert.equal(closed.workspace.root, f.workspaceRoot, 'preview uses the actual Native execution root after recovery');
  assert.equal((await f.host.resumeTurn(f.request)).state, 'closed', 'a reply lost after completion confirms the original Run');
  await tick(); assert.equal(f.requests.length, 1); assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1);
  await assert.rejects(f.host.resumeTurn({ ...f.request, runId: 'foreign-completed-run' }), /studio_native_recovery_turn_not_open/);
});

test('a terminal provider failure remains visible through read-only recovery status without exposing its raw response', async t => {
  const f = await fixture(t, { fetchModel: async () => new Response('secret-provider-response', { status: 401 }) });
  await f.host.resumeTurn(f.request); await f.agent.whenIdle();
  const status = await f.host.recoveryStatus(f.request);
  assert.equal(status.state, 'closed'); assert.equal(status.phase, 'failed');
  assert.equal(status.error.code, 'NATIVE_EXECUTION_NOT_COMPLETED');
  assert.match(status.error.message, /模型服务/);
  assert.doesNotMatch(JSON.stringify(status), /secret-provider-response/);
  assert.equal(f.requests.length, 1, 'reading the failure cannot issue another model request');
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

test('retiring recovery discovery during full prompt rebinding cannot install a late driver', async t => {
  const f = await fixture(t), entered = gate(), prompt = gate(), stop = new AbortController();
  f.services.systemPrompt.assemble = async () => { entered.resolve(); return prompt.promise; };
  const recovery = f.host.resumeTurn(f.request, stop.signal);
  const rejected = assert.rejects(recovery, /discovery-retired/);
  await entered.promise; stop.abort(Error('discovery-retired')); prompt.resolve(f.assembly);
  await rejected; await tick();
  assert.equal(f.requests.length, 0, 'late binding cannot call a model');
  assert.ok(f.agent.externalTurns.pending(), 'the original owner remains recoverable');
  assert.equal(f.events.filter(event => event.type === 'turn/end').length, 0);
});

for (const change of ['revision', 'profile', 'permission']) test(`production recovery refuses ${change} drift without model or Run creation`, async t => {
  const f = await fixture(t);
  if (change === 'revision') f.binding.agentRevision++;
  if (change === 'profile') f.values.modelProfiles[0].baseUrl = 'https://changed.invalid/v1';
  if (change === 'permission') f.binding.nativeTools.permissionContract = 'changed-policy/v1';
  await assert.rejects(f.host.resumeTurn(f.request), change === 'profile'
    ? {code:'studio_native_model_binding_changed'} : /recovery_(preset_changed|configuration_changed)/);
  await tick(); assert.equal(f.requests.length, 0); assert.equal(f.events.filter(e => e.type === 'turn/end').length, 0);
  assert.equal(f.ledger.list({tenantId:'local',workspaceId:'unused',userId:'local-user',agentId:f.binding.agentId}).length,0);
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

test('the recovery client rejects a managed response that claims local approval or a new control authority', async () => {
  const identity = { agentId: 'a', sessionId: 's' };
  const valid = { contract: 'agentkit.studio-native-recovery/v1', ...identity, runId: 'original', state: 'available', phase: 'paused',
    canResume: false, canReconcile: false, managed: { contract: 'agentkit.studio-managed-native-recovery/v1',
      commandId: 'original-command', commandState: 'accepted', controlAuthority: 'server', owner: 'open', executionState: 'running', retryAcceptedCommand: false } };
  for (const changes of [{ controlAuthority: 'local' }, { contract: 'unknown/v1' }, { retryAcceptedCommand: 'yes' }]) {
    const response = { ...valid, managed: { ...valid.managed, ...changes } };
    const state = createNativeRecoveryState({ ...identity, hostRemote: {
      nativeRecoveryStatus: async () => response, resumeNativeRun: async () => assert.fail('Status cannot execute'),
    } });
    await state.refresh(); assert.equal(state.getSnapshot().status, null); assert.ok(state.getSnapshot().error); state.dispose();
  }
});

test('the recovery client retains versioned grant status and refuses forged permission to resume a blocked or discarded command', async () => {
  const identity = { agentId: 'a', sessionId: 's' };
  const grant = { contract: 'agentkit.managed-native-execution-grants/v1', grantId: 'occurrence/member', state: 'active',
    attemptEpoch: null, revision: 1, admissionRevision: 2, admissionAllowed: false, expiresAt: null,
    qualified: false, blockedReason: 'execution_grant_admission_paused' };
  const valid = { contract: 'agentkit.studio-native-recovery/v1', ...identity, runId: 'original', state: 'available', phase: 'admitted',
    canResume: false, canReconcile: false, managed: { contract: 'agentkit.studio-managed-native-recovery/v1',
      commandId: 'original-command', commandState: 'accepted', controlAuthority: 'server', owner: 'pending', executionState: 'idle',
      retryAcceptedCommand: false, executionGrant: grant } };
  let response = structuredClone(valid), executions = 0;
  const client = createNativeRecoveryState({ ...identity, hostRemote: { nativeRecoveryStatus: async () => response,
    resumeNativeRun: async () => { executions++; assert.fail('grant status is not execution authority'); } } });
  await client.refresh(); assert.deepEqual(client.getSnapshot().status, valid);
  for (const alter of [value => { value.managed.executionGrant.contract = 'future/v2'; },
    value => { value.managed.executionGrant.blockedReason = 'caller-approved'; },
    value => { value.managed.executionGrant.revision = 0; }, value => { value.managed.executionGrant.qualified = 'yes'; },
    value => { value.canResume = true; value.managed.retryAcceptedCommand = true; }]) {
    response = structuredClone(valid); alter(response); await client.refresh();
    assert.deepEqual(client.getSnapshot().status, valid); assert.ok(client.getSnapshot().error);
  }
  response = { ...structuredClone(valid), state: 'closed', phase: 'discarded', managed: { ...valid.managed,
    commandState: 'discarded', owner: 'closed', executionGrant: { ...grant, state: 'revoked', revision: 2, blockedReason: null } } };
  await client.refresh(); assert.equal(client.getSnapshot().error, ''); assert.equal(client.getSnapshot().status.phase, 'discarded');
  await client.resume(); assert.equal(executions, 0); client.dispose();
});

test('the recovery client retains valid usage and rejects unknown, inconsistent or foreign accounting without execution', async () => {
  const usage = { inputTokens: 7, outputTokens: 9, modelCalls: 1, toolCalls: 2, cost: .25 };
  const zero = { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0 };
  const identity = { agentId: 'a', sessionId: 's' };
  const valid = { contract: 'agentkit.studio-native-recovery/v1', ...identity, runId: 'original', state: 'closed', canResume: false,
    accounting: { contract: 'agentkit.studio-native-usage/v1', runId: 'original', snapshotRevision: 6,
      own: { ...zero }, descendant: { ...usage }, total: { ...usage }, final: true, incomplete: true, complete: false } };
  let response = structuredClone(valid), controls = 0;
  const client = createNativeRecoveryState({ ...identity, hostRemote: {
    nativeRecoveryStatus: async () => response, resumeNativeRun: async () => { controls++; assert.fail('refresh must not execute'); },
  } });
  await client.refresh(); assert.deepEqual(client.getSnapshot().status, valid);
  for (const alter of [value => { value.contract = 'future/v2'; }, value => { value.runId = 'foreign'; },
    value => { value.complete = true; }, value => { value.total.modelCalls = 0; },
    value => { value.total.cost = null; }, value => { value.total.inputTokens = -1; },
    value => { value.descendant.toolCalls = 1.5; }, value => { delete value.own.outputTokens; },
    value => { value.total.extra = 1; }]) {
    response = structuredClone(valid); alter(response.accounting); await client.refresh();
    assert.deepEqual(client.getSnapshot().status, valid, 'malformed accounting cannot replace accepted data');
    assert.match(client.getSnapshot().error, /读取失败/);
  }
  response = { ...structuredClone(valid), accounting: null }; await client.refresh();
  assert.equal(client.getSnapshot().status.accounting, null, 'a non-Native Session has no fabricated usage');
  delete response.accounting; await client.refresh(); assert.equal(client.getSnapshot().error, '', 'older v1 status consumers remain compatible');
  await client.resume(); assert.equal(controls, 0); client.dispose();
});

test('the client distinguishes local receipt-wait reattachment from an explicit remote reconciliation read', async () => {
  const identity = { agentId: 'a', sessionId: 's' }, calls = [];
  const marker = { contract: 'agentkit.tool-receipt-observation/v1', operationKey: 'original', callId: 'call' };
  let response = { contract: 'agentkit.studio-native-recovery/v1', ...identity, runId: 'run', phase: 'awaiting_reconciliation',
    state: 'reconciliation_required', canResume: true, canReconcile: true, reconciliation: marker,
    receiptWait: { contract: 'agentkit.native-a2a-receipt-wait/v1', operationKey: 'original', callId: 'call' } };
  const state = createNativeRecoveryState({ ...identity, hostRemote: {
    nativeRecoveryStatus: async () => response,
    resumeNativeRun: async request => { calls.push(request); response = { ...response, state: 'recovering', canResume: false }; return response; },
    reconcileNativeTool: () => assert.fail('reattachment must never request remote inspection'),
  } });
  await state.refresh(); assert.deepEqual(calls, []);
  await state.resume(); assert.deepEqual(calls, [{ ...identity, runId: 'run' }]);
  assert.equal(state.getSnapshot().error, ''); assert.equal(state.getSnapshot().status.state, 'recovering');
  assert.equal(state.getSnapshot().status.canReconcile, true, 'an active local wait still permits explicit inspection');
  const accepted = state.getSnapshot().status;
  for (const field of ['contract', 'operationKey', 'callId']) {
    response = { ...accepted, receiptWait: { ...accepted.receiptWait, [field]: 'foreign' } };
    await state.refresh(); assert.equal(state.getSnapshot().status, accepted); assert.match(state.getSnapshot().error, /读取失败/);
  }
  state.dispose();
});

for (const transport of ['local', 'http']) test(`${transport}: explicit workspace repair retries the same operator command without a result or file payload`, async () => {
  const identity = { agentId: 'a', sessionId: 's' }, calls = [];
  const status = { contract: 'agentkit.studio-native-recovery/v1', ...identity, runId: 'run', phase: 'awaiting_reconciliation',
    state: 'reconciliation_required', canResume: false, canReconcile: true, canRepairWorkspace: true,
    reconciliation: { contract: 'agentkit.tool-receipt-observation/v1', operationKey: 'original', callId: 'call' } };
  const dispatch = async (operation, payload) => {
    calls.push({ operation, payload });
    if (operation === 'sessions/native-workspace-repair' && calls.filter(call => call.operation === operation).length === 1) throw Error('Lost reply');
    return { ok: true, value: status };
  };
  const remote = createStudioHostRemote(transport === 'local' ? { connection: { rpc: { call: (_channel, operation, payload) => dispatch(operation, payload) } } }
    : { fetchImpl: async (_url, init) => { const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ result: await dispatch(request.method, request.payload) })); } });
  const state = createNativeRecoveryState({ ...identity, hostRemote: remote, newCommandId: () => 'fixed-repair-command' });
  await state.refresh(); assert.equal(calls.length, 1); await state.repairWorkspace();
  assert.ok(state.getSnapshot().pending); await state.retry();
  const repairs = calls.filter(call => call.operation === 'sessions/native-workspace-repair');
  assert.equal(repairs.length, 2); assert.deepEqual(repairs[0], repairs[1]);
  assert.deepEqual(repairs[0].payload, { ...identity, runId: 'run', operationKey: 'original', commandId: 'fixed-repair-command' });
  assert.equal(state.getSnapshot().pending, null); state.dispose();
});

// A fixture variant that drives a real Run through createStudioNativeHarness until
// a tool effect returns ``uncertain``, leaving the Run ``interrupted`` with an
// uncertain receipt and a durable turn/owner (no turn/end). This is the
// ``effect_outcome_unknown`` product scenario — not a hand-edited snapshot.
async function interruptedFixture(t, { repairable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-recovery-int-')), workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root }), ledger = new MemoryRunStore();
  const record = await agents.create({ name: 'Interrupted', runtimeType: 'harness', bindings: { modelProfileIds: ['fixture'] } });
  const events = [], projections = new Map(), requests = [], seen = [], controller = new AbortController();
  let key = 'secret', running = Promise.resolve();
  projections.set('dsh:original-session:1:v1:', nativeDeliveryProjection());
  projections.set('agentPreset', { init: () => 'fixture-preset', apply: state => state });
  const session = { id: 'original-session', append(type, data, options) { events.push({ type, data: structuredClone(data), ...options, seq: events.length + 1 }); } };
  session.append('turn/start', { turn: 1 });
  const assembly = { prompt: 'Original system prompt', tools: [], variables: { provider: 'agentkit-studio-fixture', model: 'original' } };
  const agent = { session, options: { maxTokens: 500, provider: 'agentkit-studio-fixture', model: 'original' },
    externalTurns: nativeOwnershipHost(session, events), whenIdle: () => running };
  agent.externalTurns.resume = async (_engine, execute) => {
    const owner = agent.externalTurns.pending();
    running = execute({ ownership: owner, turn: owner.turn, signal: controller.signal,
      prepareInput: async () => ({ kind: 'enter', messages: [], assembly }) });
    try { const ending = await running; session.append('turn/end', { turn: owner.turn, ...ending }); return ending; }
    catch (error) { session.append('turn/end', { turn: owner.turn, reason: { kind: 'error', error: { code: 'NATIVE_TURN_FAILED' } } }); throw error; }
  };
  const writeTool = { name: repairable ? 'write_workspace_file' : 'write', description: 'Write a file', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 5000, contextRole: 'none', observationRole: 'none',
    progressObservation: false, contextRetention: 'normal', ...(repairable ? { workspaceCheckpointPolicy: 'file-preimages/v1',
      workspaceRepairPolicy: 'preimage-compensation/v1', recoveryPolicy: 'receipt-observation/v1' } : {}) };
  let toolCalls = 0, repairCalls = 0;
  const binding = { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: {
      definitions: () => [writeTool], forAgent: () => ({ tools: { execute: async () => {
        toolCalls++;
        return { status: 'uncertain', content: 'Write acknowledgment lost' };
      }, repairWorkspace: async request => {
        repairCalls++; assert.equal(request.contract, 'agentkit.workspace-compensation/v1');
        return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId,
          result: { status: 'error', content: { error_type: 'workspace_operation_compensated', compensated: true } } };
      } } }),
      argumentEncoding: null, permissionContract: null,
    } };
  const services = { sessions: { flush: async () => true }, sessionProjections: {
    register(value) { projections.set(value.key, value); return () => projections.delete(value.key); },
    stateOf: (_, id) => projections.has(id) ? events.reduce(projections.get(id).apply, projections.get(id).init()) : undefined,
  }, sessionController: { resolveAgent: async id => { assert.equal(id, session.id); seen.push('resolve'); return { agent }; } },
  systemPrompt: { assemble: async context => { assert.equal(context.agent, agent); seen.push('assemble'); return assembly; } } };
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'original', baseUrl: 'https://fixture.invalid/v1' }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: key }) } });
  const host = await createStudioNativeHarness({ ctx: { get: id => services[id] }, storeDir: root, workspaceRoot, agents, models, ledger,
    renderPrompt: assembly => `${assembly.prompt} for ${assembly.variables.model}`,
    agentEvents: (_ctx, actual) => { assert.equal(actual, agent); return { serial: async event => { assert.equal(event, 'agentkit/native-recovery-binding'); seen.push('query'); return binding; } }; },
    assembleContextFor: (actual, signal) => ({ agent: actual, scope: actual, signal }),
    fetchImpl: async (_url, options) => {
      requests.push({ body: JSON.parse(options.body), headers: new Headers(options.headers) });
      if (repairable && requests.length > 1) return new Response('data: ' + JSON.stringify({ choices: [{ index: 0,
        delta: { content: 'Compensated original operation' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
      return new Response('data: ' + JSON.stringify({ id: 'r1', choices: [{ index: 0,
        delta: { tool_calls: [{ index: 0, id: 'write-1', type: 'function', function: { name: writeTool.name, arguments: '{}' } }] },
        finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent, input: { kind: 'enter', messages: [{ id: 'original-user', role: 'user', content: [{ type: 'text', text: 'Write the file' }] }], assembly },
    turn: 1, signal: controller.signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly }), binding };
  // The Run starts, the model calls write, the tool returns uncertain → interrupted.
  const initial = host.executeTurn(payload); void initial.catch(() => {});
  if (repairable) {
    const deadline = performance.now() + 5000;
    while (toolCalls === 0 || (await host.recoveryStatus({ agentId: binding.agentId, sessionId: session.id })).phase !== 'awaiting_reconciliation') {
      assert.ok(performance.now() < deadline, 'the original tool must dispatch and enter reconciliation');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } else await assert.rejects(initial, /NATIVE_TURN_FAILED/);
  // Verify the tool was actually dispatched (not just that the phase changed).
  assert.equal(toolCalls, 1, 'the write tool was dispatched exactly once');
  // Derive the real scope from the durable turn/owner binding — the Host binds
  // Runs under its own workspace hash, not a hand-picked 'unused' workspaceId.
  const owner = agent.externalTurns.pending();
  assert.ok(owner, 'the turn owner was claimed');
  const admission = readNativeDshOwnership(owner, { sessionId: session.id, turn: 1 });
  const realScope = admission.identity.scope;
  const runRecord = ledger.load(realScope, admission.identity.runId);
  assert.equal(runRecord.snapshot.phase, repairable ? 'awaiting_reconciliation' : 'interrupted', `phase=${runRecord.snapshot.phase} reason=${runRecord.snapshot.reason}`);
  assert.equal(runRecord.snapshot.reason, 'effect_outcome_unknown');
  // Verify the uncertain tool result is sealed in the tool receipt — not just
  // that the phase is interrupted. The receipt status is 'committed' (the
  // effect was sealed); the uncertain outcome is in result.results[0].status.
  const toolReceipt = runRecord.receipts.find(r => r.operationKey.endsWith(':tool'));
  assert.ok(toolReceipt, 'a tool receipt exists');
  const toolResults = toolReceipt.result.results;
  assert.ok(Array.isArray(toolResults) && toolResults.length === 1, 'one tool result is sealed');
  assert.equal(toolResults[0].status, 'uncertain', 'the tool result status is uncertain');
  assert.equal(toolResults[0].content, 'Write acknowledgment lost', 'the uncertain content is preserved');
  assert.ok(events.some(e => e.type === 'turn/owner'), 'the turn owner was claimed');
  assert.equal(events.some(e => e.type === 'turn/end'), false, 'no turn/end — the run did not complete');
  const route = createSessionRoutes({ getNativeHost: async () => host });
  const request = { agentId: binding.agentId, sessionId: session.id, runId: admission.identity.runId };
  return { host, ledger, agent, binding, requests, events, seen, route, request, realScope,
    initial, get repairCalls() { return repairCalls; }, get toolCalls() { return toolCalls; } };
}

test('authenticated original-Run workspace repair wakes the installed Host driver and rejects result injection', async t => {
  const f = await interruptedFixture(t, { repairable: true });
  const before = f.ledger.load(f.realScope, f.request.runId), marker = before.snapshot.toolReconciliation;
  assert.equal((await f.host.recoveryStatus(f.request)).canRepairWorkspace, true);
  const command = { ...f.request, commandId: 'operator-repair', operationKey: marker.operationKey };
  await assert.rejects(f.route('sessions/native-workspace-repair', { ...command, result: { status: 'ok' } }), /RECONCILIATION_INVALID/);
  await f.route('sessions/native-workspace-repair', command); await f.initial;
  const after = f.ledger.load(f.realScope, f.request.runId);
  assert.equal(after.snapshot.phase, 'completed'); assert.equal(f.toolCalls, 1); assert.equal(f.repairCalls, 1);
  assert.equal(after.snapshot.configDigest, before.snapshot.configDigest);
  assert.deepEqual(after.receipts.find(row => row.operationKey === marker.operationKey), before.receipts.find(row => row.operationKey === marker.operationKey));
  assert.equal(after.intents.filter(row => row.kind === 'workspace_repair').length, 1);
  assert.equal(after.events.filter(row => row.kind === 'workspace.repair_completed').length, 1);
  assert.equal((await f.route('sessions/native-workspace-repair', command)).value.phase, 'completed');
  assert.equal(f.repairCalls, 1); assert.equal(f.requests.length, 2);
});

test('an interrupted Run with an uncertain receipt surfaces reconciliation_required and refuses resume without re-execution', async t => {
  const f = await interruptedFixture(t);
  // Host recoveryStatus: the interrupted Run with a durable turn/owner is
  // reconciliation_required, canResume false, with the real interrupted phase.
  const status = await f.host.recoveryStatus(f.request);
  assert.equal(status.state, 'reconciliation_required', `state=${status.state}`);
  assert.equal(status.canResume, false);
  assert.equal(status.phase, 'interrupted');
  assert.equal(status.runId, f.request.runId);
  assert.equal(f.requests.length, 1, 'status read does not execute another model call');
  // Host resumeTurn: the interrupted Run cannot be resumed — it must be
  // reconciled first, not blindly re-driven.
  await assert.rejects(f.host.resumeTurn(f.request), /reconciliation_required/);
  assert.equal(f.requests.length, 1, 'resume rejection does not execute another model call');
  assert.equal(f.toolCalls, 1, 'resume rejection does not re-dispatch the tool');
  // The turn owner is still pending (no turn/end), so the Run is not closed.
  assert.ok(f.agent.externalTurns.pending(), 'the original turn owner is still pending');
  // Client state: refresh surfaces reconciliation_required, resume is a no-op
  // (canResume false), and no model or tool is re-executed.
  const state = createNativeRecoveryState({ agentId: f.request.agentId, sessionId: f.request.sessionId, hostRemote: {
    nativeRecoveryStatus: async () => status,
    resumeNativeRun: async () => assert.fail('resume must not be dispatched when canResume is false'),
  } });
  await state.refresh();
  assert.equal(state.getSnapshot().status.state, 'reconciliation_required');
  assert.equal(state.getSnapshot().status.canResume, false);
  state.resume(); // no-op — canResume false
  await tick();
  assert.equal(f.requests.length, 1, 'client resume no-op does not execute another model call');
  assert.equal(f.toolCalls, 1, 'client resume no-op does not re-dispatch the tool');
  state.dispose();
});

test('an old Run whose session head advanced to a new owner is rejected, not recovered, with no model re-execution', async t => {
  // Use the standard fixture but swap fetchModel so the second model call hangs
  // until an explicit model-entered gate resolves (not polling ticks).
  let modelCalls = 0;
  const modelEntered = gate();
  const f = await fixture(t, { fetchModel: signal => {
    modelCalls++;
    if (modelCalls === 1) return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Recovered' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    // Second call: signal that the model is entered, then hang until abort.
    modelEntered.resolve();
    return new Promise(resolve => { signal.addEventListener('abort', () => resolve(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })), { once: true }); });
  } });
  // Drive the original Run to completion via recovery resume.
  const ack = (await f.route('sessions/native-recovery-resume', f.request)).value;
  assert.equal(ack.state, 'recovering');
  await f.agent.whenIdle(); await tick();
  assert.equal(modelCalls, 1, 'the original Run executed one model call');
  const originalRunId = f.request.runId;
  assert.equal((await f.host.recoveryStatus(f.request)).state, 'closed');
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1, 'the original turn ended');
  assert.equal(f.agent.externalTurns.pending(), null, 'the original turn owner is no longer pending');
  // Start a real second turn through the Host with a hanging model, so the
  // new Run's owner is pending and the session head advances. This is not a
  // hand-appended turn/owner — a real Kernel Run is created and driven.
  const secondController = new AbortController();
  f.session.append('turn/start', { turn: 2 });
  const secondPayload = { agent: f.agent, input: { kind: 'enter',
    messages: [{ id: 'second-user', role: 'user', content: [{ type: 'text', text: 'Second task' }] }], assembly: f.assembly },
    turn: 2, signal: secondController.signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly: f.assembly }), binding: f.binding };
  // Keep the original promise — do NOT .catch() it, which would turn a reject
  // into a resolve and make later assertions unreliable.
  const secondTurn = f.host.executeTurn(secondPayload);
  // Wait for the model to actually be entered (explicit gate, not tick polling).
  let timer;
  await Promise.race([modelEntered.promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('second model never entered')), 15000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(modelCalls, 2, 'the second Run made a model call');
  // The new owner is pending; the session head has advanced to the new Run.
  const newOwner = f.agent.externalTurns.pending();
  assert.ok(newOwner, 'the new turn owner is pending');
  assert.notEqual(newOwner.turn, 1, 'the pending owner is the new turn, not the old one');
  // Snapshot the new Run's ledger, owner and public events before querying the old Run.
  const newRunId = JSON.parse(newOwner.binding).identity.runId;
  const newScope = JSON.parse(newOwner.binding).identity.scope;
  const newLedgerBefore = JSON.stringify(f.ledger.load(newScope, newRunId));
  const newOwnerBefore = JSON.stringify(newOwner);
  const eventsBefore = JSON.stringify(f.events);
  // Query the OLD Run's recovery status: with the new owner pending and a
  // different runId, the old request's runId does not match the new owner's
  // identity — the Host must reject it as an identity mismatch, not return
  // closed, to protect against cross-run confusion.
  await assert.rejects(f.host.recoveryStatus({ agentId: f.request.agentId, sessionId: f.request.sessionId, runId: originalRunId }),
    /identity_mismatch/);
  await assert.rejects(f.host.resumeTurn({ agentId: f.request.agentId, sessionId: f.request.sessionId, runId: originalRunId }),
    /identity_mismatch/);
  assert.equal(modelCalls, 2, 'querying/resuming the old Run does not execute another model call');
  // The new Run's ledger, owner and public events are unchanged by the old-Run queries.
  assert.equal(JSON.stringify(f.ledger.load(newScope, newRunId)), newLedgerBefore, 'the new Run ledger is unchanged');
  assert.equal(JSON.stringify(f.agent.externalTurns.pending()), newOwnerBefore, 'the new owner is unchanged');
  assert.equal(JSON.stringify(f.events), eventsBefore, 'the public events are unchanged');
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1, 'no second turn/end was produced');
  // This durable-ownership fixture resolves cancellation to an aborted ending.
  // Assert that contract exactly; a generic Native failure cannot satisfy it.
  secondController.abort();
  assert.deepEqual(await secondTurn, { reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
  // The new Run is canceled in the ledger.
  const newRecord = f.ledger.load(newScope, newRunId);
  assert.equal(newRecord.snapshot.phase, 'canceled', `the second Run is canceled, phase=${newRecord.snapshot.phase}`);
  // The old Run remains completed.
  const ownerAdmission = JSON.parse(f.events.find(e => e.type === 'turn/owner').data.binding);
  const oldRecord = f.ledger.load(ownerAdmission.identity.scope, originalRunId);
  assert.equal(oldRecord.snapshot.phase, 'completed', 'the old Run remains completed');
});
