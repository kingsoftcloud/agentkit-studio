/** Reference-mode probes are controlled TCP outcomes; the custom SDK test uses
 * actual local HTTP, signing, tool services and the durable Memory effect DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeAicpEndpoint } from '../src/aicp-resource-connection.mjs';
import { createAicpResourceClient, createAgentEngineClient } from '../src/server-client.mjs';
import { createKnowledgeConnection, createStudioKnowledgeTools } from '../src/knowledge-tools.mjs';
import { createLegacyMemoryConnection, createLegacyMemoryTools } from '../src/legacy-memory-tools.mjs';
const internal = 'aicp.internal.api.ksyun.com', inner = 'aicp.inner.api.ksyun.com', publicHost = 'aicp.api.ksyun.com';
const values = () => ({ cloudAccessKey: 'cloud-key', cloudSecretKey: 'cloud-secret', cloudSessionToken: 'cloud-session',
  cloudRegion: 'cn-beijing-6', cloudServerUrl: 'https://aicp.api.ksyun.com' });
const configuration = () => ({ resolve: async () => ({ values: values() }) });
const cases = [
  { name: 'explicit endpoint wins over mode', endpoint: 'sdk.example:8443', mode: 'inner', origin: 'https://sdk.example:8443', probes: [] },
  { name: 'internal mode defaults HTTP', mode: ' Internal ', origin: `http://${internal}`, probes: [] },
  { name: 'inner mode defaults HTTP', mode: 'inner', origin: `http://${inner}`, probes: [] },
  { name: 'public mode defaults HTTPS', mode: 'public', origin: `https://${publicHost}`, probes: [] },
  { name: 'auto prefers reachable internal', mode: 'auto', reachable: internal, origin: `http://${internal}`, probes: [internal] },
  { name: 'detect falls through to reachable inner', mode: 'detect', reachable: inner, origin: `http://${inner}`, probes: [internal, inner] },
  { name: 'unreachable auto falls back to public HTTPS', mode: 'auto', origin: `https://${publicHost}`, probes: [internal, inner, publicHost] },
  { name: 'invalid mode uses public without probing', mode: 'unknown', origin: `https://${publicHost}`, probes: [] },
];
for (const [prefix, factory, action] of [['KSADK_KB', createKnowledgeConnection, 'RetrieveKnowledge'],
  ['KSADK_LTM', createLegacyMemoryConnection, 'QueryMemorySdk']]) {
  test(`${prefix}: reference endpoint precedence, mode and ordered detection`, async () => {
    for (const row of cases) {
      const probes = [], calls = [], env = { [`${prefix}_ENDPOINT`]: row.endpoint ?? '', KSADK_AICP_ENDPOINT_MODE: row.mode };
      const connection = await factory({ configuration: configuration(), env,
        probe: async host => { probes.push(host); return host === row.reachable; },
        fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ Code: 0, Data: {} }); } });
      await connection.client.action(action, {}, { apiVersion: '2025-11-14' });
      assert.deepEqual(probes, row.probes, row.name); assert.equal(calls.length, 1, row.name);
      const { url, init } = calls[0];
      assert.equal(url.origin, row.origin, row.name); assert.equal(url.pathname, '/');
      assert.equal(url.searchParams.get('Action'), action); assert.equal(url.searchParams.get('Version'), '2025-11-14');
      assert.equal(JSON.parse(init.body).Action, action); assert.equal(init.redirect, 'error');
      assert.match(init.headers.Authorization, /Credential=cloud-key\//);
    }
  });
  test(`${prefix}: explicit scheme, region, credentials and pending resolution are captured once`, async () => {
    let release, seen;
    const pending = new Promise(resolve => { release = resolve; }), current = values();
    const env = { [`${prefix}_ENDPOINT`]: internal, [`${prefix}_SCHEME`]: 'HTTPS', [`${prefix}_REGION`]: 'region-specific',
      [`${prefix}_ACCESS_KEY`]: 'specific-key', [`${prefix}_SECRET_KEY`]: 'specific-secret', [`${prefix}_SESSION_TOKEN`]: 'specific-token',
      KSYUN_REGION: 'fallback-region', KSYUN_ACCESS_KEY: 'fallback-key', KSYUN_SECRET_KEY: 'fallback-secret', KSADK_TRAFFIC_SOURCE: ' pinned-source ' };
    const opening = factory({ configuration: { resolve: () => pending }, env, probe: () => assert.fail('explicit SDK endpoint cannot probe'),
      fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ Code: 0, Data: {} }); } });
    env[`${prefix}_ENDPOINT`] = 'foreign.example'; env[`${prefix}_SECRET_KEY`] = 'replacement';
    env.KSADK_TRAFFIC_SOURCE = 'changed-source';
    release({ values: current }); const connection = await opening;
    current.cloudServerUrl = 'https://redirect.example'; current.cloudAccessKey = 'replacement';
    await connection.client.action(action, {}, { apiVersion: '2025-11-14' });
    assert.equal(seen.url.origin, `https://${internal}`);
    assert.match(seen.init.headers.Authorization, /Credential=specific-key\/\d+\/region-specific\/aicp\/aws4_request/);
    assert.equal(seen.init.headers['X-Amz-Security-Token'], 'specific-token');
    assert.equal(seen.init.headers['X-Traffic-Source'], 'pinned-source');
    assert.match(seen.init.headers.Authorization, /x-traffic-source/);
    assert.doesNotMatch(JSON.stringify(connection), /specific-key|specific-secret|specific-token/);
  });
  test(`${prefix}: Studio local transport is preserved without an explicit SDK route`, async () => {
    let seen;
    const connection = await factory({ configuration: { resolve: async () => ({ values: { ...values(), cloudServerUrl: 'http://127.0.0.1:32109' } }) },
      sessionToken: 'studio-session', probe: () => assert.fail('configured Studio transport cannot probe'),
      fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ Code: 0, Data: {} }); } });
    await connection.client.action(action);
    assert.equal(seen.url.pathname, `/agentengine/api/v1/${action}`);
    assert.equal(seen.init.headers['X-AgentKit-Session'], 'studio-session');
    assert.equal(seen.init.headers.Authorization, undefined); assert.equal(JSON.parse(seen.init.body).Accesskey, undefined);
    assert.equal(seen.init.headers['X-Traffic-Source'], 'agentkit');
  });
  test(`${prefix}: no configured transport retains default auto and env credential fallbacks`, async () => {
    const probes = []; let seen;
    const connection = await factory({ configuration: { resolve: async () => ({ values: {} }) },
      env: { KSYUN_ACCESS_KEY_ID: 'env-key', KSYUN_SECRET_ACCESS_KEY: 'env-secret', KSYUN_REGION: 'env-region', KSYUN_SESSION_TOKEN: 'env-token' },
      probe: async host => { probes.push(host); return host === publicHost; },
      fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ Code: 0, Data: {} }); } });
    await connection.client.action(action);
    assert.deepEqual(probes, [internal, inner, publicHost]); assert.equal(seen.url.origin, `https://${publicHost}`);
    assert.match(seen.init.headers.Authorization, /Credential=env-key\/\d+\/env-region\/aicp\/aws4_request/);
    assert.equal(seen.init.headers['X-Amz-Security-Token'], 'env-token');
  });
}

test('Host SDK route grants only resource actions and never enables generic server signing or fallback', async () => {
  let calls = 0;
  const client = createAicpResourceClient({ configuration: configuration(), origin: 'http://sdk.example:8080',
    fetchImpl: async () => { calls++; return new Response('{"Message":"inner account"}', { status: 403 }); } });
  for (const action of ['RunAgent', 'DeleteAgent', 'CreateAgentProduct', 'UpdateMemory'])
    await assert.rejects(client.action(action), { code: 'ACTION_NOT_ALLOWED' });
  assert.equal(calls, 0);
  await assert.rejects(client.action('RetrieveKnowledge'), { code: 'SERVER_ACTION_FAILED' }); assert.equal(calls, 1);
  const generic = createAgentEngineClient({ configuration: { resolve: async () => ({ values: { ...values(), cloudServerUrl: 'http://sdk.example:8080' } }) },
    resourceOrigin: new URL('http://sdk.example:8080'), fetchImpl: () => assert.fail('generic remote HTTP cannot sign') });
  await assert.rejects(generic.action('RetrieveKnowledge'), { code: 'SERVER_URL_INVALID' });
});

test('malformed explicit SDK configuration fails before probing or sending credentials', async () => {
  for (const endpoint of ['https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=secret',
    'https://example.com/#secret', 'file:///tmp/socket', 'not a host']) {
    await assert.rejects(createKnowledgeConnection({ configuration: configuration(), env: { KSADK_KB_ENDPOINT: endpoint },
      probe: () => assert.fail('explicit endpoint cannot probe'), fetchImpl: () => assert.fail('invalid endpoint cannot fetch') }), { code: 'AICP_RESOURCE_ENDPOINT_INVALID' });
  }
  await assert.rejects(createLegacyMemoryConnection({ configuration: configuration(), env: { KSADK_LTM_ENDPOINT: 'https://sdk.example', KSADK_LTM_SCHEME: 'nonsense:' } }),
    { code: 'AICP_RESOURCE_ENDPOINT_INVALID' });
  for (const source of ['source\r\n', '\tsource', '中文']) await assert.rejects(createKnowledgeConnection({ configuration: configuration(),
    env: { KSADK_TRAFFIC_SOURCE: source }, probe: () => assert.fail('invalid source cannot probe') }), { code: 'AICP_RESOURCE_TRAFFIC_SOURCE_INVALID' });
});

test('real TCP detection closes successful sockets and bounds an unreachable port', async t => {
  const http = createServer(); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const port = http.address().port;
  assert.equal(await probeAicpEndpoint('127.0.0.1', { port }), true);
  await new Promise(resolve => http.close(resolve));
  assert.equal(await probeAicpEndpoint('127.0.0.1', { port, timeoutMs: 50 }), false);
});

test('actual custom signed HTTP runs knowledge and durable Memory save/query without Studio bearer or duplicate writes', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aicp-sdk-'))), calls = [];
  const http = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ path: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body.Action === 'RetrieveKnowledge' ? { Records: [{ Segment: { Content: '真实正文', Document: { Name: '资料' } } }] }
      : body.Action === 'CreateMemorySdk' ? { RequestId: 'saved', Data: {} }
        : { Data: [{ Memories: [{ Content: 'durable fact' }] }] }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); rmSync(root, { recursive: true, force: true }); });
  const endpoint = `127.0.0.1:${http.address().port}`, input = factory => factory({ configuration: configuration(), sessionToken: 'studio-private-token',
    env: { KSADK_KB_ENDPOINT: endpoint, KSADK_KB_SCHEME: 'http', KSADK_LTM_ENDPOINT: endpoint, KSADK_LTM_SCHEME: 'http' } });
  const knowledge = createStudioKnowledgeTools({ agentId: 'agent', env: { KSADK_KB_DATASET_ID: 'dataset' }, connection: await input(createKnowledgeConnection) });
  t.after(() => knowledge.close());
  const result = await knowledge.execute('search_knowledge_base', { query: '完整问题' }, { signal: new AbortController().signal, assertCurrent: () => true });
  assert.equal(result.status, 'ok'); assert.match(JSON.stringify(result.content), /真实正文/);
  const connection = await input(createLegacyMemoryConnection), env = { KSADK_LTM_BACKEND: 'sdk', KSADK_LTM_NAMESPACE: 'collection' };
  let memory = createLegacyMemoryTools({ agentId: 'agent', root, connection, env });
  const invocation = { signal: new AbortController().signal, assertCurrent: () => true,
    context: { agentId: 'agent', userId: 'user', sessionId: 'session', runnerType: 'dsh-native' },
    owner: { kind: 'dsh', identity: { agentId: 'agent', sessionId: 'session', callId: 'original' } } };
  const saved = await memory.execute('save_memory', { content: 'durable fact' }, invocation);
  assert.equal(saved.content.status, 'persisted'); await memory.close();
  memory = createLegacyMemoryTools({ agentId: 'agent', root, connection, env }); t.after(() => memory.close());
  assert.deepEqual(await memory.execute('save_memory', { content: 'durable fact' }, invocation), saved);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(row => row.body.Action), ['RetrieveKnowledge', 'CreateMemorySdk', 'QueryMemorySdk']);
  for (const call of calls) {
    assert.match(call.path, /^\/\?Action=/); assert.equal(call.body.Version, '2025-11-14');
    assert.match(call.headers.authorization, /Credential=cloud-key\//); assert.equal(call.headers['x-agentkit-session'], undefined);
    assert.equal(call.body.Accesskey, 'cloud-key');
    assert.equal(call.headers['x-traffic-source'], 'agentkit');
  }
  const db = new DatabaseSync(join(root, 'effects/effects.sqlite'));
  try { const rows = db.prepare('SELECT prepared,result FROM legacy_memory_effects').all(); assert.equal(rows.length, 1);
    assert.equal(calls[1].headers['x-ksc-request-id'], JSON.parse(rows[0].prepared).requestIds[0]); assert.ok(rows[0].result); }
  finally { db.close(); }
});
