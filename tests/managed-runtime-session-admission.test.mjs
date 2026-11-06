import test from 'node:test';
import assert from 'node:assert/strict';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';

const token = 'managed-session-admission-test-token';
const identity = { agentId: 'ar-admission', versionId: 'version-1', manifestSha256: 'a'.repeat(64), runtimeName: 'dsh-native' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const answerText = body => (body.output || []).flatMap(item => item.content || []).map(part => part.text).filter(Boolean).join('');
const deferred = () => { const result = {}; result.promise = new Promise(resolve => { result.resolve = resolve; }); return result; };

function platformActions() {
  return {
    setRunControl() {},
    responsesInput: value => ({ input: value.ResponsesInput, session_id: value.SessionId, request_id: value.InvocationId, stream: value.Stream }),
    async parseResponses(input, headers, responses) {
      const parsed = responses.parse(input, headers);
      const sessionId = input.session_id || `native-${input.request_id}`;
      return { ...parsed, sessionId, platformSession: { sessionId }, principalDigest: 'p'.repeat(64) };
    },
    async checkRun() {}, async flushRun() {}, async settleRun() {},
  };
}

async function setup(t, { runner, sessionAdmission, logs = [] } = {}) {
  const server = await startBuildRuntimeHttp({ agentId: identity.agentId, managedIdentity: identity, platformActions: platformActions(),
    token, runner, model: 'model', models: ['model'], port: 0, sessionAdmission, runLog: entry => logs.push(entry) });
  t.after(() => server.close());
  return {
    server,
    run: (input, requestId, session = 'session-a') => fetch(`http://127.0.0.1:${server.address.port}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-agentengine-target-version-id': identity.versionId, 'x-agentengine-manifest-sha256': identity.manifestSha256 },
      body: JSON.stringify({ input, session_id: session, request_id: requestId }),
    }),
  };
}

test('three messages sent together to one Session queue and execute in order instead of failing', async t => {
  const started = [];
  const api = await setup(t, { runner: async request => { started.push(request.input); await sleep(25); return { output: `echo:${request.input}` }; } });
  const responses = await Promise.all([api.run('one', 'r1'), api.run('two', 'r2'), api.run('three', 'r3')]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.deepEqual(started, ['one', 'two', 'three'], 'turns must run one after another in arrival order');
  for (const [index, response] of responses.entries()) assert.equal(answerText(await response.json()), `echo:${['one', 'two', 'three'][index]}`);
});

test('a retried invocation joins the running turn and never executes twice', async t => {
  const completed = new Map();
  const gate = deferred();
  let executions = 0, active = 0, maxConcurrent = 0;
  const api = await setup(t, { runner: async request => {
    if (completed.has(request.requestId)) return completed.get(request.requestId);
    executions++; active++; maxConcurrent = Math.max(maxConcurrent, active);
    try { await gate.promise; const result = { output: 'once' }; completed.set(request.requestId, result); return result; }
    finally { active--; }
  } });
  const first = api.run('hello', 'retry-1');
  await sleep(30);
  const retry = api.run('hello', 'retry-1');
  await sleep(30);
  assert.equal(executions, 1, 'the retry must wait for the turn already running');
  gate.resolve();
  const [original, repeated] = await Promise.all([first, retry]);
  assert.equal(original.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(executions, 1, 'the retry replays the settled request instead of a second execution');
  assert.equal(maxConcurrent, 1);
});

test('a turn killed mid-flight is reclaimed on its deadline and the next message executes', async t => {
  const api = await setup(t, { runner: request => request.input === 'stuck' ? new Promise(() => {}) : Promise.resolve({ output: 'ok' }),
    sessionAdmission: { turnTimeoutMs: 80, fenceGraceMs: 60, waitTimeoutMs: 4000 } });
  const stuck = api.run('stuck', 'stuck-1');
  await sleep(40);
  const next = api.run('after-crash', 'next-1');
  const reclaimed = await stuck;
  assert.equal(reclaimed.status, 504, 'the reclaimed turn reports its deadline instead of a silent reset');
  assert.equal((await reclaimed.json()).error.code, 'RUNTIME_TURN_TIMEOUT');
  const response = await next;
  assert.equal(response.status, 200);
  assert.equal(answerText(await response.json()), 'ok');
});

test('a full queue refuses only the overflow request and names the holder', async t => {
  const hold = deferred();
  const api = await setup(t, { runner: async request => { if (request.input === 'hold') await hold.promise; return { output: request.input }; },
    sessionAdmission: { queueLimit: 1, waitTimeoutMs: 4000, retryAfterMs: 2000 } });
  const holder = api.run('hold', 'hold-1');
  await sleep(40);
  const queued = api.run('waiting', 'wait-1');
  await sleep(40);
  const refused = await api.run('overflow', 'overflow-1');
  assert.equal(refused.status, 409);
  assert.equal(refused.headers.get('retry-after'), '2');
  const body = await refused.json();
  assert.equal(body.error.code, 'RUNTIME_SESSION_BUSY');
  assert.equal(body.error.detail.holder.requestId, 'hold-1');
  assert.equal(body.error.detail.queue.length, 1);
  assert.equal(body.error.detail.queue.limit, 1);
  assert.match(body.error.message, /hold-1/);
  hold.resolve();
  assert.equal((await holder).status, 200);
  assert.equal((await queued).status, 200);
});

test('a wait that expires is a readable 409 with the holder and the wait time', async t => {
  const hold = deferred();
  const api = await setup(t, { runner: async request => { if (request.input === 'hold') await hold.promise; return { output: request.input }; },
    sessionAdmission: { waitTimeoutMs: 60, retryAfterMs: 1000 } });
  const holder = api.run('hold', 'hold-1');
  await sleep(15);
  const refused = await api.run('too-late', 'late-1');
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.error.code, 'RUNTIME_SESSION_WAIT_TIMEOUT');
  assert.equal(body.error.detail.holder.requestId, 'hold-1');
  assert.equal(typeof body.error.detail.queue.oldestWaitMs, 'number');
  hold.resolve();
  assert.equal((await holder).status, 200);
});

test('a Session turn is not shared with another Session and releases cleanly', async t => {
  const api = await setup(t, { runner: async request => { await sleep(20); return { output: request.input }; } });
  const [a, b] = await Promise.all([api.run('a', 'a-1', 'session-a'), api.run('b', 'b-1', 'session-b')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await api.run('a2', 'a-2', 'session-a')).status, 200, 'a settled Session accepts the next turn');
});
