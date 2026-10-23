import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createDshNodeA2aTools, DSH_NODE_A2A_CONTRACT } from '../src/providers/dsh-node-a2a-tools.mjs';

const spec = { local_name: 'research', binding_id: 'binding-1', space_id: 'space-1', target_agent_id: 'a2a-agent-remote',
  expected_version_id: 'version-1', exposure: 'tool' };
const args = { agent: 'research', message: '真正的请求 😀' };
const records = directory => {
  const values = [];
  const visit = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) visit(full); else if (entry.name.endsWith('.json')) values.push({ path: full, bytes: readFileSync(full), value: JSON.parse(readFileSync(full)) });
  } };
  visit(directory); return values;
};
async function waitUntil(fn) {
  const limit = Date.now() + 6000;
  while (!fn()) { assert.ok(Date.now() < limit, 'actual effect/checkpoint did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function setup(t, { protocol = 'JSONRPC', streaming = true, mode = 'complete', source = 'hosted', timeout, skipIntent = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-a2a-node-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); mkdirSync(stateDir);
  const requests = []; let sends = 0, version = 'version-1', policy = 'workspace-write', approve = async () => 'allowed-once';
  const task = { id: 'remote-task', contextId: 'remote-context', status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ artifactId: 'result', parts: [{ text: '最终 😀' }] }] };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      assert.equal(body.A2ASpaceId, spec.space_id); assert.equal(req.headers.authorization, 'Bearer synthetic-a2a-token');
      res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: spec.target_agent_id, VersionId: version, Source: source,
        AgentCard: { name: 'research', description: 'Remote research', capabilities: { streaming },
          supportedInterfaces: [{ url: origin + (protocol === 'JSONRPC' ? '/rpc' : '/a2a'), protocolBinding: protocol, protocolVersion: '1.0' }] } }] } })); return;
    }
    const method = protocol === 'JSONRPC' ? body.method : req.url.endsWith('/message:stream') ? 'SendStreamingMessage'
      : req.url.endsWith('/message:send') ? 'SendMessage' : 'GetTask';
    const params = protocol === 'JSONRPC' ? body.params : body;
    const wrap = result => protocol === 'JSONRPC' ? { jsonrpc: '2.0', id: body.id, result } : result;
    if (!method.startsWith('Send')) { assert.equal(method, 'GetTask'); res.end(JSON.stringify(wrap(task))); return; }
    sends++;
    const saved = records(stateDir), remote = saved.find(row => row.value.contract === 'agentkit.studio-dsh-a2a-host/v1'
      && row.value.request.message.messageId === params.message.messageId);
    const intent = saved.find(row => row.value.contract === 'agentkit.dsh-node-command-ledger/v1' && row.value.phase === 'executing'
      && row.value.owner.agentId === remote?.value.owner.agentId && row.value.owner.sessionId === remote?.value.owner.sessionId);
    if (!skipIntent) assert.ok(intent, 'fsynced original DSH intent before HTTP');
    assert.equal(remote.value.phase, 'sending'); assert.ok(remote.value.owner.agentId);
    assert.equal(remote.value.request.dsh.call.arguments.message, args.message);
    assert.equal(remote.value.request.message.messageId, params.message.messageId);
    for (const key of ['scope', 'runId', 'turnId', 'executionFence', 'taskChainId']) assert.equal(Object.hasOwn(remote.value.request.dsh, key), false);
    assert.equal(Object.hasOwn(remote.value.request, 'native'), false);
    if (method === 'SendMessage') { res.end(JSON.stringify(wrap({ task }))); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    const event = (id, payload) => `id: ${id}\r\ndata: ${JSON.stringify(wrap(payload))}\r\n\r\n`;
    res.write(event('1', { task: { id: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } } }));
    if (mode === 'hold') return;
    if (mode === 'lost') { res.destroy(); return; }
    const base = { taskId: task.id, contextId: task.contextId };
    res.write(event('2', { artifactUpdate: { ...base, artifact: { artifactId: 'result', parts: [{ text: '最终 ' }] } } }));
    const append = event('3', { artifactUpdate: { ...base, artifact: { artifactId: 'result', parts: [{ text: '😀' }] }, append: true, lastChunk: true } });
    const bytes = Buffer.from(append), index = bytes.indexOf(Buffer.from('😀'));
    res.write(bytes.subarray(0, index + 1)); res.write(bytes.subarray(index + 1)); res.write(append);
    if (mode !== 'poll') res.write(event('4', { statusUpdate: { ...base, status: { state: 'TASK_STATE_COMPLETED' } } }));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { KSADK_A2A_SPACE_ID: spec.space_id, KSADK_A2A_SERVICE_URL: origin,
    KSADK_A2A_SERVICE_TOKEN: 'synthetic-a2a-token', KSADK_A2A_ALLOW_PRIVATE: 'true' };
  const options = { agentId: 'agent', agentRevision: 3, buildId: 'frozen-build', workspaceRoot, stateDir, env,
    bindings: [{ ...spec, ...(timeout ? { timeout_seconds: timeout } : {}) }] };
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: policy }) }, approval: { request: input => approve(input) } };
  const owners = [];
  function create(overrides = {}) { const port = createDshNodeA2aTools({ ...options, ctx, ...overrides }); owners.push(port); return port; }
  const port = create();
  const exec = (name = 'call_a2a_agent', body = args, extra = {}) => ({ name, arguments: body, agent: { session: { id: 'session' } },
    callId: 'original-call', signal: new AbortController().signal, ...extra });
  t.after(async () => { await Promise.all(owners.map(port => port.close())); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return { port, create, exec, options, env, requests, records: () => records(stateDir), get sends() { return sends; },
    drift: () => { version = 'foreign'; }, readOnly: () => { policy = 'read-only'; }, approval: fn => { approve = fn; } };
}

for (const protocol of ['JSONRPC', 'HTTP+JSON']) for (const streaming of [false, true]) test(`DSH actual ${protocol} ${streaming ? 'stream' : 'send'} persists original intent, duplicate receipt and remote owner`, async t => {
  const h = await setup(t, { protocol, streaming }), exec = h.exec();
  h.readOnly(); let approvals = 0; h.approval(async input => { approvals++; assert.equal(input.agent, exec.agent); assert.equal(input.callId, exec.callId); return 'allowed-once'; });
  const result = await h.port.execute(exec.name, args, exec);
  assert.equal(result.status, 'ok', canonical(result)); assert.equal(result.content.reply, '最终 😀'); assert.equal(h.sends, 1);
  assert.equal(h.port.contract, DSH_NODE_A2A_CONTRACT);
  assert.equal(await h.port.execute('list_a2a_agents', {}, h.exec('list_a2a_agents', {})).then(value => value.content.agents[0].agent_id), spec.target_agent_id);
  const before = h.records().map(row => [row.path, row.bytes.toString()]), network = h.requests.length;
  assert.deepEqual(await h.port.execute(exec.name, args, exec), result);
  assert.equal(h.requests.length, network); assert.equal(h.sends, 1); assert.equal(approvals, 2);
  await h.port.close(); const replacement = h.create(), coldExec = h.exec();
  h.approval(async input => { assert.equal(input.agent, coldExec.agent); return 'allowed-once'; });
  assert.deepEqual(await replacement.execute(exec.name, args, coldExec), result);
  assert.equal(h.requests.length, network); assert.deepEqual(h.records().map(row => [row.path, row.bytes.toString()]), before);
  assert.doesNotMatch(canonical(h.records().map(row => row.value)), /synthetic-a2a-token/);
});

test('stream EOF polls only the original remote Task and external endpoints receive no registry token', async t => {
  const h = await setup(t, { mode: 'poll', source: 'external' });
  const result = await h.port.execute('call_a2a_agent', args, h.exec()); assert.equal(result.content.reply, '最终 😀');
  assert.deepEqual(h.requests.filter(row => row.url === '/rpc').map(row => row.body.method), ['SendStreamingMessage', 'GetTask']);
  for (const row of h.requests.filter(row => row.url === '/rpc')) assert.equal(row.authorization, undefined);
});

test('lost stream and same-call concurrent entries never resend and cold-open preserves exact original receipt', async t => {
  const h = await setup(t, { mode: 'lost' });
  const [a, b] = await Promise.all([h.port.execute('call_a2a_agent', args, h.exec()), h.port.execute('call_a2a_agent', args, h.exec())]);
  assert.equal(a.status, 'uncertain'); assert.deepEqual(a, b); assert.equal(h.sends, 1);
  assert.equal(h.records().find(row => row.value.contract === 'agentkit.studio-dsh-a2a-host/v1').value.phase, 'unknown');
  const count = h.requests.length; await h.port.close();
  assert.deepEqual(await h.create().execute('call_a2a_agent', args, h.exec()), a); assert.equal(h.requests.length, count);
});

for (const cause of ['caller', 'host', 'timeout']) test(`actual ${cause} interruption checkpoints unknown remote Task without retry`, async t => {
  const h = await setup(t, { mode: 'hold', ...(cause === 'timeout' ? { timeout: 0.15 } : {}) }), controller = new AbortController();
  const pending = h.port.execute('call_a2a_agent', args, h.exec('call_a2a_agent', args, { signal: controller.signal }));
  await waitUntil(() => h.sends === 1 && h.records().some(row => row.value.projection?.taskId === 'remote-task'));
  if (cause === 'caller') controller.abort(new Error('caller canceled'));
  if (cause === 'host') await h.port.close();
  const result = await pending; assert.equal(result.status, 'uncertain', canonical(result));
  const remote = h.records().find(row => row.value.contract === 'agentkit.studio-dsh-a2a-host/v1').value;
  assert.equal(remote.phase, 'unknown'); assert.equal(remote.projection.taskId, 'remote-task');
  const count = h.requests.length; await h.port.close();
  assert.deepEqual(await h.create().execute('call_a2a_agent', args, h.exec()), result);
  assert.equal(h.sends, 1); assert.equal(h.requests.length, count);
});

test('revision, Frozen Build, endpoint and argument drift reject original call without HTTP', async t => {
  const h = await setup(t, { streaming: false });
  assert.equal((await h.port.execute('call_a2a_agent', args, h.exec())).status, 'ok'); const count = h.requests.length;
  for (const override of [{ agentRevision: 4 }, { buildId: 'other-build' }, { env: { ...h.env, KSADK_A2A_SERVICE_URL: 'http://127.0.0.1:9' } }]) {
    const result = await h.create(override).execute('call_a2a_agent', args, h.exec());
    assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'dsh_node_command_call_identity_conflict');
  }
  const other = { ...args, message: 'changed' };
  assert.equal((await h.port.execute('call_a2a_agent', other, h.exec('call_a2a_agent', other))).status, 'error');
  assert.equal(h.requests.length, count); assert.equal(h.sends, 1);
});

