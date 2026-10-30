import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeConnection, createStudioKnowledgeTools, knowledgeBindings } from '../src/knowledge-tools.mjs';
import { createDshNodeKnowledgeTools } from '../src/providers/dsh-node-knowledge-tools.mjs';

const formal = 'search_knowledge_base', signal = () => new AbortController().signal;
const plugin = (id, enabled = true) => ({ enabled, config: { binding: { resource: { kind: 'knowledge-base', id, secretKey: 'never-copy' } } } });
const bindings = (...ids) => knowledgeBindings({ bindings: { plugins: ids.map(id => plugin(id)) } });
const reply = (content = '检索正文') => ({ data: { Records: [{ Segment: { Content: content, Answer: '回答', Document: { Name: '文档' } } }] } });
function service(action, options = {}) {
  return createStudioKnowledgeTools({ agentId: 'agent', bindings: bindings('kb'),
    connection: { client: { action }, bindingDigest: 'a'.repeat(64) }, ...options });
}
const invoke = (tool, args, options = {}) => tool.execute(formal, args, { signal: signal(), assertCurrent: () => true, ...options });
function setup(t, action, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-knowledge-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const knowledge = service(action), owners = [];
  const create = extra => { const owner = createDshNodeKnowledgeTools({ agentId: 'agent', agentRevision: 1, buildId: 'build',
    workspaceRoot, stateDir, knowledge, ...options, ...extra }); owners.push(owner); return owner; };
  t.after(async () => { for (const owner of owners) await owner.close(); });
  const exec = (args, extra = {}) => ({ name: formal, arguments: args, callId: 'original-call',
    agent: { session: { id: 'session' } }, signal: signal(), ...extra });
  return { root, workspaceRoot, stateDir, create, exec };
}
function records(path) {
  try { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? records(join(path, entry.name))
    : entry.name === 'record.json' ? [JSON.parse(readFileSync(join(path, entry.name), 'utf8'))] : []); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('only enabled Agent knowledge resources enter the immutable public admission binding', () => {
  const spec = { bindings: { plugins: [plugin('kb'), plugin('kb'), plugin('hidden', false), { config: { binding: { resource: { kind: 'memory-instance', id: 'memory' } } } }] } };
  const value = knowledgeBindings(spec); spec.bindings.plugins[0].config.binding.resource.id = 'changed';
  assert.deepEqual(value, { contract: 'agentkit.studio-knowledge-bindings/v1', datasetIds: ['kb'] });
  assert.equal(JSON.stringify(value).includes('never-copy'), false);
});

test('preserves Python retrieval defaults, full Unicode query, sources, answers and explicit top_k', async () => {
  const requests = [], tool = service(async (...args) => { requests.push(args); return reply(); });
  const query = '请检索😀完整内容'.repeat(100);
  assert.deepEqual(await invoke(tool, { query }), { status: 'ok', content: '[1] (来源: 文档) 检索正文\n    答案: 回答' });
  assert.deepEqual(requests[0].slice(0, 2), ['RetrieveKnowledge', { DatasetId: 'kb', Query: query,
    RetrievalModel: { SearchMethod: 'intelligence_search', TopK: 5, RerankingEnable: false } }]);
  assert.equal(requests[0][2].apiVersion, '2025-11-14'); assert.ok(requests[0][2].signal instanceof AbortSignal);
  await invoke(tool, { query: 'q', top_k: 12 }); assert.equal(requests[1][1].RetrievalModel.TopK, 12);
});

test('legacy retrieval settings and environment dataset are captured once, while actual Agent IDs take precedence', async () => {
  const requests = [], env = { KSADK_KB_DATASET_ID: 'env-kb', KSADK_KB_TOP_K: '7', KSADK_KB_SEARCH_METHOD: 'semantic',
    KSADK_KB_SCORE_THRESHOLD: '0', KSADK_KB_RERANKING_ENABLE: 'YES' };
  const action = async (_name, payload) => { requests.push(payload); return { data: { Records: [] } }; };
  const tool = service(action, { env, bindings: bindings() }); env.KSADK_KB_TOP_K = '99';
  assert.deepEqual(await invoke(tool, { query: 'q' }), { status: 'ok', content: '未找到相关知识库内容。' });
  assert.deepEqual(requests[0], { DatasetId: 'env-kb', Query: 'q', RetrievalModel: { SearchMethod: 'semantic',
    TopK: 7, RerankingEnable: true, ScoreThresholdEnabled: true, ScoreThreshold: 0 } });
  await invoke(service(action, { env }), { query: 'q' }); assert.equal(requests[1].DatasetId, 'kb');
});

test('multiple bound datasets preserve deterministic order and never publish partial results as complete', async () => {
  const calls = [], tool = service(async (_name, payload) => { calls.push(payload.DatasetId); return reply(payload.DatasetId); }, { bindings: bindings('one', 'two') });
  assert.match((await invoke(tool, { query: 'q' })).content, /\[1\].*one[\s\S]*\[2\].*two/);
  assert.deepEqual(calls, ['one', 'two']);
  const partial = await invoke(service(async (_name, payload) => payload.DatasetId === 'one' ? reply('partial') : { data: {} },
    { bindings: bindings('one', 'two') }), { query: 'q' });
  assert.equal(partial.status, 'error'); assert.equal(JSON.stringify(partial).includes('partial'), false);
});

test('invalid/unconfigured input has no transport effect', async () => {
  let calls = 0; const action = async () => { calls++; return reply(); };
  for (const args of [{ query: '' }, { query: ' ' }, { query: 1 }, { query: 'q', top_k: 0 }, { query: 'q', top_k: 1.5 }, { query: 'q', foreign: 'x' }])
    assert.equal((await invoke(service(action), args)).status, 'error');
  assert.equal((await invoke(service(action, { bindings: bindings() }), { query: 'q' })).content.error_type, 'knowledge_not_configured');
  assert.equal(calls, 0);
});

test('malformed, rejected and failed responses stay errors with no credential echo or false empty search', async () => {
  for (const data of ['broken', [], {}, { Records: false }, { Code: true, Records: [] }, { Code: 500, Records: [] },
    { Error: { Message: 'private-token' }, Records: [] }, { ResponseMetadata: 'invalid', Records: [] }, { Records: [{ Segment: { Content: 1 } }] }]) {
    const result = await invoke(service(async () => ({ data })), { query: 'q' });
    assert.equal(result.content.error_type, 'knowledge_response_invalid'); assert.equal(JSON.stringify(result).includes('private-token'), false);
  }
  const result = await invoke(service(async () => { throw new Error('https://secret-token@private'); }), { query: 'q' });
  assert.deepEqual(result, { status: 'error', content: { ok: false, error_type: 'knowledge_search_failed' } });
});

for (const mode of ['cancel', 'authority', 'retire']) test(`noncooperative transport ${mode} cannot publish a late answer or launch the next dataset`, async () => {
  let entered, deliver, live = true, calls = 0;
  const started = new Promise(resolve => { entered = resolve; }), response = new Promise(resolve => { deliver = resolve; });
  const controller = new AbortController(), tool = service(() => { calls++; entered(); return response; }, { bindings: bindings('one', 'two') });
  const pending = invoke(tool, { query: 'q' }, { signal: controller.signal, assertCurrent: () => live }); await started;
  if (mode === 'cancel') controller.abort(); else if (mode === 'retire') await tool.close(); else live = false;
  if (mode !== 'authority') await assert.rejects(pending); deliver(reply('late secret answer'));
  if (mode === 'authority') await assert.rejects(pending, { code: 'knowledge_authority_lost' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('thenable authority is rejected before transport; rejected promise remains observed', async () => {
  await assert.rejects(invoke(service(() => assert.fail('must not dispatch')), { query: 'q' },
    { assertCurrent: () => Promise.reject(new Error('async authority')) }), { code: 'knowledge_authority_lost' });
});

test('DSH persists original intent before dispatch; duplicate receipts and immutable binding conflicts survive new owner', async t => {
  let calls = 0; const h = setup(t, async (_name, payload) => {
    calls++; const [record] = records(h.stateDir); assert.equal(record.phase, 'executing');
    assert.equal(record.request.call.arguments.query, payload.Query); assert.equal(record.binding.agentRevision, 1); return reply();
  });
  const args = { query: '原始查询' }, exec = h.exec(args), first = await h.create().execute(formal, args, exec);
  assert.equal(first.status, 'ok'); assert.deepEqual(await h.create().execute(formal, args, exec), first); assert.equal(calls, 1);
  for (const extra of [{ agentRevision: 2 }, { buildId: 'changed-build' }, { knowledge: service(async () => assert.fail('binding drift'), { bindings: bindings('other') }) }])
    assert.equal((await h.create(extra).execute(formal, args, exec)).content.error_type, 'dsh_node_command_call_identity_conflict');
  assert.equal(calls, 1);
});

test('retiring a DSH owner bounds an uncooperative lookup and prevents later result publication', async t => {
  let enter, deliver; const started = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { deliver = resolve; });
  const h = setup(t, () => { enter(); return held; }), owner = h.create(), args = { query: 'q' }, exec = h.exec(args);
  const pending = owner.execute(formal, args, exec); await started; await owner.close();
  assert.equal((await pending).status, 'uncertain'); deliver(reply('late')); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.create().execute(formal, args, h.exec(args))).status, 'uncertain');
});

test('snapshot Node transport signs exact API requests and does not follow later config, environment or method mutation', async () => {
  let values = { cloudAccessKey: 'key', cloudSecretKey: 'secret', cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'cn-beijing-6' };
  const calls = [], env = { KSADK_KB_ACCESS_KEY: 'override-key', KSADK_KB_SECRET_KEY: 'override-secret', KSADK_KB_REGION: 'cn-shanghai-2' };
  const connection = await createKnowledgeConnection({ configuration: { resolve: async () => ({ values }) }, env,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers }); return Response.json(reply().data); } });
  const tool = createStudioKnowledgeTools({ agentId: 'agent', bindings: bindings('kb'), connection });
  values.cloudServerUrl = 'https://foreign.example'; env.KSADK_KB_ACCESS_KEY = 'new-key'; connection.client.action = () => assert.fail('transport replacement');
  assert.equal((await invoke(tool, { query: 'full' })).status, 'ok');
  assert.match(calls[0].url, /^https:\/\/aicp\.api\.ksyun\.com\//); assert.equal(calls[0].body.Accesskey, 'override-key');
  assert.equal(calls[0].body.Region, 'cn-shanghai-2'); assert.equal(calls[0].body.Version, '2025-11-14');
  assert.match(calls[0].headers.Authorization, /Credential=override-key/);
  assert.equal(JSON.stringify(tool.binding).includes('override-key'), false); assert.equal(JSON.stringify(tool.binding).includes('override-secret'), false);
});

