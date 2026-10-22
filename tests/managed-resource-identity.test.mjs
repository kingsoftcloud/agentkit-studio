import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { bindDshAgentRoute, createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManagedSessionRegistry } from '../src/managed-session-registry.mjs';
import { createManagedResourceIdentityResolver } from '../src/managed-resource-identity.mjs';

const trustedUser = `aeu_${'a'.repeat(64)}`;
const prompt = { sessionId: 'native-managed-session', messages: [{ role: 'user', content: 'resource lookup' }],
  userId: 'forged-body-user', metadata: { userId: 'forged-metadata-user' }, user: { id: 'forged-option-user' } };

function fixture(t, runtime, resolveResourceUser) {
  const bridge = createRuntimeBridge();
  t.after(() => bridge.close());
  bindDshAgentRoute(prompt.sessionId, { agentId: 'ar-managed', runtime, local: true, agentRevision: 1,
    nativeTools: true, agent: { session: { header: { cwd: '/tmp/managed-resource-fixture' } } } }, bridge);
  const received = [];
  const adapter = createDshRuntimeAdapter({ bridge, resolveResourceUser,
    localHandler: async () => async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      received.push(JSON.parse(raw));
      response.writeHead(200);
      response.end('data: {"runtimeEvent":{"event_type":"run.completed"}}\n\ndata: [DONE]\n\n');
    },
    codexResourceContext: async request => { received.push(request); return {}; },
    codexRuntime: { async *stream() { yield { type: 'text', text: 'fixture' }; } },
  });
  return { received, read: async options => { for await (const _chunk of adapter.stream(options || prompt)) {} } };
}

for (const runtime of ['dsh-native', 'harness', 'codex']) {
  test(`${runtime} resource identity comes from the managed session owner, ignoring input user fields`, async t => {
    const lookups = [];
    const f = fixture(t, runtime, async key => { lookups.push(key); return trustedUser; });
    await f.read();
    assert.deepEqual(lookups, [{ agentId: 'ar-managed', sessionId: prompt.sessionId }]);
    assert.equal(f.received[0].userId, trustedUser);
    assert.ok(!JSON.stringify(f.received).includes('forged-'));
  });

  test(`${runtime} refuses resource consumption if its managed session ownership is unavailable`, async t => {
    const f = fixture(t, runtime, async () => { throw Object.assign(Error('missing ownership'), { code: 'MANAGED_RESOURCE_IDENTITY_UNAVAILABLE' }); });
    await assert.rejects(f.read(), { code: 'MANAGED_RESOURCE_IDENTITY_UNAVAILABLE' });
    assert.equal(f.received.length, 0);
  });
}

test('legacy local resources retain the existing explicit user identity when no managed resolver is installed', async t => {
  const f = fixture(t, 'harness');
  await f.read();
  assert.equal(f.received[0].userId, 'forged-body-user');
});

test('resource ownership survives reopen, stays stable across sessions, and separates two business subjects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-resource-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = { identity: { agentId: 'ar-managed', versionId: 'v1' } };
  const registry = await createManagedSessionRegistry(directory);
  const row = (id, owner) => ({ format: 'agentengine.dsh-session/v1', sessionId: id, nativeSessionId: `native-${id}`,
    versionId: 'v1', owner, userId: `aeu_${owner}`, epoch: randomUUID(), phase: 'ready' });
  await registry.write(row('alice-first', 'a'.repeat(64)));
  await registry.write(row('alice-second', 'a'.repeat(64)));
  await registry.write(row('bob-first', 'b'.repeat(64)));
  for (let reopen = 0; reopen < 2; reopen++) {
    const resolve = await createManagedResourceIdentityResolver({ runtime, directory });
    const lookup = id => resolve({ agentId: 'ar-managed', sessionId: `native-${id}` });
    assert.equal(await lookup('alice-first'), trustedUser);
    assert.equal(await lookup('alice-second'), trustedUser);
    assert.equal(await lookup('bob-first'), `aeu_${'b'.repeat(64)}`);
    await assert.rejects(resolve({ agentId: 'ar-other', sessionId: 'native-alice-first' }), { code: 'MANAGED_RESOURCE_IDENTITY_UNAVAILABLE' });
  }
});

test('cached ownership cannot outlive deletion, change platform versions or accept a mismatched partition', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-resource-retired-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = { identity: { agentId: 'ar-managed', versionId: 'v1' } };
  const registry = await createManagedSessionRegistry(directory);
  const valid = { format: 'agentengine.dsh-session/v1', sessionId: 'public', nativeSessionId: 'native',
    versionId: 'v1', owner: 'a'.repeat(64), userId: trustedUser, epoch: randomUUID(), phase: 'ready' };
  await registry.write(valid);
  const resolve = await createManagedResourceIdentityResolver({ runtime, directory });
  const lookup = () => resolve({ agentId: 'ar-managed', sessionId: 'native' });
  assert.equal(await lookup(), trustedUser);
  for (const patch of [{ phase: 'deleting' }, { phase: 'deleted' }, { versionId: 'v2' }, { userId: 'studio-anonymous' }]) {
    await registry.write({ ...valid, ...patch });
    await assert.rejects(lookup(), { code: 'MANAGED_RESOURCE_IDENTITY_UNAVAILABLE' });
  }
  await registry.write(valid);
  assert.equal(await lookup(), trustedUser);
  await registry.write({ ...valid, sessionId: 'ambiguous-alias' });
  const reopened = await createManagedResourceIdentityResolver({ runtime, directory });
  await assert.rejects(reopened({ agentId: 'ar-managed', sessionId: 'native' }), { code: 'MANAGED_RESOURCE_IDENTITY_UNAVAILABLE' });
});
