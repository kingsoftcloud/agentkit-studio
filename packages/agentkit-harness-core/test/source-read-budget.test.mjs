import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, NativeKernel, MemoryRunStore, emptyUsage, artifactToolDefinitions,
  sourceReadBudgetFor, prepareSourceReadQuote } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, tool, digest } from './fixtures.mjs';

const read = tool({ name: 'read_source', contextRole: 'workspace_read', sourceObservationPolicy: 'workspace-source-model/v1',
  resultArchivePolicy: 'archived-model-view/v5', parameters: { type: 'object', properties: { path: { type: 'string' } } } });
const contextPolicy = { tokenizerId: 'source-counter', tokenizerDigest: 'source-counter/v1', enabled: true,
  triggerRatio: 0.9, targetRatio: 0.6, summaryMaxTokens: 400, maxCompactions: 10,
  maxCompactionsWithoutProgress: 3, minModelTurnsBetween: 0, maxSummaryRetries: 1 };
const bytes = value => Buffer.byteLength(canonical(value));
const messageUnits = message => bytes(message) + 10;
const context = { tokens: { tokenizerId: contextPolicy.tokenizerId, tokenizerDigest: contextPolicy.tokenizerDigest,
  countText: async ({ text }) => Math.max(1, Buffer.byteLength(text)),
  countMessage: async ({ message }) => messageUnits(message),
  countRequest: async ({ messages, tools }) => 200 + bytes(tools) + messages.reduce((sum, message) => sum + messageUnits(message), 0),
} };
const options = { sourceReadPolicy: 'studio-source-read/v1', artifactPolicy: 'runtime-artifacts/v1', contextPolicy,
  tools: [read, ...artifactToolDefinitions()], profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture',
    compatibilityDigest: 'fixture', contextWindow: 50000, maxOutputTokens: 1000 }, limits: { maxParallelTools: 2, maxToolResultBytes: 4096 } };
const response = toolCalls => ({ kind: toolCalls ? 'tool_calls' : 'final_candidate', text: toolCalls ? '' : 'Done',
  toolCalls: toolCalls ?? [], usage: emptyUsage() });
const calls = Array.from({ length: 6 }, (_, index) => ({ name: read.name, callId: `read-${index}`, arguments: { path: `${index}.txt` } }));
const baseRequest = config => ({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', taskChainId: 'chain',
  parentRunId: null, operationKey: 'model', signal: new AbortController().signal, profile: config.profile,
  messages: [{ role: 'system', content: 'Actual instructions' }, { role: 'user', content: config.contract.objective }],
  tools: config.tools, maxInlineImageBytes: config.limits.maxInlineImageBytes, finalizationOnly: false });

test('source policy is opt-in, requires context/artifact bindings and seals the source tool policy', () => {
  assert.equal(Object.hasOwn(fixture().config, 'sourceReadPolicy'), false);
  assert.throws(() => fixture({ sourceReadPolicy: 'unknown' }), /invalid_source_read_policy/);
  assert.throws(() => fixture({ ...options, contextPolicy: null }), /invalid_source_read_policy/);
  assert.throws(() => fixture({ ...options, tools: [{ ...read, readOnly: false }, ...artifactToolDefinitions()] }), /invalid_source_observation_policy|invalid_tool_concurrency/);
  const unbound = structuredClone(read); delete unbound.sourceObservationPolicy;
  assert.throws(() => fixture({ ...options, tools: [unbound, ...artifactToolDefinitions()] }), /invalid_source_archive_policy/);
});

test('complete prepared surface and original declared readers determine source shares, not a smaller dispatch segment', async () => {
  const { config, snapshot } = fixture(options), request = baseRequest(config);
  const after = { ...snapshot, phase: 'executing_tools', messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: calls }], pendingTools: calls };
  const quote = await prepareSourceReadQuote(snapshot, after, config, request, context.tokens, digest);
  assert.equal(quote.status, 'ready'); assert.equal(quote.readerCallIds.length, 6); assert.equal(quote.summaryUnits, 0);
  assert.equal(quote.maxSourceUnits, Math.floor(quote.availableUnits / 2 / 6));
  assert.ok(quote.fixedUnits >= 200 + bytes(config.tools));
  after.sourceReadQuote = quote;
  const first = sourceReadBudgetFor(after, config, calls[0], digest);
  const later = sourceReadBudgetFor({ ...after, pendingTools: calls.slice(4), usage: { ...after.usage, toolCalls: 4 } }, config, calls[5], digest);
  assert.deepEqual(first, later); assert.equal(first.sourceGroupSize, 6);
  assert.equal(sourceReadBudgetFor({ ...after, goalRevision: 1 }, config, calls[0], digest), undefined);
  const changed = structuredClone(after); changed.messages.at(-1).toolCalls[0].arguments.path = 'other';
  assert.equal(sourceReadBudgetFor(changed, config, calls[0], digest), undefined);
  assert.equal(sourceReadBudgetFor(after, { ...config, contextPolicy: { ...contextPolicy, tokenizerDigest: 'other' } }, calls[0], digest), undefined);
  const larger = structuredClone(request); larger.tools[0].description += 'Additional actual MCP schema '.repeat(100);
  const priced = await prepareSourceReadQuote(snapshot, after, config, larger, context.tokens, digest);
  assert.ok(priced.maxSourceUnits < quote.maxSourceUnits);
  assert.deepEqual(after.sourceReadQuote, quote, 'pricing and descriptor derivation are detached');
});

