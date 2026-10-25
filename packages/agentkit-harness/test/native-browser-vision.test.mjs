import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeKernel, configure, emptyUsage, canonical, copy, addUsage,
} from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { createNativeToolAuthority } from '../../../src/providers/native-tool-authority.mjs';
import { createNativeVisionBrowser, NATIVE_VISION_BROWSER_CONTRACT, VisionObservationContext } from '../src/native/browser-vision.mjs';

const sha256Hex = v => createHash('sha256').update(v).digest('hex');
const DATA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';

function makeImageBlock(url = DATA_PNG, detail = 'auto') { return { type: 'image_url', image_url: { url, detail } }; }
function makeBrowserResult({ status = 'ok', content = {}, media = null, resourceUsage = {}, resourceUsageReported } = {}) {
  const r = { status, content: { ...content }, resourceUsage: { modelCalls: 0, toolCalls: 1, cost: 0, ...resourceUsage } };
  r.context = { content: canonical(content), ...(media ? { media: [media] } : {}) };
  if (resourceUsageReported !== undefined) r.resourceUsageReported = resourceUsageReported;
  return r;
}
function makeRequest({ action = 'screenshot', signal = new AbortController().signal, budget = { maxModelCallsRemaining: 3, parentFinalizationReserved: true, maxToolCallsRemaining: 5, depth: 0, maxDepth: 3 }, interaction = null } = {}) {
  return { call: { callId: 'c1', name: 'browser_inspect_workspace', arguments: { action, path: 'app' } },
    definition: { name: 'browser_inspect_workspace' }, operationKey: 'op-1',
    scope, runId: 'run-1', sessionId: 'session', turnId: '1', buildId: 'revision-x',
    parentRunId: null, taskChainId: 'session', executionFence: 1, signal, interaction, budget };
}
function makeVisionModel({ text = 'A login page.', kind = 'final_candidate', usage = { inputTokens: 100, outputTokens: 50, cost: 1 }, usageReported = true } = {}) {
  let received = null;
  return { generate: async (req) => { received = req; return { kind, text, toolCalls: [], usage: { ...emptyUsage(), ...usage }, usageReported }; }, _received: () => received };
}
function makeVisionProfile() {
  return { profileId: 'vision-1', profileVersion: 'sha256:abc', compatibilityDigest: 'sha256:abc',
    providerFamily: 'anthropic-messages', supportsImages: true, input: ['image'], imageInputMode: 'native',
    contextWindow: 16000, maxOutputTokens: 1024 };
}
function makeBrowser(results) { const q = Array.isArray(results) ? [...results] : [results]; return { execute: async () => q.shift() || makeBrowserResult({}) }; }
const assertCurrentTrue = () => true;

// ---- Real Kernel integration test ----

function realKernelSetup(t) {
  const root = mkdtempSync(join(tmpdir(), 'vision-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Real createNativeModelPort with deterministic HTTP fixture.
  // The model port sends stream:true for openai-chat, so it expects SSE format.
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    // Verify system message + user message present.
    const sysMsg = body.messages.find(m => m.role === 'system');
    assert.ok(sysMsg, 'system message present');
    const userMsg = body.messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'user message present');
    // Return SSE format (the model port sends stream:true).
    const sseBody = `data: ${JSON.stringify({
      id: 'resp-1', model: body.model,
      choices: [{ index: 0, delta: { content: 'A login page with a form.' }, finish_reason: null }],
      usage: null,
    })}\n\ndata: ${JSON.stringify({
      id: 'resp-1', model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })}\n\ndata: [DONE]\n\n`;
    return new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } });
  };

  const modelPort = createNativeModelPort({
    resolveProfile: async () => ({
      protocol: 'openai-chat', baseUrl: 'https://vision.invalid/v1', apiKey: 'test-key',
      model: 'vision-model', parameters: {},
    }),
    fetchImpl,
  });

  return { root, modelPort };
}

function buildKernelConfig(contextSources) {
  const base = fixture().config;
  return configure({
    ...base, instructions: 'Answer.',
    contract: { ...base.contract, objective: 'Task' },
    inputMessages: [{ role: 'user', kind: 'user_input', content: 'Task' }],
    tools: [], contextSources,
    contextPolicy: {
      enabled: true, tokenizerId: 'test', tokenizerDigest: 'test/v1',
      triggerRatio: 0.99, targetRatio: 0.5, summaryMaxTokens: 80,
      maxCompactions: null, maxCompactionsWithoutProgress: 4,
      minModelTurnsBetween: 2, maxSummaryRetries: 2,
    },
    limits: { ...base.limits, maxRepairs: 0 },
  });
}

