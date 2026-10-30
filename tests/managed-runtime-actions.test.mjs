import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedRuntimePrincipal } from '../src/managed-runtime-identity.mjs';
import { createManagedRuntimeActions } from '../src/managed-runtime-actions.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { readSse } from '../src/sse.mjs';
import { createManagedResourceIdentityResolver } from '../src/managed-resource-identity.mjs';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { bindDshAgentRoute, createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { createManagedResourceContext } from '../src/managed-resource-context.mjs';

const token = 'managed-action-component-private-token';
const ownerHeaders = subject => ({ 'x-agentengine-identity-namespace': 'business', 'x-agentengine-business-tenant-id': 'tenant',
  'x-agentengine-subject-type': 'user', 'x-agentengine-subject-id': subject });
const runtime = { identity: { agentId: 'ar-managed', versionId: 'version-1', manifestSha256: 'a'.repeat(64), runtimeName: 'dsh-native', runtimeVersion: 'studio-1' },
  declaration: { name: 'fixture' }, agent: {} };

async function setup(t, { onRun, withResourceContext, repairColdOpenTurn = false, runLog } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'managed-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = new Map(), live = new Map();
  let creates = 0, modelCalls = 0, flushed = 0, reads = 0, observationsDisposed = 0;
  const observedEvents = id => {
    const events = structuredClone(stored.get(id).events);
    // DSH cold observations balance interrupted turns in memory. The durable
    // read handle still returns the original shorter physical log.
    if (repairColdOpenTurn && !live.has(id) && events.some(event => event.type === 'turn/start')
      && events.at(-1)?.type !== 'turn/end') events.push({ type: 'turn/end', seq: events.length,
      time: events.at(-1).time + 1, data: { reason: { kind: 'interrupted' } } });
    return events;
  };
  const controller = {
    projections: async ({ sessionId }) => stored.has(sessionId) ? { kind: 'sequenced', asOfSeq: observedEvents(sessionId).length - 1,
      values: { sessionListMetadata: { lastPromptAt: stored.get(sessionId).events.findLast(event => event.type === 'user/message')?.time } } } : null,
    create: async ({ sessionId }) => { creates++; stored.set(sessionId, { header: { id: sessionId, createdAt: Date.now() }, events: [] }); live.set(sessionId, { id: sessionId }); return { sessionId }; },
    selectModel: async () => {}, cancel: () => {},
  };
  const persistence = {
    stat: async id => stored.has(id) ? { header: stored.get(id).header, formatStatus: 'current' } : undefined,
    open: async id => ({ header: stored.get(id).header, read: async (offset, length) => { reads++; return { events: stored.get(id).events.slice(offset, offset + length) }; }, close: async () => {} }),
  };
  const services = { sessionController: controller, sessionPersistence: persistence,
    sessionQuery: { observeSession: async id => {
      const events = observedEvents(id);
      return { header: stored.get(id).header, cursor: events.length - 1, events,
        [Symbol.dispose]: () => { observationsDisposed++; } };
    } },
    sessions: { get: id => live.get(id), flush: async () => { flushed++; return true; } }, agents: { withoutInitiator: work => work(), list: () => [] } };
  const ctx = { get: name => services[name] };
  const append = (id, entries) => {
    const events = stored.get(id).events;
    for (const event of entries) events.push({ ...event, seq: events.length, time: Date.now() + events.length });
  };
  const runner = async request => {
    const previous = stored.get(request.sessionId).events.find(event => event.type === 'user/message' && event.data.source.rpcId === request.occurrenceId);
    if (previous) {
      if (previous.data.content[0].text !== request.input) throw Object.assign(Error('conflict'), { code: 'RUNTIME_REQUEST_CONFLICT', status: 409 });
      return { output: `answer:${request.input}` };
    }
    await onRun?.(request);
    modelCalls++;
    if (request.input === 'pending') {
      append(request.sessionId, [{ type: 'turn/start', data: {} },
        { type: 'user/message', data: { source: { rpcId: request.occurrenceId }, content: [{ type: 'text', text: request.input }] } }]);
      return new Promise((_, reject) => {
        const stop = () => { append(request.sessionId, [{ type: 'turn/end', data: { reason: { kind: 'aborted' } } }]); reject(request.signal.reason); };
        if (request.signal.aborted) stop(); else request.signal.addEventListener('abort', stop, { once: true });
      });
    }
    append(request.sessionId, [
      { type: 'turn/start', data: { turn: modelCalls } },
      { type: 'user/message', data: { source: { rpcId: request.occurrenceId }, content: [{ type: 'text', text: request.input }] } },
      { type: 'assistant/attempt', data: { message: { content: [{ type: 'text', text: 'discarded' }] } } },
      { type: 'tool/call', data: { callId: 'call', name: 'lookup', arguments: '{}' } },
      { type: 'tool/result', data: { message: { source: { callId: 'call' }, content: [{ type: 'text', text: 'found' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'checked' }, { type: 'text', text: `answer:${request.input}` }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]);
    request.onFrame?.({ kind: 'assistant', value: { type: 'chunk', attemptId: 'one', chunk: { type: 'text-delta', index: 0, text: `answer:${request.input}` } } });
    request.onFrame?.({ kind: 'assistant', value: { type: 'end', attemptId: 'one', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
    return { output: `answer:${request.input}` };
  };
  let server;
  const start = async () => {
    const actions = await createManagedRuntimeActions({ ctx, runtime, model: 'model', models: ['model'], directory: root,
      admit: async () => ({ presetId: 'managed-preset' }) });
    server = await startBuildRuntimeHttp({ agentId: runtime.identity.agentId, managedIdentity: runtime.identity, platformActions: actions, token, runner, withResourceContext, runLog,
      model: 'model', port: 0, validatePrevious: async previous => {
        if (!stored.get(previous.sessionId)?.events.some(event => event.data?.source?.rpcId === previous.occurrenceId)) throw Object.assign(Error('absent'), { status: 404 });
      } });
  };
  await start(); t.after(() => server.close());
  const post = async (path, body, user = 'alice', extra = {}) => fetch(`http://127.0.0.1:${server.address.port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-agentengine-target-version-id': runtime.identity.versionId, 'x-agentengine-manifest-sha256': runtime.identity.manifestSha256,
      ...ownerHeaders(user), ...extra }, body: JSON.stringify(body),
  });
  const action = (name, body, user, extra) => post(`/agentengine/api/v1/${name}`, { AgentId: 'ar-managed', ...body }, user, extra);
  const run = (text, id, session = 'public-session', user = 'alice') => post('/v1/responses', { input: text, session_id: session, request_id: id }, user);
  return { action, post, run, stored, live, append, root, restart: async () => { await server.close(); await start(); },
    counts: () => ({ creates, modelCalls, flushed, reads, observationsDisposed }), services };
}

test('managed run logs use public session and invocation IDs with the deployed version', async t => {
  const logs = [];
  const api = await setup(t, { runLog: entry => logs.push(entry) });
  const response = await api.action('RunAgent', { SessionId: 'logs-public-session', InvocationId: 'logs-invocation',
    ResponsesInput: 'private-content', Stream: true });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert(body.includes('response.completed'));
  assert.deepEqual(logs.map(entry => entry.event), ['runtime.run.started', 'runtime.run.completed']);
  for (const entry of logs) {
    assert.equal(entry.agentId, runtime.identity.agentId);
    assert.equal(entry.versionId, runtime.identity.versionId);
    assert.equal(entry.runtimeName, runtime.identity.runtimeName);
    assert.equal(entry.sessionId, 'logs-public-session');
    assert.equal(entry.invocationId, 'logs-invocation');
  }
  assert(!JSON.stringify(logs).includes('private-content'));
});

test('managed history flush failure is logged as failure rather than completion', async t => {
  const logs = [];
  const api = await setup(t, { runLog: entry => logs.push(entry),
    onRun: () => { api.services.sessions.flush = async () => false; } });
  const response = await api.run('private-content', 'flush-failure');
  assert.equal(response.status, 503);
  assert.deepEqual(logs.map(entry => entry.event), ['runtime.run.started', 'runtime.run.failed']);
  assert.equal(logs[1].code, 'RUNTIME_SESSION_PERSISTENCE_REQUIRED');
});

test('cold interrupted history uses one canonical DSH observation without rewriting its physical log', async t => {
  const api = await setup(t, { repairColdOpenTurn: true });
  assert.equal((await api.run('answer committed before process exit', 'interrupted-run')).status, 200);
  const id = api.stored.keys().next().value;
  const raw = api.stored.get(id).events;
  assert.equal(raw.pop().type, 'turn/end');
  const physical = structuredClone(raw);
  api.live.clear();
  await api.restart();
  const response = await api.action('ListSessionEvents', { SessionId: 'public-session', Limit: 100 });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(result.Data.Events.filter(event => event.EventType === 'run_status').map(event => event.Metadata.status),
    ['in_progress', 'failed']);
  assert.ok(result.Data.Events.every(event => event.InvocationId === 'interrupted-run'));
  const messages = await api.action('ListSessionMessages', { SessionId: 'public-session' });
  assert.equal(messages.status, 200);
  assert.deepEqual((await messages.json()).Data.Messages.map(message => message.Role), ['user', 'assistant']);
  assert.deepEqual(api.stored.get(id).events, physical, 'a cold read must not write reconstructed closers to the native log');
  assert.equal(api.counts().modelCalls, 1, 'history reconstruction must not replay the interrupted business request');
  assert.equal(api.counts().observationsDisposed, 2, 'each canonical observation lease must be released');
});

test('real HTTP carries memory permits only inside each active runner, outside native input and history', async t => {
  const context = createManagedResourceContext({ ...runtime, declaration: { resources: { memory: { id: 'mem-test' } } } });
  const observed = [];
  const api = await setup(t, { withResourceContext: context.run, onRun: async request => {
    const grant = context.permit();
    assert.equal(JSON.stringify(request).includes('drp1.'), false);
    observed.push(JSON.parse(Buffer.from(grant.split('.')[1], 'base64url')).subject_digest);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(context.permit(), grant);
  } });
  const grants = Object.fromEntries(['alice', 'bob'].map(user => [user,
    `drp1.${Buffer.from(JSON.stringify({ format: 'agentengine.dsh-memory-permit/v1',
      agent_id: runtime.identity.agentId, version_id: runtime.identity.versionId,
      manifest_sha256: runtime.identity.manifestSha256, memory_id: 'mem-test',
      subject_digest: managedRuntimePrincipal(ownerHeaders(user)).digest,
      expires_at: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.${'f'.repeat(64)}`]));
  const results = await Promise.all(['alice', 'bob'].map(user => api.action('RunAgent', {
    SessionId: `permit-${user}`, InvocationId: `permit-${user}-1`, ResponsesInput: 'hello', Stream: false,
    UserId: 'forged', Metadata: { permit: 'forged' },
  }, user, { 'x-agentengine-resource-permit': grants[user] })));
  assert.ok(results.every(response => response.status === 200));
  assert.deepEqual(observed.sort(), ['alice', 'bob'].map(user => managedRuntimePrincipal(ownerHeaders(user)).digest).sort());
  assert.throws(() => context.permit(), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  assert.equal(JSON.stringify([...api.stored.values()]).includes('drp1.'), false);
  const rejected = await api.action('RunAgent', { SessionId: 'permit-missing', InvocationId: 'missing', ResponsesInput: 'hello' });
  assert.equal(rejected.status, 403);
  assert.equal(observed.length, 2);
});

test('managed data APIs require a complete trusted carrier; body user cannot impersonate it', async t => {
  const api = await setup(t);
  const headers = ownerHeaders('alice'); delete headers['x-agentengine-subject-id'];
  assert.throws(() => managedRuntimePrincipal(headers), { code: 'RUNTIME_TRUSTED_IDENTITY_REQUIRED' });
  assert.equal(managedRuntimePrincipal(ownerHeaders('alice')).userId, 'aeu_b69b45fb0384e1515da62eac2fc27a8f2137f9b9bc9dbc25f704a092a75a6e33', 'matches the Server/KsADK Python identity fixture');
  assert.throws(() => managedRuntimePrincipal({ ...ownerHeaders('alice'), 'x-agentengine-subject-id': 'x\nInjected' }), { code: 'RUNTIME_TRUSTED_IDENTITY_INVALID' });
  const missing = await api.post('/v1/responses', { input: 'hi', user: 'alice' }, 'alice', { 'x-agentengine-subject-id': '' });
  assert.equal(missing.status, 401); assert.equal(api.counts().creates, 0);
  const created = await (await api.action('CreateSession', { SessionId: 'public-session', UserId: 'forged' })).json();
  assert.equal(created.Code, 0); assert.equal(created.Data.Session.UserId, managedRuntimePrincipal(ownerHeaders('alice')).userId);
  assert.equal((await api.action('GetSession', { SessionId: 'public-session', UserId: 'alice' }, 'bob')).status, 404);
  assert.equal((await api.action('CreateSession', { SessionId: 'public-session', UserId: 'alice' }, 'bob')).status, 404);
  assert.equal((await api.action('GetSession', { SessionId: 'public-session', AgentId: 'other' })).status, 404);
  assert.equal((await api.action('CreateSession', { SessionId: '../unsafe' })).status, 400);
});

for (const profile of ['dsh-native', 'harness', 'codex']) {
  test(`managed HTTP -> durable owner -> ${profile} resource adapter ignores forged UserId across restart`, async t => {
    let resolveResourceUser;
    const identities = [];
    const api = await setup(t, { onRun: async request => {
      const bridge = createRuntimeBridge();
      bindDshAgentRoute(request.sessionId, { agentId: 'ar-managed', runtime: profile, local: true,
        nativeTools: true, agentRevision: 1, agent: { session: { header: { cwd: '/tmp/resource-http-fixture' } } } }, bridge);
      const adapter = createDshRuntimeAdapter({ bridge, resolveResourceUser,
        localHandler: async () => async (req, res) => {
          let raw = ''; for await (const chunk of req) raw += chunk;
          identities.push(JSON.parse(raw).userId);
          res.writeHead(200); res.end('data: {"runtimeEvent":{"event_type":"run.completed"}}\n\ndata: [DONE]\n\n');
        },
        codexResourceContext: async options => { identities.push(options.userId); return {}; },
        codexRuntime: { async *stream() { yield { type: 'text', text: 'fixture' }; } },
      });
      try {
        for await (const _chunk of adapter.stream({ sessionId: request.sessionId, userId: 'forged',
          metadata: { userId: 'forged' }, messages: [{ role: 'user', content: request.input }] })) {}
      } finally { bridge.close(); }
    } });
    const openResolver = () => createManagedResourceIdentityResolver({ runtime, directory: api.root });
    resolveResourceUser = await openResolver();
    const run = (session, user, id) => api.action('RunAgent', { SessionId: session, InvocationId: id,
      UserId: 'forged', ResponsesInput: 'memory lookup', Stream: false }, user);
    assert.equal((await run('alice-one', 'alice', 'a1')).status, 200);
    await api.restart(); resolveResourceUser = await openResolver();
    assert.equal((await run('alice-one', 'alice', 'a2')).status, 200);
    assert.equal((await run('alice-two', 'alice', 'a3')).status, 200);
    assert.equal((await run('bob-one', 'bob', 'b1')).status, 200);
    const before = identities.length;
    assert.equal((await run('alice-one', 'bob', 'stolen')).status, 404);
    assert.equal(identities.length, before);
    assert.deepEqual(identities, [
      ...Array(3).fill(managedRuntimePrincipal(ownerHeaders('alice')).userId),
      managedRuntimePrincipal(ownerHeaders('bob')).userId,
    ]);
  });
}

test('parallel creation is idempotent and a completed session is reused after HTTP/metadata reopen', async t => {
  const api = await setup(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => api.action('CreateSession', { SessionId: 'public-session' }).then(response => response.json())));
  assert.ok(results.every(result => result.Code === 0)); assert.equal(api.counts().creates, 1);
  const first = await (await api.run('one', 'first')).json();
  await api.restart();
  assert.equal((await api.action('CreateSession', { SessionId: 'public-session' })).status, 200);
  const replay = await (await api.run('one', 'first')).json();
  assert.equal(first.id, replay.id); assert.equal(api.counts().creates, 1); assert.equal(api.counts().modelCalls, 1);
  assert.equal((await api.run('changed', 'first')).status, 409);
});

test('Action streaming and Responses use the same native session; invocation mapping and body isolation survive reopen', async t => {
  const api = await setup(t);
  const response = await api.action('RunAgent', { Messages: [{ role: 'user', content: 'first' }], SessionId: 'public-session',
    InvocationId: 'public-invocation', Stream: true, ApiFormat: 'responses', UserId: 'spoofed' });
  assert.equal(response.status, 200);
  const frames = []; for await (const frame of readSse(response.body)) frames.push(frame);
  const completed = frames.find(frame => frame.type === 'response.completed');
  assert.equal(completed.response.output_text, 'answer:first');
  assert.equal(completed.response.session_id, 'public-session');
  assert.ok(completed.response.conversation.id.startsWith('conv_'));
  assert.ok(frames.some(frame => frame.type === 'response.output_text.delta'));
  await api.restart();
  const history = await (await api.action('ListSessionMessages', { SessionId: 'public-session', IncludeReasoning: true, IncludeToolEvents: true })).json();
  assert.deepEqual(history.Data.Messages.map(message => message.Role), ['user', 'assistant']);
  assert.deepEqual(history.Data.Messages.map(message => message.InvocationId), ['public-invocation', 'public-invocation']);
  assert.equal(history.Data.Messages[1].Reasoning[0].text, 'checked');
  assert.deepEqual(history.Data.Messages[1].ToolEvents, [{ Type: 'tool_call', SeqId: 4, ToolCallId: 'call', Name: 'lookup',
    Args: '{}', Status: 'completed', Result: 'found', ResultSeqId: 5 }]);
  assert.equal(JSON.stringify(history).includes('discarded'), false);
  assert.ok(api.counts().flushed >= 3);
  const continued = await api.post('/v1/responses', { input: 'next', previous_response_id: completed.response.id, request_id: 'next', user: 'another' });
  assert.equal(continued.status, 200); assert.equal(api.counts().creates, 1);
});

test('history pages preserve whole invocation groups and a fixed epoch/snapshot across new messages', async t => {
  const api = await setup(t);
  for (let index = 1; index <= 4; index++) assert.equal((await api.run(`question-${index}`, `invocation-${index}`)).status, 200);
  const first = (await (await api.action('ListSessionMessages', { SessionId: 'public-session', Limit: 2 })).json()).Data;
  assert.deepEqual(first.Messages.map(message => message.Content.text), ['question-4', 'answer:question-4']);
  assert.ok(first.HasMore); assert.equal(first.NextCursor, first.Messages[0].StartSeqId);
  assert.equal((await api.action('ListSessionMessages', { SessionId: 'public-session', BeforeSeqId: first.NextCursor })).status, 409);
  await api.run('question-5', 'invocation-5');
  const seen = [...first.Messages]; let page = first;
  while (page.HasMore) {
    page = (await (await api.action('ListSessionMessages', { SessionId: 'public-session', Limit: 2, BeforeSeqId: page.NextCursor,
      HistoryEpoch: first.HistoryEpoch, SnapshotSeqId: first.SnapshotSeqId })).json()).Data;
    seen.unshift(...page.Messages);
  }
  assert.equal(seen.length, 8); assert.equal(new Set(seen.map(message => message.MessageId)).size, 8);
  assert.equal(seen.some(message => message.Content.text.includes('question-5')), false);
  const forward = (await (await api.action('ListSessionMessages', { SessionId: 'public-session', Limit: 3, AfterSeqId: 0 })).json()).Data;
  assert.deepEqual(forward.Messages.map(message => message.Content.text), ['question-1', 'answer:question-1']);
  const next = (await (await api.action('ListSessionMessages', { SessionId: 'public-session', Limit: 2, AfterSeqId: forward.LatestSeqId,
    HistoryEpoch: forward.HistoryEpoch, SnapshotSeqId: forward.SnapshotSeqId })).json()).Data;
  assert.equal(next.Messages[0].Content.text, 'question-2');
  assert.equal((await api.action('ListSessionMessages', { SessionId: 'public-session', HistoryEpoch: 'stale' })).status, 409);
});

test('logical session deletion is durable, hidden from lists and rejects every old response handle', async t => {
  const api = await setup(t);
  const response = await (await api.run('first', 'first')).json();
  assert.equal((await api.action('DeleteSession', { SessionId: 'public-session' }, 'bob')).status, 404);
  const deleted = await (await api.action('DeleteSession', { SessionId: 'public-session' })).json();
  assert.equal(deleted.Data.Deleted, true); assert.equal(deleted.Data.RetainedNativeHistory, true);
  await api.restart();
  assert.equal((await api.action('GetSession', { SessionId: 'public-session' })).status, 404);
  assert.equal((await api.action('ListSessionMessages', { SessionId: 'public-session' })).status, 404);
  assert.equal((await api.run('again', 'second')).status, 409);
  assert.equal((await api.post('/v1/responses', { input: 'again', previous_response_id: response.id })).status, 404);
  assert.equal((await (await api.action('ListSessions', {})).json()).Data.Total, 0);
  assert.equal((await (await api.action('DeleteSession', { SessionId: 'public-session' })).json()).Data.Deleted, true);
  assert.equal(api.counts().modelCalls, 1);
});

test('lost native state cannot silently become a fresh empty conversation', async t => {
  const api = await setup(t);
  await api.run('first', 'first');
  const nativeId = api.stored.keys().next().value;
  api.stored.delete(nativeId); api.live.delete(nativeId);
  assert.equal((await api.run('next', 'next')).status, 503);
  assert.equal((await api.action('ListSessionMessages', { SessionId: 'public-session' })).status, 503);
  assert.equal(api.counts().creates, 1);
});

test('Hosted UI offset event pages expose the full frozen total without losing older events', async t => {
  const api = await setup(t);
  await api.run('first', 'first');
  await api.run('second', 'second');
  const read = async fields => {
    const response = await api.action('ListSessionEvents', { SessionId: 'public-session', ...fields });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.Data;
  };
  const full = await read({ Limit: 100 });
  const first = await read({ Offset: 0, Limit: 3 });
  assert.equal(first.Total, full.Events.length);
  assert.equal(first.Offset, 0); assert.equal(first.Limit, 3);
  const cursor = { HistoryEpoch: first.HistoryEpoch, SnapshotSeqId: first.SnapshotSeqId, CursorSource: first.CursorSource };
  await api.run('after snapshot', 'third');
  const pages = [];
  for (let offset = 0; offset < first.Total; offset += 3) {
    const page = await read({ ...cursor, Offset: offset, Limit: 3 });
    assert.equal(page.Total, first.Total);
    assert.equal(page.HasMore, offset + page.Events.length < first.Total);
    pages.push(...page.Events);
  }
  assert.deepEqual(pages, full.Events.toReversed());
  const empty = await read({ ...cursor, Offset: first.Total, Limit: 3 });
  assert.deepEqual(empty.Events, []); assert.equal(empty.HasMore, false);
  const filtered = await read({ ...cursor, Offset: 0, Limit: 1, EventTypes: ['assistant_message'] });
  assert.equal(filtered.Total, 2);
  assert.deepEqual(filtered.Events.map(event => event.InvocationId), ['second']);
  assert.equal((await api.action('ListSessionEvents', { SessionId: 'public-session', Offset: 1 })).status, 409);
});

test('explicit session sequence pages acknowledge the Server contract through an empty terminal page', async t => {
  const api = await setup(t);
  await api.run('first', 'first');
  const seen = []; let page, after = 0;
  do {
    const response = await api.action('ListSessionEvents', { SessionId: 'public-session', EventOrder: 'session_seq', Limit: 2,
      AfterSeqId: after, ...(page ? { HistoryEpoch: page.HistoryEpoch, SnapshotSeqId: page.SnapshotSeqId } : {}) });
    assert.equal(response.status, 200);
    page = (await response.json()).Data;
    assert.equal(page.EventOrder, 'session_seq');
    assert.equal(typeof page.HasMore, 'boolean');
    assert.ok(Number.isSafeInteger(page.NextCursor) && page.NextCursor > after);
    seen.push(...page.Events); after = page.NextCursor;
  } while (page.HasMore);
  assert.equal(seen.length, 6);
  const empty = (await (await api.action('ListSessionEvents', { SessionId: 'public-session', EventOrder: 'session_seq',
    AfterSeqId: after, HistoryEpoch: page.HistoryEpoch, SnapshotSeqId: page.SnapshotSeqId })).json()).Data;
  assert.deepEqual(empty.Events, []); assert.equal(empty.HasMore, false); assert.equal(empty.NextCursor, after);
});

test('explicit session sequence pages respect a BeforeSeqId upper bound', async t => {
  const api = await setup(t);
  await api.run('first', 'first');
  const full = (await (await api.action('ListSessionEvents', { SessionId: 'public-session' })).json()).Data;
  const read = async fields => {
    const response = await api.action('ListSessionEvents', { SessionId: 'public-session', EventOrder: 'session_seq',
      HistoryEpoch: full.HistoryEpoch, SnapshotSeqId: full.SnapshotSeqId, ...fields });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.Data;
  };
  assert.deepEqual((await read({ BeforeSeqId: 3 })).Events.map(event => event.SeqId), [1, 2]);
  const first = await read({ AfterSeqId: 1, BeforeSeqId: 6, Limit: 2 });
  assert.deepEqual(first.Events.map(event => event.SeqId), [2, 4]);
  assert.equal(first.NextCursor, 4); assert.equal(first.HasMore, true);
  const last = await read({ AfterSeqId: first.NextCursor, BeforeSeqId: 6, Limit: 2 });
  assert.deepEqual(last.Events.map(event => event.SeqId), [5]);
  assert.equal(last.NextCursor, 5); assert.equal(last.HasMore, false);
  const empty = await read({ AfterSeqId: last.NextCursor, BeforeSeqId: 6 });
  assert.deepEqual(empty.Events, []); assert.equal(empty.NextCursor, 5); assert.equal(empty.HasMore, false);
});

test('event reads retain public invocation/status identity and omit private native configuration', async t => {
  const api = await setup(t);
  await api.run('question', 'public-run');
  const id = api.stored.keys().next().value;
  api.append(id, [{ type: 'request/header', data: { credential: 'private-upstream' } }]);
  const result = await (await api.action('ListSessionEvents', { SessionId: 'public-session', Limit: 100, EventOrder: 'session_seq' })).json();
  assert.equal(result.Code, 0);
  assert.deepEqual(result.Data.Events.filter(event => event.EventType === 'run_status').map(event => event.Metadata.status), ['in_progress', 'completed']);
  assert.ok(result.Data.Events.every(event => event.InvocationId === 'public-run'));
  assert.equal(JSON.stringify(result).includes('private-upstream'), false);
  const filtered = await (await api.action('ListSessionEvents', { SessionId: 'public-session', EventTypes: ['assistant_message'] })).json();
  assert.deepEqual(filtered.Data.Events.map(event => event.EventType), ['assistant_message']);
  assert.equal((await api.action('ListSessionEvents', { SessionId: 'public-session', Offset: -1 })).status, 400);
  const bootstrap = (await (await api.action('GetAgentUiBootstrap', {})).json()).Data;
  assert.equal(bootstrap.Model.id, 'model'); assert.equal(bootstrap.HostedChat.Transports[0].Runtime, 'dsh');
  const catalog = (await (await api.action('ListAgentModels', {})).json()).Data;
  assert.equal(catalog.Current, 'model'); assert.equal(catalog.Models[0].id, 'model');
  // Unlike Messages, Events obey a hard event limit and may split a turn.
  const seen = []; let page;
  do {
    page = (await (await api.action('ListSessionEvents', { SessionId: 'public-session', Limit: 2, AfterSeqId: page?.LatestSeqId ?? 0,
      ...(page ? { HistoryEpoch: page.HistoryEpoch, SnapshotSeqId: page.SnapshotSeqId } : {}) })).json()).Data;
    assert.ok(page.Events.length <= 2); seen.push(...page.Events);
  } while (page.HasMore);
  assert.deepEqual(seen.map(event => event.EventId), result.Data.Events.map(event => event.EventId));
  const backward = []; let older;
  do {
    older = (await (await api.action('ListSessionEvents', { SessionId: 'public-session', Limit: 2,
      ...(older ? { BeforeSeqId: older.NextCursor, HistoryEpoch: older.HistoryEpoch, SnapshotSeqId: older.SnapshotSeqId } : {}) })).json()).Data;
    assert.ok(older.Events.length <= 2); backward.unshift(...older.Events);
  } while (older.HasMore);
  assert.deepEqual(backward.map(event => event.EventId), result.Data.Events.map(event => event.EventId));
});

test('history rejects a replaced native source and bounds an oversized invocation instead of fabricating empty success', async t => {
  const api = await setup(t);
  await api.run('question', 'first');
  const id = api.stored.keys().next().value;
  const record = api.stored.get(id);
  record.header.createdAt += 1000;
  assert.equal((await api.action('ListSessionMessages', { SessionId: 'public-session' })).status, 409);
  record.header.createdAt -= 1000;
  // Keep this one invocation open across many bounded native slices.
  record.events.pop();
  api.append(id, Array.from({ length: 8300 }, () => ({ type: 'step/start', data: {} })));
  api.append(id, [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]);
  const limited = await api.action('ListSessionMessages', { SessionId: 'public-session' });
  assert.equal(limited.status, 429); assert.equal((await limited.json()).ReasonCode, 'HISTORY_PROJECTION_BUDGET_EXCEEDED');
});

test('CancelRun validates the subject and invocation, and waits for native durability before its stream terminal', async t => {
  const api = await setup(t);
  await api.action('CreateSession', { SessionId: 'public-session' });
  let release, reached;
  const barrier = new Promise(accept => { release = accept; });
  const flushing = new Promise(accept => { reached = accept; });
  api.services.sessions.flush = async session => {
    if (api.stored.get(session.id).events.at(-1)?.data?.reason?.kind === 'aborted') { reached(); await barrier; }
    return true;
  };
  const response = await api.post('/v1/responses', { input: 'pending', session_id: 'public-session', request_id: 'pending', stream: true });
  const iterator = readSse(response.body)[Symbol.asyncIterator]();
  const initial = (await iterator.next()).value;
  assert.equal(initial.type, 'response.created');
  const concurrent = await api.run('another', 'another');
  assert.equal(concurrent.status, 409); assert.equal((await concurrent.json()).error.code, 'RUNTIME_SESSION_BUSY');
  assert.equal((await api.action('CancelRun', { SessionId: 'public-session', InvocationId: 'pending' }, 'bob')).status, 404);
  assert.equal((await api.action('CancelRun', { SessionId: 'public-session', InvocationId: 'wrong' })).status, 404);
  let ended = false;
  const remaining = (async () => { const frames = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) frames.push(event); ended = true; return frames; })();
  assert.equal((await api.action('CancelRun', { SessionId: 'public-session', InvocationId: 'pending' })).status, 200);
  await flushing;
  assert.equal(ended, false, 'native flush must settle before the terminal frame');
  release();
  const frames = await remaining;
  assert.ok(frames.some(event => event.type === 'response.canceled'));
  assert.equal(frames.some(event => event.type === 'response.completed'), false);
  const events = (await (await api.action('ListSessionEvents', { SessionId: 'public-session' })).json()).Data.Events;
  assert.equal(events.at(-1).Metadata.status, 'cancelled');
});
