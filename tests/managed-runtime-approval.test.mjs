import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedApprovalRegistry, hasManagedApprovalRun, requestManagedApproval } from '../src/managed-runtime-approval.mjs';
import { createManagedRuntimeActions } from '../src/managed-runtime-actions.mjs';
import { managedRuntimeBootstrap } from '../src/managed-runtime-capabilities.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';
import { currentBusinessInvocation } from '../src/providers/business-invocation-context.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createMcpLoopbackService } from './fixtures/mcp-loopback-service.mjs';
import { nativeMcpInvocation } from '../src/providers/native-mcp-invocation.mjs';

const token = 'managed-approval-component-private-token';
const ownerHeaders = subject => ({ 'x-agentengine-identity-namespace': 'business',
  'x-agentengine-business-tenant-id': 'tenant', 'x-agentengine-subject-type': 'user',
  'x-agentengine-subject-id': subject });
const runtime = { identity: { agentId: 'ar-managed', versionId: 'version-1', manifestSha256: 'a'.repeat(64),
  runtimeName: 'dsh-native', runtimeVersion: 'studio-1' }, declaration: { name: 'fixture' }, agent: {} };

function bridgeFixture({ timeoutMs } = {}) {
  const listeners = [];
  const ctx = { on: (name, handler, options) => { listeners.push({ name, handler, options });
    return () => { const index = listeners.indexOf(handler); if (index >= 0) listeners.splice(index, 1); }; } };
  const published = [], closed = [];
  const bridge = createManagedApprovalRegistry({ ctx, timeoutMs, now: () => 1700000000000 });
  const open = (overrides = {}) => bridge.begin({ runId: 'run_abc', sessionId: 'public-session',
    nativeSessionId: 'runtime-native', mode: 'ask', publish: item => published.push(item),
    publishDone: (id, decision, revision) => closed.push({ id, decision, revision }), ...overrides });
  const ask = (request = {}) => listeners.find(entry => entry.name === 'approval/request').handler({
    agent: { session: { id: 'runtime-native' } }, toolName: 'bash', callId: 'call-1', reason: 'network', ...request,
  }, () => Promise.resolve('unavailable'));
  return { bridge, open, ask, published, closed, listeners };
}

test('managed bootstrap declares only the approval surface the Host implements', () => {
  const bootstrap = managedRuntimeBootstrap(runtime, 'model');
  assert.equal(bootstrap.Capabilities.Approval, true);
  assert.deepEqual(bootstrap.Capabilities.ApprovalPolicy, { Modes: ['ask', 'risk'], DefaultMode: 'risk', RuntimeOverride: true });
  assert.equal(bootstrap.Capabilities.InteractionV1, true);
  assert.equal(bootstrap.Capabilities.interaction_v1.enabled, true);
  assert.equal(bootstrap.Capabilities.RuntimeCapabilityMatrix.submit_interaction.supported, true);
  // Pause and resume are still unimplemented; declaring them would advertise a
  // surface whose Action the Host rejects.
  assert.equal(bootstrap.Capabilities.RuntimeCapabilityMatrix.pause.supported, false);
  assert.equal(bootstrap.Capabilities.RuntimeCapabilityMatrix.resume.supported, false);
  assert.equal(bootstrap.Capabilities.RunLifecycle.Resume, false);
  assert.equal(bootstrap.Capabilities.RuntimeCapabilities.ResumeRun.Supported, false);
  assert.equal(bootstrap.Capabilities.ResumeRun, false);
});

test('an approval ask becomes an mcp_approval_request and approve releases the DSH wait', async () => {
  const fixture = bridgeFixture();
  const run = fixture.open();
  assert.equal(run.policy, 'ask');
  const outcome = fixture.ask();
  assert.deepEqual(fixture.published.map(item => [item.type, item.name, item.run_id, item.session_id]),
    [['mcp_approval_request', 'bash', 'run_abc', 'public-session']]);
  const interactionId = fixture.published[0].id;
  assert.match(interactionId, /^appr_[a-f0-9]{32}$/);
  const receipt = fixture.bridge.resolve({ sessionId: 'public-session', nativeSessionId: 'runtime-native',
    runId: 'run_abc', interactionId, expectedRevision: 1, action: 'approve', response: { decision: 'approve' },
    idempotencyKey: 'interaction-1' });
  assert.equal(await outcome, 'allowed-once');
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.decision, 'approved');
  assert.equal(receipt.revision, 2);
  assert.equal(receipt.interaction_id, interactionId);
  assert.equal(receipt.run_id, 'run_abc');
  assert.deepEqual(fixture.closed, [{ id: interactionId, decision: 'approved', revision: 2 }]);
});

