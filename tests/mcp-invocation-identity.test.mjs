/** Trusted MCP invocation identity: every MCP tool call carries the live
 * Session and principal, on `_meta` (all transports) and on HTTP headers.
 * Tool arguments can never select or override it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createBoundResourceToolExecutor } from '../src/host/services/resource-tools.mjs';
import { createMcpLoopbackService } from './fixtures/mcp-loopback-service.mjs';
import {
  MCP_INVOCATION_META_KEY, applyMcpInvocationHeaders, createMcpInvocationScope, mcpInvocationMeta,
  normalizeMcpInvocationIdentity,
} from '../src/providers/mcp-invocation-identity.mjs';
import { normalizeBusinessInvocation, runWithBusinessInvocation } from '../src/providers/business-invocation-context.mjs';
import { nativeMcpInvocation } from '../src/providers/native-mcp-invocation.mjs';

const IDENTITY = Object.freeze({
  source: 'dsh-native', sessionId: 'session-1', userId: 'aeu_0123456789abcdef', tenantId: 'tenant-1',
  workspaceId: 'workspace-1', agentId: 'agent-1', runId: 'run-1', callId: 'ak-native-1',
});

/** Minimal StreamableHTTP peer: records the exact JSON-RPC params and headers
 * of every authenticated request. */
function mcpFetchRecorder(record = []) {
  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const message = init.body ? JSON.parse(init.body) : null;
    record.push({ method: message?.method, params: message?.params, url: String(url),
      headers: Object.fromEntries(headers) });
    if (!message) return new Response(null, { status: 405 });
    const reply = result => Response.json({ jsonrpc: '2.0', id: message.id, result },
      { headers: { 'content-type': 'application/json', 'mcp-session-id': 'identity-session' } });
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'identity', version: '1' } });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') return reply({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] });
    if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'ok' }], isError: false });
    return new Response(null, { status: 405 });
  };
  return fetchImpl;
}

test('invocation identity needs both a visible Session and a trusted principal', () => {
  assert.equal(normalizeMcpInvocationIdentity(undefined), null);
  assert.equal(normalizeMcpInvocationIdentity('dsh-native'), null);
  assert.equal(normalizeMcpInvocationIdentity({ source: 'dsh-native', sessionId: 'session-1' }), null, 'a principal is required');
  assert.equal(normalizeMcpInvocationIdentity({ source: 'dsh-native', userId: 'user-1' }), null, 'a Session is required');
  assert.equal(normalizeMcpInvocationIdentity({ source: 'forged', sessionId: 'session-1', userId: 'user-1' }), null);
  assert.equal(normalizeMcpInvocationIdentity({ source: 'dsh-native', sessionId: 'session\n1', userId: 'user-1' }), null,
    'header-unsafe values are never forwarded');
  const identity = normalizeMcpInvocationIdentity({ source: 'dsh-native', sessionId: 'session-1', userId: 'user-1',
    agentId: 'agent-1', tenantId: 't\u0000enant', runId: 'run-1', credential: 'secret' });
  assert.deepEqual(identity, { v: 1, source: 'dsh-native', sessionId: 'session-1', userId: 'user-1', agentId: 'agent-1', runId: 'run-1' },
    'optional fields are dropped when unsafe and unknown fields never leave the Host');
  assert.equal(Object.isFrozen(identity), true);
});