test('read-only denial, malformed input, missing Space and version drift never send', async t => {
  const h = await setup(t); h.readOnly(); h.approval(async () => 'denied');
  assert.equal((await h.port.execute('call_a2a_agent', args, h.exec())).status, 'error'); assert.equal(h.requests.length, 0);
  assert.equal((await h.port.execute('call_a2a_agent', {}, h.exec('call_a2a_agent', {}))).status, 'error'); assert.equal(h.requests.length, 0);
  const missing = h.create({ env: {}, bindings: [] });
  assert.equal((await missing.execute('list_a2a_agents', {}, h.exec('list_a2a_agents', {}))).content.error_type, 'A2A_SPACE_NOT_CONFIGURED');
  h.approval(async () => 'allowed-once'); h.drift();
  const result = await h.port.execute('call_a2a_agent', args, h.exec()); assert.equal(result.status, 'error'); assert.equal(h.sends, 0);
});

test('deferred permission cannot borrow changed identity or continue after retirement', async t => {
  const h = await setup(t); h.readOnly(); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  h.approval(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const exec = h.exec(), pending = h.port.execute('call_a2a_agent', args, exec); await ready;
  exec.agent.session = { id: 'other' }; release('allowed-once');
  assert.equal((await pending).content.error_type, 'dsh_a2a_request_drifted'); assert.equal(h.requests.length, 0);
  let ready2; const entered = new Promise(resolve => { ready2 = resolve; });
  h.approval(() => { ready2(); return new Promise(() => {}); });
  const retired = h.port.execute('call_a2a_agent', args, h.exec()); await entered; await h.port.close();
  assert.equal((await retired).status, 'error'); assert.equal(h.requests.length, 0);
});

test('actual SIGKILL and a new Node PID preserve sending checkpoint without another request', async t => {
  const h = await setup(t, { mode: 'hold' });
  const start = () => fork(new URL('./fixtures/dsh-node-a2a-driver.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python', KSADK_PYTHON: '/unavailable/python' } });
  const first = start(); let firstErr = ''; first.stderr.on('data', chunk => { firstErr += chunk; });
  t.after(() => { if (first.exitCode === null) first.kill('SIGKILL'); });
  first.send({ ...h.options, args });
  await waitUntil(() => h.sends === 1 && h.records().some(row => row.value.projection?.taskId === 'remote-task'));
  const exited = once(first, 'exit'); first.kill('SIGKILL'); const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL', firstErr);
  const bytes = h.records().map(row => [row.path, row.bytes.toString()]), count = h.requests.length;
  const second = start(); t.after(() => { if (second.exitCode === null) second.kill('SIGKILL'); });
  const message = once(second, 'message'); second.send({ ...h.options, args });
  const [reply] = await message; assert.equal(reply.result.status, 'uncertain', canonical(reply)); assert.notEqual(reply.pid, first.pid);
  await once(second, 'exit'); assert.equal(second.exitCode, 0);
  assert.equal(h.requests.length, count); assert.equal(h.sends, 1); assert.deepEqual(h.records().map(row => [row.path, row.bytes.toString()]), bytes);
});

test('the same call id in another real Session or Agent cannot borrow the original remote owner', async t => {
  const h = await setup(t, { streaming: false });
  const a = await h.port.execute('call_a2a_agent', args, h.exec());
  const secondExec = h.exec('call_a2a_agent', args, { agent: { session: { id: 'second-session' } } });
  const b = await h.port.execute('call_a2a_agent', args, secondExec);
  const other = h.create({ agentId: 'another-agent' });
  const c = await other.execute('call_a2a_agent', args, h.exec());
  assert.equal(a.status, 'ok'); assert.equal(b.status, 'ok'); assert.equal(c.status, 'ok'); assert.equal(h.sends, 3);
  assert.equal(new Set([a.content.task_id, b.content.task_id, c.content.task_id]).size, 3);
  const owners = h.records().filter(row => row.value.contract === 'agentkit.studio-dsh-a2a-host/v1');
  assert.equal(owners.length, 3); assert.equal(new Set(owners.map(row => canonical(row.value.owner))).size, 3);
});