test('reject fails the DSH wait closed and the receipt is idempotent', async () => {
  const fixture = bridgeFixture();
  fixture.open();
  const outcome = fixture.ask();
  const interactionId = fixture.published[0].id;
  const request = { sessionId: 'public-session', nativeSessionId: 'runtime-native', runId: 'run_abc',
    interactionId, expectedRevision: 1, action: 'reject', response: { decision: 'reject' }, idempotencyKey: 'decision-1' };
  const receipt = fixture.bridge.resolve(request);
  assert.equal(await outcome, 'rejected');
  assert.equal(receipt.decision, 'rejected');
  const replay = fixture.bridge.resolve(request);
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.decision, 'rejected');
  assert.equal(fixture.closed.length, 1, 'a replayed decision must not settle the interaction twice');
});

test('unknown, foreign, stale and conflicting decisions stay distinguishable', async () => {
  const fixture = bridgeFixture();
  fixture.open();
  const outcome = fixture.ask();
  const interactionId = fixture.published[0].id;
  const base = { sessionId: 'public-session', nativeSessionId: 'runtime-native', runId: 'run_abc',
    interactionId, expectedRevision: 1, action: 'approve' };
  assert.throws(() => fixture.bridge.resolve({ ...base, interactionId: 'appr_' + '0'.repeat(32) }),
    { code: 'RUNTIME_INTERACTION_NOT_FOUND', status: 404 });
  assert.throws(() => fixture.bridge.resolve({ ...base, sessionId: 'other-session' }),
    { code: 'RUNTIME_INTERACTION_NOT_FOUND', status: 404 });
  assert.throws(() => fixture.bridge.resolve({ ...base, nativeSessionId: 'runtime-other' }),
    { code: 'RUNTIME_INTERACTION_NOT_FOUND', status: 404 });
  assert.throws(() => fixture.bridge.resolve({ ...base, runId: 'run_other' }),
    { code: 'RUNTIME_INTERACTION_NOT_FOUND', status: 404 });
  assert.throws(() => fixture.bridge.resolve({ ...base, expectedRevision: 2 }),
    { code: 'RUNTIME_INTERACTION_REVISION_CONFLICT', status: 409 });
  assert.throws(() => fixture.bridge.resolve({ ...base, action: 'submit' }),
    { code: 'RUNTIME_INTERACTION_ACTION_UNSUPPORTED', status: 400 });
  assert.throws(() => fixture.bridge.resolve({ ...base, response: { decision: 'reject' } }),
    { code: 'RUNTIME_INTERACTION_RESPONSE_INVALID', status: 400 });
  assert.equal(fixture.bridge.resolve(base).decision, 'approved');
  assert.equal(await outcome, 'allowed-once');
  assert.throws(() => fixture.bridge.resolve({ ...base, idempotencyKey: 'second-key' }),
    { code: 'RUNTIME_INTERACTION_ALREADY_RESOLVED', status: 409 });
});

test('closing a run cancels its pending asks and a non-interactive run keeps the fail-closed chain', async () => {
  const fixture = bridgeFixture();
  const run = fixture.open();
  const outcome = fixture.ask();
  run.close();
  assert.equal(await outcome, 'cancelled');
  assert.deepEqual(fixture.closed, [{ id: fixture.published[0].id, decision: 'cancelled', revision: 2 }]);
  assert.deepEqual(fixture.bridge.snapshot(), { runs: 0, pending: 0, settled: 1 });
  assert.equal(fixture.open({ mode: 'never' }), null);
  const live = fixture.open();
  assert.ok(live);
  assert.equal(fixture.bridge.begin({ runId: 'run_def', sessionId: 'public-session',
    nativeSessionId: 'runtime-native', mode: 'ask', publish: () => {} }), null,
  'a second interactive run cannot share the same native session');
  live.close();
});

test('an approval timeout settles the interaction as cancelled', async () => {
  const fixture = bridgeFixture({ timeoutMs: 1000 });
  fixture.open();
  const outcome = fixture.ask();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fixture.closed.length, 0);
  fixture.bridge.dispose();
  assert.equal(await outcome, 'cancelled');
});

