import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createManagedResourceClient } from '../src/managed-resource-client.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createPlatformServices } from '../src/host/services/platform.mjs';
import { createManagedResourceContext } from '../src/managed-resource-context.mjs';

const token = 'synthetic-private-workload-token';
const runtime = profile => ({ identity: { agentId: 'ar-fixture', versionId: 'platform-version-1',
  manifestSha256: 'a'.repeat(64), runtimeName: profile }, declaration: {} });
const environment = url => ({ AGENTENGINE_RESOURCE_SERVER_URL: url, AGENTKIT_RUNTIME_TOKEN: token,
  KSYUN_ACCESS_KEY: 'unrelated-fixture-ak', KSYUN_SECRET_KEY: 'unrelated-fixture-sk' });

async function service(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/`;
}

for (const profile of ['dsh-native', 'harness', 'codex']) test(`${profile} Host uses scoped resources through existing KB/Memory adapters without cloud keys`, async t => {
  const received = [];
  const url = await service(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    received.push({ path: request.url, headers: request.headers, payload });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ Code: 0, Data: request.url.endsWith('/RetrieveKnowledge')
      ? { Records: [{ Content: 'fixture-hidden-fact' }] } : { Success: true }, RequestId: 'fixture-receipt' }));
  });
  // Exercise the actual managed Host service selection, not a standalone
  // client that the Host never constructs.
  const definition = { ...runtime(profile), declaration: { resources: { memory: { id: 'mem-fixture' } } } };
  const context = createManagedResourceContext(definition), subjectDigest = 'b'.repeat(64);
  const permit = `drp1.${Buffer.from(JSON.stringify({ format: 'agentengine.dsh-memory-permit/v1',
    agent_id: definition.identity.agentId, version_id: definition.identity.versionId,
    manifest_sha256: definition.identity.manifestSha256, memory_id: 'mem-fixture', subject_digest: subjectDigest,
    expires_at: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.${'f'.repeat(64)}`;
  const services = createPlatformServices({ get: () => ({}), effect: () => {} },
    { env: environment(url), managedRuntime: definition, managedResourceContext: context });
  const serverClient = await services.serverClientPromise;
  const adapter = createLocalResourceAdapters({ serverClient });
  t.after(() => adapter.close());
  assert.deepEqual(await adapter.searchKnowledge('kb-fixture', 'question'), [{ Content: 'fixture-hidden-fact' }]);
  const write = () => adapter.writeMemory('mem-fixture', `aeu_${subjectDigest}`, [{ role: 'user', content: 'fixture-memory' }],
    { agentId: 'ar-fixture', sessionId: 'trusted-session' });
  await assert.rejects(write(), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  assert.equal((await context.run({ headers: { 'x-agentengine-resource-permit': permit }, subjectDigest }, write)).accepted, true);
  await assert.rejects(write(), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  assert.equal(received.length, 2);
  for (const item of received) {
    assert.equal(item.headers.authorization, `Bearer ${token}`);
    assert.equal(item.headers['x-agentengine-target-version-id'], 'platform-version-1');
    assert.equal(item.headers['x-agentengine-manifest-sha256'], 'a'.repeat(64));
    assert.ok(item.path.startsWith('/agentengine/internal/v1/dsh/agents/ar-fixture/resources/'));
    const encoded = JSON.stringify(item);
    for (const value of ['unrelated-fixture-ak', 'unrelated-fixture-sk', 'AWS4-HMAC', 'trusted-business-user']) assert.ok(!encoded.includes(value));
  }
  assert.match(received[1].payload.AgentUserId, /^mp1-[a-f0-9]{60}$/);
  assert.equal(received[0].headers['x-agentengine-resource-permit'], undefined);
  assert.equal(received[1].headers['x-agentengine-resource-permit'], permit);
  assert.equal(JSON.stringify(received[1].payload).includes(permit), false);
});

test('resource-only client rejects management Actions, malformed roots and response errors without echoing details', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent++; return new Response('private-credential-and-content', { status: 403 }); };
  for (const url of ['', 'file:///private', 'https://user:password@fixture.test/', 'https://fixture.test/?token=private', 'https://fixture.test/wrong-path']) {
    const client = createManagedResourceClient({ runtime: runtime('codex'), env: environment(url), fetchImpl });
    await assert.rejects(client.action('RetrieveKnowledge'), { code: 'MANAGED_RESOURCE_SERVER_UNAVAILABLE' });
  }
  const client = createManagedResourceClient({ runtime: runtime('codex'), env: environment('https://fixture.test/'), fetchImpl });
  await assert.rejects(client.action('DeleteAgent'), { code: 'MANAGED_RESOURCE_ACTION_NOT_ALLOWED' });
  await assert.rejects(client.skillAction('RetrieveKnowledge'), { code: 'MANAGED_RESOURCE_ACTION_NOT_ALLOWED' });
  await assert.rejects(client.action('RetrieveKnowledge'), error => error.code === 'MANAGED_RESOURCE_ACCESS_REVOKED' && !error.message.includes('private-credential'));
  assert.equal(sent, 1);
});

test('bounded replies reject oversized and invalid envelopes', async () => {
  for (const response of [new Response('x'.repeat(2 * 1024 * 1024 + 1)), new Response('{'),
    Response.json({ Code: 500, Data: { secret: 'private' } }), Response.json({ Code: 0 })]) {
    const client = createManagedResourceClient({ runtime: runtime('harness'), env: environment('https://fixture.test/'), fetchImpl: async () => response });
    await assert.rejects(client.action('RetrieveKnowledge'), { code: 'MANAGED_RESOURCE_RESPONSE_INVALID' });
  }
});

test('Skill transport uses the same immutable identity and honors cancellation', async t => {
  let requestSeen;
  const observed = new Promise(resolve => { requestSeen = resolve; });
  const url = await service(t, (request, response) => { requestSeen(request); });
  const controller = new AbortController();
  const client = createManagedResourceClient({ runtime: runtime('dsh-native'), env: environment(url) });
  const pending = client.skillAction('ListSkillsBySpaceId', { SpaceId: 'space-second' }, { signal: controller.signal });
  const assertion = assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  const request = await observed;
  assert.equal(request.headers['x-agentengine-target-version-id'], 'platform-version-1');
  controller.abort(); await assertion;
});

test('memory HTTP follows its active run cancellation without retrying the write', async t => {
  let acknowledge, sent = 0;
  const observed = new Promise(resolve => { acknowledge = resolve; });
  const url = await service(t, request => { sent++; acknowledge(request); });
  const controller = new AbortController();
  const client = createManagedResourceClient({ runtime: runtime('dsh-native'), env: environment(url),
    getResourcePermit: () => 'synthetic-fixture-permit', getResourceSignal: () => controller.signal });
  const pending = client.action('CreateMemorySdk', { MemoryCollectionId: 'mem-fixture' });
  const assertion = assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  await observed;
  controller.abort();
  await assertion;
  assert.equal(sent, 1);
});

test('a declared Skill Space is identified by its binding kind rather than UUID spelling', async t => {
  const seen = [];
  const url = await service(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks)));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ Code: 0, Data: { Skills: [], TotalCount: 0 } }));
  });
  const definition = { ...runtime('dsh-native'), declaration: { resources: { skill_spaces: [{ id: 'space-prefixed' }] } } };
  const serverClient = createManagedResourceClient({ runtime: definition, env: environment(url) });
  const adapters = createLocalResourceAdapters({ serverClient });
  assert.deepEqual(await adapters.loadSkill('space-prefixed'), { name: 'space-prefixed', content: '' });
  assert.equal(seen[0].SpaceId, 'space-prefixed');
  await assert.rejects(adapters.loadSkill('unbound-local-name'), { code: 'SKILL_NOT_INSTALLED' });
  assert.equal(seen.length, 1);
  await adapters.close();
});
