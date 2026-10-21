import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRunStore } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { studioBrowserDefinition } from '../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';
import { buildExecutionEngine } from '../src/build-engine.mjs';

async function setup(t, { spec = {}, profile = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-host-unit-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root }), ledger = new MemoryRunStore();
  const record = await agents.create({ name: 'Native', runtimeType: 'harness', spec: { ...spec, bindings: { modelProfileIds: ['fixture'] } } });
  const events = [], definitions = new Map(), requests = [];
  let apiKey = 'secret-one', unregisters = 0;
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned', baseUrl: 'https://model.invalid/v1', ...profile }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) }, credentials: { resolve: async () => ({ value: apiKey }) } });
  const session = { id: 'session', append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 });
  const services = { sessions: { flush: async () => true }, llm: {}, sessionProjections: {
    register(definition) { definitions.set(definition.key, definition); return () => { definitions.delete(definition.key); unregisters++; }; },
    stateOf(_session, id) { const definition = definitions.get(id); return events.reduce(definition.apply, definition.init()); },
  } };
  const ctx = { get: id => services[id] };
  const resolutions = [], builds = { resolve: async (agentId, buildId) => {
    resolutions.push({ agentId, buildId }); return { ...structuredClone(record),
      executionEngine: buildExecutionEngine(record.spec, 'agentkit.native-dsh-turn/v1') };
  } };
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, builds, models, ledger,
    renderPrompt: () => 'Trusted Host instructions', fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(`data: ${JSON.stringify({ id: `response-${requests.length}`, choices: [{ index: 0, delta: { content: 'Complete' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const payload = { agent: { session, options: { provider: 'agentkit-studio-fixture', model: 'pinned' } },
    input: { kind: 'enter', messages: [{ id: 'input-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Finish' }] }], assembly: { tools: [] } },
    turn: 1, signal: new AbortController().signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly: payload.input.assembly }),
    binding: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1',
      nativeTools: { definitions: () => [], forAgent: () => ({ tools: { execute: async () => assert.fail('No tool dispatched') } }) } } };
  const head = () => {
    const scope = { tenantId: 'local', workspaceId: ledgerScope(), userId: 'local-user', agentId: record.metadata.id };
    return ledger.sessionHead(scope, 'session');
  };
  // The workspace identity is public deterministic configuration, not a path
  // read from user input. Keep the hash identical to production's scope key.
  const ledgerScope = () => createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex');
  return { host, payload, record, agents, builds, resolutions, models, values, requests, ledger, head, events, services,
    rotate: key => { apiKey = key; }, unregisters: () => unregisters };
}
test('Studio Native Host pins revision/input/model while refreshing credentials outside its ledger', async t => {
  const fixture = await setup(t);
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.equal(new Headers(fixture.requests[0].options.headers).get('authorization'), 'Bearer secret-one');
  const run = fixture.head();
  assert.equal(run.phase, 'completed');
  assert.equal(run.verification.checks[0].verifierId, 'studio.delivery-evidence-rejection');
  assert.equal(run.verification.checks[0].status, 'not_run');
  assert.match(run.verification.checks[0].evidenceRefs[0], /^artifact:/);
  assert.equal(run.outcome, 'unverified');
  assert.equal(JSON.stringify(fixture.ledger.load(run.scope, run.runId)).includes('secret-one'), false);
  fixture.rotate('secret-two');
  fixture.payload.agent.session.append('turn/start', { turn: 2 });
  await fixture.host.executeTurn({ ...fixture.payload, turn: 2 });
  assert.equal(new Headers(fixture.requests[1].options.headers).get('authorization'), 'Bearer secret-two');
  assert.equal(fixture.head().parentRunId, run.runId);
  assert.equal(JSON.stringify(fixture.ledger.load(run.scope, fixture.head().runId)).includes('secret-two'), false);
});
test('Studio Host releases the revision-bound resources with the settled Run identity', async t => {
  const fixture = await setup(t), releases = [];
  fixture.payload.binding.nativeTools.releaseSession = request => {
    assert.equal(fixture.head().phase, 'completed'); releases.push(request);
  };
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(releases, [{ scope: fixture.head().scope, runId: fixture.head().runId, sessionId: 'session' }]);
});
test('Studio Native pins its browser task policy and explicit execution limits in the Run configuration', async t => {
  const fixture = await setup(t, { spec: { execution: { nativeLimits: { maxModelCalls: 20, maxToolCalls: 0 } } } });
  fixture.payload.binding.nativeTools.definitions = () => [studioBrowserDefinition()];
  await fixture.host.executeTurn(fixture.payload);
  const run = fixture.head(), config = fixture.ledger.load(run.scope, run.runId).configuration;
  assert.equal(config.workspaceObservationPolicy.role, 'browser');
  assert.ok(config.workspaceObservationPolicy.pathSuffixes.includes('.tsx'));
  assert.equal(config.limits.maxModelCalls, 20); assert.equal(config.limits.maxToolCalls, 0);
  assert.equal(config.limits.verificationReserveModelCalls, 4);
  assert.equal(config.limits.browserObservationIntervalToolCalls, 12);
});
test('Studio Native rejects missing public turn capability and unbound models before creating a run', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.host.executeTurn({ ...fixture.payload, prepareInput: undefined }), /studio_native_whole_turn_host_required/);
  fixture.payload.agent.options.model = 'unbound';
  fixture.models.catalog = async () => ({ items: [] });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_bound_model_unavailable/);
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
test('Studio Native uses the admitted SessionController model selection instead of stale creation options', async t => {
  const fixture = await setup(t);
  fixture.payload.agent.options = { provider: 'old-default', model: 'old-default' };
  fixture.payload.input.assembly.variables = { provider: 'agentkit-studio-fixture', model: 'pinned' };
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.equal(JSON.parse(fixture.requests[0].options.body).model, 'pinned');
  assert.equal(fixture.ledger.load(fixture.head().scope, fixture.head().runId).configuration.profile.profileId, 'fixture');
});
test('an unbound or malformed admitted model cannot fall back to the creation default', async t => {
  const fixture = await setup(t); fixture.models.catalog = async () => ({ items: [] });
  for (const variables of [{ provider: 'unbound', model: 'pinned' }, { provider: 'agentkit-studio-fixture', model: 'unbound' }, { model: null }]) {
    fixture.payload.input.assembly.variables = variables;
    await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_(bound_model_unavailable|model_selection_invalid)/);
  }
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
test('Studio Native refuses a legacy Frozen Build before creating a run or contacting a model', async t => {
  const fixture = await setup(t); fixture.payload.binding.buildId = 'legacy-build';
  fixture.builds.resolve = async () => structuredClone(fixture.record);
  await assert.rejects(fixture.host.executeTurn(fixture.payload), /studio_native_build_engine_mismatch/);
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
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
  const snapshot = changed.head(), record = changed.ledger.load(snapshot.scope, snapshot.runId);
  const receipts = record.receipts.filter(receipt => record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind === 'model');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].result.failureKind, 'host_error');
});
test('Studio Native close is idempotent and retires its projection exactly once', async t => {
  const fixture = await setup(t);
  const first = fixture.host.close(), second = fixture.host.close();
  assert.equal(first, second); await first;
  assert.equal(fixture.unregisters(), 1);
  assert.throws(() => fixture.host.executeTurn(fixture.payload), /studio_native_host_closed/);
});
test('Studio Native admits live typed input through Host policy and trusted attachment resolution', async t => {
  const fixture = await setup(t), steps = [], reads = [];
  fixture.services.attachments = { readImageRequest: async ref => {
    reads.push(ref); return { mediaType: 'image/png', data: Uint8Array.of(1, 2) };
  } };
  const content = [{ type: 'text', text: 'Use the new image' }, { type: 'image', attachment: { attachmentId: 'host-admitted-image' } }];
  fixture.payload.prepareInput = async step => {
    steps.push(step);
    const run = fixture.head(), record = fixture.ledger.load(run.scope, run.runId);
    assert.equal(record.intents.find(intent => intent.operationKey === run.pendingIntent)?.kind, 'input');
    assert.equal(record.intents.find(intent => intent.operationKey === run.pendingIntent)?.status, 'running');
    return { kind: 'enter', assembly: fixture.payload.input.assembly, messages: step === 2
      ? [{ id: 'steering-image', role: 'user', source: { kind: 'user' }, content },
        { id: 'host-context', role: 'user', source: { kind: 'tool', callId: 'already-host-owned' }, content: [{ type: 'text', text: 'Host-owned context' }] }] : [] };
  };
  await fixture.host.executeTurn(fixture.payload);
  assert.deepEqual(steps, [2, 3]); assert.equal(fixture.requests.length, 2); assert.equal(reads.length, 1);
  const messages = JSON.parse(fixture.requests[1].options.body).messages;
  assert.deepEqual(messages.at(-2).content, [{ type: 'text', text: 'Use the new image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=', detail: 'auto' } }]);
  const delivered = fixture.events.filter(event => event.type === 'user/message' && event.data.content[0]?.text === 'Use the new image');
  assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].data.content, content);
  const context = fixture.events.find(event => event.type === 'user/message' && event.data.content[0]?.text === 'Host-owned context');
  assert.deepEqual(context.data.source, { kind: 'tool', callId: 'already-host-owned' });
  assert.equal(fixture.head().goal, 'Finish');
});
test('Studio Native respects a pre-step rejection without reporting the stale candidate as completion', async t => {
  const fixture = await setup(t);
  fixture.payload.prepareInput = async () => ({ kind: 'reject' });
  assert.deepEqual(await fixture.host.executeTurn(fixture.payload), { reason: { kind: 'blocked' } });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.head().outcome, 'blocked'); assert.equal(fixture.head().reason, 'host_input_rejected');
  assert.equal(fixture.head().finalText, '');
});
for (const changed of ['tool binding', 'request series', 'model selection']) test(`Studio Native refuses a changed ${changed} during input admission`, async t => {
  const fixture = await setup(t);
  fixture.payload.binding.nativeTools.definitions = (_agent, tools) => tools;
  fixture.payload.prepareInput = async () => ({ kind: 'enter', messages: [],
    ...(changed === 'request series' ? { startsRequestSeries: true } : {}), assembly: {
      tools: changed === 'tool binding' ? [{ name: 'unexpected' }] : [],
      ...(changed === 'model selection' ? { variables: { provider: 'agentkit-studio-fixture', model: 'changed-after-admission' } } : {}),
    } });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), { code: 'NATIVE_TURN_FAILED', nativeReason: 'effect_outcome_unknown' });
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.head().phase, 'interrupted');
  const run = fixture.head();
  assert.equal(fixture.ledger.load(run.scope, run.runId).receipts.at(-1).result.code,
    changed === 'request series' ? 'studio_native_request_series_rebind_required' : 'studio_native_input_binding_changed');
});
test('Studio Native close during a stalled input claim fences late admission', async t => {
  const fixture = await setup(t);
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; }), late = new Promise(resolve => { finish = resolve; });
  fixture.payload.prepareInput = async () => { enter(); await late; return { kind: 'enter', messages: [], assembly: fixture.payload.input.assembly }; };
  const running = fixture.host.executeTurn(fixture.payload);
  const rejected = assert.rejects(running, /Studio Native host closed/);
  await entered; await fixture.host.close(); await rejected;
  assert.equal(fixture.head().phase, 'canceled'); assert.equal(fixture.requests.length, 1);
  const run = fixture.head(), before = fixture.ledger.load(run.scope, run.runId);
  assert.ok(before.receipts.some(receipt => receipt.status === 'uncertain'));
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.ledger.load(run.scope, run.runId), before);
});
test('Studio Native binds context/output budgets and the production counter from the Frozen Build', async t => {
  const fixture = await setup(t, { spec: { context: { maxInputTokens: 5000, reserveOutputTokens: 1000,
    compaction: { enabled: false, thresholdRatio: .6 } } }, profile: { contextWindow: 4000, maxOutputTokens: 2000 } });
  fixture.payload.binding.buildId = 'fixed-context-build';
  fixture.agents.getRevision = async () => assert.fail('Read the Frozen Build, not the mutable draft');
  await fixture.host.executeTurn(fixture.payload);
  const run = fixture.head(), configuration = fixture.ledger.load(run.scope, run.runId).configuration;
  assert.equal(configuration.profile.contextWindow, 4000); assert.equal(configuration.profile.maxOutputTokens, 1000);
  assert.equal(configuration.contextPolicy.enabled, false); assert.equal(configuration.contextPolicy.triggerRatio, .6);
  assert.match(configuration.contextPolicy.tokenizerId, /cjk-ascii-estimate-125-wire-image/);
  assert.equal(JSON.parse(fixture.requests[0].options.body).max_tokens, 1000);
  assert.ok(fixture.ledger.load(run.scope, run.runId).receipts.some(receipt => receipt.result.admission?.countedInputTokens > 0));
});
test('Studio Native refuses an over-budget request before HTTP when compaction is disabled', async t => {
  const fixture = await setup(t, { spec: { context: { maxInputTokens: 3000, reserveOutputTokens: 128, compaction: { enabled: false } } } });
  fixture.payload.input.messages[0].content[0].text = '中文上下文'.repeat(1000);
  await assert.rejects(fixture.host.executeTurn(fixture.payload), { code: 'NATIVE_TURN_FAILED', nativeReason: 'context_compaction_disabled' });
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.head().usage.modelCalls, 0);
});
test('Studio Native keeps an image-only admission with its independent objective through context planning', async t => {
  const fixture = await setup(t, { spec: { context: { compaction: { thresholdRatio: .001 } } } });
  fixture.services.attachments = { readImageRequest: async () => ({ mediaType: 'image/png', data: Uint8Array.of(1) }) };
  fixture.payload.input.messages[0].content = [{ type: 'image', attachment: { attachmentId: 'image-only' } }];
  await fixture.host.executeTurn(fixture.payload);
  assert.equal(fixture.requests.length, 1);
  assert.ok(JSON.parse(fixture.requests[0].options.body).messages.some(message => Array.isArray(message.content)
    && message.content.some(block => block.type === 'image_url')));
  assert.equal(fixture.head().goal, 'Inspect the attached input and respond to the user.');
});
for (const [context, code] of [
  [{ maxInputTokens: 1000, reserveOutputTokens: 1000 }, 'studio_native_context_budget_conflict'],
  [{ maxInputTokens: '4000' }, 'studio_native_context_budget_invalid'],
  [{ compaction: { thresholdRatio: 0 } }, 'invalid_context_policy'],
  [{ compaction: { pruneToolResults: true } }, 'studio_native_compaction_option_unsupported'],
]) test(`Studio Native rejects an invalid or unsupported context contract: ${JSON.stringify(context)}`, async t => {
  const fixture = await setup(t, { spec: { context } });
  await assert.rejects(fixture.host.executeTurn(fixture.payload), { code });
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.head(), null);
});