async function child(t, input) {
  const process = fork(new URL('./fixtures/knowledge-owner.mjs', import.meta.url), [JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; process.stderr.on('data', bytes => { stderr += bytes; });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  const message = once(process, 'message'); message.catch(() => {});
  const exited = once(process, 'exit');
  return { process, exited, async result() { const [messageValue] = await message; const [code] = await exited; assert.equal(code, 0, stderr); return messageValue; } };
}

test('actual separate PID cold receipts need no service; SIGKILL during HTTP never silently reissues original call', { timeout: 20000 }, async t => {
  let calls = 0, entered; const started = new Promise(resolve => { entered = resolve; });
  const server = createServer((req, res) => { calls++; req.resume(); if (calls === 2) { entered(); return; } res.end(JSON.stringify(reply('actual HTTP').data)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const h = setup(t, () => assert.fail('parent must not dispatch')), input = { workspaceRoot: h.workspaceRoot, stateDir: h.stateDir,
    url: `http://127.0.0.1:${server.address().port}`, callId: 'finished' };
  const first = await (await child(t, input)).result(), second = await (await child(t, input)).result();
  assert.notEqual(first.pid, second.pid); assert.deepEqual(first.result, second.result); assert.equal(calls, 1);
  const running = await child(t, { ...input, callId: 'killed' }); await started; running.process.kill('SIGKILL');
  const [code, sig] = await running.exited; assert.equal(code, null); assert.equal(sig, 'SIGKILL');
  const recovered = await (await child(t, { ...input, callId: 'killed' })).result();
  assert.notEqual(recovered.pid, running.process.pid); assert.equal(recovered.result.status, 'uncertain'); assert.equal(calls, 2);
});
