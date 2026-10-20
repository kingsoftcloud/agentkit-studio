import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-host-unit-'));
  const agents = createAgentStore({ storeDir: root }), ledger = new MemoryRunStore();
  const record = await agents.create({ name: 'Native', runtimeType: 'harness', bindings: { modelProfileIds: ['fixture'] } });
  const events = [], definitions = new Map(), requests = [];
  let apiKey = 'secret-one', unregisters = 0;
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned', baseUrl: 'https://model.invalid/v1' }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: apiKey }) } });
  const session = { id: 'session', append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 });
  const services = { sessions: { flush: async () => true }, llm: {}, sessionProjections: {
    register(definition) { definitions.set(definition.key, definition); return () => { definitions.delete(definition.key); unregisters++; }; },
    stateOf(_session, id) { const definition = definitions.get(id); return events.reduce(definition.apply, definition.init()); },
  } };
  const ctx = { get: id => services[id] };
  const resolutions = [], builds = { resolve: async (agentId, buildId) => {
    resolutions.push({ agentId, buildId }); return structuredClone(record);
  } };
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot: root, agents, builds, models, ledger,
    renderPrompt: () => 'Trusted Host instructions', fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(`data: ${JSON.stringify({ id: `response-${requests.length}`, choices: [{ index: 0, delta: { content: 'Complete' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent: { session, options: { provider: 'agentkit-studio-fixture', model: 'pinned' } },
    input: { kind: 'enter', messages: [{ id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish' }] }], assembly: { tools: [] } },
    turn: 1, signal: new AbortController().signal, prepareInput: async () => undefined,
    binding: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1',
      nativeTools: { definitions: () => [], forAgent: () => ({ tools: { execute: async () => assert.fail('No tool dispatched') } }) } } };
  const head = () => {
    const scope = { tenantId: 'local', workspaceId: ledgerScope(), userId: 'local-user', agentId: record.metadata.id };
    return ledger.sessionHead(scope, 'session');
  };
  // The workspace identity is public deterministic configuration, not a path
  // read from user input. Keep the hash identical to production's scope key.
  const ledgerScope = () => createHash('sha256').update(JSON.stringify(root)).digest('hex');
  return { host, payload, record, agents, builds, resolutions, models, values, requests, ledger, head, events,
    rotate: key => { apiKey = key; }, unregisters: () => unregisters };
}
test('Studio Native Host pins revision/input/model while refreshing credentials outside its ledger', async t => {
  const fixture = await setup(t);
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.equal(new Headers(fixture.requests[0].options.headers).get('authorization'), 'Bearer secret-one');
  const run = fixture.head();
  assert.equal(run.phase, 'completed');
  assert.equal(JSON.stringify(fixture.ledger.load(run.scope, run.runId)).includes('secret-one'), false);
  fixture.rotate('secret-two');
  fixture.payload.agent.session.append('turn/start', { turn: 2 });
  await fixture.host.executeTurn({ ...fixture.payload, turn: 2 });
  assert.equal(new Headers(fixture.requests[1].options.headers).get('authorization'), 'Bearer secret-two');
  assert.equal(fixture.head().parentRunId, run.runId);
  assert.equal(JSON.stringify(fixture.ledger.load(run.scope, fixture.head().runId)).includes('secret-two'), false);
});
test('Studio Native rejects missing public turn capability and unbound models before creating a run', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.host.executeTurn({ ...fixture.payload, prepareInput: undefined }), /studio_native_whole_turn_host_required/);
  fixture.payload.agent.options.model = 'unbound';
  fixture.models.catalog = async () => ({ items: [] });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_bound_model_unavailable/);
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
test('Studio Native resolves Frozen Build authority instead of reading a mutable agent draft', async t => {
  const fixture = await setup(t);
  fixture.payload.binding.buildId = 'frozen-build';
  fixture.agents.getRevision = async () => assert.fail('Frozen execution cannot read a draft');
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(fixture.resolutions, [{ agentId: fixture.record.metadata.id, buildId: 'frozen-build' }]);
  assert.equal(fixture.head().buildId, 'frozen-build');
});
test('a changed Frozen revision and a mid-run model binding cannot dispatch an HTTP request', async t => {
  const frozen = await setup(t);
  frozen.payload.binding.buildId = 'build';
  frozen.builds.resolve = async () => ({ ...frozen.record, metadata: { ...frozen.record.metadata, revision: 2 } });
  await assert.rejects(frozen.host.executeTurn(frozen.payload), /studio_native_revision_binding_changed/);
  assert.equal(frozen.requests.length, 0); assert.equal(frozen.head(), null);
  const changed = await setup(t), original = changed.models.profile;
  let lookups = 0;
  changed.models.profile = async id => {
    const profile = await original(id); return ++lookups > 1 ? { ...profile, baseUrl: 'https://changed.invalid/v1' } : profile;
  };
  await assert.rejects(changed.host.executeTurn(changed.payload), { code: 'NATIVE_TURN_FAILED', nativeReason: 'provider_terminal_error' });
  assert.equal(changed.requests.length, 0);
  const snapshot = changed.head(), receipts = changed.ledger.load(snapshot.scope, snapshot.runId).receipts;
  assert.equal(receipts[0].result.failureKind, 'host_error');
});
test('Studio Native close is idempotent and retires its projection exactly once', async t => {
  const fixture = await setup(t);
  const first = fixture.host.close(), second = fixture.host.close();
  assert.equal(first, second); await first;
  assert.equal(fixture.unregisters(), 1);
  assert.throws(() => fixture.host.executeTurn(fixture.payload), /studio_native_host_closed/);
});
