// Actual Studio Native service, SQLite, Kernel, gateway and HTTP protocols.
// Session/registry/approval are narrow doubles; mounted-Host acceptance remains
// separate. No fake receipt, supplied result, replacement Run or remote replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';
import { createNativeRecoveryState } from '../src/client/state/native-recovery.mjs';
import { hostFetch } from '../src/http-fetch.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10000;
  for (;;) { const value = check(); if (value) return value;
    assert.ok(Date.now() < deadline, 'checkpoint not reached'); await delay(10); }
}
async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-reconcile-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const registry = new Map(), projections = new Map(), events = [], failures = [], bodies = [];
  const remote = { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED' } };
  let sends = 0, gets = 0, continues = 0, modelCalls = 0, discovery = 0, approvals = 0;
  let running, host, gateway, binding, revision = 1, preset = 'actual-preset', resolveBinding, readReply;
  const controller = new AbortController(), ledger = new SqliteRunStore(join(root, 'runs.sqlite'));
  const session = { id: 'original-session', append(type, data, options) { events.push({ type, data: structuredClone(data), ...options, seq: events.length + 1 }); } };
  session.append('turn/start', { turn: 1 });
  const agent = { session, options: { maxTokens: 500 }, externalTurns: nativeOwnershipHost(session, events) };
  const server = createServer((req, res) => void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); bodies.push(body);
    if (req.url === '/v1/chat/completions') {
      modelCalls++;
      const delta = modelCalls === 1 ? { tool_calls: [{ index: 0, id: 'original-call', type: 'function',
        function: { name: 'call_a2a_agent', arguments: '{"agent":"remote","message":"initial"}' } }] } : { content: 'Original task finished' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: modelCalls === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      discovery++; res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
        supportedInterfaces: [{ url: origin + '/rpc', protocolVersion: '1.0', protocolBinding: 'JSONRPC' }],
      } }] } })); return;
    }
    let result;
    if (body.method === 'GetTask') { gets++; assert.equal(body.params.id, 'original-remote'); if (readReply) await readReply(); result = remote; }
    else {
      assert.equal(body.method, 'SendMessage');
      if (body.params.message.taskId) {
        continues++; assert.equal(body.params.message.taskId, 'original-remote'); assert.equal(body.params.message.contextId, 'original-context');
        assert.deepEqual(body.params.message.parts, [{ data: { answer: 42 } }]); remote.status.state = 'TASK_STATE_COMPLETED';
        remote.artifacts = [{ artifactId: 'answer', parts: [{ text: 'remote verified answer' }] }];
      } else sends++;
      result = { task: remote };
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  })().catch(error => { failures.push(error); res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    controller.abort(); await Promise.allSettled([running]); await host?.close(); await gateway?.close(); ledger.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  const agents = createAgentStore({ storeDir: root });
  const record = await agents.create({ name: 'A2A receipt', runtimeType: 'harness', bindings: { modelProfileIds: ['fixture'] } });
  const services = { sessions: { flush: async () => true },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async () => { approvals++; return 'allowed-once'; } },
    sessionController: { resolveAgent: async id => { assert.equal(id, session.id); return { agent }; } },
    sessionProjections: {
      register(value) { projections.set(value.key, value); return () => projections.delete(value.key); },
      stateOf: (_, id) => id === 'agentPreset' ? preset : id === 'turnBoundary'
        ? events.reduce((state, event) => event.type === 'turn/start' ? { lastTurn: event.data.turn, openTurnStartSeq: event.seq }
          : event.type === 'turn/end' ? { ...state, openTurnStartSeq: null } : state, { lastTurn: 0, openTurnStartSeq: null }) : projections.has(id)
        ? events.reduce(projections.get(id).apply, projections.get(id).init()) : undefined,
    } };
  const ctx = { effect: install => install(), get: key => services[key], tools: {
    register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    async execute(exec) { const tool = registry.get(exec.name), value = await tool.execute(exec.arguments, exec);
      return { isError: false, value, content: tool.output.render(exec.arguments, value) }; },
  } };
  gateway = createNativeDshTools({ ctx, config: { agentId: record.metadata.id, a2aBindings: [{ local_name: 'remote', binding_id: 'binding',
    space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' }] }, workspaceRoot, stateDir: join(root, 'state'),
  commandEnvironment: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' } });
  binding = { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: gateway };
  const assembly = { prompt: 'Original system', tools: [...registry.values()], variables: {} };
  services.systemPrompt = { assemble: async () => assembly };
  const models = createModelService({ configuration: { resolve: async () => ({ values: { modelProfiles: [{ id: 'fixture',
    provider: 'openai-compatible', modelName: 'original-model', baseUrl: origin + '/v1' }] } }) }, credentials: { resolve: async () => ({ value: 'fixture-key' }) } });
  host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, models, ledger, fetchImpl: hostFetch,
    renderPrompt: value => value.prompt, assembleContextFor: () => ({ agent, signal: controller.signal }),
    agentEvents: () => ({ serial: async name => {
      assert.equal(name, 'agentkit/native-recovery-binding');
      return resolveBinding ? resolveBinding() : { ...binding, agentRevision: revision };
    } }) });
  const input = { kind: 'enter', messages: [{ id: 'original-input', role: 'user', content: [{ type: 'text', text: 'call remote' }] }], assembly };
  running = host.executeTurn({ agent, input, binding, turn: 1, signal: controller.signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly }) });
  // Attach immediately so failed checkpoints do not hide a rejected execution.
  running.catch(() => {});
  const admission = await until(() => {
    const owner = agent.externalTurns.pending(); if (!owner) return;
    const admitted = readNativeDshOwnership(owner, { sessionId: session.id, turn: 1 });
    try { if (ledger.load(admitted.identity.scope, admitted.identity.runId).snapshot.phase === 'awaiting_reconciliation') return admitted; }
    catch (error) { if (error.code !== 'run_not_found') throw error; }
  });
  const request = { agentId: binding.agentId, sessionId: session.id, runId: admission.identity.runId };
  const route = createSessionRoutes({ getNativeHost: async () => host });
  const load = () => ledger.load(admission.identity.scope, request.runId);
  const operationKey = load().snapshot.toolReconciliation.operationKey;
  return { host, agent, services, ledger, request, load, remote, route, bodies, operationKey,
    count: () => ({ sends, gets, continues, modelCalls, discovery, approvals }),
    run: () => running, drift: () => { revision++; }, preset: value => { preset = value; },
    bindingGate: callback => { resolveBinding = callback; }, binding,
    readGate: callback => { readReply = callback; }, cancel: () => controller.abort(),
    reconcile: (commandId = 'read-original', more = {}) => route('sessions/native-recovery-reconcile', { ...request, operationKey, commandId, ...more }),
    async continueRemote() {
      const base = { ...request, operationKey, callId: 'original-call' };
      const observed = (await route('sessions/native-a2a-control', { ...base, kind: 'get', commandId: 'inspect' })).value;
      return route('sessions/native-a2a-control', { ...base, kind: 'continue', commandId: 'answer', pauseDigest: observed.pauseDigest, parts: [{ data: { answer: 42 } }] });
    } };
}

test('Studio completes a receipt query and continues the SAME active Run after approved remote input', async t => {
  const f = await setup(t), original = f.load();
  const status = await f.host.recoveryStatus(f.request);
  assert.equal(status.state, 'recovering'); assert.equal(status.canResume, false); assert.equal(status.canReconcile, true);
  assert.equal(status.receiptWait.contract, 'agentkit.native-a2a-receipt-wait/v1');
  assert.equal(f.count().modelCalls, 1); assert.equal(f.count().gets, 0);
  await f.continueRemote(); assert.equal(f.count().approvals, 1);
  assert.equal(f.load().snapshot.phase, 'awaiting_reconciliation', 'remote controls alone never forge a Native result');
  const ack = (await f.reconcile()).value; assert.equal(ack.runId, f.request.runId);
  await until(() => {
    const record = f.load();
    if (record.intents.some(row => row.kind === 'tool_receipt') && record.snapshot.phase === 'awaiting_reconciliation')
      assert.fail(JSON.stringify(record.receipts.at(-1)));
    return record.snapshot.phase === 'completed';
  });
  await f.run();
  const completed = f.load(); assert.equal(completed.snapshot.phase, 'completed');
  assert.equal(completed.snapshot.runId, original.snapshot.runId); assert.equal(completed.snapshot.usage.toolCalls, 1);
  assert.deepEqual(completed.intents.find(row => row.kind === 'tool'), original.intents.find(row => row.kind === 'tool'));
  assert.deepEqual(completed.receipts.find(row => row.operationKey === f.operationKey), original.receipts.find(row => row.operationKey === f.operationKey));
  assert.equal(completed.intents.filter(row => row.kind === 'tool_receipt').length, 1);
  assert.equal(completed.events.filter(row => row.kind === 'tool.receipt_reconciled').length, 1);
  assert.equal(f.count().sends, 1); assert.equal(f.count().continues, 1); assert.equal(f.count().modelCalls, 2); assert.equal(f.count().discovery, 1);
  const replay = f.bodies.filter(body => body.model)[1];
  assert.ok(replay.messages.some(message => message.role === 'tool' && message.tool_call_id === 'original-call'
    && message.content.includes('remote verified answer')));
  const before = f.count(), ledger = JSON.stringify(completed);
  await f.reconcile(); assert.deepEqual(f.count(), before); assert.equal(JSON.stringify(f.load()), ledger, 'same command confirms without another query');
});

test('remote input completion automatically resumes the original Studio Run without a separate reconcile action', async t => {
  const f = await setup(t), original = f.load();
  const before = f.count();
  await delay(220);
  assert.deepEqual(f.count(), before, 'waiting inspects only local facts, never remote HTTP or the model');
  await f.continueRemote();
  await f.run();
  const completed = f.load();
  assert.equal(completed.snapshot.phase, 'completed');
  assert.equal(completed.snapshot.runId, original.snapshot.runId);
  assert.equal(completed.snapshot.usage.toolCalls, 1);
  assert.deepEqual(completed.intents.find(row => row.kind === 'tool'), original.intents.find(row => row.kind === 'tool'));
  assert.deepEqual(completed.receipts.find(row => row.operationKey === f.operationKey),
    original.receipts.find(row => row.operationKey === f.operationKey));
  assert.equal(completed.intents.filter(row => row.kind === 'tool_receipt').length, 1);
  assert.equal(completed.commands.filter(row => row.command.commandId.startsWith('native-a2a-receipt-')).length, 1);
  assert.equal(completed.events.filter(row => row.kind === 'tool.receipt_reconciled').length, 1);
  assert.equal(f.count().sends, 1); assert.equal(f.count().continues, 1); assert.equal(f.count().modelCalls, 2);
  assert.equal(f.count().gets, 2, 'only the two explicit continuation reads; the terminal receipt is already committed');
  assert.equal(f.count().discovery, 1); assert.equal(f.count().approvals, 1);
  const replay = f.bodies.filter(body => body.model)[1];
  assert.equal(replay.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'original-call'
    && message.content.includes('remote verified answer')).length, 1);
});