// ---- Unit tests ----

test('contract', () => {
  const vb = createNativeVisionBrowser({ browser: makeBrowser({}), model: makeVisionModel(), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue });
  assert.equal(vb.contract, NATIVE_VISION_BROWSER_CONTRACT);
});

test('assertCurrent required', () => {
  assert.throws(() => createNativeVisionBrowser({ browser: makeBrowser({}), model: makeVisionModel(), profile: makeVisionProfile() }), /assert_current_required/);
});

test('the vision profile must explicitly admit native images', () => {
  assert.throws(() => createNativeVisionBrowser({ browser: makeBrowser({}), model: makeVisionModel(),
    profile: { ...makeVisionProfile(), imageInputMode: 'unsupported', supportsImages: true },
    assertCurrent: assertCurrentTrue }), /vision_profile_image_input_invalid/);
});

test('a caption cache hit preserves complete browser usage without inventing unknown model usage', async () => {
  let modelCalls = 0;
  const usage = { ...emptyUsage(), toolCalls: 1 };
  const result = makeBrowserResult({ media: makeImageBlock(), resourceUsage: usage, resourceUsageReported: true });
  result.contentBlocks = [makeImageBlock(), { type: 'text', text: 'browser text' }];
  const model = makeVisionModel();
  const adapter = createNativeVisionBrowser({ browser: makeBrowser([result, result]), profile: makeVisionProfile(),
    model: { generate: async req => { modelCalls++; return model.generate(req); } }, assertCurrent: assertCurrentTrue });
  await adapter.execute(makeRequest());
  const hit = await adapter.execute(makeRequest());
  assert.equal(modelCalls, 1); assert.equal(hit.content.vision_description_cache_hit, true);
  assert.equal(hit.resourceUsageReported, true); assert.deepEqual(hit.resourceUsage, usage);
  assert.equal(hit.context?.media, undefined); assert.deepEqual(hit.contentBlocks, [{ type: 'text', text: 'browser text' }]);
});

test('caption and observation limits count Unicode code points without splitting an image label', async () => {
  const adapter = createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })),
    model: makeVisionModel({ text: '😀后续' }), profile: makeVisionProfile(), maxCaptionChars: 1, assertCurrent: assertCurrentTrue });
  assert.equal((await adapter.execute(makeRequest())).content.vision_description, '😀');
  const context = new VisionObservationContext({ scope, runId: 'r', goalRevision: 0, goal: '😀'.repeat(3000), failedObservations: ['😀'.repeat(300)] });
  const data = JSON.parse(context.modelText().split('observation_context: ')[1]);
  assert.equal(data.goal, context.goal); assert.equal(data.failedObservations[0], context.failedObservations[0]);
  assert.equal(data.truncated, false);
});

test('assertCurrent thenable → rejection observed, no unhandledRejection', async () => {
  let unhandled = 0;
  const handler = () => { unhandled++; };
  process.on('unhandledRejection', handler);
  try {
    await assert.rejects(createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: makeVisionModel(), profile: makeVisionProfile(), assertCurrent: () => Promise.reject(new Error('async')) }).execute(makeRequest()), /vision_guard_failed/);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(unhandled, 0);
  } finally { process.off('unhandledRejection', handler); }
});

test('success: caption, usage valid, resourceUsageReported true', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), content: { status: 'ok', text: 'P' } })), model: makeVisionModel({ text: 'Login form.' }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.content.vision_description, 'Login form.');
  assert.equal(r.resourceUsage.modelCalls, 1);
  assert.equal(r.resourceUsageReported, true);
  assert.doesNotThrow(() => addUsage(emptyUsage(), r.resourceUsage));
});

test('INSTRUCTIONS as system message', async () => {
  const model = makeVisionModel({ text: 'cap' });
  await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(model._received().messages[0].role, 'system');
  assert.ok(model._received().messages[0].content.includes('visibly present'));
});