async function httpFixture(t, { onRun, mcp = false, env } = {}) {
  const runtimeConfig = mcp ? { ...runtime, declaration: { ...runtime.declaration, resources: { mcp_servers: [{ id: 'fixture-mcp' }] } } } : runtime;
  const root = await mkdtemp(join(tmpdir(), 'managed-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = new Map(), live = new Map(), listeners = [];
  const controller = {
    projections: async ({ sessionId }) => stored.has(sessionId) ? { kind: 'sequenced',
      asOfSeq: stored.get(sessionId).events.length - 1, values: { sessionListMetadata: {} } } : null,
    create: async ({ sessionId }) => { stored.set(sessionId, { header: { id: sessionId, createdAt: Date.now() }, events: [] });
      live.set(sessionId, { id: sessionId }); return { sessionId }; },
    selectModel: async () => {}, cancel: () => {},
  };
  const persistence = { stat: async id => stored.has(id) ? { header: stored.get(id).header, formatStatus: 'current' } : undefined,
    open: async id => ({ header: stored.get(id).header, read: async (offset, length) => ({ events: stored.get(id).events.slice(offset, offset + length) }), close: async () => {} }) };
  const services = { sessionController: controller, sessionPersistence: persistence,
    sessions: { get: id => live.get(id), flush: async () => true }, agents: { withoutInitiator: work => work(), list: () => [] },
    sessionQuery: { observeSession: async id => ({ header: stored.get(id).header, cursor: stored.get(id).events.length - 1,
      events: stored.get(id).events, [Symbol.dispose]: () => {} }) } };
  const ctx = { get: name => services[name], on: (name, handler) => { if (name === 'approval/request') listeners.push(handler); return () => {}; } };
  const approval = createManagedApprovalRegistry({ ctx, timeoutMs: 5000 });
  const append = (id, entries) => { const events = stored.get(id).events;
    for (const event of entries) events.push({ ...event, seq: events.length, time: Date.now() + events.length }); };
  const runner = async request => {
    if (request.input === 'needs-approval') {
      assert.equal(request.approvalPolicy, 'ask');
      const outcome = await listeners[0]({ agent: { session: { id: request.sessionId } },
        toolName: 'bash', callId: 'call-1', reason: 'network' }, () => Promise.resolve('unavailable'));
      append(request.sessionId, [{ type: 'turn/start', data: {} },
        { type: 'user/message', data: { source: { rpcId: request.occurrenceId }, content: [{ type: 'text', text: request.input }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `outcome:${outcome}` }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }]);
      return { output: `outcome:${outcome}` };
    }
    await onRun?.(request);
    append(request.sessionId, [{ type: 'turn/start', data: {} },
      { type: 'user/message', data: { source: { rpcId: request.occurrenceId }, content: [{ type: 'text', text: request.input }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'plain answer' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } }]);
    return { output: 'plain answer' };
  };
  const actions = await createManagedRuntimeActions({ ctx, runtime: runtimeConfig, model: 'model', models: ['model'],
    directory: root, admit: async () => ({ presetId: 'managed-preset' }), approval, env: env ?? {} });
  const server = await startBuildRuntimeHttp({ agentId: runtimeConfig.identity.agentId, managedIdentity: runtimeConfig.identity,
    platformActions: actions, token, runner, approval, model: 'model', port: 0, runLog: () => {},
    validatePrevious: async () => {} });
  t.after(() => { approval.dispose(); return server.close(); });
  const base = `http://127.0.0.1:${server.address.port}`;
  const headers = user => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-agentengine-target-version-id': runtime.identity.versionId,
    'x-agentengine-manifest-sha256': runtime.identity.manifestSha256, ...ownerHeaders(user) });
  return { server, approval, base, headers, stored,
    action: (name, body, user = 'alice') => fetch(`${base}/agentengine/api/v1/${name}`,
      { method: 'POST', headers: headers(user), body: JSON.stringify({ AgentId: 'ar-managed', ...body }) }),
    runAgent: (body, user = 'alice') => fetch(`${base}/agentengine/api/v1/RunAgent`,
      { method: 'POST', headers: headers(user), body: JSON.stringify({ AgentId: 'ar-managed', Stream: true, ApiFormat: 'responses', ...body }) }) };
}

async function readUntil(response, predicate, timeoutMs = 8000) {
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const match = predicate(text);
    if (match) return { text, match, reader, decoder };
  }
  throw new Error(`stream did not reach the expected frame: ${text.slice(0, 2000)}`);
}

async function readRest(reader, decoder) {
  let text = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('RunAgent binds business UserId and SessionId in private Runtime context', async t => {
  let seen;
  const api = await httpFixture(t, { onRun: async request => {
    seen = currentBusinessInvocation();
    assert.equal(request.input, 'business turn');
    assert.equal(request.sessionId, seen.nativeSessionId);
  } });
  const response = await api.runAgent({ SessionId: 'business-session', UserId: 'customer@example.com',
    InvocationId: 'business-run-1', ResponsesInput: 'business turn' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen.contract, 'agentkit.business-invocation/v1');
  assert.equal(seen.userId, 'customer@example.com');
  assert.equal(seen.sessionId, 'business-session');
  assert.equal(seen.requestId, 'business-run-1');
  assert.equal(seen.agentId, 'ar-managed');
  assert.match(seen.businessDigest, /^[a-f0-9]{64}$/);
  assert.match(seen.nativeSessionId, /^runtime-/);
  assert.ok(!JSON.stringify(api.stored).includes('customer@example.com'), 'business identity must not enter DSH transcript');
  assert.equal(currentBusinessInvocation(), null, 'request context must not leak after RunAgent returns');
  const conflict = await api.runAgent({ SessionId: 'business-session', UserId: 'other@example.com',
    InvocationId: 'business-run-2', ResponsesInput: 'another turn' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).ReasonCode, 'RUNTIME_BUSINESS_SESSION_CONFLICT');
});

test('a deployment can require business UserId and SessionId for MCP bindings', async t => {
  const api = await httpFixture(t, { mcp: true, env: { AGENTKIT_MCP_BUSINESS_IDENTITY: 'require' } });
  const missing = await api.runAgent({ SessionId: 'mcp-session', ResponsesInput: 'hello' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).ReasonCode, 'RUNTIME_BUSINESS_ID_REQUIRED');
  const missingSession = await api.runAgent({ UserId: 'biz-user', ResponsesInput: 'hello' });
  assert.equal(missingSession.status, 400);
  assert.equal((await missingSession.json()).ReasonCode, 'RUNTIME_BUSINESS_ID_REQUIRED');
  const valid = await api.runAgent({ SessionId: 'mcp-session', UserId: 'biz-user', InvocationId: 'mcp-run-1', ResponsesInput: 'hello' });
  assert.equal(valid.status, 200);
  await valid.text();
});

test('without the opt-in, MCP bindings keep accepting callers that never send UserId', async t => {
  let seen = 'unset';
  const api = await httpFixture(t, { mcp: true, onRun: async () => { seen = currentBusinessInvocation(); } });
  const response = await api.runAgent({ SessionId: 'legacy-session', ResponsesInput: 'hello' });
  assert.equal(response.status, 200);
  await response.text();
  // Existing Agents with MCP bindings keep working: the platform correlation ids
  // still reach MCP, but no business user is invented for a caller that never
  // claimed one.
  assert.equal(seen.userId, undefined);
  assert.equal(seen.sessionId, 'legacy-session');
  assert.equal(typeof seen.requestId, 'string');
  assert.equal(typeof seen.businessDigest, 'string', 'the named session still separates replay fingerprints');
});

test('a direct Responses caller cannot claim a business identity', async t => {
  let seen = 'unset';
  const api = await httpFixture(t, { mcp: true, onRun: async () => { seen = currentBusinessInvocation(); } });
  // The private RunAgent sidecar is Host authority: a direct /v1/responses
  // caller must not be able to mint one, and its public session_id is not a
  // business session.
  const response = await fetch(`${api.base}/v1/responses`, { method: 'POST', headers: api.headers('alice'),
    body: JSON.stringify({ input: 'hello', session_id: 'platform-session', request_id: 'direct-1',
      __agentkit_business_user_id: 'forged@example.com', __agentkit_business_session_id: 'forged-session' }) });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen.userId, undefined);
  assert.equal(seen.sessionId, undefined);
});

test('omitting RunAgent SessionId never substitutes the platform session', async t => {
  const seen = [];
  const service = await createMcpLoopbackService({ transport: 'http', getCredential: () => 'loopback-token',
    onCall: (request, extra) => { seen.push({ meta: request.params._meta, headers: extra?.requestInfo?.headers }); } });
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: 'loopback-token' }) } });
  t.after(async () => { await adapters.close(); await service.close(); });
  const api = await httpFixture(t, { mcp: true, onRun: async request => {
    assert.equal(currentBusinessInvocation().userId, 'customer@example.com');
    assert.equal(currentBusinessInvocation().sessionId, undefined, 'no business session was named');
    await adapters.callMcpTool({ resourceId: 'fixture-mcp', endpointUrl: service.endpoint,
      transport: 'http', envRefs: { Authorization: 'env://MCP_LOOPBACK_TOKEN' } }, service.toolName, {},
    { invocation: nativeMcpInvocation({ scope: { userId: 'aeu_platform' }, agent: { session: { id: request.sessionId } },
      agentId: 'ar-managed', runId: 'run-1', callId: 'call-1' }) });
  } });
  const response = await api.runAgent({ UserId: 'customer@example.com', ResponsesInput: 'hello' });
  assert.equal(response.status, 200);
  await response.text();
  const meta = seen[0].meta['io.agentkit.studio/invocation'];
  assert.equal(meta.businessUserId, 'customer@example.com');
  // The platform session is not silently relabelled as the business session.
  assert.equal(Object.hasOwn(meta, 'businessSessionId'), false);
  assert.equal(Object.hasOwn(seen[0].headers, 'x-agentkit-business-session-id'), false);
});

