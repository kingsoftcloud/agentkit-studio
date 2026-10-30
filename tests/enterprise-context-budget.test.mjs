// Enterprise Agent objective context/budget integration evidence.
//
// These tests exercise the active NativeKernel execution loop against a real
// localhost HTTP model endpoint, the production createNativeModelPort adapter,
// the production createNativeContextPort counter (via bindNativeContext), and a
// real file-backed SQLite run store. They verify the remaining context/budget
// integration of the enterprise Agent objective INDEPENDENTLY of any Memory
// source changes: automatic compaction charges the shared model-call budget
// and emits separately observable usage; malformed/failed compaction cannot
// hide source messages or exceed its own retry budget; cancellation stops
// further model calls. No production, doc or existing test file is modified.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, tool, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { estimateNativeWireInput } from '@kingsoftcloud/agentkit-harness-node/native/context-counter';
import { bindNativeContext } from '../src/providers/native-context.mjs';

const description = { protocol: 'openai-chat', modelName: 'pinned', contextWindow: 6000, maxOutputTokens: 256, parameters: {} };
const summaryText = 'PRIVATE-CONTEXT-NOTES' + '中文摘要'.repeat(12);

function startServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.ok(estimateNativeWireInput(body) + body.max_tokens <= description.contextWindow, 'counter admits the request within the context window');
    let spec;
    try { spec = await handler(req, body, requests.length - 1); }
    catch (error) { res.writeHead(500); res.end(String(error.message)); return; }
    res.writeHead(spec.status ?? 200, spec.headers ?? { 'content-type': 'text/event-stream', connection: 'close' });
    const b = spec.body;
    if (b == null) { res.end(); return; }
    res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : `data: ${JSON.stringify(b)}\n\ndata: [DONE]\n\n`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, requests,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}

const sse = (delta, finish_reason = 'stop', usage = { prompt_tokens: 5, completion_tokens: 7 }) => ({
  body: { id: 'r', choices: [{ index: 0, delta, finish_reason }], usage },
});

function isSummaryRequest(body) {
  // The kernel marks compaction quotes with this versioned marker; compaction
  // requests carry no tools and use the summary max-tokens budget.
  return body.tools === undefined && body.messages.some(message =>
    typeof message.content === 'string' && message.content.includes('agentkit.native-summary-quote/v1'));
}

