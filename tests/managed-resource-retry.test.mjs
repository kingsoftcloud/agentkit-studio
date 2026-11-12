import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedResourceClient } from '../src/managed-resource-client.mjs';

const runtime = { identity: { agentId: 'ar-retry-fixture', versionId: 'platform-version-1',
  manifestSha256: 'a'.repeat(64) }, declaration: {} };
const env = { AGENTENGINE_RESOURCE_SERVER_URL: 'https://fixture.test/', AGENTKIT_RUNTIME_TOKEN: 'fixture-runtime-token' };
const envelope = () => Response.json({ Code: 0, Data: { Success: true }, RequestId: 'fixture-receipt' });

function client(fetchImpl, options = {}) {
  return createManagedResourceClient({ runtime, env, fetchImpl, retryDelaysMs: [0, 0, 0], ...options });
}

test('5xx and 429 responses are retried to the bounded limit then reported as server unavailable', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const managed = client(async () => { calls += 1; return new Response('upstream unavailable', { status }); });
    await assert.rejects(managed.action('RetrieveKnowledge'), error => {
      assert.equal(error.code, 'MANAGED_RESOURCE_SERVER_UNAVAILABLE');
      assert.equal(error.status, status);
      assert.equal(error.attempts, 3);
      return true;
    });
    assert.equal(calls, 3, `expected three attempts for ${status}`);
  }
});

test('network errors and request timeouts are retried and can recover', async () => {
  let calls = 0;
  const managed = client(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) throw Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    return envelope();
  });
  const result = await managed.action('RetrieveKnowledge');
  assert.deepEqual(result, { data: { Success: true }, requestId: 'fixture-receipt' });
  assert.equal(calls, 3);
});

test('an exhausted network error is reported as server unavailable with its attempt count', async () => {
  let calls = 0;
  const managed = client(async () => { calls += 1; throw new TypeError('socket closed'); });
  await assert.rejects(managed.action('RetrieveKnowledge'), error => {
    assert.equal(error.code, 'MANAGED_RESOURCE_SERVER_UNAVAILABLE');
    assert.equal(error.status, 0);
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(calls, 3);
});

test('a 409 owner-unavailable snapshot is classified once and never retried', async () => {
  let calls = 0;
  const managed = client(async () => {
    calls += 1;
    return Response.json({ detail: 'DSH_RESOURCE_OWNER_UNAVAILABLE' }, { status: 409 });
  });
  await assert.rejects(managed.action('RetrieveKnowledge'), error => {
    assert.equal(error.code, 'MANAGED_RESOURCE_SNAPSHOT_MISSING');
    assert.equal(error.status, 409);
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(calls, 1);
});

test('other 409 conflicts are terminal request failures rather than retried snapshots', async () => {
  let calls = 0;
  const managed = client(async () => {
    calls += 1;
    return Response.json({ detail: 'DSH_RESOURCE_VERSION_MISMATCH' }, { status: 409 });
  });
  await assert.rejects(managed.action('RetrieveKnowledge'), error => {
    assert.equal(error.code, 'MANAGED_RESOURCE_REQUEST_FAILED');
    assert.equal(error.status, 409);
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(calls, 1);
});

test('403, 401, 404 and other 4xx responses are classified without replay', async () => {
  const cases = [[403, 'MANAGED_RESOURCE_ACCESS_REVOKED'], [401, 'MANAGED_RESOURCE_REQUEST_FAILED'],
    [404, 'MANAGED_RESOURCE_REQUEST_FAILED'], [400, 'MANAGED_RESOURCE_REQUEST_FAILED'],
    [422, 'MANAGED_RESOURCE_REQUEST_FAILED']];
  for (const [status, code] of cases) {
    let calls = 0;
    const managed = client(async () => { calls += 1; return new Response('deterministic rejection', { status }); });
    await assert.rejects(managed.action('RetrieveKnowledge'), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.attempts, 1);
      return true;
    });
    assert.equal(calls, 1, `expected a single attempt for ${status}`);
  }
});

test('a transient failure followed by 403 stops retrying and preserves the revocation', async () => {
  let calls = 0;
  const managed = client(async () => {
    calls += 1;
    if (calls === 1) return new Response('temporary', { status: 503 });
    return new Response('revoked', { status: 403 });
  });
  await assert.rejects(managed.action('RetrieveKnowledge'), { code: 'MANAGED_RESOURCE_ACCESS_REVOKED', status: 403 });
  assert.equal(calls, 2);
});

test('a successful first response performs no retry and keeps the existing contract', async () => {
  let calls = 0;
  const managed = client(async () => { calls += 1; return envelope(); });
  assert.deepEqual(await managed.skillAction('ListSkillsBySpaceId', { SpaceId: 'space' }),
    { data: { Success: true }, requestId: 'fixture-receipt' });
  assert.equal(calls, 1);
});

test('mutating memory submissions do not replay transport failures', async () => {
  for (const failure of ['response', 'network', 'body']) {
    let calls = 0;
    const managed = createManagedResourceClient({ runtime: { ...runtime,
      declaration: { resources: { memory: { id: 'memory-fixture' } } } }, env,
      getResourcePermit: () => 'fixture-permit', retryDelaysMs: [0, 0, 0],
      fetchImpl: async () => {
        calls += 1;
        if (failure === 'network') throw new TypeError('socket closed');
        if (failure === 'body') {
          const stream = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('{"Code":0'));
            controller.error(new Error('response body reset'));
          } });
          return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('upstream unavailable', { status: 503 });
      },
    });
    await assert.rejects(managed.action('CreateMemorySdk', { MemoryCollectionId: 'memory-fixture' }), error => {
      assert.equal(error.code, failure === 'body' ? 'MANAGED_RESOURCE_RESPONSE_INVALID' : 'MANAGED_RESOURCE_SERVER_UNAVAILABLE');
      if (failure !== 'body') assert.equal(error.attempts, 1);
      return true;
    });
    assert.equal(calls, 1, `expected one write attempt for ${failure}`);
  }
});

test('the retry ceiling is configurable and invalid policy values fail fast', async () => {
  let calls = 0;
  const managed = client(async () => { calls += 1; return new Response('unavailable', { status: 503 }); },
    { maxAttempts: 2 });
  await assert.rejects(managed.action('RetrieveKnowledge'), { code: 'MANAGED_RESOURCE_SERVER_UNAVAILABLE', attempts: 2 });
  assert.equal(calls, 2);
  assert.throws(() => createManagedResourceClient({ runtime, env, maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createManagedResourceClient({ runtime, env, retryDelaysMs: [1, -1] }), /retryDelaysMs/);
});

test('an outer cancellation during backoff stops the request without another attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  const managed = createManagedResourceClient({ runtime, env, retryDelaysMs: [200],
    fetchImpl: async () => {
      calls += 1;
      setTimeout(() => controller.abort(), 5);
      return new Response('unavailable', { status: 503 });
    } });
  await assert.rejects(managed.action('RetrieveKnowledge', {}, { signal: controller.signal }),
    { code: 'REQUEST_CANCELLED' });
  assert.equal(calls, 1);
});