test('ModelRequest: content string + media array', async () => {
  const model = makeVisionModel({ text: 'cap' });
  await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  const req = model._received();
  assert.equal(typeof req.messages[1].content, 'string');
  assert.ok(Array.isArray(req.messages[1].media));
  assert.equal(req.messages[1].media[0].type, 'image_url');
});

test('model.generate called then throws → modelCalls=1, resourceUsageReported=false', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), content: { status: 'ok', text: 'P' } })), model: { generate: async () => { throw new Error('vision down'); } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.resourceUsage.modelCalls, 1);
  assert.equal(r.resourceUsageReported, false);
  assert.doesNotThrow(() => addUsage(emptyUsage(), r.resourceUsage));
});

test('model abort after generate → valid usage KEPT as lower bounds, modelCalls=1', async () => {
  const ac = new AbortController();
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), content: { status: 'ok', text: 'P' }, resourceUsage: { modelCalls: 0, toolCalls: 1, cost: 0, inputTokens: 0, outputTokens: 0 } })), model: { generate: async () => { ac.abort(); return { kind: 'final_candidate', text: 'cap', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cost: 1, modelCalls: 0, toolCalls: 0 } }; } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute({ ...makeRequest({ signal: ac.signal }) });
  assert.equal(r.content.vision_description, 'cap');
  assert.equal(r.resourceUsage.modelCalls, 1);
  assert.equal(r.resourceUsage.inputTokens, 10, 'valid tokens kept after abort');
  assert.equal(r.resourceUsage.cost, 1, 'valid cost kept after abort');
  // Abort after model return → usage IS known (model returned valid data).
  assert.equal(r.resourceUsageReported, true, 'usage known because model returned valid data');
});

test('a caption returned after cancellation does not populate a later request cache', async () => {
  const ac = new AbortController(); let calls = 0;
  const image = makeBrowserResult({ media: makeImageBlock() });
  const port = createNativeVisionBrowser({ browser: makeBrowser([image, image]),
    model: { generate: async () => { calls++; if (calls === 1) ac.abort();
      return { kind: 'final_candidate', text: calls === 1 ? 'late caption' : 'current caption', toolCalls: [], usage: emptyUsage() }; } },
    profile: makeVisionProfile(), assertCurrent: assertCurrentTrue });
  await port.execute(makeRequest({ signal: ac.signal }));
  const current = await port.execute(makeRequest());
  assert.equal(calls, 2); assert.equal(current.content.vision_description, 'current caption');
  assert.equal(current.content.vision_description_cache_hit, false);
});

test('signal abort after browser → browser result preserved, no model call', async () => {
  const ac = new AbortController();
  let called = false;
  const r = await createNativeVisionBrowser({ browser: { execute: async () => { ac.abort(); return makeBrowserResult({ media: makeImageBlock(), content: { status: 'ok', text: 'P' } }); } }, model: { generate: async () => { called = true; return { kind: 'final_candidate', text: '', toolCalls: [], usage: emptyUsage() }; } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute({ ...makeRequest({ signal: ac.signal }) });
  assert.equal(called, false);
  assert.equal(r.status, 'ok');
  assert.equal(r.content.text, 'P');
});

test('usageReported false from model → known valid fields kept as lower bounds, resourceUsageReported=false', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), resourceUsage: { modelCalls: 0, toolCalls: 1, cost: 1, inputTokens: 3, outputTokens: 4 } })), model: makeVisionModel({ usage: { inputTokens: 11, outputTokens: 7, cost: 2, modelCalls: 0, toolCalls: 0 }, usageReported: false }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.resourceUsage.modelCalls, 1);
  // Known valid vision fields are kept even when usageReported=false.
  assert.equal(r.resourceUsage.inputTokens, 14, 'browser 3 + vision 11 = 14 lower bound');
  assert.equal(r.resourceUsage.outputTokens, 11, 'browser 4 + vision 7 = 11 lower bound');
  assert.equal(r.resourceUsage.cost, 3, 'browser 1 + vision 2 = 3 lower bound');
  assert.equal(r.resourceUsageReported, false, 'incomplete because usageReported=false');
  assert.doesNotThrow(() => addUsage(emptyUsage(), r.resourceUsage));
});

test('browser resourceUsageReported=false preserved through caption success', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), resourceUsage: { modelCalls: 2, toolCalls: 1, cost: 5, inputTokens: 200 }, resourceUsageReported: false })), model: makeVisionModel({ text: 'cap', usage: { inputTokens: 50, outputTokens: 30, cost: 2 } }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.resourceUsage.modelCalls, 3);
  assert.equal(r.resourceUsage.inputTokens, 250, 'known tokens added');
  assert.equal(r.resourceUsageReported, false, 'browser false preserved');
});