// Scenario 1: compaction charges the shared model-call budget, emits observable
// usage, preserves source messages, and a cold reopen does not exceed the budget.
test('automatic compaction shares the model-call budget and reports observable usage; source survives cold reopen within budget', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-context-budget-shared-'));
  const filename = join(directory, 'runs.sqlite');
  const server = await startServer((req, body, idx) => {
    if (isSummaryRequest(body)) return sse({ content: summaryText }, 'length');
    if (idx === 0) return sse({ tool_calls: [{ index: 0, id: 'publication', type: 'function',
      function: { name: 'write', arguments: '{}' } }] }, 'tool_calls');
    return sse({ content: 'Publication completed' });
  });
  t.after(async () => { store?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });

  // maxModelCalls is deliberately tight: one task call that requests the tool,
  // then compaction summaries must consume the remaining budget before the
  // task can finish. This proves compaction draws from the SAME budget.
  const limits = { maxModelCalls: 3, finalizationReserveModelCalls: 0, maxWallMs: 60_000 };
  const binding = bindNativeContext({ description, context: { compaction: {
    thresholdRatio: 0.5, targetRatio: 0.2, summaryMaxTokens: 64, minModelTurnsBetween: 0 } } });
  const { config, snapshot } = fixture({
    profile: { profileId: 'enterprise-budget', profileVersion: '1', providerFamily: 'openai-chat',
      compatibilityDigest: 'bound', ...binding.profile }, limits,
    contextPolicy: binding.policy,
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
  });
  const ports = () => ({ context: binding.port,
    model: createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', model: 'pinned',
      baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'not-persisted' }) }),
    tools: { execute: async () => ({ status: 'ok', content: { publication: true },
      context: { content: 'Observed publication evidence 中文 '.repeat(1400) } }) } });

  let store = new SqliteRunStore(filename);
  const kernel = new NativeKernel({ store, digest, owner: 'first', ports: ports() });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');

  // The run cannot complete: compaction spent the shared model-call budget
  // before the task's final call. With finalizationReserveModelCalls=0 the
  // planner refuses to admit further compaction once the budget is exhausted,
  // so the run terminates with an explicit bounded reason (never a silent
  // truncation) and the model-call count is bounded exactly by maxModelCalls.
  assert.notEqual(result.phase, 'completed', 'compaction sharing the budget prevents silent completion');
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'context_finalization_budget_unavailable');
  assert.equal(result.usage.modelCalls, limits.maxModelCalls,
    'compaction counted against the shared model-call budget (1 task + 2 summaries = 3)');
  assert.equal(server.requests.length, limits.maxModelCalls, 'exactly one task and two summary HTTP attempts');
  assert.equal(result.usage.inputTokens, 15);
  assert.equal(result.usage.outputTokens, 21);

  // Compaction emits a separately observable usage event on the durable event
  // stream — distinct from task model.completed events — carrying its own usage.
  const events = store.events(scope, 'run');
  const summaries = events.filter(event => event.kind === 'context.summary_completed');
  assert.equal(summaries.length, 2, 'both compaction attempts report separate usage');
  assert.ok(summaries.every(event => Object.hasOwn(event.payload, 'usage')
    && Object.hasOwn(event.payload, 'usageReported')), 'summary events carry their own usage/reporting flags');

  // The original source evidence is not hidden by the in-progress compaction:
  // mid-compaction the source messages remain in the durable transcript.
  const before = store.load(scope, 'run').snapshot;
  assert.ok(before.messages.some(message => typeof message.content === 'string'
    && message.content.includes('Observed publication evidence')), 'source evidence preserved in SQLite');
  assert.ok(JSON.stringify(before).includes('not-persisted') === false, 'api key never persisted');

  // Cold reopen: the run is already terminal, so the budget is not exceeded —
  // no additional model HTTP attempt is dispatched by the replacement kernel.
  const fixedRequests = server.requests.length;
  store.close(); store = new SqliteRunStore(filename);
  const reopened = new NativeKernel({ store, digest, owner: 'replacement', ports: ports() });
  const redone = await reopened.runUntilIdle(scope, 'run');
  assert.equal(redone.phase, 'failed');
  assert.equal(server.requests.length, fixedRequests, 'cold reopen does not exceed the exhausted shared budget');
  assert.equal(redone.usage.modelCalls, limits.maxModelCalls, 'persisted usage is authoritative across reopen');
  store.close(); store = null;
});

// Scenario 2: a malformed compaction (provider returns empty summary text) is
// bounded by maxSummaryRetries, never hides source messages, and does not let a
// failing compaction exceed its own retry budget to retry indefinitely.
test('malformed compaction exhausts its own retry budget without hiding source messages', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-context-budget-malformed-'));
  const filename = join(directory, 'runs.sqlite');
  const server = await startServer((req, body, idx) => {
    if (isSummaryRequest(body)) return sse({ content: '' }, 'stop'); // malformed: empty summary text
    if (idx === 0) return sse({ tool_calls: [{ index: 0, id: 'publication', type: 'function',
      function: { name: 'write', arguments: '{}' } }] }, 'tool_calls');
    return sse({ content: 'Publication completed' });
  });
  t.after(async () => { store?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });

  const maxSummaryRetries = 1;
  const binding = bindNativeContext({ description, context: { compaction: {
    thresholdRatio: 0.5, targetRatio: 0.2, summaryMaxTokens: 64,
    minModelTurnsBetween: 0, maxSummaryRetries } } });
  const { config, snapshot } = fixture({
    profile: { profileId: 'enterprise-malformed', profileVersion: '1', providerFamily: 'openai-chat',
      compatibilityDigest: 'bound', ...binding.profile },
    limits: { maxModelCalls: 20, finalizationReserveModelCalls: 0, maxWallMs: 60_000 },
    contextPolicy: binding.policy,
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
  });
  const ports = () => ({ context: binding.port,
    model: createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', model: 'pinned',
      baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'not-persisted' }) }),
    tools: { execute: async () => ({ status: 'ok', content: { publication: true },
      context: { content: 'Observed publication evidence 中文 '.repeat(1400) } }) } });

  let store = new SqliteRunStore(filename);
  const kernel = new NativeKernel({ store, digest, owner: 'first', ports: ports() });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');

  // The malformed compaction is bounded by maxSummaryRetries: it fails with the
  // explicit retry-exhausted reason rather than looping or hiding the failure.
  assert.equal(result.phase, 'failed');
  assert.equal(result.reason, 'context_summary_retry_exhausted');
  // One task call + (maxSummaryRetries + 1) malformed summary attempts — no more.
  const summaryAttempts = server.requests.filter(body => body.tools === undefined).length;
  assert.equal(summaryAttempts, maxSummaryRetries + 1, 'malformed compaction cannot exceed its own retry budget');
  assert.ok(server.requests.length <= 1 + maxSummaryRetries + 1, 'no unbounded retry loop');

  // The source evidence remains visible in the durable transcript; a failing
  // compaction never erased the original messages.
  const record = store.load(scope, 'run').snapshot;
  assert.ok(record.messages.some(message => typeof message.content === 'string'
    && message.content.includes('Observed publication evidence')), 'malformed compaction did not hide source messages');
  store.close(); store = null;
});

