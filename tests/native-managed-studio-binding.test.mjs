import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { createHash, randomUUID } from 'node:crypto';

import { MemoryRunStore, NativeKernel, canonical, copy } from '../packages/agentkit-harness-core/dist/index.mjs';

import { tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';

import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';

import { memoryDigest } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';

import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';

import { createAgentStore } from '../src/agent-store.mjs';

import { createModelService } from '../src/model-service.mjs';

import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';

import { createStudioManagedNativeBinding } from '../src/host/services/native-managed-binding.mjs';

import { buildExecutionEngine } from '../src/build-engine.mjs';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { command as serverCommand, permitIssuer, configuration as serverConfiguration, response as serverResponse } from './fixtures/native-managed-kernel.mjs';
import { NATIVE_DSH_MANAGED_TURN_CONTRACT } from '../packages/agentkit-harness/src/native/dsh-managed-ownership.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { createStudioManagedNativeSessionControl } from '../src/host/services/native-managed-kernel.mjs';
import { managedNativeOwnerProjection } from '../src/host/services/native-managed-execution.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { createNativeRecoveryState } from '../src/client/state/native-recovery.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Build a real createStudioNativeHarness against synthetic Host services plus a
 * separate managed ledger. The harness wires the real model/tool/Memory/Skill/
 * MCP/Browser/children/hooks assembler; only the DSH Session lifecycle and the
 * managed execution are test doubles. The local ledger is the harness's own
 * store; the managed ledger is the one a trusted caller passes to
 * resolveManagedBinding, so tests can prove the managed Run never touches it. */
async function setup(t, { spec = {}, profile = {}, respond, publishStreamFrame, frozen = false, text = 'Finish the managed task', sqlite = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'managed-binding-unit-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root });
  const localStore = new MemoryRunStore();
  const managedStore = sqlite ? new SqliteRunStore(join(root, 'managed-runs.sqlite')) : new MemoryRunStore();
  const fullSpec = { ...spec, bindings: { modelProfileIds: ['fixture'], ...spec.bindings } };
  const record = await agents.create({ name: 'Managed', runtimeType: 'harness', spec: fullSpec });
  const events = [], definitions = new Map(), requests = [];
  let apiKey = 'secret-managed';
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned',
    baseUrl: 'https://model.invalid/v1', ...profile }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) },
    credentials: { resolve: async () => ({ value: apiKey }) },
    fetchImpl: async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }) });
  const session = { id: 'managed-session',
    append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 });
  const assembly = { tools: [], variables: { provider: 'agentkit-studio-fixture', model: 'pinned' } };
  const agent = { session, options: { provider: 'agentkit-studio-fixture', model: 'pinned' }, whenIdle: async () => {} };
  const services = {
    sessions: { flush: async () => true }, llm: {},
    sessionProjections: {
      register(definition) { definitions.set(definition.key, definition); return () => { definitions.delete(definition.key); }; },
      stateOf(_session, id) { const definition = definitions.get(id); return definition ? events.reduce(definition.apply, definition.init()) : undefined; },
    },
    systemPrompt: { assemble: async () => assembly },
    sessionController: { resolveAgent: async id => ({ agent }) },
  };
  const ctx = { get: id => services[id] };
  const resolutions = [];
  const builds = { resolve: async (agentId, buildId) => {
    resolutions.push({ agentId, buildId });
    return { ...structuredClone(record), executionEngine: buildExecutionEngine(record.spec, 'agentkit.native-dsh-turn/v1') };
  } };
  const agentBinding = { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1',
    nativeTools: { definitions: () => [], forAgent: () => ({ tools: { execute: async () => assert.fail('No tool dispatched') } }) } };
  if (frozen) agentBinding.buildId = 'frozen-managed-build';
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, builds, models, ledger: localStore,
    publishStreamFrame,
    agentEvents: () => ({ serial: async () => agentBinding }),
    assembleContextFor: () => ({ agent }),
    renderPrompt: () => 'Trusted Host instructions',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const response = respond ? await respond(requests.length, JSON.parse(options.body))
        : { choices: [{ index: 0, delta: { content: 'Complete' }, finish_reason: 'stop' }] };
      if (response instanceof Response) return response;
      return new Response(`data: ${JSON.stringify({ id: `response-${requests.length}`, ...response,
        usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); localStore.close?.(); managedStore.close?.(); await rm(root, { recursive: true, force: true }); });
  const workspaceId = createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex');
  const target = { tenantId: 'tenant-managed', agentInstanceId: record.metadata.id };
  const principal = { userId: 'managed-user' };
  const expectedScope = { tenantId: target.tenantId, workspaceId, userId: principal.userId, agentId: target.agentInstanceId };
  const makePayload = (overrides = {}) => ({
    agent, signal: new AbortController().signal,
    input: { kind: 'enter', messages: [{ id: 'input-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text }] }] },
    prepareInput: async () => ({ kind: 'enter', messages: [], assembly }),
    ...overrides,
  });
  const makeCommand = (overrides = {}) => ({
    tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, command_type: 'enqueue',
    session_id: session.id, command_id: 'cmd-1', payload: { content: text },
    ...overrides,
  });
  return { root, workspaceRoot, host, localStore, managedStore, record, agents, models, builds, resolutions, values,
    requests, events, services, ctx, assembly, session, agent, target, principal, expectedScope,
    agentBinding, workspaceId, makePayload, makeCommand };
}

/** Drive a real NativeKernel against a resolved managed binding's ports and the
 * managed ledger. During withExecution the deferred ports delegate to the live
 * binding's ports, so the kernel exercises the real model/tool/verification stack. */
async function runManagedKernel({ binding, store, runId, sessionId, signal, turn = 1, parentRunId = null }) {
  const kernel = new NativeKernel({ store, ports: binding.ports, digest: hash, owner: 'test-managed-owner' });
  const identity = { scope: copy(binding.scope), runId, sessionId: String(sessionId),
    turnId: String(turn), buildId: binding.buildId, parentRunId, taskChainId: parentRunId ?? runId };
  kernel.start(identity, binding.configuration, { expectedParentRunId: parentRunId });
  return kernel.runUntilIdle(binding.scope, runId, { signal });
}

test('existing Studio recovery route reads and retries the original managed ledger, then prefers a newer ordinary turn', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const h = await setup(t, { respond: async () => { entered.resolve(); await finish.promise;
    return { choices: [{ index: 0, delta: { content: 'Managed done' }, finish_reason: 'stop' }] }; } });
  h.services.sessionProjections.register(managedNativeOwnerProjection());
  h.agent.externalTurns = nativeOwnershipHost(h.session, h.events);
  const execution = { run: async request => {
    const turn = h.events.findLast(event => event.type === 'turn/start').data.turn;
    const ownership = { contract: 'dsh.external-turn/v1', engine: NATIVE_DSH_MANAGED_TURN_CONTRACT, turn,
      binding: canonical({ contract: NATIVE_DSH_MANAGED_TURN_CONTRACT, identity: request.identity, configDigest: hash(request.configuration) }) };
    h.agent.externalTurns.claim(ownership);
    const snapshot = await request.execute({ signal: request.signal, ownership, turn,
      prepareInput: async () => ({ kind: 'enter', messages: [], assembly: h.assembly }) });
    h.session.append('turn/end', { turn, reason: { kind: 'completed' } }); return snapshot;
  } };
  const issuer = permitIssuer({ target: h.target });
  const runtime = createManagedNativeKernel({ directory: join(h.root, 'receiver'), target: h.target,
    permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    resolveBinding: createStudioManagedNativeBinding({ ctx: h.ctx, target: h.target, principal: h.principal,
      execution, resolveHost: async () => h.host }) });
  t.after(() => runtime.close()); t.after(() => finish.resolve());
  h.services.studioManagedNativeSessionControl = createStudioManagedNativeSessionControl({ runtime, target: h.target, principal: h.principal });
  const route = createSessionRoutes({ getNativeHost: async () => h.host });
  const request = { agentId: h.target.agentInstanceId, sessionId: h.session.id };
  const cmd = serverCommand({ ...h.makeCommand(), command_id: randomUUID() }), receipt = await runtime.receive(cmd, issuer.issue(cmd));
  const pending = (await route('sessions/native-recovery-status', request)).value;
  assert.equal(pending.runId, receipt.run_id); assert.equal(pending.phase, 'admitted'); assert.equal(pending.canResume, true);
  assert.equal(pending.managed.owner, 'pending'); assert.equal(h.requests.length, 0);
  const ack = (await route('sessions/native-recovery-resume', { ...request, runId: receipt.run_id })).value;
  assert.equal(ack.state, 'available'); assert.equal(ack.managed.executionState, 'queued'); await entered.promise;
  const live = (await route('sessions/native-recovery-status', request)).value;
  assert.equal(live.phase, 'requesting_model'); assert.equal(live.managed.owner, 'open'); assert.equal(live.canResume, false);
  assert.equal(live.managed.executionState, 'running'); assert.equal(live.state, 'recovering');
  assert.equal(live.accounting.runId, receipt.run_id);
  assert.equal(live.accounting.total.modelCalls, 1, 'the dispatched model attempt is already accounted while its response is pending');
  await assert.rejects(route('sessions/native-recovery-status', { ...request, agentId: 'other' }), /IDENTITY_MISMATCH/);
  await assert.rejects(route('sessions/native-recovery-status', { ...request, runId: 'other' }), /identity_mismatch/);
  await assert.rejects(route('sessions/native-recovery-reconcile', { ...request, runId: receipt.run_id,
    operationKey: 'not-a-grant', commandId: 'not-a-grant' }), { code: 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED' });
  finish.resolve(); await runtime.drain(cmd.session_id);
  const closed = (await route('sessions/native-recovery-status', request)).value;
  assert.equal(closed.state, 'closed'); assert.equal(closed.phase, 'completed'); assert.equal(closed.managed.owner, 'closed');
  assert.equal(closed.accounting.total.modelCalls, 1); assert.equal(closed.canReconcile, false);
  const client = createNativeRecoveryState({ ...request, hostRemote: {
    nativeRecoveryStatus: async () => closed, resumeNativeRun: async () => assert.fail('A read cannot retry a Run'),
  } });
  await client.refresh(); assert.deepEqual(client.getSnapshot().status, closed); client.dispose();
  await route('sessions/native-recovery-resume', { ...request, runId: receipt.run_id });
  assert.equal(h.requests.length, 1);
  assert.equal(h.localStore.sessionHead(h.expectedScope, h.session.id), null);
  h.session.append('turn/start', { turn: 2 });
  const next = h.makePayload({ turn: 2, binding: h.agentBinding }); next.input.assembly = h.assembly;
  await h.host.executeTurn(next);
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  const ordinary = (await route('sessions/native-recovery-status', request)).value;
  assert.equal(ordinary.managed, undefined); assert.equal(ordinary.turn, null); assert.equal(ordinary.phase, 'completed');
  assert.notEqual(ordinary.runId, receipt.run_id);
  assert.equal((await route('sessions/native-recovery-status', { ...request, runId: receipt.run_id })).value.runId, receipt.run_id);
  assert.equal(h.requests.length, 2);
  const ordinaryScope = { ...h.expectedScope, tenantId: 'local', userId: 'local-user' };
  const background = new NativeKernel({ store: h.localStore, owner: 'opaque-turn-fixture', digest: hash,
    ports: { model: { generate: async () => serverResponse() } } });
  background.start({ scope: ordinaryScope, runId: 'opaque-background', sessionId: h.session.id,
    turnId: 'wake_opaque', buildId: 'fixture', parentRunId: ordinary.runId, taskChainId: 'fixture' }, serverConfiguration(cmd));
  assert.equal((await background.runUntilIdle(ordinaryScope, 'opaque-background')).phase, 'completed');
  h.localStore.acknowledge(ordinaryScope, 'opaque-background', `dsh:${h.session.id}:3:v1:${'a'.repeat(64)}`, 0);
  assert.equal((await route('sessions/native-recovery-status', request)).value.runId, 'opaque-background',
    'opaque Native IDs use their persisted SDK delivery position rather than Number(turnId)');
});

test('existing product recovery route exposes grant-blocked queue and closes discarded work without starting an owner', async t => {
  const h = await setup(t); h.agent.externalTurns = nativeOwnershipHost(h.session, h.events);
  const issuer = permitIssuer({ target: h.target });
  const runtime = createManagedNativeKernel({ directory: join(h.root, 'grant-receiver'), target: h.target,
    permitVerifier: issuer.verifier, assertCurrent: () => true, autoStart: false,
    resolveBinding: createStudioManagedNativeBinding({ ctx: h.ctx, target: h.target, principal: h.principal,
      execution: { run: async () => assert.fail('blocked work cannot create an SDK owner') }, resolveHost: async () => h.host }) });
  t.after(() => runtime.close());
  h.services.studioManagedNativeSessionControl = createStudioManagedNativeSessionControl({ runtime, target: h.target, principal: h.principal });
  const route = createSessionRoutes({ getNativeHost: async () => h.host }), request = { agentId: h.target.agentInstanceId, sessionId: h.session.id };
  const spec = { grant_id: 'product-occurrence', tenant_id: h.target.tenantId, agent_instance_id: request.agentId,
    session_id: request.sessionId, owner_ref: 'trusted-host' };
  runtime.executionGrants.ensure(spec);
  runtime.executionGrants.setAdmission(spec, false, { expected_revision: 1, idempotency_key: 'pause' });
  const cmd = serverCommand({ ...h.makeCommand(), command_id: randomUUID(), payload: { content: 'Keep original work', execution_grant_id: spec.grant_id } });
  const receipt = await runtime.receive(cmd, issuer.issue(cmd)); assert.equal(receipt.status, 'accepted');
  await assert.rejects(runtime.drain(cmd.session_id), { code: 'execution_grant_admission_paused' });
  const pending = (await route('sessions/native-recovery-status', request)).value;
  assert.equal(pending.managed.executionGrant.blockedReason, 'execution_grant_admission_paused');
  assert.equal(pending.managed.executionGrant.qualified, false); assert.equal(pending.canResume, false);
  assert.equal(pending.state, 'available'); assert.equal(pending.error, null); assert.equal(h.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(pending), /owner_ref|trusted-host/u);
  runtime.executionGrants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'stop' });
  const discarded = (await route('sessions/native-recovery-status', request)).value;
  assert.equal(discarded.managed.commandState, 'discarded'); assert.equal(discarded.state, 'closed');
  assert.equal(discarded.phase, 'discarded'); assert.equal(discarded.managed.owner, 'closed');
  const client = createNativeRecoveryState({ ...request, hostRemote: { nativeRecoveryStatus: async () => discarded,
    resumeNativeRun: () => assert.fail('discarded work cannot be resumed') } });
  await client.refresh(); assert.deepEqual(client.getSnapshot().status, discarded); assert.equal(client.getSnapshot().error, '');
  await client.resume(); client.dispose(); assert.equal(h.requests.length, 0);
});

// --- Part A: createStudioNativeHarness.resolveManagedBinding (real assembler + real NativeKernel + managed SQLite) ---

for (const failFlush of [false, true]) test(`managed receiver live preview settles only after durable flush (failFlush=${failFlush})`, { timeout: 10000 }, async t => {
  const prefix = Promise.withResolvers(), finish = Promise.withResolvers(), frames = [];
  let toolCalls = 0;
  const encode = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
  const h = await setup(t, { publishStreamFrame: ({ agent }, frame) => {
    assert.equal(agent, h.agent); frames.push(frame);
    if (frame.chunk?.argumentsDelta === '{') prefix.resolve();
  }, respond: n => n === 1 ? new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encode({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'preview-call',
      type: 'function', function: { name: 'inspect', arguments: '{' } }] }, finish_reason: null }] }));
    finish.promise.then(() => {
      controller.enqueue(encode({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
        function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
    });
  } }), { headers: { 'content-type': 'text/event-stream' } })
    : { choices: [{ index: 0, delta: { content: 'Managed complete' }, finish_reason: 'stop' }] } });
  h.agentBinding.nativeTools = { definitions: () => [tool({ name: 'inspect' })],
    forAgent: () => ({ tools: { execute: async () => { toolCalls++; return { status: 'ok', content: 'Inspected' }; } } }) };
  h.agent.externalTurns = nativeOwnershipHost(h.session, h.events);
  const execution = { run: async request => {
    const ownership = { contract: 'dsh.external-turn/v1', engine: NATIVE_DSH_MANAGED_TURN_CONTRACT, turn: 1,
      binding: canonical({ contract: NATIVE_DSH_MANAGED_TURN_CONTRACT, identity: request.identity,
        configDigest: hash(request.configuration) }) };
    h.agent.externalTurns.claim(ownership);
    return request.execute({ signal: request.signal,
    prepareInput: async () => ({ kind: 'enter', messages: [], assembly: h.assembly }), turn: 1,
    ownership }); } };
  const resolveBinding = createStudioManagedNativeBinding({ ctx: h.ctx, target: h.target, principal: h.principal,
    resolveHost: async () => h.host, execution });
  const issuer = permitIssuer({ target: h.target });
  const runtime = createManagedNativeKernel({ directory: join(h.root, 'receiver'), target: h.target,
    permitVerifier: issuer.verifier, resolveBinding, assertCurrent: () => true, autoStart: false });
  t.after(() => runtime.close()); t.after(() => finish.resolve());
  const cmd = serverCommand({ ...h.makeCommand(), command_id: randomUUID() });
  await runtime.receive(cmd, issuer.issue(cmd));
  const running = runtime.drain(cmd.session_id);
  await prefix.promise;
  assert.equal(frames[0].type, 'start'); assert.equal(frames[0].step, 1);
  assert.equal(frames.some(frame => frame.type === 'end'), false);
  assert.equal(toolCalls, 0); assert.equal(h.events.some(event => event.type === 'tool/call'), false);
  assert.equal(h.events.some(event => event.type === 'assistant/message'), false);
  if (failFlush) {
    h.services.sessions.flush = async () => {
      if (h.events.some(event => event.type === 'assistant/message')) throw Error('managed stream flush failed');
      return true;
    };
    finish.resolve(); await assert.rejects(running, /managed stream flush failed/);
    assert.equal(toolCalls, 0); assert.equal(h.requests.length, 1);
    assert.equal(frames.filter(frame => frame.type === 'end').length, 1);
    assert.deepEqual(frames.at(-1).outcome, { kind: 'abandoned' });
    return;
  }
  finish.resolve(); await running;
  assert.equal(toolCalls, 1); assert.equal(h.requests.length, 2);
  assert.deepEqual(frames.filter(frame => frame.type === 'start').map(frame => [frame.turn, frame.step, frame.revision]), [[1, 1, 1], [1, 2, 2]]);
  for (const end of frames.filter(frame => frame.type === 'end')) {
    assert.equal(end.outcome.kind, 'committed'); assert.equal(end.outcome.eventType, 'assistant/message');
    const message = h.events.find(event => event.seq === end.outcome.seq);
    const chunks = frames.filter(frame => frame.type === 'chunk' && frame.attemptId === end.attemptId);
    assert.deepEqual(message.data.stream, chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk })));
    assert.equal(end.index, chunks.length);
  }
  const before = copy(frames);
  assert.equal((await runtime.receive(cmd, issuer.issue(cmd))).status, 'duplicate'); await runtime.drain(cmd.session_id);
  assert.deepEqual(frames, before); assert.equal(toolCalls, 1); assert.equal(h.requests.length, 2);
  // The same live Agent can return to ordinary Studio chat. Its revision must
  // continue increasing so the UI cannot mistake the next stream for stale data.
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  h.session.append('turn/start', { turn: 2 });
  h.agent.externalTurns = nativeOwnershipHost(h.session, h.events);
  const next = h.makePayload({ turn: 2, binding: h.agentBinding });
  next.input.assembly = h.assembly;
  await h.host.executeTurn(next);
  assert.deepEqual(frames.filter(frame => frame.type === 'start').map(frame => frame.revision), [1, 2, 3]);
});

test('managed resolveManagedBinding runs model->tool->result through the managed SQLite ledger and leaves the local ledger untouched', async t => {
  let toolCalls = 0;
  const h = await setup(t, { sqlite: true,
    respond: count => count === 1
      ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function',
        function: { name: 'inspect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
      : { choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] },
  });
  const inspectTool = tool({ name: 'inspect' });
  h.agentBinding.nativeTools = { definitions: () => [inspectTool],
    forAgent: () => ({ tools: { execute: async () => { toolCalls++; return { status: 'ok',
      content: 'TOOL_RESULT_IN_MANAGED_LEDGER',
      resourceUsage: { modelCalls: 0, toolCalls: 1, inputTokens: 0, outputTokens: 0, cost: 0 } }; } } }) };
  const runId = 'managed-run-1';
  const payload = h.makePayload();
  const binding = await h.host.resolveManagedBinding(payload, { store: h.managedStore, runId,
    target: h.target, principal: h.principal });
  assert.deepEqual(binding.scope, h.expectedScope);
  assert.equal(typeof binding.ports.model.generate, 'function');
  assert.equal(typeof binding.ports.tools.execute, 'function');
  const snapshot = await runManagedKernel({ binding, store: h.managedStore, runId,
    sessionId: h.session.id, signal: payload.signal });
  assert.equal(snapshot.phase, 'completed');
  assert.equal(toolCalls, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, 'https://model.invalid/v1/chat/completions');
  const record = h.managedStore.load(binding.scope, runId);
  assert.equal(record.snapshot.phase, 'completed');
  assert.equal(record.snapshot.usage.modelCalls, 2);
  assert.equal(record.snapshot.usage.toolCalls, 1);
  const toolReceipt = record.receipts.flatMap(receipt => receipt.result?.results ?? [])
    .find(result => result.content === 'TOOL_RESULT_IN_MANAGED_LEDGER');
  assert.ok(toolReceipt, 'the tool result is sealed in the managed ledger');
  assert.equal(JSON.stringify(record).includes('secret-managed'), false, 'credentials stay outside the ledger');
  // The local harness ledger is untouched: no Run, no session head.
  assert.equal(h.localStore.sessionHead(h.expectedScope, h.session.id), null);
  assert.deepEqual(h.localStore.list(h.expectedScope), []);
  assert.throws(() => h.localStore.load(h.expectedScope, runId), { code: 'run_not_found' });
  await binding.releaseResources?.({ scope: binding.scope, runId, sessionId: h.session.id });
});

test('managed resolveManagedBinding resolves a Frozen Build through builds.resolve', async t => {
  const h = await setup(t, { frozen: true });
  h.agentBinding.nativeTools = { definitions: () => [],
    forAgent: () => ({ tools: { execute: async () => ({ status: 'ok', content: 'ok' }) } }) };
  const payload = h.makePayload();
  const binding = await h.host.resolveManagedBinding(payload, { store: h.managedStore, runId: 'frozen-run-1',
    target: h.target, principal: h.principal });
  assert.equal(binding.buildId, 'frozen-managed-build');
  assert.deepEqual(h.resolutions, [{ agentId: h.record.metadata.id, buildId: 'frozen-managed-build' }]);
  assert.equal(binding.configuration.hostRecoveryBinding.buildId, 'frozen-managed-build');
  await binding.releaseResources?.({ scope: binding.scope, runId: 'frozen-run-1', sessionId: h.session.id });
});

test('withExecution invokes the completed-Turn consumer at a completed terminal through managed SQLite', async t => {
  const h = await setup(t, { sqlite: true,
    spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      write: { mode: 'candidate', flushAfterTurn: true } },
      context: { rollout: { memoryWrite: 'enabled' } } },
    // Explicit "remember" tasks belong to the main Run's governed Memory
    // tools. This ordinary preference exercises completed-turn extraction.
    text: '我喜欢用Vim',
    respond: () => ({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] }),
  });
  const hostPrepareInput = async () => ({ kind: 'enter', messages: [], assembly: h.assembly });
  const receiver = createStudioManagedNativeBinding({ ctx: h.ctx, target: h.target, principal: h.principal,
    resolveHost: async () => h.host,
    execution: { run: async req => req.execute({ signal: req.signal, prepareInput: req.prepareInput }) } });
  for (const turn of [1, 2]) {
    const runId = `managed-run-${turn}`, parentRunId = turn === 1 ? null : 'managed-run-1';
    const result = await receiver({ command: h.makeCommand({ command_id: `cmd-${turn}` }), stage: 'execute', runId,
      signal: new AbortController().signal, store: h.managedStore });
    const snapshot = await result.withExecution({
      identity: { scope: result.scope, runId, sessionId: h.session.id, turnId: String(turn), buildId: result.buildId,
        parentRunId, taskChainId: parentRunId ?? runId },
      execute: async options => runManagedKernel({ binding: result, store: h.managedStore, runId,
        sessionId: h.session.id, signal: options.signal, turn, parentRunId }),
      signal: new AbortController().signal, prepareInput: hostPrepareInput,
    });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(h.managedStore.load(result.scope, runId).snapshot.phase, 'completed');
    // The completed-Turn consumer ran: the local-default memory DB holds the extracted fact.
    const memoryDb = join(h.root, 'native-harness', 'memory-v1', memoryDigest(result.scope.tenantId).slice(7), 'memory.sqlite');
    const provider = new SqliteNativeMemoryProvider(memoryDb, { principal: copy(result.scope) });
    try {
      const records = provider.list();
      // The policy needs two independent original observations, not duplicate
      // delivery of one completed turn, before promoting an implicit preference.
      assert.equal(records.length, turn === 1 ? 0 : 1);
      if (turn === 2) {
        assert.equal(records[0].content, '我喜欢用Vim');
        assert.equal(records[0].sourceEventIds.length, 2);
      }
    } finally { provider.close(); }
    await result.release({ scope: result.scope, runId, sessionId: h.session.id });
  }
  assert.equal(h.requests.length, 2);
});