test('browser resourceUsageReported=false preserved on cache hit', async () => {
  let calls = 0;
  const img = makeImageBlock();
  const browser = makeBrowser([makeBrowserResult({ media: img, resourceUsageReported: false }), makeBrowserResult({ media: img, resourceUsageReported: false })]);
  const model = { generate: async () => { calls++; return { kind: 'final_candidate', text: 'cap', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, usageReported: true }; } };
  const vb = createNativeVisionBrowser({ browser, model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue });
  await vb.execute(makeRequest());
  const r = await vb.execute(makeRequest());
  assert.equal(calls, 1);
  assert.equal(r.resourceUsage.modelCalls, 0);
  assert.equal(r.resourceUsageReported, false, 'browser false preserved on cache hit');
});

test('negative/NaN vision usage → invalid fields 0, valid fields kept, reported=false', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), resourceUsage: { modelCalls: 2, toolCalls: 1, cost: 5, inputTokens: 200, outputTokens: 100 } })), model: makeVisionModel({ usage: { inputTokens: -5, outputTokens: 30, cost: NaN, modelCalls: 0, toolCalls: 0 } }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.resourceUsage.modelCalls, 3);
  // Invalid fields (inputTokens=-5, cost=NaN) → 0 placeholder; valid outputTokens=30 kept.
  assert.equal(r.resourceUsage.inputTokens, 200, 'invalid vision input → 0, browser kept');
  assert.equal(r.resourceUsage.outputTokens, 130, 'valid vision output 30 kept: 100+30=130');
  assert.equal(r.resourceUsage.cost, 5, 'invalid vision cost → 0, browser kept');
  assert.equal(r.resourceUsageReported, false, 'incomplete because some fields invalid');
});

test('browser uncertain → no caption, result preserved', async () => {
  let called = false;
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ status: 'uncertain', media: makeImageBlock(), content: { code: 'tool_outcome_unknown' } })), model: { generate: async () => { called = true; return { kind: 'final_candidate', text: '', toolCalls: [], usage: emptyUsage() }; } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(called, false);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.code, 'tool_outcome_unknown');
});

test('browser approval_required → no caption', async () => {
  let called = false;
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ status: 'approval_required', media: makeImageBlock(), content: { code: 'approval' } })), model: { generate: async () => { called = true; return { kind: 'final_candidate', text: '', toolCalls: [], usage: emptyUsage() }; } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(called, false);
  assert.equal(r.status, 'approval_required');
});

test('profile mutation → frozen', async () => {
  const profile = makeVisionProfile();
  const model = makeVisionModel({ text: 'cap' });
  const vb = createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model, profile, assertCurrent: assertCurrentTrue });
  profile.profileVersion = 'tampered';
  await vb.execute(makeRequest());
  assert.equal(model._received().profile.profileVersion, 'sha256:abc');
});

test('cache hit: modelCalls=0, no second call', async () => {
  let calls = 0;
  const img = makeImageBlock();
  const browser = makeBrowser([makeBrowserResult({ media: img }), makeBrowserResult({ media: img })]);
  const model = { generate: async () => { calls++; return { kind: 'final_candidate', text: 'cap', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, usageReported: true }; } };
  const vb = createNativeVisionBrowser({ browser, model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue });
  await vb.execute(makeRequest());
  const r = await vb.execute(makeRequest());
  assert.equal(calls, 1);
  assert.equal(r.content.vision_description_cache_hit, true);
  assert.equal(r.resourceUsage.modelCalls, 0);
});

test('different scope → no cache', async () => {
  let calls = 0;
  const img = makeImageBlock();
  const browser = makeBrowser([makeBrowserResult({ media: img }), makeBrowserResult({ media: img })]);
  const model = { generate: async () => { calls++; return { kind: 'final_candidate', text: `c${calls}`, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, usageReported: true }; } };
  const vb = createNativeVisionBrowser({ browser, model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue });
  await vb.execute(makeRequest());
  await vb.execute({ ...makeRequest(), scope: { ...scope, agentId: 'other' } });
  assert.equal(calls, 2);
});