test('ArtifactRead shares the original group but cannot reserve or mint another archive; mixed groups reserve the actual summary frame', async () => {
  const { config, snapshot } = fixture(options), request = baseRequest(config);
  const artifactCalls = calls.map(call => ({ ...call, name: 'ArtifactRead', arguments: { uri: 'artifact://earned' } }));
  const after = { ...snapshot, phase: 'executing_tools', messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: artifactCalls }] };
  const quote = await prepareSourceReadQuote(snapshot, after, config, request, context.tokens, digest);
  assert.equal(quote.status, 'ready'); assert.equal(quote.prospectiveRefUnits, 0);
  assert.ok(quote.summaryUnits > contextPolicy.summaryMaxTokens);
  after.messages.at(-1).toolCalls = [calls[0], ...artifactCalls.slice(1)];
  const mixed = await prepareSourceReadQuote(snapshot, after, config, request, context.tokens, digest);
  assert.equal(mixed.readerCallIds.length, 6); assert.ok(mixed.prospectiveRefUnits > 0);
  assert.equal(mixed.summaryUnits, quote.summaryUnits);
});

for (const backend of ['memory', 'sqlite']) test(`${backend}: Kernel commits original batch quote once and keeps shares across split execution and restart`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-source-capacity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = backend === 'sqlite' ? new SqliteRunStore(join(root, 'run.sqlite')) : new MemoryRunStore();
  t.after(() => store.close?.());
  const { config, snapshot } = fixture(options), budgets = []; let models = 0, saved;
  const ports = { context, model: { generate: async () => ++models === 1 ? response(calls) : response() },
    tools: { execute: async request => { budgets.push(request.sourceReadBudget); return { status: 'ok', content: { read: request.call.arguments.path } }; } } };
  const kernel = new NativeKernel({ store, owner: 'first', digest, ports, onCheckpoint: async checkpoint => {
    if (checkpoint.phase === 'executing_tools' && checkpoint.usage.toolCalls === 2 && checkpoint.pendingIntent === null) {
      saved = checkpoint; throw Error('controlled_driver_restart');
    }
  } });
  kernel.start(snapshot, config);
  await assert.rejects(kernel.runUntilIdle(scope, snapshot.runId), /controlled_driver_restart/);
  assert.equal(saved.sourceReadQuote.status, 'ready'); assert.equal(saved.sourceReadQuote.readerCallIds.length, 6);
  if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(join(root, 'run.sqlite')); }
  const restarted = new NativeKernel({ store, owner: 'second', digest, ports });
  restarted.attach(scope, snapshot.runId, config);
  const end = await restarted.runUntilIdle(scope, snapshot.runId);
  assert.equal(end.phase, 'completed'); assert.equal(models, 2); assert.equal(budgets.length, 6);
  assert.ok(budgets.every(budget => canonical(budget) === canonical(budgets[0])));
  assert.equal(budgets[0].sourceGroupSize, 6); assert.equal(end.sourceReadQuote, null);
});

for (const broken of ['missing', 'throws', 'invalid', 'overflows', 'overflows_text', 'hangs']) test(`known model response remains committed when the source counter ${broken}`, async () => {
  const { config, snapshot } = fixture({ ...options, profile: { ...options.profile, requestTimeoutMs: broken === 'hangs' ? 100 : 10000 },
    limits: { ...options.limits, maxToolCalls: 1 } });
  const tokens = { ...context.tokens };
  if (broken === 'missing') delete tokens.countMessage;
  if (broken === 'throws') tokens.countMessage = async () => { throw Error('counter unavailable'); };
  if (broken === 'invalid') tokens.countMessage = async () => -1;
  if (broken === 'overflows') {
    tokens.countMessage = async () => Number.MAX_SAFE_INTEGER;
  }
  if (broken === 'overflows_text') tokens.countText = async () => Number.MAX_SAFE_INTEGER;
  if (broken === 'hangs') tokens.countMessage = async () => new Promise(() => {});
  const store = new MemoryRunStore(); let models = 0, reads = 0;
  const kernel = new NativeKernel({ store, owner: 'counter-failure', digest, ports: { context: { tokens },
    model: { generate: async () => ++models === 1 ? response(calls.slice(0, 1)) : response() },
    tools: { execute: async () => { reads++; throw Error('must not execute'); } } } });
  kernel.start(snapshot, config);
  const end = await kernel.runUntilIdle(scope, snapshot.runId);
  assert.equal(reads, 0); assert.equal(models, 2); assert.equal(end.phase, 'completed');
  const record = store.load(scope, snapshot.runId);
  assert.ok(record.receipts.some(receipt => receipt.result.kind === 'tool_calls'));
  assert.ok(end.messages.some(message => message.role === 'tool' && message.content.includes('source_read_budget_unavailable')));
});
