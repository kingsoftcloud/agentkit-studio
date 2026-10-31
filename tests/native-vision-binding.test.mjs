import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeKernel, configure, emptyUsage, canonical, copy, addUsage,
} from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { createStudioNativeVisionBinding, STUDIO_NATIVE_VISION_BINDING } from '../src/providers/native-vision-binding.mjs';

const DATA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';

function makeImageBlock() { return { type: 'image_url', image_url: { url: DATA_PNG, detail: 'auto' } }; }
function makeVisionProfile() {
  return { profileId: 'vision-1', profileVersion: 'sha256:abc', compatibilityDigest: 'sha256:abc',
    providerFamily: 'openai-chat', imageInputMode: 'native', contextWindow: 16000, maxOutputTokens: 1024 };
}
function makeDeterministicBrowser() {
  return {
    execute: async (req) => ({
      status: 'ok', content: { status: 'ok', text: 'Page loaded' },
      context: { content: canonical({ status: 'ok' }), media: [makeImageBlock()] },
      resourceUsage: { modelCalls: 0, toolCalls: 1, cost: 0 },
    }),
    recoverSessions: async () => [], releaseSession: async () => {},
  };
}
function makeRealModelPort() {
  return createNativeModelPort({
    resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: 'https://v.invalid/v1', apiKey: 'k', model: 'm', parameters: {} }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      return new Response(
        `data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta: { content: 'Login form visible.' }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n` +
        `data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
}
function buildConfig(tools) {
  const base = fixture().config;
  return configure({ ...base, instructions: 'Answer.', contract: { ...base.contract, objective: 'Task' },
    inputMessages: [{ role: 'user', kind: 'user_input', content: 'Task' }], tools, contextSources: [],
    limits: { ...base.limits, maxRepairs: 0, maxModelCalls: 10, maxToolCalls: 10, effectTimeoutMs: 120000 } });
}
function makeBrowserToolDef() {
  return { name: 'browser_inspect_workspace', description: 'Browser', parameters: { type: 'object', properties: {}, additionalProperties: true },
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 60000,
    contextRole: 'none', observationRole: 'browser', progressObservation: false, contextRetention: 'normal' };
}
function makeRequest(overrides = {}) {
  return { call: { callId: 'c1', name: 'browser_inspect_workspace', arguments: { action: 'screenshot', path: 'app' } },
    definition: { name: 'browser_inspect_workspace' }, operationKey: 'op-1',
    scope, runId: 'run-1', sessionId: 'session', turnId: '1', buildId: 'revision-x',
    parentRunId: null, taskChainId: 'session', executionFence: 1, signal: new AbortController().signal,
    interaction: null, budget: { maxModelCallsRemaining: 3, parentFinalizationReserved: true, maxToolCallsRemaining: 5, depth: 0, maxDepth: 3 }, ...overrides };
}

// ---- Unit tests ----

test('binding is frozen pure JSON', () => {
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 's', store: { load: () => null }, model: { generate: async () => ({}) }, profile: makeVisionProfile() });
  assert.equal(vb.contract, STUDIO_NATIVE_VISION_BINDING);
  assert.equal(vb.binding.contract, STUDIO_NATIVE_VISION_BINDING);
  assert.ok(Object.isFrozen(vb.binding));
  assert.ok(vb.binding.profileDigest.startsWith('sha256:'));
});

test('profile must have imageInputMode=native (no OR fallback)', () => {
  const p = makeVisionProfile(); p.imageInputMode = 'text';
  assert.throws(() => createStudioNativeVisionBinding({ scope, sessionId: 's', store: { load: () => null }, model: { generate: async () => ({}) }, profile: p }), /image_invalid/);
});

test('close invalidates wrappers: execute after close throws', async () => {
  const browser = makeDeterministicBrowser();
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store: { load: () => null }, model: makeRealModelPort(), profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(browser);
  vb.close();
  await assert.rejects(wrapped.execute(makeRequest()), /vision_binding_closed|vision_guard_failed|aborted/i);
});

test('close does NOT close parent browser port', () => {
  let browserClosed = false;
  const toolsPort = { execute: async () => ({}), close: () => { browserClosed = true; } };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 's', store: { load: () => null }, model: { generate: async () => ({}) }, profile: makeVisionProfile() });
  vb.wrapTools(toolsPort);
  vb.close();
  assert.equal(browserClosed, false, 'parent browser NOT closed');
});

test('external isClosed feeds into authority', async () => {
  let extClosed = false;
  const browser = makeDeterministicBrowser();
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store: { load: () => null }, model: makeRealModelPort(), profile: makeVisionProfile(), isClosed: () => extClosed });
  const wrapped = vb.wrapTools(browser);
  // Before close: execute should work (authority may still reject due to no real run, but not due to isClosed).
  extClosed = true;
  await assert.rejects(wrapped.execute(makeRequest()), /vision_binding_closed|vision_guard_failed/i);
  vb.close();
});

test('close is idempotent', () => {
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 's', store: { load: () => null }, model: { generate: async () => ({}) }, profile: makeVisionProfile() });
  vb.close(); vb.close();
});

test('wrapTools: non-browser tools pass through without vision model call', async () => {
  let visionCalled = false, otherCalled = false;
  const toolsPort = { execute: async (req) => {
    if (req.call.name === 'other_tool') { otherCalled = true; return { status: 'ok', content: {} }; }
    return makeDeterministicBrowser().execute(req);
  }, recoverSessions: async () => [], releaseSession: async () => {} };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store: { load: () => null }, model: { generate: async () => { visionCalled = true; return { kind: 'final_candidate', text: '', toolCalls: [], usage: emptyUsage() }; } }, profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(toolsPort);
  await wrapped.execute({ ...makeRequest(), call: { callId: 'o1', name: 'other_tool', arguments: {} }, definition: { name: 'other_tool' } });
  assert.ok(otherCalled); assert.equal(visionCalled, false);
  vb.close();
});

test('wrapTools preserves recoverSessions and releaseSession', async () => {
  let recovered = false, released = false;
  const toolsPort = { execute: async () => ({}), recoverSessions: async () => { recovered = true; return []; }, releaseSession: async () => { released = true; } };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store: { load: () => null }, model: { generate: async () => ({}) }, profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(toolsPort);
  await wrapped.recoverSessions({ scope, sessionId: 'session' });
  await wrapped.releaseSession({ scope, sessionId: 'session' });
  assert.ok(recovered); assert.ok(released);
  vb.close();
});

test('rejects invalid scope', () => {
  assert.throws(() => createStudioNativeVisionBinding({ scope: { tenantId: '' }, sessionId: 's', store: { load: () => null }, model: { generate: async () => ({}) }, profile: makeVisionProfile() }), /scope_invalid/);
});

test('foreign scope rejected by ToolAuthority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vb-')); // not cleaning up here, small
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const browser = makeDeterministicBrowser();
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, model: makeRealModelPort(), profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(browser);
  const foreignReq = { ...makeRequest(), scope: { ...scope, agentId: 'foreign' } };
  await assert.rejects(wrapped.execute(foreignReq), /vision_guard_failed|authority|scope/i);
  vb.close(); store.close(); rmSync(root, { recursive: true, force: true });
});

// ---- Real Kernel + SQLite + ToolAuthority + ModelPort integration ----

test('real Kernel: vision caption in SQLite receipt, modelCalls=1, snapshot usage', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vb-k1-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
  const browser = makeDeterministicBrowser();
  const toolsPort = { execute: async (req) => browser.execute(req), recoverSessions: async () => [], releaseSession: async () => {} };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, model: makeRealModelPort(), profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(toolsPort); t.after(() => vb.close());
  const config = buildConfig([makeBrowserToolDef()]);
  const ports = {
    context: { tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1', countRequest: async () => 10, countText: async () => 5 }, prepare: async (r) => ({ messages: r.snapshot.messages, context: {} }) },
    model: { generate: async (req) => {
      if (req.messages.filter(m => m.role === 'tool').length === 0) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'bc1', name: 'browser_inspect_workspace', arguments: { action: 'screenshot', path: 'app' } }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async (req) => wrapped.execute(req) },
  };
  const kernel = new NativeKernel({ store, ports, digest, owner: 'test' });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, config);
  const snap = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snap.phase, 'completed', `${snap.phase} ${snap.reason}`);
  const record = store.load(scope, 'run');
  const receipt = record.receipts.find(r => r.result?.results?.some(res => res.content?.vision_description));
  assert.ok(receipt, 'vision caption in SQLite receipt');
  const result = receipt.result.results.find(res => res.content?.vision_description);
  assert.equal(result.content.vision_description, 'Login form visible.');
  assert.equal(result.content.vision_description_trust, 'untrusted_model_output');
  assert.equal(result.resourceUsage.modelCalls, 1);
  assert.equal(snap.descendantUsage.modelCalls, 1);
});

test('SQLite close/reopen: receipt persists, no duplicate model call', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vb-k2-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(dbPath);
  let modelCalls = 0;
  const modelPort = makeRealModelPort();
  const browser = makeDeterministicBrowser();
  const toolsPort = { execute: async (req) => browser.execute(req) };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, model: { generate: async (req) => { modelCalls++; return modelPort.generate(req, () => {}); } }, profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(toolsPort);
  const config = buildConfig([makeBrowserToolDef()]);
  const ports = {
    context: { tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1', countRequest: async () => 10, countText: async () => 5 }, prepare: async (r) => ({ messages: r.snapshot.messages, context: {} }) },
    model: { generate: async (req) => {
      if (req.messages.filter(m => m.role === 'tool').length === 0) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'bc1', name: 'browser_inspect_workspace', arguments: { action: 'screenshot' } }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async (req) => wrapped.execute(req) },
  };
  const kernel = new NativeKernel({ store, ports, digest, owner: 'test' });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, config);
  const snap = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snap.phase, 'completed');
  assert.equal(modelCalls, 1);
  vb.close(); store.close();
  store = new SqliteRunStore(dbPath); t.after(() => store.close());
  const record = store.load(scope, 'run');
  const receipt = record.receipts.find(r => r.result?.results?.some(res => res.content?.vision_description));
  assert.ok(receipt, 'receipt persisted after reopen');
  const original = canonical(record);
  const cold = new NativeKernel({ store, ports: { ...ports,
    model: { generate: () => assert.fail('completed Run cannot dispatch a new main model') },
    tools: { execute: () => assert.fail('completed Run cannot dispatch the browser/vision again') } }, digest, owner: 'cold' });
  assert.equal((await cold.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(canonical(store.load(scope, 'run')), original);
  assert.equal(modelCalls, 1, 'no duplicate call on resumed completed Run');
});

// Browser transport is deterministic; execution intent, lease, definition,
// operation key and receipts are the real NativeKernel/SQLite authority.
for (const drift of ['extra', 'signal', 'call', 'budget', 'interaction', 'definition', 'fence']) {
  test(`full original request stays locked while the browser awaits: ${drift}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'vb-drift-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
    let original, modelCalls = 0, browserCalls = 0;
    const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, profile: makeVisionProfile(),
      model: { generate: async () => { modelCalls++; return { kind: 'final_candidate', text: 'Caption', usage: emptyUsage() }; } } });
    t.after(() => vb.close());
    const wrapped = vb.wrapTools({ execute: async request => {
      browserCalls++;
      await Promise.resolve();
      if (drift === 'extra') original.futureContext = { revision: 2 };
      if (drift === 'signal') original.signal = new AbortController().signal;
      if (drift === 'call') original.call.arguments.path = 'foreign';
      if (drift === 'budget') original.budget.maxDepth++;
      if (drift === 'interaction') original.interaction = { foreign: true };
      if (drift === 'definition') original.definition.description = 'foreign';
      if (drift === 'fence') original.executionFence++;
      return makeDeterministicBrowser().execute(request);
    } });
    const ports = { model: { generate: async request => request.messages.some(message => message.role === 'tool')
      ? { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }
      : { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'browser', name: 'browser_inspect_workspace', arguments: { path: 'app' } }], usage: emptyUsage() } },
      tools: { execute: async request => { original = request; request.futureContext = { revision: 1 }; return wrapped.execute(request); } } };
    const kernel = new NativeKernel({ store, ports, digest, owner: 'drift' });
    kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, buildConfig([makeBrowserToolDef()]));
    await kernel.runUntilIdle(scope, 'run');
    assert.equal(browserCalls, 1); assert.equal(modelCalls, 0, 'drift cannot dispatch a caption model');
    const results = store.load(scope, 'run').receipts.flatMap(receipt => receipt.result?.results ?? []);
    assert.deepEqual(results, [{ status: 'uncertain', content: { code: 'tool_outcome_unknown' } }]);
    assert.equal(store.load(scope, 'run').snapshot.phase, 'interrupted');
    assert.equal(store.load(scope, 'run').snapshot.reason, 'effect_outcome_unknown');
    assert.equal(results.some(result => result.content?.vision_description), false);
    await kernel.runUntilIdle(scope, 'run');
    assert.equal(browserCalls, 1, 'unknown browser effect is not automatically repeated');
    assert.equal(modelCalls, 0);
  });
}