test('null budget → model call', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: makeVisionModel({ text: 'cap' }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest({ budget: { maxModelCallsRemaining: null, parentFinalizationReserved: true, maxToolCallsRemaining: 5, depth: 0, maxDepth: 3 } }));
  assert.equal(r.content.vision_description, 'cap');
});

test('budget=0 → no model call', async () => {
  let called = false;
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: { generate: async () => { called = true; return { kind: 'final_candidate', text: '', toolCalls: [], usage: emptyUsage() }; } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest({ budget: { maxModelCallsRemaining: 0, parentFinalizationReserved: true, maxToolCallsRemaining: 5, depth: 0, maxDepth: 3 } }));
  assert.equal(called, false);
});

test('assertCurrent false → throws', async () => {
  let count = 0;
  await assert.rejects(createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: makeVisionModel(), profile: makeVisionProfile(), assertCurrent: () => { count++; return count > 1 ? false : true; } }).execute(makeRequest()), /vision_guard_failed/);
});

test('observation context async → no unhandledRejection', async () => {
  let unhandled = 0;
  const handler = () => { unhandled++; };
  process.on('unhandledRejection', handler);
  try {
    const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: makeVisionModel(), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue, observationContext: () => Promise.resolve(new VisionObservationContext({ scope, runId: 'run-1', goalRevision: 0, goal: 'g' })) }).execute(makeRequest());
    assert.equal(r.content.vision_description_status, 'observation_context_unavailable');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(unhandled, 0);
  } finally { process.off('unhandledRejection', handler); }
});

test('valid context → caption', async () => {
  const model = makeVisionModel({ text: 'Form visible.' });
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue, observationContext: (req) => new VisionObservationContext({ scope: req.scope, runId: req.runId, goalRevision: 1, goal: 'Test login' }) }).execute(makeRequest());
  assert.equal(r.content.vision_description, 'Form visible.');
  assert.ok(model._received().messages[1].content.includes('observation_context'));
});

test('remote URL not sent to model', async () => {
  let called = false;
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock('https://example.com/s.png') })), model: { generate: async () => { called = true; return { kind: 'final_candidate', text: '', toolCalls: [], usage: emptyUsage() }; } }, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(called, false);
});

test('drift detection', async () => {
  await assert.rejects(createNativeVisionBrowser({ browser: { execute: async (req) => { req.scope = { ...req.scope, agentId: 'x' }; return makeBrowserResult({ media: makeImageBlock() }); } }, model: makeVisionModel(), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest()), /vision_request_drifted/);
});

test('goalRevision in cache key', async () => {
  let calls = 0;
  const img = makeImageBlock();
  const browser = makeBrowser([makeBrowserResult({ media: img }), makeBrowserResult({ media: img })]);
  const model = { generate: async () => { calls++; return { kind: 'final_candidate', text: `c${calls}`, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cost: 0 }, usageReported: true }; } };
  const vb1 = createNativeVisionBrowser({ browser, model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue, observationContext: (r) => new VisionObservationContext({ scope: r.scope, runId: r.runId, goalRevision: 1, goal: 'g' }) });
  await vb1.execute(makeRequest());
  const vb2 = createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: img })), model, profile: makeVisionProfile(), assertCurrent: assertCurrentTrue, observationContext: (r) => new VisionObservationContext({ scope: r.scope, runId: r.runId, goalRevision: 2, goal: 'g' }) });
  const r = await vb2.execute(makeRequest());
  assert.equal(calls, 2);
  assert.equal(r.content.vision_description_cache_hit, false);
});

test('combined usage valid for core addUsage', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock(), resourceUsage: { modelCalls: 5, toolCalls: 3, cost: 10, inputTokens: 500, outputTokens: 200, cachedInputTokens: 50, cacheWriteInputTokens: 30, reasoningTokens: 20 } })), model: makeVisionModel({ usage: { inputTokens: 100, outputTokens: 50, cost: 2, cachedInputTokens: 10, cacheWriteInputTokens: 7, reasoningTokens: 5 } }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.resourceUsage.modelCalls, 6);
  assert.equal(r.resourceUsage.inputTokens, 600);
  assert.equal(r.resourceUsage.cachedInputTokens, 60);
  assert.equal(r.resourceUsage.cacheWriteInputTokens, 37);
  assert.equal(r.resourceUsage.cost, 12);
  assert.equal(r.resourceUsageReported, true);
  assert.doesNotThrow(() => addUsage(emptyUsage(), r.resourceUsage));
});