test('omitting RunAgent InvocationId derives a platform request id for the business invocation', async t => {
  const seen = [];
  const api = await httpFixture(t, { mcp: true, onRun: async () => { seen.push(currentBusinessInvocation()); } });
  const response = await api.runAgent({ SessionId: 'no-invocation', UserId: 'customer@example.com', ResponsesInput: 'hello' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen[0].sessionId, 'no-invocation');
  // businessInvocationId is never empty: it carries the platform request id.
  assert.match(seen[0].requestId, /^[0-9a-f-]{36}$/);
});

test('a real RunAgent HTTP turn reaches a real MCP server with both identities', async t => {
  const seen = [];
  const service = await createMcpLoopbackService({ transport: 'http', getCredential: () => 'loopback-token',
    onCall: (request, extra) => { seen.push({ meta: request.params._meta, headers: extra?.requestInfo?.headers }); } });
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: 'loopback-token' }) } });
  t.after(async () => { await adapters.close(); await service.close(); });
  const api = await httpFixture(t, { mcp: true, onRun: async request => {
    // The Native tool seam composes the identity from the live Session and the
    // private RunAgent context; the model never supplies either value.
    assert.equal(currentBusinessInvocation()?.userId, 'customer@example.com');
    assert.equal(currentBusinessInvocation()?.sessionId, 'business-session-42');
    await adapters.callMcpTool({ resourceId: 'fixture-mcp', endpointUrl: service.endpoint,
      transport: 'http', envRefs: { Authorization: 'env://MCP_LOOPBACK_TOKEN' } }, service.toolName, {},
    { invocation: nativeMcpInvocation({ scope: { tenantId: 'tenant', workspaceId: 'workspace', userId: 'aeu_platform' },
      agent: { session: { id: request.sessionId } }, agentId: 'ar-managed',
      runId: 'run-1', callId: 'call-1' }) });
  } });
  const response = await api.runAgent({ SessionId: 'business-session-42', UserId: 'customer@example.com',
    InvocationId: 'request-1001', ResponsesInput: 'hello' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen.length, 1);
  const meta = seen[0].meta['io.agentkit.studio/invocation'];
  // Platform/native identity is preserved; business identity is added beside it.
  assert.equal(meta.userId, 'aeu_platform');
  assert.equal(meta.businessUserId, 'customer@example.com');
  assert.equal(meta.businessSessionId, 'business-session-42');
  assert.equal(meta.businessInvocationId, 'request-1001');
  assert.notEqual(meta.sessionId, 'business-session-42', 'native session is not replaced by the business session');
  assert.equal(seen[0].headers['x-agentkit-business-user-id'], 'customer@example.com');
  assert.equal(seen[0].headers['x-agentkit-business-session-id'], 'business-session-42');
  assert.equal(seen[0].headers.authorization, 'Bearer loopback-token', 'MCP credentials stay untouched');
});

