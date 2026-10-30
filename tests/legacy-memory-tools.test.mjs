import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { createLegacyMemoryTools, createLegacyMemoryConnection, legacyMemoryBindings, legacyMemoryToolDefinitions } from '../src/legacy-memory-tools.mjs';
import { LegacyMemoryEffects } from '../src/legacy-memory-effects.mjs';
import { memorySubjectId, memorySessionId } from '../src/memory-identity.mjs';
import { createDshNodeLegacyMemory } from '../src/providers/dsh-node-legacy-memory.mjs';
import { bindDshInvocationContext, getDshInvocationContext } from '../src/providers/dsh-invocation-context.mjs';
import { mkdirSync } from 'node:fs';
import { hostFetch } from '../src/http-fetch.mjs';
import { createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';

const context = { agentId: 'agent', userId: 'actual-user', sessionId: 'actual-session', runnerType: 'dsh-native' };
const owner = callId => ({ kind: 'dsh', identity: { agentId: 'agent', sessionId: 'actual-session', callId } });
const invocation = (callId, extra = {}) => ({ signal: new AbortController().signal, assertCurrent: () => true,
  context: structuredClone(context), owner: owner(callId), ...extra });
const plugin = (id, enabled = true) => ({ enabled, config: { binding: { resource: { kind: 'memory-instance', id, secretKey: 'no-copy' } } } });
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-legacy-memory-'))), services = [];
  t.after(async () => { for (const service of services) await service.close(); rmSync(root, { recursive: true, force: true }); });
  const make = (extra = {}) => { const service = createLegacyMemoryTools({ root, agentId: 'agent', ...extra }); services.push(service); return service; };
  return { root, make };
}
const records = root => {
  const db = new DatabaseSync(join(root, 'effects', 'effects.sqlite'));
  try { return db.prepare('SELECT * FROM legacy_memory_effects ORDER BY created_at,rowid').all()
    .map(row => ({ ...row, request: JSON.parse(row.request), prepared: JSON.parse(row.prepared), result: row.result && JSON.parse(row.result) })); }
  finally { db.close(); }
};
async function server(t, handler) {
  const calls = [], http = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const call = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; calls.push(call); await handler(call, res);
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  return { url: `http://127.0.0.1:${http.address().port}`, calls };
}
const json = (response, body) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
const sdkOptions = action => ({ env: { KSADK_LTM_BACKEND: 'sdk' }, connection: { client: { action }, bindingDigest: 'a'.repeat(64) } });
async function childResult(input) {
  const child = fork(new URL('./fixtures/legacy-memory-owner.mjs', import.meta.url), [JSON.stringify(input)],
    { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'), [message] = await once(child, 'message'); await exited;
  if (message.error) throw new Error(message.error); return message.result;
}

test('enabled Memory bindings contain only public collection IDs; definitions retain legacy tool inputs', () => {
  const spec = { bindings: { plugins: [plugin('one'), plugin('one'), plugin('hidden', false)] } };
  const value = legacyMemoryBindings(spec); spec.bindings.plugins[0].config.binding.resource.id = 'changed';
  assert.deepEqual(value, { contract: 'agentkit.legacy-memory-bindings/v1', collectionIds: ['one'] });
  assert.equal(JSON.stringify(value).includes('no-copy'), false);
  const definitions = legacyMemoryToolDefinitions();
  assert.deepEqual(definitions.map(item => [item.name, item.readOnly]), [['load_memory', true], ['save_memory', false]]);
  assert.deepEqual(definitions[1].parameters.required, ['content']);
});

test('missing trusted user/Session context and invalid schema have no effect record', async t => {
  const { root, make } = setup(t), service = make();
  assert.match((await service.execute('load_memory', { query: 'q' }, invocation('missing', { context: null }))).content, /缺少运行时上下文/);
  assert.equal((await service.execute('save_memory', { content: 'fact' }, invocation('foreign', { context: { ...context, agentId: 'foreign' } }))).content.ok, false);
  assert.equal((await service.execute('save_memory', { content: 'fact', user_id: 'foreign' }, invocation('forged'))).status, 'error');
  assert.deepEqual(records(root), []);
});

test('SQLite survives cold open, isolates users, preserves ASCII AND/CJK OR and empty results', async t => {
  const { make } = setup(t), first = make();
  await first.execute('save_memory', { content: 'Alice prefers tea in Beijing 北京喝茶' }, invocation('save-one'));
  await first.execute('save_memory', { content: 'Alice prefers coffee' }, invocation('save-two'));
  await first.close(); const cold = make();
  assert.equal((await cold.execute('load_memory', { query: 'Alice tea' }, invocation('read'))).content, '[1] Alice prefers tea in Beijing 北京喝茶');
  assert.equal((await cold.execute('load_memory', { query: 'Alice unavailable' }, invocation('empty'))).content, '');
  assert.match((await cold.execute('load_memory', { query: '北京喝什么？' }, invocation('chinese'))).content, /北京喝茶/);
  assert.equal((await cold.execute('load_memory', { query: 'Alice' }, invocation('other', { context: { ...context, userId: 'other-user' } }))).content, '');
  assert.equal((await cold.execute('save_memory', { content: 'api_key=not-a-real-key' }, invocation('secret'))).content.error_type, 'legacy_memory_content_rejected');
});

test('SQLite duplicate calls restore exact receipts and reject identity drift without adding facts', async t => {
  const { root, make } = setup(t), first = make(), args = { content: 'durable preference' }, options = invocation('same-call');
  const result = await first.execute('save_memory', args, options); await first.close();
  const cold = make(); assert.deepEqual(await cold.execute('save_memory', args, invocation('same-call')), result);
  await assert.rejects(cold.execute('save_memory', { content: 'changed' }, invocation('same-call')), { code: 'legacy_memory_effect_identity_conflict' });
  assert.equal(records(root).length, 1);
  const db = new DatabaseSync(join(root, 'local', 'local.sqlite'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM legacy_ltm_facts').get().n, 1); db.close();
});

test('configured SQLite path is durable and pinned; explicit volatile modes lose facts on cold open', async t => {
  const { root, make } = setup(t), path = join(root, 'configured', 'memory.db'), env = { KSADK_MEMORY_DB_PATH: path };
  const first = make({ env }); await first.execute('save_memory', { content: 'custom durable fact' }, invocation('custom-save')); await first.close();
  const cold = make({ env }); assert.equal((await cold.execute('load_memory', { query: 'custom durable' }, invocation('custom-read'))).content, '[1] custom durable fact');
  assert.equal(lstatSync(path).mode & 0o077, 0);
  const changed = make({ env: { KSADK_MEMORY_DB_PATH: join(root, 'other', 'memory.db') } });
  await assert.rejects(changed.execute('save_memory', { content: 'custom durable fact' }, invocation('custom-save')), { code: 'legacy_memory_effect_identity_conflict' });
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  assert.throws(() => make({ workspaceRoot, env: { KSADK_MEMORY_DB_PATH: join(workspaceRoot, 'memory.db') } }), { code: 'legacy_memory_workspace_overlap' });
  for (const [mode, settings] of [['sqlite', { KSADK_MEMORY_DB_PATH: ':memory:' }], ['inmemory', { KSADK_LTM_FORCE_INMEMORY: 'true' }]]) {
    const service = make({ env: settings }); await service.execute('save_memory', { content: 'ephemeral fact' }, invocation(`volatile-save-${mode}`));
    assert.match((await service.execute('load_memory', { query: 'ephemeral' }, invocation(`volatile-warm-${mode}`))).content, /ephemeral fact/); await service.close();
    const reopened = make({ env: settings }); assert.equal((await reopened.execute('load_memory', { query: 'ephemeral' }, invocation(`volatile-cold-${mode}`))).content, '');
  }
});

test('HTTP keeps base path, legacy metadata/flush, full Unicode, attribution and auth; cold receipt makes no request', async t => {
  const { root, make } = setup(t), http = await server(t, (call, res) => json(res, call.url.endsWith('/search') ? { memories: ['真实事实'] } : {}));
  const env = { KSADK_LTM_BACKEND: 'http', KSADK_LTM_HTTP_URL: `${http.url}/v1`, KSADK_LTM_HTTP_TOKEN: 'private-token', KSADK_TRAFFIC_SOURCE: 'migration-test' };
  const service = make({ env }), content = '用户记忆😀'.repeat(6000), args = { content };
  env.KSADK_LTM_HTTP_URL = 'http://127.0.0.1:1'; env.KSADK_LTM_HTTP_TOKEN = 'changed';
  assert.equal((await service.execute('save_memory', args, invocation('http-save'))).content.status, 'persisted');
  const request = http.calls[0]; assert.equal(request.url, '/v1/memories');
  assert.equal(request.headers.authorization, 'Bearer private-token'); assert.equal(request.headers['x-traffic-source'], 'migration-test');
  assert.equal(JSON.parse(request.body.events[0]).parts[0].text, content);
  assert.deepEqual(request.body.metadata, { agent_id: 'agent', session_id: 'actual-session', runner_type: 'dsh-native', flush: true });
  assert.equal(request.body.session_id, 'actual-session'); assert.equal(request.body.flush, true);
  assert.deepEqual(records(root)[0].prepared.payload, request.body);
  assert.equal((lstatSync(join(root, 'effects', 'effects.sqlite')).mode & 0o077), 0);
  assert.equal(JSON.stringify(records(root)).includes('private-token'), false);
  assert.equal((await service.execute('load_memory', { query: '请找记忆😀' }, invocation('http-read'))).content, '[1] 真实事实');
  await service.close(); const cold = make({ env: { ...env, KSADK_LTM_HTTP_URL: `${http.url}/v1`, KSADK_LTM_HTTP_TOKEN: 'private-token' } });
  await cold.execute('save_memory', args, invocation('http-save')); assert.equal(http.calls.length, 2);
});

test('SDK stores exact DTO before dispatch and distinguishes accepted/not extracted from persisted', async t => {
  const { root, make } = setup(t), calls = [];
  const options = sdkOptions(async (name, payload, request) => {
    calls.push({ name, payload, request });
    if (name === 'CreateMemorySdk') {
      assert.deepEqual(records(root)[0].prepared.targets[0], payload);
      assert.equal(records(root)[0].phase, 'prepared'); return { requestId: 'receipt', data: { Code: 0 } };
    }
    if (name === 'QueryMemorySdk') return { data: { Data: [] } };
    return { data: { Data: { Items: [{ SessionId: 'actual-session', AgentUserId: 'actual-user', MemoryCollectionId: 'namespace', State: 'processing' }], Total: 1 } } };
  });
  options.env.KSADK_LTM_NAMESPACE = 'namespace';
  const service = make(options), result = await service.execute('save_memory', { content: '中文记忆' }, invocation('sdk-pending'));
  assert.deepEqual(result.content, { ok: false, status: 'accepted_not_extracted', message: '记忆保存请求已被后端受理，但尚未抽取成可检索记忆。',
    session_id: 'actual-session', session_state: 'processing' });
  assert.deepEqual(calls.map(item => item.name), ['CreateMemorySdk', 'QueryMemorySdk', 'ListSessions']);
  const payload = calls[0].payload, message = payload.Data.Conversation[0];
  assert.equal(payload.AgentUserId, 'actual-user'); assert.equal(payload.SessionId, 'actual-session'); assert.equal(payload.Flush, true);
  assert.match(message.MessageId, /^[a-f\d-]{36}$/); assert.ok(Number.isSafeInteger(message.CreatedAt));
  assert.deepEqual(message.Content, [{ Type: 'input_text', Text: '中文记忆' }]);
  assert.ok(calls.every(item => item.request.preserveEnvelope === true && item.request.signal instanceof AbortSignal));
  assert.equal(calls[0].request.requestId, records(root)[0].prepared.requestIds[0]);
  await service.execute('save_memory', { content: '中文记忆' }, invocation('sdk-pending')); assert.equal(calls.length, 3);
});

test('bound cloud tools use the same user/Session partition as Studio context injection', async t => {
  const { make } = setup(t), calls = [], options = sdkOptions(async (name, payload) => {
    calls.push({ name, payload }); return name === 'CreateMemorySdk' ? { data: {}, requestId: 'accepted' } : { data: { Memories: ['fact'] } };
  });
  const service = make({ ...options, bindings: legacyMemoryBindings({ bindings: { plugins: [plugin('collection')] } }) });
  assert.equal((await service.execute('save_memory', { content: 'fact' }, invocation('bound'))).content.status, 'persisted');
  assert.equal(calls[0].payload.AgentUserId, memorySubjectId('collection', context.userId, context.agentId));
  assert.equal(calls[0].payload.SessionId, memorySessionId(context.sessionId));
  assert.equal(calls[1].payload.AgentUserId, calls[0].payload.AgentUserId);
});

test('SDK ambiguous write, malformed search and partial multi-collection writes never report persisted or replay', async t => {
  const { make } = setup(t); let writes = 0;
  const service = make({ ...sdkOptions(async name => { if (name === 'CreateMemorySdk') { writes++; throw new Error('transport secret must not echo'); } }),
    bindings: legacyMemoryBindings({ bindings: { plugins: [plugin('one'), plugin('two')] } }) });
  const result = await service.execute('save_memory', { content: 'fact' }, invocation('ambiguous'));
  assert.equal(result.status, 'uncertain'); assert.equal(JSON.stringify(result).includes('transport secret'), false);
  await service.execute('save_memory', { content: 'fact' }, invocation('ambiguous')); assert.equal(writes, 1);
  const malformed = make(sdkOptions(async () => ({ data: { Error: { Code: 'failed' }, Memories: [] } })));
  assert.equal((await malformed.execute('load_memory', { query: 'fact' }, invocation('malformed'))).status, 'uncertain');
  let partialWrites = 0;
  const partial = make({ ...sdkOptions(async name => {
    assert.equal(name, 'CreateMemorySdk'); if (++partialWrites === 1) return { data: {}, requestId: 'first-accepted' }; throw new Error('second outcome unknown');
  }), bindings: legacyMemoryBindings({ bindings: { plugins: [plugin('one'), plugin('two')] } }) });
  assert.equal((await partial.execute('save_memory', { content: 'partial' }, invocation('partial'))).status, 'uncertain');
  assert.equal((await partial.execute('save_memory', { content: 'partial' }, invocation('partial'))).status, 'uncertain'); assert.equal(partialWrites, 2);
});

test('original request drift or authority loss after await cannot publish a successful write', async t => {
  const { make } = setup(t), options = invocation('drift'), args = { content: 'fact' };
  let calls = 0;
  const service = make(sdkOptions(async () => { calls++; args.content = 'redirected'; return { data: {}, requestId: 'accepted' }; }));
  assert.equal((await service.execute('save_memory', args, options)).status, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await service.execute('save_memory', { content: 'fact' }, invocation('drift'))).status, 'uncertain'); assert.equal(calls, 1);
});

test('real SIGKILL during HTTP write leaves an original durable intent; new PID does not re-submit', { timeout: 20000 }, async t => {
  const { root } = setup(t); let received; const receipt = new Promise(resolve => { received = resolve; });
  const http = await server(t, call => { received(call); });
  const input = { service: { agentId: 'agent', root, env: { KSADK_LTM_BACKEND: 'http', KSADK_LTM_HTTP_URL: http.url } },
    name: 'save_memory', args: { content: 'exact original effect😀' }, invocation: { context, owner: owner('killed') } };
  const processA = fork(new URL('./fixtures/legacy-memory-owner.mjs', import.meta.url), [JSON.stringify(input)],
    { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (processA.exitCode === null && processA.signalCode === null) processA.kill('SIGKILL'); });
  const request = await receipt; assert.deepEqual(records(root)[0].prepared.payload, request.body);
  assert.equal((await childResult(input)).status, 'uncertain', 'another live process cannot duplicate the pending write');
  assert.equal(http.calls.length, 1);
  const exited = once(processA, 'exit'); processA.kill('SIGKILL'); const [, killedBy] = await exited; assert.equal(killedBy, 'SIGKILL');
  const before = records(root); const result = await childResult(input);
  assert.equal(result.status, 'uncertain'); assert.equal(http.calls.length, 1); assert.deepEqual(records(root), before);
});

test('HTTP success headers without a complete body are not a confirmed write', async t => {
  const { make } = setup(t), controller = new AbortController();
  const http = await server(t, (_call, response) => {
    response.writeHead(200, { 'Content-Length': '1000' }); response.write('{');
    setImmediate(() => controller.abort(new Error('cancel incomplete response')));
  });
  const service = make({ env: { KSADK_LTM_BACKEND: 'http', KSADK_LTM_HTTP_URL: http.url } });
  assert.equal((await service.execute('save_memory', { content: 'fact' }, invocation('incomplete-body', { signal: controller.signal }))).status, 'uncertain');
  assert.equal((await service.execute('save_memory', { content: 'fact' }, invocation('incomplete-body'))).status, 'uncertain');
  assert.equal(http.calls.length, 1);
});

test('service retirement aborts a noncooperative backend and never accepts its late success', async t => {
  const { root, make } = setup(t); let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const service = make(sdkOptions(() => { entered(); return new Promise(resolve => { finish = resolve; }); }));
  const pending = service.execute('save_memory', { content: 'fact' }, invocation('retired')); await started;
  await service.close(); const result = await pending; assert.equal(result.status, 'uncertain');
  finish({ data: {}, requestId: 'too-late' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(records(root)[0].result.status, 'uncertain');
});

test('effect store requires exact synchronous authority and serializes competing owners before dispatch', async t => {
  const { root } = setup(t), store = new LegacyMemoryEffects(join(root, 'direct')); t.after(() => store.close());
  let count = 0, finish;
  const input = { owner: owner('compete'), request: { name: 'save_memory' }, binding: { contract: 'actual-host-binding/v1' },
    signal: new AbortController().signal, assertCurrent: () => true, prepare: () => ({ originalId: 'fixed' }),
    dispatch: () => { count++; return new Promise(resolve => { finish = resolve; }); } };
  const first = store.execute(input); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.execute(input)).status, 'uncertain'); assert.equal(count, 1);
  finish({ status: 'ok', content: 'confirmed' }); await first;
  assert.deepEqual(await store.execute(input), { status: 'ok', content: 'confirmed' });
  await assert.rejects(store.execute({ ...input, owner: owner('async-authority'), assertCurrent: async () => true }), { code: 'legacy_memory_effect_authority_lost' });
});

test('real signed Node transport preserves SDK response envelopes and captures configuration', async t => {
  const { root, make } = setup(t), http = await server(t, (call, res) => {
    const action = call.body.Action;
    json(res, action === 'CreateMemorySdk' ? { Code: 0, RequestId: 'create-receipt', Data: { Accepted: true } }
      : action === 'ListSessions' ? { Data: { Items: [{ SessionId: 'actual-session', State: 'processing' }], Total: 1 } }
        : { Code: 0, Data: call.body.Query === 'pending fact' ? [] : [{ Memories: [{ Content: 'actual fact' }] }] });
  });
  const values = { cloudAccessKey: 'access', cloudSecretKey: 'secret', cloudRegion: 'cn-beijing-6', cloudServerUrl: 'https://aicp.api.ksyun.com' };
  const connection = await createLegacyMemoryConnection({ configuration: { resolve: async () => ({ values }) },
    fetchImpl: (url, init) => hostFetch(`${http.url}${new URL(url).pathname}${new URL(url).search}`, init) });
  values.cloudServerUrl = 'http://127.0.0.1:1'; values.cloudSecretKey = 'changed';
  const service = make({ connection, env: { KSADK_LTM_BACKEND: 'sdk' } });
  assert.equal((await service.execute('save_memory', { content: 'actual fact' }, invocation('signed'))).content.status, 'persisted');
  assert.equal(http.calls.length, 2); assert.match(http.calls[0].headers.authorization, /access/);
  assert.equal(http.calls[1].body.Query, 'actual fact');
  assert.equal(http.calls[0].headers['x-ksc-request-id'], records(root)[0].prepared.requestIds[0]);
  const pending = await service.execute('save_memory', { content: 'pending fact' }, invocation('signed-pending'));
  assert.equal(pending.content.status, 'accepted_not_extracted'); assert.equal(pending.content.session_state, 'processing');
  assert.equal(http.calls.length, 5); assert.equal(http.calls.at(-1).body.Action, 'ListSessions');
});

test('actual DSH Agent/Session context, revision/Build and current standing policy own Memory dispatch', async t => {
  const { root, make } = setup(t), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  let mode = 'read-only', approved = 'denied', policyChecks = 0;
  const ctx = { sandboxPolicy: { resolve: () => { policyChecks++; return { mode }; } }, approval: { request: async () => approved } };
  const service = make(), port = createDshNodeLegacyMemory({ ctx, workspaceRoot, stateDir: join(root, 'state'), agentId: 'agent',
    agentRevision: 4, buildId: 'frozen-build', memory: service }); t.after(() => port.close());
  const agent = { session: { id: 'real-session' } }, args = { content: 'actual user fact' }, exec = { agent, name: 'save_memory', arguments: args,
    callId: 'owned-call', signal: new AbortController().signal };
  await assert.rejects(port.execute(exec.name, args, exec), { code: 'dsh_memory_invocation_unbound' });
  bindDshInvocationContext(agent, { userId: 'real-user', runnerType: 'codex' });
  await assert.rejects(port.execute(exec.name, args, exec), { code: 'STUDIO_NATIVE_PERMISSION_DENIED' }); assert.deepEqual(records(root), []);
  approved = 'allowed-once'; assert.equal((await port.execute(exec.name, args, exec)).content.status, 'persisted');
  const row = records(root)[0], origin = row.request.owner;
  assert.equal(origin.kind, 'dsh'); assert.equal(origin.request.agentRevision, 4); assert.equal(origin.request.buildId, 'frozen-build');
  assert.equal(origin.request.call.callId, 'owned-call'); assert.equal(row.request.request.context.userId, 'real-user');
  assert.equal(JSON.stringify(origin).includes('executionFence'), false); assert.equal(JSON.stringify(origin).includes('runId'), false);
  bindDshInvocationContext(agent, { userId: 'other-user', runnerType: 'codex' });
  await assert.rejects(port.execute(exec.name, args, exec), { code: 'legacy_memory_effect_identity_conflict' });
  assert.ok(policyChecks > 0); mode = 'workspace-write';
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} actual stream adapter binds trusted user before invoking the runtime`, async t => {
  const { root } = setup(t), bridge = createRuntimeBridge(); t.after(() => bridge.close());
  const agent = { session: { id: 'actual-session', header: { cwd: root }, snapshotEvents: () => [], append: () => {} } };
  let checked = 0;
  const check = () => { const trusted = getDshInvocationContext(agent); checked++;
    assert.equal(trusted.userId, 'trusted-user'); assert.equal(trusted.session, agent.session); assert.equal(trusted.runnerType, runtime); };
  const adapter = createDshRuntimeAdapter({ bridge,
    localHandler: async () => async (request, response) => {
      for await (const _chunk of request) {} check(); response.writeHead(200);
      response.end('data: {"runtimeEvent":{"event_type":"run.completed"}}\n\ndata: [DONE]\n\n');
    }, codexRuntime: { async *stream() { check(); yield { type: 'text', text: 'answer' }; } } });
  for await (const _frame of adapter.stream({ model: 'local:agent', studioRuntime: runtime, agent,
    sessionId: 'actual-session', userId: 'trusted-user', messages: [{ role: 'user', content: 'hello' }] })) {}
  assert.equal(checked, 1);
});