test('error with screenshot: caption + error preserved', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ status: 'error', media: makeImageBlock(), content: { error_type: 'page_error' } })), model: makeVisionModel({ text: 'Console error.' }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue }).execute(makeRequest());
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'page_error');
  assert.equal(r.content.vision_description, 'Console error.');
});

test('null actions → any action captioned', async () => {
  const r = await createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: makeVisionModel({ text: 'cap' }), profile: makeVisionProfile(), assertCurrent: assertCurrentTrue, actions: null }).execute(makeRequest({ action: 'custom' }));
  assert.equal(r.content.vision_description, 'cap');
});

test('interaction preserved in seal', async () => {
  let guardReq = null;
  const vb = createNativeVisionBrowser({ browser: makeBrowser(makeBrowserResult({ media: makeImageBlock() })), model: makeVisionModel({ text: 'cap' }), profile: makeVisionProfile(), assertCurrent: (req) => { guardReq = req; return true; } });
  await vb.execute({ ...makeRequest({ interaction: { callId: 'c1' } }) });
  assert.equal(guardReq.interaction?.callId, 'c1');
});

// ---- Real Kernel + SQLite + createNativeModelPort + ToolAuthority integration ----

test('real createNativeModelPort: system INSTRUCTIONS, typed image, untrusted caption, modelCalls=1', async t => {
  const { root, modelPort } = realKernelSetup(t);
  const img = makeImageBlock();

  // Create the vision browser adapter — it wraps a mock browser and real model port.
  const browserResult = makeBrowserResult({ media: img, content: { status: 'ok', text: 'Page' } });
  const browser = { execute: async () => browserResult };
  const vb = createNativeVisionBrowser({ browser, model: modelPort, profile: makeVisionProfile(), assertCurrent: () => true });

  // Directly call execute to verify the real model port works end-to-end.
  const req = makeRequest();
  const result = await vb.execute(req);

  assert.ok(result.content.vision_description, 'vision caption produced');
  assert.equal(result.content.vision_description_trust, 'untrusted_model_output');
  assert.equal(result.content.vision_description_cache_hit, false);
  assert.equal(result.resourceUsage.modelCalls, 1, 'vision model call counted');
  assert.equal(result.resourceUsageReported, true);
  assert.doesNotThrow(() => addUsage(emptyUsage(), result.resourceUsage));
});