test('a nonterminal receipt stays waiting; lost response confirmation cannot create another read', async t => {
  const f = await setup(t), calls = [];
  let lose = true, ids = 0;
  const state = createNativeRecoveryState({ ...f.request, newCommandId: () => `receipt-${++ids}`, hostRemote: {
    nativeRecoveryStatus: request => f.host.recoveryStatus(request),
    async reconcileNativeTool(request) {
      calls.push(structuredClone(request)); const value = (await f.route('sessions/native-recovery-reconcile', request)).value;
      if (lose) { lose = false; throw Error('reply lost'); } return value;
    },
  } });
  t.after(() => state.dispose()); await state.refresh(); await state.reconcile();
  await until(() => f.load().intents.some(row => row.kind === 'tool_receipt') && f.load().snapshot.phase === 'awaiting_reconciliation');
  assert.ok(state.getSnapshot().pending); await state.retry();
  assert.deepEqual(calls[0], calls[1]); assert.equal(ids, 1); assert.equal(state.getSnapshot().pending, null);
  assert.equal(f.count().gets, 1); assert.equal(f.count().sends, 1); assert.equal(f.count().modelCalls, 1);
  assert.equal(f.load().intents.filter(row => row.kind === 'tool_receipt').length, 1);
  await f.continueRemote(); await state.refresh(); await state.reconcile(); await f.run();
  assert.equal(ids, 2); assert.equal(f.load().snapshot.phase, 'completed'); assert.equal(f.count().sends, 1);
});

