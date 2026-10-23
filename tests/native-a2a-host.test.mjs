// Actual localhost HTTP/SSE + NativeKernel + SQLite + production Studio gateway.
// The DSH registry below is an explicit pipeline double; it is not the packed
// DSH Host proof. No discovery/resolve/dispatch/fetch port is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, emptyUsage, canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { prepareNativeA2AHost } from '../src/providers/native-a2a-host.mjs';
import { createA2AProjection } from '../src/providers/native-a2a-protocol.mjs';

const spec = { local_name: 'research', binding_id: 'binding-1', space_id: 'a2a-space-1', target_agent_id: 'a2a-agent-remote-1',
  expected_version_id: 'version-1', exposure: 'tool' };
const final = () => ({ kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() });
const call = (name = 'call_a2a_agent', args = { agent: 'research', message: '查一下😀' }) => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
  toolCalls: [{ callId: 'actual-call', name, arguments: args }] });

async function setup(t, { protocol = 'JSONRPC', streaming = true, source = 'hosted', mode = 'complete', denied = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-a2a-host-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot);
  const filename = join(root, 'runs.sqlite'); let store = new SqliteRunStore(filename), gateway;
  const requests = [], registry = new Map(), agent = { session: { id: 'session' } };
  let models = 0, remoteSends = 0, version = spec.expected_version_id, approvals = 0, policy = 'workspace-write', runningId = 'run', repeat = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      assert.equal(body.A2ASpaceId, spec.space_id); assert.equal(body.PageSize, 100);
      res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: spec.target_agent_id, VersionId: version, Source: source,
        AgentCard: { name: 'research', description: 'Research', capabilities: { streaming },
          supportedInterfaces: [{ url: `${origin}${protocol === 'JSONRPC' ? '/rpc' : '/a2a/v1'}`, protocolBinding: protocol, protocolVersion: '1.0' }] } }] } }));
      return;
    }
    const method = protocol === 'JSONRPC' ? body.method : req.url.endsWith('/message:stream') ? 'SendStreamingMessage'
      : req.url.endsWith('/message:send') ? 'SendMessage' : 'GetTask';
    const params = protocol === 'JSONRPC' ? body.params : body;
    const wrap = result => protocol === 'JSONRPC' ? { jsonrpc: '2.0', id: body.id, result } : result;
    const task = { id: 'remote-task', contextId: 'remote-context', status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: 'result', parts: [{ text: '最终😀' }] }] };
    if (method.startsWith('Send')) {
      remoteSends++;
      // Both the claimed Native intent and the fsynced managed-call marker
      // exist before the real remote HTTP handler observes a send.
      const saved = store.load(scope, runningId);
      assert.equal(saved.snapshot.phase, 'executing_tools');
      const intent = saved.intents.find(row => row.operationKey === saved.snapshot.pendingIntent);
      assert.equal(intent.status, 'running'); assert.equal(intent.claimedFence, saved.lease.fence);
      const record = records()[0]; assert.equal(record.phase, 'sending');
      assert.equal(record.request.native.call.callId, 'actual-call'); assert.equal(record.request.message.messageId, params.message.messageId);
      assert.equal(params.message.role, 'ROLE_USER'); assert.equal(params.message.parts[0].text, '查一下😀');
      if (method === 'SendMessage') { res.end(JSON.stringify(wrap({ task }))); return; }
      res.setHeader('Content-Type', 'text/event-stream');
      const event = (id, payload) => `id: ${id}\r\ndata: ${JSON.stringify(wrap(payload))}\r\n\r\n`;
      res.write(event('1', { task: { id: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } } }));
      const base = { taskId: task.id, contextId: task.contextId };
      res.write(event('2', { artifactUpdate: { ...base, artifact: { artifactId: 'result', parts: [{ text: '最终' }] } } }));
      if (mode === 'lost') { res.destroy(); return; }
      if (mode === 'hold') return;
      const append = event('3', { artifactUpdate: { ...base, artifact: { artifactId: 'result', parts: [{ text: '😀' }] }, append: true, lastChunk: true } });
      const bytes = Buffer.from(append), emoji = bytes.indexOf(Buffer.from('😀'));
      res.write(bytes.subarray(0, emoji + 1)); res.write(bytes.subarray(emoji + 1));
      res.write(append); // stable event identity is an idempotent duplicate.
      if (mode !== 'poll') res.write(event('4', { statusUpdate: { ...base, status: { state: 'TASK_STATE_COMPLETED',
        message: { messageId: 'status-message', role: 'ROLE_AGENT', parts: [{ text: 'message fallback' }] } } } }));
      res.end(); return;
    }
    assert.equal(method, 'GetTask'); res.end(JSON.stringify(wrap(task)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { KSADK_A2A_SPACE_ID: spec.space_id, KSADK_A2A_SERVICE_URL: origin,
    KSADK_A2A_SERVICE_TOKEN: 'fixture-private-token', KSADK_A2A_ALLOW_PRIVATE: 'true' };
  function records() {
    const directory = join(stateDir, 'a2a-calls');
    return readdirSync(directory).flatMap(owner => readdirSync(join(directory, owner)).filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(join(directory, owner, file), 'utf8'))));
  }
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: policy }) },
    approval: { request: async () => { approvals++; return 'allowed-once'; } }, tools: {
      register(value) { registry.set(value.name, value); return () => registry.delete(value.name); },
      async execute(input) {
        if (denied) return { isError: true, content: [{ type: 'text', text: 'Policy denied' }] };
        const tool = registry.get(input.name);
        try { const value = await tool.execute(input.arguments, input);
          return { isError: false, value, content: tool.output.render(input.arguments, value) }; }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.code ?? error.message }] }; }
      },
    } };
  function bind() { gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, a2aBindings: [spec] },
    workspaceRoot, stateDir, commandEnvironment: env }); }
  bind();
  async function run({ runId = 'run', toolName = 'call_a2a_agent', args, modelAssert, signal } = {}) {
    runningId = runId;
    const definitions = gateway.definitions(agent, [...registry.values()]), data = fixture({ tools: definitions });
    const bound = gateway.forAgent(agent, { scope, store });
    const tools = { execute: async request => {
      const result = await bound.tools.execute(request);
      if (repeat) assert.deepEqual(await bound.tools.execute(request), result);
      return result;
    } };
    const kernel = new NativeKernel({ store, digest, owner: 'a2a-http-host', ports: { ...bound, tools, model: { generate: async request => {
      models++; if (models % 2) return call(toolName, args);
      modelAssert?.(JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content)); return final();
    } } } });
    kernel.start({ ...data.snapshot, runId, turnId: runId }, data.config);
    return kernel.runUntilIdle(scope, runId, { signal });
  }
  t.after(async () => { await gateway.close(); store.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return { run, root, records, env, requests, get gateway() { return gateway; }, get store() { return store; },
    get sends() { return remoteSends; }, get models() { return models; }, get approvals() { return approvals; },
    repeat() { repeat = true; }, readOnly() { policy = 'read-only'; }, drift() { version = 'foreign-version'; },
    async reopen(runId = 'run') {
      const before = canonical(store.load(scope, runId)); await gateway.close(); store.close(); store = new SqliteRunStore(filename); bind();
      const kernel = new NativeKernel({ store, digest, owner: 'replacement', ports: {
        tools: { execute: () => assert.fail('cold recovery cannot re-execute tools') },
        model: { generate: () => assert.fail('cold recovery cannot call a model') },
      } });
      await kernel.runUntilIdle(scope, runId); assert.equal(canonical(store.load(scope, runId)), before);
    },
  };
}

for (const protocol of ['JSONRPC', 'HTTP+JSON']) for (const streaming of [true, false]) {
  test(`actual ${protocol} ${streaming ? 'stream' : 'send'} uses durable Native admission and restores without resend`, async t => {
    const h = await setup(t, { protocol, streaming }); h.repeat(); h.readOnly();
    const result = await h.run({ modelAssert(output) {
      assert.equal(output.ok, true, canonical(output)); assert.equal(output.reply, '最终😀');
      assert.match(output.task_id, /^a2a-task-[a-f0-9]{32}$/u);
      assert.equal(output.task_id, h.records()[0].platformTaskId); assert.equal(output.state, 'completed');
    } });
    assert.equal(result.phase, 'completed'); assert.equal(h.sends, 1); assert.equal(h.models, 2);
    assert.equal(h.approvals, 2, 'each DSH entry uses its actual one-shot permission decision');
    assert.equal(h.records().length, 1); assert.equal(h.records()[0].phase, 'terminal');
    assert.doesNotMatch(canonical(h.store.load(scope, 'run')), /fixture-private-token/);
    const count = h.requests.length, record = canonical(h.records());
    await h.reopen(); assert.equal(h.sends, 1); assert.equal(h.requests.length, count); assert.equal(canonical(h.records()), record);
  });
}

test('stream EOF reconciles the original task with GetTask without a second Send', async t => {
  const h = await setup(t, { mode: 'poll' });
  const result = await h.run({ modelAssert: output => assert.equal(output.reply, '最终😀') });
  assert.equal(result.phase, 'completed'); assert.equal(h.sends, 1);
  assert.deepEqual(h.requests.filter(row => row.url === '/rpc').map(row => row.body.method), ['SendStreamingMessage', 'GetTask']);
});

test('broken stream leaves a durable unknown call and cold recovery never sends again', async t => {
  const h = await setup(t, { mode: 'lost' });
  const result = await h.run(); assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
  assert.equal(h.sends, 1); assert.equal(h.records()[0].phase, 'unknown');
  const count = h.requests.length; await h.reopen(); assert.equal(h.requests.length, count); assert.equal(h.sends, 1);
});

test('registry denial prevents discovery and send, and version drift prevents send', async t => {
  const denied = await setup(t, { denied: true });
  assert.equal((await denied.run()).phase, 'completed'); assert.equal(denied.requests.length, 0);
  const drifted = await setup(t); drifted.drift();
  assert.equal((await drifted.run({ modelAssert: output => assert.equal(output.ok, false) })).phase, 'completed');
  assert.equal(drifted.sends, 0);
});

test('external card endpoint receives no hosted registry token', async t => {
  const h = await setup(t, { source: 'external', streaming: false }); await h.run();
  assert.equal(h.requests[0].headers.authorization, 'Bearer fixture-private-token');
  assert.equal(h.requests.find(row => row.url === '/rpc').headers.authorization, undefined);
});

test('actual cancellation preserves a bound remote task and a durable unknown outcome without another Send', async t => {
  const h = await setup(t, { mode: 'hold' }), controller = new AbortController();
  const running = h.run({ signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!h.sends || h.records()[0]?.projection?.taskId !== 'remote-task') {
    assert.ok(Date.now() < deadline, 'remote task checkpoint was not written');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  const result = await running;
  assert.equal(result.phase, 'canceled');
  while (h.records()[0].phase !== 'unknown') {
    assert.ok(Date.now() < deadline, 'cancel did not settle its managed call');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(h.records()[0].projection.taskId, 'remote-task'); assert.equal(h.sends, 1);
  const count = h.requests.length; await h.reopen(); assert.equal(h.requests.length, count);
});

test('A2A is absent without a bound Space; provider pins credentials and endpoint privately', () => {
  assert.equal(prepareNativeA2AHost({ env: {} }), null);
  assert.throws(() => prepareNativeA2AHost({ bindings: [{ ...spec, expected_version_id: undefined }] }), /A2A_BINDING_ID_REQUIRED/);
});

test('projection rejects foreign tasks, terminal overwrite, missing append base and conflicting duplicate events', () => {
  const p = createA2AProjection('scope');
  const task = { task: { id: 'task', contextId: 'context', status: { state: 'TASK_STATE_WORKING' } } };
  p.apply(task, '1'); p.apply(task, '1');
  assert.throws(() => p.apply({ task: { ...task.task, id: 'foreign' } }), /A2A_REMOTE_BINDING_CONFLICT/);
  assert.throws(() => p.apply({ artifactUpdate: { taskId: 'task', contextId: 'context', append: true,
    artifact: { artifactId: 'missing', parts: [{ text: 'extra' }] } } }), /A2A_ARTIFACT_BASE_REQUIRED/);
  assert.throws(() => p.apply({ ...task, invalid: true }, '1'), /A2A_EVENT_ID_CONFLICT/);
  p.apply({ statusUpdate: { taskId: 'task', contextId: 'context', status: { state: 'TASK_STATE_COMPLETED' } } });
  assert.throws(() => p.apply(task), /A2A_TERMINAL_STATE_CONFLICT/);
});