test('real NativeKernel + SQLite + ToolAuthority: vision tool receipt with budget + usageComplete', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vision-k2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => store.close());

  // Real createNativeModelPort with SSE fixture.
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    return new Response(
      `data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta: { content: 'Login form visible.' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n` +
      `data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const modelPort = createNativeModelPort({
    resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: 'https://v.invalid/v1', apiKey: 'k', model: 'm', parameters: {} }),
    fetchImpl,
  });

  // Browser returns image; vision adapter wraps it.
  const img = makeImageBlock();
  const browserResult = makeBrowserResult({ media: img, content: { status: 'ok', text: 'Page' } });
  const browser = { execute: async () => browserResult };

  // Real ToolAuthority backed by the SQLite store.
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store, isClosed: () => false });

  const vb = createNativeVisionBrowser({ browser, model: modelPort, profile: makeVisionProfile(), assertCurrent: authority });

  // Build a config with the vision browser as a tool.
  const toolDef = {
    name: 'browser_inspect_workspace', description: 'Browser', parameters: { type: 'object', properties: {}, additionalProperties: true },
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 60000,
    contextRole: 'none', observationRole: 'browser', progressObservation: false, contextRetention: 'normal',
  };
  const base = fixture().config;
  const config = configure({
    ...base, instructions: 'Answer.',
    contract: { ...base.contract, objective: 'Task' },
    inputMessages: [{ role: 'user', kind: 'user_input', content: 'Task' }],
    tools: [toolDef], contextSources: [],
    limits: { ...base.limits, maxRepairs: 0, maxModelCalls: 10, maxToolCalls: 10, effectTimeoutMs: 120000 },
  });

  // Kernel with the vision adapter as the tool port.
  const ports = {
    context: { tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1', countRequest: async () => 10, countText: async () => 5 }, prepare: async (r) => ({ messages: r.snapshot.messages, context: {} }) },
    model: { generate: async (request) => {
      // First call: emit a tool call to the browser.
      if (request.messages.filter(m => m.role === 'tool').length === 0) {
        return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'bc1', name: 'browser_inspect_workspace', arguments: { action: 'screenshot', path: 'app' } }], usage: emptyUsage() };
      }
      // Second call: final answer.
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async (req) => vb.execute(req) },
  };

  const kernel = new NativeKernel({ store, ports, digest, owner: 'test' });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, config);
  const snap = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snap.phase, 'completed', `phase: ${snap.phase} reason: ${snap.reason}`);

  // Verify the tool receipt has the vision caption + resource usage.
  const record = store.load(scope, 'run');
  const toolReceipt = record.receipts.find(r => r.result?.results?.some(res => res.content?.vision_description));
  assert.ok(toolReceipt, 'vision tool receipt in SQLite store');
  const toolResult = toolReceipt.result.results.find(res => res.content?.vision_description);
  assert.equal(toolResult.content.vision_description, 'Login form visible.');
  assert.equal(toolResult.content.vision_description_trust, 'untrusted_model_output');
  assert.equal(toolResult.resourceUsage.modelCalls, 1, 'vision model call in receipt');
  // Verify usage was committed to the snapshot.
  assert.ok(snap.usage.modelCalls >= 1, 'model call in snapshot usage');
});

test('SQLite close/reopen: tool receipt persisted, no duplicate vision model call', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vision-k3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(dbPath);

  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    return new Response(
      `data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta: { content: 'Login form.' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'r', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n` +
      `data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const modelPort = createNativeModelPort({
    resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: 'https://v.invalid/v1', apiKey: 'k', model: 'm', parameters: {} }),
    fetchImpl,
  });

  let modelCallCount = 0;
  const img = makeImageBlock();
  const browser = { execute: async () => makeBrowserResult({ media: img, content: { status: 'ok', text: 'P' } }) };
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store, isClosed: () => false });
  const vb = createNativeVisionBrowser({ browser, model: { generate: async (req) => { modelCallCount++; return modelPort.generate(req, () => {}); } }, profile: makeVisionProfile(), assertCurrent: authority });

  const toolDef = { name: 'browser_inspect_workspace', description: 'Browser', parameters: { type: 'object', properties: {}, additionalProperties: true },
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 60000, contextRole: 'none', observationRole: 'browser', progressObservation: false, contextRetention: 'normal' };
  const base = fixture().config;
  const config = configure({ ...base, instructions: 'A', contract: { ...base.contract, objective: 'T' },
    inputMessages: [{ role: 'user', kind: 'user_input', content: 'T' }], tools: [toolDef], contextSources: [],
    limits: { ...base.limits, maxRepairs: 0, maxModelCalls: 10, maxToolCalls: 10, effectTimeoutMs: 120000 } });
  const ports = {
    context: { tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1', countRequest: async () => 10, countText: async () => 5 }, prepare: async (r) => ({ messages: r.snapshot.messages, context: {} }) },
    model: { generate: async (req) => {
      if (req.messages.filter(m => m.role === 'tool').length === 0) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'bc1', name: 'browser_inspect_workspace', arguments: { action: 'screenshot' } }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async (req) => vb.execute(req) },
  };
  const kernel = new NativeKernel({ store, ports, digest, owner: 'test' });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: 'revision-x' }, config);
  const snap = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snap.phase, 'completed');
  assert.equal(modelCallCount, 1, 'exactly 1 vision model call');

  store.close();
  // Reopen the SQLite store — the tool receipt should persist.
  store = new SqliteRunStore(dbPath);
  t.after(() => store.close());
  const record = store.load(scope, 'run');
  const toolReceipt = record.receipts.find(r => r.result?.results?.some(res => res.content?.vision_description));
  assert.ok(toolReceipt, 'vision receipt persisted after SQLite reopen');
  const before = canonical(record);
  const replacement = new NativeKernel({ store, digest, owner: 'replacement', ports: {
    model: { generate: () => assert.fail('completed recovery cannot call the model') },
    tools: { execute: () => assert.fail('completed recovery cannot repeat the browser or vision model') },
  } });
  assert.equal((await replacement.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(canonical(store.load(scope, 'run')), before);
  assert.equal(modelCallCount, 1, 'no duplicate model call on reopen');
});