test('managed HTTP presents an approval item and SubmitInteraction approve lets the run finish', async t => {
  const api = await httpFixture(t);
  const bootstrap = await (await api.action('GetAgentUiBootstrap', { Name: 'fixture' })).json();
  assert.equal(bootstrap.Data.Capabilities.Approval, true);
  assert.deepEqual(bootstrap.Data.Capabilities.ApprovalPolicy.Modes, ['ask', 'risk']);
  assert.equal(bootstrap.Data.Capabilities.InteractionV1, true);
  const response = await api.runAgent({ SessionId: 'approval-session', InvocationId: 'approval-run-1',
    ResponsesInput: 'needs-approval', Metadata: { agentengine: { tool_approval_mode: 'ask' } } });
  assert.equal(response.status, 200);
  const first = await readUntil(response, text => /"mcp_approval_request"/.test(text));
  const frames = first.text.split('\n\n').filter(Boolean);
  const added = frames.find(frame => frame.startsWith('event: response.output_item.added')
    && frame.includes('mcp_approval_request'));
  assert.ok(added, first.text);
  const payload = JSON.parse(added.split('data: ')[1]);
  assert.equal(payload.item.type, 'mcp_approval_request');
  assert.equal(payload.item.name, 'bash');
  assert.match(payload.item.id, /^appr_[a-f0-9]{32}$/);
  assert.equal(payload.item.session_id, 'approval-session');
  assert.match(payload.run_id, /^run_[a-f0-9]{32}$/);
  assert.equal(payload.item.run_id, payload.run_id);
  const submitted = await (await api.action('SubmitInteraction', { SessionId: 'approval-session',
    RunId: payload.run_id, InteractionId: payload.item.id, ExpectedRevision: 1, Action: 'approve',
    Response: { decision: 'approve' }, IdempotencyKey: 'approval-key-1' })).json();
  assert.equal(submitted.Code, 0, JSON.stringify(submitted));
  assert.equal(submitted.Data.status, 'accepted');
  assert.equal(submitted.Data.decision, 'approved');
  assert.equal(submitted.Data.run_id, payload.run_id);
  assert.equal(submitted.Data.command_id, `interaction:${payload.item.id}:revision-1`);
  const rest = await readRest(first.reader, first.decoder);
  assert.match(rest, /event: response\.approval_resolved/);
  assert.match(rest, /"decision":"approved"/);
  assert.match(rest, /event: response\.output_item\.done/);
  assert.match(rest, /"type":"mcp_approval_request"/);
  assert.match(rest, /event: response\.completed/);
  assert.match(rest, /"output_text":"outcome:allowed-once"/);
});