test('identity headers replace resource-configured values instead of being spoofed by them', () => {
  const identity = normalizeMcpInvocationIdentity(IDENTITY);
  assert.deepEqual(mcpInvocationMeta(identity), { [MCP_INVOCATION_META_KEY]: identity });
  const headers = applyMcpInvocationHeaders(new Headers({ authorization: 'Bearer resource-token',
    'x-agentkit-user-id': 'resource-configured' }), identity);
  assert.equal(headers.get('authorization'), 'Bearer resource-token', 'MCP credentials are untouched');
  assert.equal(headers.get('x-agentkit-user-id'), IDENTITY.userId);
  assert.equal(headers.get('x-agentkit-session-id'), IDENTITY.sessionId);
  assert.equal(headers.get('x-agentkit-invocation-source'), 'dsh-native');
  const business = normalizeMcpInvocationIdentity({ source: 'run-agent', sessionId: 'native', userId: 'platform',
    businessUserId: 'customer', businessSessionId: 'order-session' });
  const businessHeaders = applyMcpInvocationHeaders(new Headers({ 'x-agentkit-business-user-id': 'forged' }), business);
  assert.equal(businessHeaders.get('x-agentkit-business-user-id'), 'customer');
  assert.equal(businessHeaders.get('x-agentkit-business-session-id'), 'order-session');
  assert.deepEqual([...headers.keys()].sort(), ['authorization', 'x-agentkit-agent-id', 'x-agentkit-call-id',
    'x-agentkit-invocation-source', 'x-agentkit-run-id', 'x-agentkit-session-id', 'x-agentkit-tenant-id',
    'x-agentkit-user-id', 'x-agentkit-workspace-id']);
});

test('an invocation scope keeps concurrent Sessions from observing each other', async () => {
  const scope = createMcpInvocationScope();
  const identity = normalizeMcpInvocationIdentity(IDENTITY);
  assert.equal(scope.current(), null);
  const seen = await Promise.all([scope.run(identity, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return scope.current();
  }), scope.run(normalizeMcpInvocationIdentity({ ...IDENTITY, sessionId: 'session-2' }), async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return scope.current();
  })]);
  assert.deepEqual(seen.map(value => value.sessionId), ['session-1', 'session-2']);
  assert.equal(scope.current(), null, 'the scope does not leak past the call');
});

test('correlation ids are unconditional while business attribution stays optional', () => {
  // A managed turn always has a request id and a native session, whether or not
  // the caller claimed a business user.
  const correlation = normalizeBusinessInvocation({ requestId: 'req-1', nativeSessionId: 'runtime-1' });
  assert.deepEqual({ ...correlation }, { contract: 'agentkit.business-invocation/v1',
    requestId: 'req-1', nativeSessionId: 'runtime-1' });
  assert.equal(Object.hasOwn(correlation, 'userId'), false);
  assert.equal(Object.hasOwn(correlation, 'businessDigest'), false);
  // A business user without a business session omits the session field.
  const business = normalizeBusinessInvocation({ userId: 'customer-1', requestId: 'req-1' });
  assert.equal(business.userId, 'customer-1');
  assert.equal(Object.hasOwn(business, 'sessionId'), false, 'the platform session is never substituted');
  assert.match(business.businessDigest, /^[a-f0-9]{64}$/);
  // The invocation id is the minimum: no managed turn reaches MCP without it.
  assert.equal(normalizeBusinessInvocation({ userId: 'customer-1', sessionId: 'order-1' }), null);
});

test('Native MCP keeps platform identity and adds the active RunAgent business identity', async () => {
  const business = normalizeBusinessInvocation({ userId: 'customer-1', sessionId: 'order-1', requestId: 'req-1', nativeSessionId: 'runtime-1' });
  const identity = await runWithBusinessInvocation(business, async () => nativeMcpInvocation({
    scope: { tenantId: 'tenant', workspaceId: 'workspace', userId: 'aeu-platform' },
    agent: { session: { id: 'runtime-1' } }, agentId: 'agent-1', runId: 'run-1', callId: 'call-1',
  }));
  assert.deepEqual(identity, {
    source: 'run-agent', sessionId: 'runtime-1', userId: 'aeu-platform', businessUserId: 'customer-1',
    businessSessionId: 'order-1', nativeSessionId: 'runtime-1', invocationId: 'req-1', businessInvocationId: 'req-1',
    tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent-1', runId: 'run-1', callId: 'call-1',
  });
});

