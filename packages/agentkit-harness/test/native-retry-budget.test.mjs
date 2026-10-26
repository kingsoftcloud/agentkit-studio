import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configure, canonical, NativeKernel } from '../../agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';

const identity = {
  scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
  sessionId: 'retry-session', runId: 'retry-run', turnId: 'turn', buildId: 'build',
  parentRunId: null, taskChainId: 'chain',
};
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

async function setup(t, response, limits = {}, profile = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-retry-budget-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const next = response(requests.length);
    res.writeHead(next.status ?? 200, { 'content-type': 'application/json', ...next.headers });
    res.end(JSON.stringify(next.body ?? { error: { message: 'fixture failure' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const database = join(directory, 'runs.sqlite');
  const stores = [];
  let now = 10_000;
  const config = configure({
    profile: { profileId: 'local', profileVersion: '1', providerFamily: 'openai-compatible',
      compatibilityDigest: 'a'.repeat(64), providerReplayMode: 'none', maxOutputTokens: 128,
      contextWindow: 4096, requestTimeoutMs: 3000, maxProviderRetries: 9, maxRetries: 9,
      retryInitialDelayMs: 100, retryMaxDelayMs: 100, rateLimitCooldownMs: 100, ...profile },
    contract: { objective: 'Exercise the shared task budget' },
    limits: { maxModelCalls: 3, finalizationReserveModelCalls: 0, maxWallMs: 60_000, ...limits },
    hostBindingDigest: 'local-http-retry-budget/v1',
  });
  const open = () => {
    const store = new SqliteRunStore(database); stores.push(store);
    const kernel = new NativeKernel({ store, owner: `worker-${stores.length}`, digest,
      now: () => now, random: () => 0,
      ports: { model: createNativeModelPort({ resolveProfile: async () => ({
        protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'local-fixture-key', model: 'fixture',
      }) }), tools: { execute: async () => { throw Error('No tools admitted'); } } },
    });
    return { store, kernel };
  };
  const step = kernel => kernel.runUntilIdle(identity.scope, identity.runId, { waitForRetry: false });
  t.after(async () => {
    for (const store of stores) store.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { open, step, requests, config, advance: ms => { now += ms; } };
}

test('real HTTP retry kinds share one durable model-call budget across cold reopen', async t => {
  const fixture = await setup(t, attempt => attempt % 2
    ? { status: 429, headers: { 'retry-after': '0' } }
    : { body: { id: 'empty', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] } });
  let { store, kernel } = fixture.open();
  kernel.start(identity, fixture.config);
  let snapshot = await fixture.step(kernel);
  assert.equal(fixture.requests.length, 1, 'adapter does not retry behind the kernel');
  assert.equal(snapshot.usage.modelCalls, 1);
  assert.equal(snapshot.providerErrors, 1);
  assert.ok(snapshot.retryNotBefore > 10_000);
  store.close();
  ({ store, kernel } = fixture.open());
  snapshot = await fixture.step(kernel);
  assert.equal(fixture.requests.length, 1, 'cold worker honors persisted retry delay');
  fixture.advance(101);
  snapshot = await fixture.step(kernel);
  assert.equal(fixture.requests.length, 2);
  assert.equal(snapshot.modelErrors, 1, 'empty output is a distinct retry kind');
  fixture.advance(101);
  snapshot = await fixture.step(kernel);
  assert.equal(snapshot.usage.modelCalls, 3);
  fixture.advance(101);
  snapshot = await fixture.step(kernel);
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.outcome, 'budget_exhausted');
  assert.equal(snapshot.reason, 'model_budget_exhausted');
  assert.equal(fixture.requests.length, 3, 'separate error counters cannot multiply the shared cap');
  assert.equal(store.load(identity.scope, identity.runId).snapshot.usage.modelCalls, 3);
});

test('shared wall budget wins over a provider Retry-After without another HTTP attempt', async t => {
  const fixture = await setup(t, () => ({ status: 429, headers: { 'retry-after': '30' } }), { maxWallMs: 500 });
  const { store, kernel } = fixture.open(); kernel.start(identity, fixture.config);
  const driving = kernel.runUntilIdle(identity.scope, identity.runId);
  const deadline = Date.now() + 3000;
  while (!store.load(identity.scope, identity.runId).snapshot.retryNotBefore && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.load(identity.scope, identity.runId).snapshot.retryNotBefore, 40_000);
  // Advance the active worker's monotonic clock while it owns the retry wait.
  fixture.advance(501);
  const done = await driving;
  assert.equal(done.phase, 'failed');
  assert.equal(done.outcome, 'budget_exhausted');
  assert.equal(fixture.requests.length, 1);
  assert.equal(done.usage.modelCalls, 1);
});

test('cancelling a persisted provider wait does not dispatch another HTTP request', async t => {
  const fixture = await setup(t, () => ({ status: 503 }));
  const { kernel } = fixture.open(); kernel.start(identity, fixture.config);
  await fixture.step(kernel);
  kernel.submit(identity.scope, identity.runId, { commandId: 'user-stop', kind: 'cancel', payload: {} });
  const done = await fixture.step(kernel);
  assert.equal(done.phase, 'canceled');
  assert.equal(done.reason, 'user_canceled');
  assert.equal(fixture.requests.length, 1);
});