test('managed HTTP reject denies the tool and keeps the stream terminally complete', async t => {
  const api = await httpFixture(t);
  const response = await api.runAgent({ SessionId: 'deny-session', InvocationId: 'deny-run-1',
    ResponsesInput: 'needs-approval', Metadata: { agentengine: { tool_approval_mode: 'risk' } } });
  const first = await readUntil(response, text => /"mcp_approval_request"/.test(text));
  const payload = JSON.parse(first.text.split('\n\n').find(frame => frame.includes('mcp_approval_request')).split('data: ')[1]);
  const submitted = await (await api.action('SubmitInteraction', { SessionId: 'deny-session',
    RunId: payload.run_id, InteractionId: payload.item.id, ExpectedRevision: 1, Action: 'reject',
    Response: { decision: 'reject' }, IdempotencyKey: 'deny-key-1' })).json();
  assert.equal(submitted.Code, 0, JSON.stringify(submitted));
  assert.equal(submitted.Data.decision, 'rejected');
  const rest = await readRest(first.reader, first.decoder);
  assert.match(rest, /"decision":"rejected"/);
  assert.match(rest, /"output_text":"outcome:rejected"/);
  // A second decision for the same interaction is a distinct platform error.
  const duplicate = await api.action('SubmitInteraction', { SessionId: 'deny-session', RunId: payload.run_id,
    InteractionId: payload.item.id, ExpectedRevision: 1, Action: 'approve', IdempotencyKey: 'deny-key-2' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).ReasonCode, 'RUNTIME_INTERACTION_ALREADY_RESOLVED');
});

test('a caller idempotency key reused by another session does not replay that receipt', async t => {
  const api = await httpFixture(t);
  const [responseA, responseB] = await Promise.all([
    api.runAgent({ SessionId: 'key-scope-session-a', InvocationId: 'key-scope-run-a',
      ResponsesInput: 'needs-approval', Metadata: { agentengine: { tool_approval_mode: 'ask' } } }),
    api.runAgent({ SessionId: 'key-scope-session-b', InvocationId: 'key-scope-run-b',
      ResponsesInput: 'needs-approval', Metadata: { agentengine: { tool_approval_mode: 'risk' } } }),
  ]);
  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  const itemOf = text => JSON.parse(text.split('\n\n')
    .find(frame => frame.includes('mcp_approval_request')).split('data: ')[1]);
  const [firstA, firstB] = await Promise.all([
    readUntil(responseA, text => /"mcp_approval_request"/.test(text)),
    readUntil(responseB, text => /"mcp_approval_request"/.test(text)),
  ]);
  const itemA = itemOf(firstA.text), itemB = itemOf(firstB.text);
  // The same caller-chosen key is forwarded verbatim for both sessions.
  const submit = (sessionId, item, action) => api.action('SubmitInteraction', { SessionId: sessionId,
    RunId: item.run_id, InteractionId: item.item.id, ExpectedRevision: 1, Action: action,
    Response: { decision: action }, IdempotencyKey: 'caller-shared-key' });
  const submittedA = await (await submit('key-scope-session-a', itemA, 'approve')).json();
  assert.equal(submittedA.Code, 0, JSON.stringify(submittedA));
  assert.equal(submittedA.Data.status, 'accepted');
  const submittedB = await (await submit('key-scope-session-b', itemB, 'reject')).json();
  assert.equal(submittedB.Code, 0, JSON.stringify(submittedB));
  // Session B resolves its own interaction; it never sees session A's receipt.
  assert.equal(submittedB.Data.status, 'accepted');
  assert.equal(submittedB.Data.session_id, 'key-scope-session-b');
  assert.equal(submittedB.Data.run_id, itemB.run_id);
  assert.equal(submittedB.Data.interaction_id, itemB.item.id);
  assert.equal(submittedB.Data.decision, 'rejected');
  assert.equal(submittedB.Data.duplicate, undefined);
  const [restA, restB] = await Promise.all([
    readRest(firstA.reader, firstA.decoder), readRest(firstB.reader, firstB.decoder)]);
  assert.match(restA, /"output_text":"outcome:allowed-once"/);
  assert.match(restB, /"output_text":"outcome:rejected"/);
});