test('every MCP tool call carries the Host-bound identity on _meta and HTTP headers', async () => {
  const record = [];
  const adapters = createLocalResourceAdapters({ fetchImpl: mcpFetchRecorder(record) });
  try {
    const binding = { resourceId: 'identity-mcp', endpointUrl: 'https://example.test/mcp' };
    const result = await adapters.callMcpTool(binding, 'search', {
      query: 'hello',
      userId: 'model-supplied',
      _meta: { [MCP_INVOCATION_META_KEY]: { userId: 'model-supplied' } },
    }, { invocation: IDENTITY, resultFormat: 'mcp-result/v1' });
    assert.equal(result.content[0].text, 'ok');
    const call = record.find(item => item.method === 'tools/call');
    assert.deepEqual(call.params.arguments, {
      query: 'hello',
      userId: 'model-supplied',
      _meta: { [MCP_INVOCATION_META_KEY]: { userId: 'model-supplied' } },
    }, 'tool arguments stay exactly what the model produced');
    assert.deepEqual(call.params._meta, { [MCP_INVOCATION_META_KEY]: {
      v: 1, source: 'dsh-native', sessionId: 'session-1', userId: 'aeu_0123456789abcdef', tenantId: 'tenant-1',
      workspaceId: 'workspace-1', agentId: 'agent-1', runId: 'run-1', callId: 'ak-native-1',
    } }, 'the JSON-RPC _meta is the Host identity, never the argument bag');
    assert.equal(call.headers['x-agentkit-session-id'], 'session-1');
    assert.equal(call.headers['x-agentkit-user-id'], 'aeu_0123456789abcdef');
    assert.equal(call.headers['x-agentkit-agent-id'], 'agent-1');
    assert.equal(call.headers['x-agentkit-invocation-source'], 'dsh-native');
    assert.equal(record.filter(item => item.method !== 'notifications/initialized')
      .every(item => item.headers['x-agentkit-session-id'] === 'session-1'), true,
    'connection, discovery and call requests all carry the identity');
  } finally { await adapters.close(); }
});

test('RunAgent MCP metadata preserves platform identity and adds business identity', async () => {
  const record = [];
  const adapters = createLocalResourceAdapters({ fetchImpl: mcpFetchRecorder(record) });
  try {
    const invocation = { source: 'run-agent', sessionId: 'native-session', userId: 'aeu-platform',
      businessUserId: 'customer@example.com', businessSessionId: 'order-session-42',
      businessInvocationId: 'request-1001', nativeSessionId: 'native-session', agentId: 'agent-1' };
    await adapters.callMcpTool({ resourceId: 'business-mcp', endpointUrl: 'https://example.test/mcp' }, 'search', {}, { invocation });
    const call = record.find(item => item.method === 'tools/call');
    const meta = call.params._meta[MCP_INVOCATION_META_KEY];
    assert.equal(meta.sessionId, 'native-session');
    assert.equal(meta.userId, 'aeu-platform');
    assert.equal(meta.businessUserId, 'customer@example.com');
    assert.equal(meta.businessSessionId, 'order-session-42');
    assert.equal(call.headers['x-agentkit-session-id'], 'native-session');
    assert.equal(call.headers['x-agentkit-user-id'], 'aeu-platform');
    assert.equal(call.headers['x-agentkit-business-user-id'], 'customer@example.com');
    assert.equal(call.headers['x-agentkit-business-session-id'], 'order-session-42');
    assert.equal(call.headers['x-agentkit-business-invocation-id'], 'request-1001');
    assert.equal(record.filter(item => item.method !== 'notifications/initialized')
      .every(item => item.headers['x-agentkit-business-user-id'] === 'customer@example.com'
        && item.headers['x-agentkit-business-session-id'] === 'order-session-42'), true,
    'business identity is attached to initialize, list and call requests');
  } finally { await adapters.close(); }
});

test('an MCP call without trusted identity stays byte-compatible with today', async () => {
  const record = [];
  const adapters = createLocalResourceAdapters({ fetchImpl: mcpFetchRecorder(record) });
  try {
    await adapters.callMcpTool({ resourceId: 'anonymous-mcp', endpointUrl: 'https://example.test/mcp' }, 'search', {});
    const call = record.find(item => item.method === 'tools/call');
    assert.equal(Object.hasOwn(call.params, '_meta'), false);
    assert.equal(Object.keys(call.headers).some(name => name.startsWith('x-agentkit-')), false);
  } finally { await adapters.close(); }
});