test('Studio rejects invented results, wrong operations and changed trusted revisions before enqueue or remote reads', async t => {
  const f = await setup(t), before = JSON.stringify(f.load());
  await assert.rejects(f.reconcile('forged', { result: { status: 'ok' } }), /RECONCILIATION_INVALID/);
  await assert.rejects(f.reconcile('wrong', { operationKey: 'another-operation' }), /reconciliation_required/);
  f.drift(); await assert.rejects(f.reconcile(), /preset_changed/);
  assert.equal(JSON.stringify(f.load()), before); assert.equal(f.count().gets, 0); assert.equal(f.count().modelCalls, 1);
});

test('Studio rechecks preset after an asynchronous trusted binding lookup', async t => {
  const f = await setup(t), entered = Promise.withResolvers(), answer = Promise.withResolvers();
  f.bindingGate(() => { entered.resolve(); return answer.promise; });
  const pending = f.reconcile(); await entered.promise; f.preset('another-preset'); answer.resolve(f.binding);
  await assert.rejects(pending, /identity_mismatch/);
  assert.equal(f.load().commands.length, 0); assert.equal(f.count().gets, 0);
});

test('late HTTP receipt after cancellation cannot continue the original Run or call the model', async t => {
  const f = await setup(t), entered = Promise.withResolvers(), reply = Promise.withResolvers();
  t.after(() => reply.resolve());
  f.readGate(() => { entered.resolve(); return reply.promise; });
  await f.reconcile(); await entered.promise;
  assert.equal(f.load().snapshot.phase, 'reconciling_tool');
  f.cancel(); await f.run(); assert.equal(f.load().snapshot.phase, 'canceled');
  const record = JSON.stringify(f.load());
  f.remote.status.state = 'TASK_STATE_COMPLETED'; reply.resolve(); await delay(25);
  assert.equal(JSON.stringify(f.load()), record); assert.equal(f.count().sends, 1); assert.equal(f.count().modelCalls, 1);
  assert.equal(f.load().events.some(event => event.kind === 'tool.receipt_reconciled'), false);
});

test('caller abort during an uncooperative session lookup cannot enqueue a late reconciliation', async t => {
  const f = await setup(t), entered = Promise.withResolvers(), found = Promise.withResolvers(), caller = new AbortController();
  f.services.sessionController.resolveAgent = () => { entered.resolve(); return found.promise; };
  const pending = f.route('sessions/native-recovery-reconcile', { ...f.request, operationKey: f.operationKey, commandId: 'aborted-query' }, caller.signal);
  const rejected = assert.rejects(pending, /caller-stopped/);
  await entered.promise; caller.abort(Error('caller-stopped')); await rejected;
  found.resolve({ agent: f.agent }); await delay(10);
  assert.equal(f.load().commands.length, 0); assert.equal(f.count().gets, 0); assert.equal(f.count().modelCalls, 1);
});