// Scenario 3: cancellation stops further model HTTP calls while a compaction
// request is in flight, leaving the source messages intact.
test('cancellation stops further compaction model calls and preserves source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-context-budget-cancel-'));
  const filename = join(directory, 'runs.sqlite');
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); server.requests = (server.requests || []); server.requests.push(body);
    if (isSummaryRequest(body)) {
      // Hold the compaction response open so cancellation arrives in flight.
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { content: summaryText }, finish_reason: null }] })}\n\n`);
      req.on('close', () => { try { res.end(); } catch {} });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'publication', type: 'function',
      function: { name: 'write', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.requests = [];
  t.after(async () => { store?.close(); server.closeAllConnections(); await new Promise(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); });

  const binding = bindNativeContext({ description, context: { compaction: {
    thresholdRatio: 0.5, targetRatio: 0.2, summaryMaxTokens: 64, minModelTurnsBetween: 0 } } });
  const { config, snapshot } = fixture({
    profile: { profileId: 'enterprise-cancel', profileVersion: '1', providerFamily: 'openai-chat',
      compatibilityDigest: 'bound', ...binding.profile },
    limits: { maxModelCalls: 20, finalizationReserveModelCalls: 0, maxWallMs: 60_000 },
    contextPolicy: binding.policy,
    tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
  });
  const ports = () => ({ context: binding.port,
    model: createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', model: 'pinned',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'not-persisted' }) }),
    tools: { execute: async () => ({ status: 'ok', content: { publication: true },
      context: { content: 'Observed publication evidence 中文 '.repeat(1400) } }) } });

  let store = new SqliteRunStore(filename);
  const kernel = new NativeKernel({ store, digest, owner: 'first', ports: ports() });
  kernel.start(snapshot, config);
  const done = kernel.runUntilIdle(scope, 'run');
  // Wait until the compaction HTTP request is in flight, then cancel the run.
  await new Promise(resolve => {
    const interval = setInterval(() => {
      if (server.requests.length >= 2) { clearInterval(interval); resolve(); }
    }, 5);
  });
  kernel.submit(scope, 'run', { commandId: 'user-stop', kind: 'cancel', payload: {} });
  const result = await done;

  assert.equal(result.phase, 'canceled');
  assert.equal(result.reason, 'user_canceled');
  // Exactly the task call plus the in-flight compaction call — no further model
  // calls were dispatched after cancellation.
  assert.equal(server.requests.length, 2, 'cancellation stopped further compaction model calls');
  const record = store.load(scope, 'run').snapshot;
  assert.ok(record.messages.some(message => typeof message.content === 'string'
    && message.content.includes('Observed publication evidence')), 'source preserved after cancellation');
  store.close(); store = null;
});