test('a deployment can opt out of the identity channel for a strict MCP server', async () => {
  const record = [];
  const adapters = createLocalResourceAdapters({ fetchImpl: mcpFetchRecorder(record), invocationIdentity: false });
  try {
    await adapters.callMcpTool({ resourceId: 'strict-mcp', endpointUrl: 'https://example.test/mcp' }, 'search', {}, { invocation: IDENTITY });
    const call = record.find(item => item.method === 'tools/call');
    assert.equal(Object.hasOwn(call.params, '_meta'), false);
    assert.equal(Object.keys(call.headers).some(name => name.startsWith('x-agentkit-')), false);
  } finally { await adapters.close(); }
});

test('concurrent Sessions sharing one MCP connection keep their own identity', async () => {
  const record = [];
  const adapters = createLocalResourceAdapters({ fetchImpl: mcpFetchRecorder(record) });
  try {
    const binding = { resourceId: 'shared-connection-mcp', endpointUrl: 'https://example.test/mcp' };
    const other = { ...IDENTITY, sessionId: 'session-2', userId: 'aeu_fedcba9876543210' };
    await Promise.all([adapters.callMcpTool(binding, 'search', {}, { invocation: IDENTITY }),
      adapters.callMcpTool(binding, 'search', {}, { invocation: other })]);
    const calls = record.filter(item => item.method === 'tools/call');
    assert.deepEqual(calls.map(call => [call.headers['x-agentkit-session-id'], call.params._meta[MCP_INVOCATION_META_KEY].userId])
      .sort(), [['session-1', 'aeu_0123456789abcdef'], ['session-2', 'aeu_fedcba9876543210']].sort());
    assert.equal(record.filter(item => item.method === 'initialize').length, 1, 'identity stays per request, not per connection');
  } finally { await adapters.close(); }
});

test('a real loopback MCP server observes the Session and principal of the caller', async t => {
  const seen = [];
  const service = await createMcpLoopbackService({ transport: 'http', getCredential: () => 'loopback-token',
    onCall: (request, extra) => { seen.push({ meta: request.params._meta, headers: extra?.requestInfo?.headers }); } });
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: 'loopback-token' }) } });
  t.after(async () => { await adapters.close(); await service.close(); });
  const binding = { resourceId: 'loopback-identity', endpointUrl: service.endpoint, transport: 'http',
    envRefs: { Authorization: 'env://MCP_LOOPBACK_TOKEN' } };
  const result = await adapters.callMcpTool(binding, service.toolName, {}, { invocation: IDENTITY });
  assert.equal(result[0].text, service.receipt);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].meta, { [MCP_INVOCATION_META_KEY]: {
    v: 1, source: 'dsh-native', sessionId: 'session-1', userId: 'aeu_0123456789abcdef', tenantId: 'tenant-1',
    workspaceId: 'workspace-1', agentId: 'agent-1', runId: 'run-1', callId: 'ak-native-1',
  } });
  assert.equal(seen[0].headers['x-agentkit-session-id'], 'session-1');
  assert.equal(seen[0].headers['x-agentkit-user-id'], 'aeu_0123456789abcdef');
  assert.equal(seen[0].headers.authorization, 'Bearer loopback-token');
});

test('the Host resource tool executor forwards the Host-bound invocation and drops caller-forged fields', async () => {
  const record = refs => ({ spec: { bindings: { mcpServers: refs } } });
  const binding = { resourceId: 'crm', endpointUrl: 'https://crm.example.test/mcp' };
  let actual;
  const execute = createBoundResourceToolExecutor({
    agents: { get: async id => id === 'agent' ? record([binding]) : null },
    resources: { callMcpTool: async (...args) => { actual = args; return 'result'; } },
  });
  const invocation = { source: 'dsh-native', sessionId: 'session-1', userId: 'aeu_0123456789abcdef' };
  assert.equal(await execute({ agentId: 'agent', resourceId: 'crm', name: 'probe', arguments: { q: 1 }, invocation,
    userId: 'forged-user', sessionId: 'forged-session' }), 'result');
  assert.deepEqual(actual.slice(0, 3), [binding, 'probe', { q: 1 }]);
  assert.deepEqual(actual[3].invocation, invocation);
  assert.equal(actual[3].userId, undefined);
  assert.equal(actual[3].sessionId, undefined);
});