test('strict asynchronous isClosed is observed and rejected before browser dispatch', async () => {
  let calls = 0;
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store: { load: () => null },
    profile: makeVisionProfile(), model: { generate: () => assert.fail('no model') },
    isClosed: () => Promise.reject(new Error('closed lookup failed')) });
  const wrapped = vb.wrapTools({ execute: async () => { calls++; } });
  await assert.rejects(wrapped.execute(makeRequest()), /vision_binding_is_closed_invalid/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); vb.close();
});

for (const waiting of ['browser', 'model']) test(`close settles a noncooperative ${waiting} and observes its late rejection`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vb-close-await-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
  let started, rejectLate, browserCalls = 0, modelCalls = 0, received;
  const ready = new Promise(resolve => { started = resolve; });
  const stuck = request => { received = request.signal; started(); return new Promise((_resolve, reject) => { rejectLate = reject; }); };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, profile: makeVisionProfile(),
    model: { generate: request => { modelCalls++; return stuck(request); } } });
  t.after(() => vb.close());
  const wrapped = vb.wrapTools({ execute: async request => {
    browserCalls++; return waiting === 'browser' ? stuck(request) : makeDeterministicBrowser().execute(request);
  } });
  const kernel = new NativeKernel({ store, digest, owner: 'close-await', ports: { tools: wrapped,
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'browser', name: 'browser_inspect_workspace', arguments: { path: 'app' } }] }) } } });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, buildConfig([makeBrowserToolDef()]));
  const advancing = kernel.runUntilIdle(scope, 'run');
  await ready; vb.close();
  let timer;
  const snapshot = await Promise.race([advancing, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('close failed to settle')), 1000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(received.aborted, true);
  assert.equal(snapshot.phase, 'interrupted'); assert.equal(snapshot.reason, 'effect_outcome_unknown');
  assert.equal(browserCalls, 1); assert.equal(modelCalls, waiting === 'model' ? 1 : 0);
  const original = canonical(store.load(scope, 'run'));
  rejectLate(new Error('late transport rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canonical(store.load(scope, 'run')), original, 'late work cannot publish a caption or rewrite receipts');
});

for (const replaceContract of [false, true]) test(`vision uses the accepted current goal after steering (replace contract=${replaceContract})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vb-goal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
  const requests = [], codec = makeRealModelPort();
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, profile: makeVisionProfile(),
    model: { generate: async request => { requests.push(request); return codec.generate(request, () => {}); } } });
  t.after(() => vb.close());
  const config = buildConfig([makeBrowserToolDef()]);
  const kernel = new NativeKernel({ store, digest, owner: 'steering', ports: {
    tools: vb.wrapTools(makeDeterministicBrowser()), model: { generate: async request => request.messages.some(message => message.role === 'tool')
      ? { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }
      : { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'browser', name: 'browser_inspect_workspace', arguments: { path: 'app' } }] } } } });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, config);
  kernel.submit(scope, 'run', { commandId: 'new-goal', kind: 'steer', payload: { text: 'Check current login form', expectedGoalRevision: 0,
    ...(replaceContract ? { taskContract: { ...config.contract, revision: 'new-task-revision' } } : {}) } });
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'completed'); assert.equal(snapshot.goalRevision, 1);
  assert.equal(requests.length, 1);
  const observation = JSON.parse(requests[0].messages[1].content.split('observation_context: ')[1]);
  assert.equal(observation.goal, 'Check current login form'); assert.equal(observation.goalRevision, 1);
  assert.equal(observation.authority, 'observation_only_no_execution_or_completion_authority');
});

test('close invalidates wrapper: execute after close rejected by ownClosed check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vb-k3-'));
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const browser = makeDeterministicBrowser();
  const toolsPort = { execute: async (req) => browser.execute(req) };
  const vb = createStudioNativeVisionBinding({ scope, sessionId: 'session', store, model: makeRealModelPort(), profile: makeVisionProfile() });
  const wrapped = vb.wrapTools(toolsPort);
  vb.close();
  // After close, the wrapped execute checks ownClosed before dispatching to vision.
  // The ownClosed check throws before the authority guard even runs.
  await assert.rejects(wrapped.execute(makeRequest()), /vision_binding_closed|guard/i);
  store.close(); rmSync(root, { recursive: true, force: true });
});