test('managed HTTP rejects approval modes it cannot present and foreign submissions', async t => {
  const api = await httpFixture(t);
  const sync = await api.runAgent({ SessionId: 'sync-session', InvocationId: 'sync-run-1',
    ResponsesInput: 'needs-approval', Stream: false, Metadata: { agentengine: { tool_approval_mode: 'ask' } } });
  assert.equal(sync.status, 400);
  assert.equal((await sync.json()).ReasonCode, 'RUNTIME_APPROVAL_STREAM_REQUIRED');
  const missing = await api.action('SubmitInteraction', { SessionId: 'never-created-session',
    RunId: 'run_' + '0'.repeat(32), InteractionId: 'appr_' + '1'.repeat(32), ExpectedRevision: 1,
    Action: 'approve', Response: {}, IdempotencyKey: 'unknown-key' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).ReasonCode, 'RUNTIME_SESSION_NOT_FOUND');
  const unknown = await api.action('SubmitInteraction', { SessionId: 'sync-session',
    RunId: 'run_' + '0'.repeat(32), InteractionId: 'appr_' + '1'.repeat(32), ExpectedRevision: 1,
    Action: 'approve', Response: {}, IdempotencyKey: 'unknown-key-2' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).ReasonCode, 'RUNTIME_INTERACTION_NOT_FOUND');
  // Another principal can not reach the session at all.
  const foreign = await api.action('SubmitInteraction', { SessionId: 'sync-session',
    RunId: 'run_' + '0'.repeat(32), InteractionId: 'appr_' + '1'.repeat(32), ExpectedRevision: 1,
    Action: 'approve', Response: {}, IdempotencyKey: 'foreign-key' }, 'bob');
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).ReasonCode, 'RUNTIME_SESSION_NOT_FOUND');
});

test('managed HTTP accepts one Responses mcp_approval_response as the compatibility decision', async t => {
  const api = await httpFixture(t);
  const response = await api.runAgent({ SessionId: 'compat-session', InvocationId: 'compat-run-1',
    ResponsesInput: 'needs-approval', Metadata: { agentengine: { tool_approval_mode: 'ask' } } });
  const first = await readUntil(response, text => /"mcp_approval_request"/.test(text));
  const payload = JSON.parse(first.text.split('\n\n').find(frame => frame.includes('mcp_approval_request')).split('data: ')[1]);
  const resume = await api.runAgent({ SessionId: 'compat-session', InvocationId: 'compat-run-2',
    ResponsesInput: [{ type: 'mcp_approval_response', approval_request_id: payload.item.id, approve: true }] });
  assert.equal(resume.status, 200);
  const resumed = await resume.text();
  assert.match(resumed, /event: response\.approval_resolved/);
  assert.match(resumed, /"decision":"approved"/);
  assert.match(resumed, /event: response\.completed/);
  const rest = await readRest(first.reader, first.decoder);
  assert.match(rest, /"output_text":"outcome:allowed-once"/);
});

test('external provider asks present an interaction and approve releases the wait', async () => {
  const fixture = bridgeFixture();
  const run = fixture.open();
  assert.equal(run.policy, 'ask');
  const pending = fixture.bridge.request({ sessionId: 'public-session', nativeSessionId: 'runtime-native',
    toolName: 'codex/command', callId: 'item-cmd', reason: 'write marker' });
  assert.ok(pending instanceof Promise);
  assert.deepEqual(fixture.published.map(item => [item.type, item.name, item.call_id, item.reason, item.run_id, item.session_id]),
    [['mcp_approval_request', 'codex/command', 'item-cmd', 'write marker', 'run_abc', 'public-session']]);
  const receipt = fixture.bridge.resolve({ sessionId: 'public-session', nativeSessionId: 'runtime-native',
    runId: 'run_abc', interactionId: fixture.published[0].id, expectedRevision: 1, action: 'approve',
    idempotencyKey: 'external-approve-1' });
  assert.equal(await pending, 'allowed-once');
  assert.equal(receipt.decision, 'approved');
  fixture.bridge.dispose();
});

test('external provider asks can be rejected and a closed run cancels them', async () => {
  const fixture = bridgeFixture();
  fixture.open();
  const rejected = fixture.bridge.request({ nativeSessionId: 'runtime-native',
    toolName: 'codex/permissions', callId: 'item-perm', reason: 'network' });
  const rejectedId = fixture.published[0].id;
  fixture.bridge.resolve({ sessionId: 'public-session', nativeSessionId: 'runtime-native',
    runId: 'run_abc', interactionId: rejectedId, expectedRevision: 1, action: 'reject' });
  assert.equal(await rejected, 'rejected');
  const cancelled = fixture.bridge.request({ nativeSessionId: 'runtime-native',
    toolName: 'codex/file-change', callId: 'call-patch', reason: 'patch' });
  assert.equal(fixture.bridge.snapshot().pending, 1);
  fixture.bridge.close('run_abc');
  assert.equal(await cancelled, 'cancelled');
  assert.deepEqual(fixture.closed.at(-1), { id: fixture.published[1].id, decision: 'cancelled', revision: 2 });
  assert.equal(fixture.bridge.request({ nativeSessionId: 'runtime-native', toolName: 'codex/command' }), undefined);
  fixture.bridge.dispose();
});

test('external asks only reach live runs, prefer the native session id and honour abort', async () => {
  const fixture = bridgeFixture();
  assert.equal(fixture.bridge.request({ nativeSessionId: 'runtime-missing' }), undefined);
  assert.equal(fixture.bridge.request({}), undefined);
  fixture.open();
  const byNative = fixture.bridge.request({ sessionId: 'another-public', nativeSessionId: 'runtime-native',
    toolName: 'codex/command', callId: 'native-first', reason: 'native wins' });
  const byPlatform = fixture.bridge.request({ sessionId: 'public-session', toolName: 'codex/command', callId: 'platform-fallback' });
  assert.deepEqual(fixture.published.map(item => item.call_id), ['native-first', 'platform-fallback']);
  const aborted = fixture.bridge.request({ nativeSessionId: 'runtime-native', signal: AbortSignal.abort() });
  assert.equal(await aborted, 'cancelled');
  assert.equal(fixture.published.length, 2);
  for (const item of fixture.published) {
    fixture.bridge.resolve({ sessionId: 'public-session', nativeSessionId: 'runtime-native',
      runId: 'run_abc', interactionId: item.id, expectedRevision: 1, action: 'approve' });
  }
  assert.deepEqual(await Promise.all([byNative, byPlatform]), ['allowed-once', 'allowed-once']);
  fixture.bridge.dispose();
});

test('module helpers route provider asks to the registry that owns a live run', async () => {
  const first = bridgeFixture();
  const second = bridgeFixture();
  first.open({ runId: 'run-first', sessionId: 'public-first', nativeSessionId: 'native-first' });
  second.open({ runId: 'run-second', sessionId: 'public-second', nativeSessionId: 'native-second' });
  try {
    assert.equal(hasManagedApprovalRun('native-first'), true);
    assert.equal(hasManagedApprovalRun('native-second'), true);
    assert.equal(hasManagedApprovalRun('public-second'), true);
    assert.equal(hasManagedApprovalRun('native-missing'), false);
    const routed = requestManagedApproval({ nativeSessionId: 'native-second', toolName: 'codex/command', callId: 'routed-ask' });
    assert.ok(routed);
    assert.equal(second.published.length, 1);
    assert.equal(first.published.length, 0);
    assert.equal(requestManagedApproval({ nativeSessionId: 'native-missing' }), undefined);
    second.bridge.resolve({ sessionId: 'public-second', nativeSessionId: 'native-second',
      runId: 'run-second', interactionId: second.published[0].id, expectedRevision: 1, action: 'approve' });
    assert.equal(await routed, 'allowed-once');
    second.bridge.close('run-second');
    assert.equal(hasManagedApprovalRun('native-second'), false);
  } finally {
    first.bridge.dispose();
    second.bridge.dispose();
  }
});
