import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactToolDefinitions, governArtifactResult, executeArtifactTool, validateArtifactConfiguration,
  NativeKernel, MemoryRunStore, emptyUsage, canonical, contextContinuity, artifactProgressIdentity } from '../dist/index.mjs';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const source = tool({ name: 'source', readOnly: false, concurrentSafe: false, timeoutMs: 5000 });
const call = (name, args = {}, id = name) => ({ name, arguments: args, callId: id });
const response = calls => ({ kind: calls ? 'tool_calls' : 'final_candidate', text: calls ? '' : 'Done',
  toolCalls: calls ?? [], usage: emptyUsage() });
const policy = { artifactPolicy: 'runtime-artifacts/v1', tools: [source, ...artifactToolDefinitions()], limits: { maxToolResultBytes: 1400 } };
const context = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', taskChainId: 'chain',
  parentRunId: null, operationKey: 'original-effect', signal: new AbortController().signal };
async function storage(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-artifact-runtime-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, artifacts: await createNativeArtifactStore({ directory: join(root, 'artifacts'), scope }) };
}
const parseMessage = message => JSON.parse(message.content);
const modelBytes = result => Buffer.byteLength(canonical({ content: result.context?.content ?? canonical(result.content),
  media: result.context?.media ?? [], additionalContexts: result.additionalContexts ?? [] }));

function sourceCapacityFixture() {
  return fixture({ ...policy, sourceReadPolicy: 'studio-source-read/v1', contextPolicy: {
    tokenizerId: 'page-counter', tokenizerDigest: 'page-counter/v1', enabled: true,
    triggerRatio: .9, targetRatio: .6, summaryMaxTokens: 400, maxCompactions: 10,
    maxCompactionsWithoutProgress: 3, minModelTurnsBetween: 0, maxSummaryRetries: 1,
  } });
}
const pageBudget = { policy: 'agentkit.source-page-budget/v1', quoteDigest: 'original-quote',
  counterId: 'page-counter', tokenizerDigest: 'page-counter/v1', sourceGroupSize: 3,
  maxSourceUnits: 40, maxResultUnits: 650, maxResultBytes: 1400 };
const pageCount = async text => Math.max(1, Buffer.byteLength(text));

test('ArtifactRead applies source and quoted-result shares to continuous Unicode pages', async t => {
  const { artifacts } = await storage(t), { config, snapshot } = sourceCapacityFixture();
  const text = '😀"\\\n汉'.repeat(8), ref = await artifacts.write({ ...context, content: text, mediaType: 'text/plain', metadata: {} });
  snapshot.artifactRefs = [ref];
  let offset = 0, joined = '', pages = 0;
  do {
    const result = await executeArtifactTool(context, call('ArtifactRead', { uri: ref.uri, offset_chars: offset, limit_chars: 32000 }),
      snapshot, config, artifacts, { budget: pageBudget, countText: pageCount });
    assert.equal(result.status, 'ok'); assert.equal(result.content.offset_chars, offset);
    assert.ok(await pageCount(result.content.content) <= pageBudget.maxSourceUnits);
    assert.ok(await pageCount(canonical(canonical(result.content))) <= pageBudget.maxResultUnits);
    assert.ok(modelBytes(result) <= pageBudget.maxResultBytes);
    assert.equal(Array.from(result.content.content).length, result.content.returned_chars);
    joined += result.content.content; offset = result.content.next_offset; pages++;
    assert.ok(pages < 30);
  } while (offset !== null);
  assert.equal(joined, text); assert.ok(pages > 1);
});

test('ArtifactRead refuses missing, stale, undersized or invalid capacity before storage I/O', async t => {
  const { artifacts } = await storage(t), { config, snapshot } = sourceCapacityFixture();
  const ref = await artifacts.write({ ...context, content: 'Do not read', mediaType: 'text/plain', metadata: {} });
  snapshot.artifactRefs = [ref]; let reads = 0;
  const guarded = { ...artifacts, read: async () => { reads++; throw Error('unexpected read'); } };
  for (const capacity of [undefined,
    { budget: { ...pageBudget, tokenizerDigest: 'changed' }, countText: pageCount },
    { budget: { ...pageBudget, maxResultUnits: 1 }, countText: pageCount },
    { budget: pageBudget, countText: async () => -1 },
  ]) {
    const result = await executeArtifactTool(context, call('ArtifactRead', { uri: ref.uri }), snapshot, config, guarded, capacity);
    assert.equal(result.status, 'error');
  }
  assert.equal(reads, 0);
});

test('artifact policy is sealed, reserved definitions cannot be changed, and legacy configuration stays unmarked', () => {
  const legacy = fixture().config;
  assert.equal(Object.hasOwn(legacy, 'artifactPolicy'), false);
  assert.throws(() => fixture({ ...policy, tools: [source] }), /artifact_tool_binding_invalid/);
  const tools = [source, ...artifactToolDefinitions()]; tools[1].readOnly = false;
  assert.throws(() => fixture({ ...policy, tools }), /artifact_tool_binding_invalid/);
  assert.throws(() => fixture({ ...policy, limits: { maxToolResultBytes: 1023 } }), /artifact_result_budget_too_small/);
  assert.throws(() => validateArtifactConfiguration({ ...legacy, artifactPolicy: 'unknown' }), /invalid_artifact_policy/);
  assert.equal(fixture(policy).config.artifactPolicy, 'runtime-artifacts/v1');
});

for (const backend of ['memory', 'sqlite']) test(`${backend}: actual Kernel archives the post-policy view, retains original receipt, and restricts read/search/catalog`, async t => {
  const { root, artifacts } = await storage(t), store = backend === 'sqlite' ? new SqliteRunStore(join(root, 'run.sqlite')) : new MemoryRunStore();
  t.after(() => store.close?.());
  const raw = { secretHostFact: 'MUST_NOT_BECOME_READABLE', source: '原始回执'.repeat(2000) };
  const observed = 'model-observed:😀\n'.repeat(1000), received = [], requests = []; let effects = 0, turns = 0;
  const { config, snapshot } = fixture(policy);
  const kernel = new NativeKernel({ store, owner: 'first', digest, ports: { artifacts,
    tools: { execute: async () => { effects++; appendFileSync(join(root, 'writes'), 'one\n');
      return { status: 'ok', content: raw, context: { content: observed } }; } },
    model: { generate: async request => {
      requests.push(request); if (++turns === 1) return response([call('source')]);
      received.push(...request.messages.filter(message => message.role === 'tool'));
      if (turns === 2) {
        const uri = parseMessage(request.messages.at(-1)).artifact_uri;
        return response([call('ArtifactRead', { uri, limit_chars: 32000 }),
          call('ArtifactSearch', { uris: [uri], query: 'model-observed', max_matches: 2, context_chars: 2 }),
          call('ArtifactList'), call('ArtifactRead', { uri: 'artifact://unearned' }, 'denied')]);
      }
      return response();
    } } } });
  kernel.start(snapshot, config);
  const end = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.equal(effects, 1); assert.equal(readFileSync(join(root, 'writes'), 'utf8'), 'one\n');
  assert.equal(end.artifactRefs.length, 1);
  const first = record.receipts.find(receipt => receipt.result.results)?.result.results[0];
  assert.deepEqual(first.content, raw); assert.equal(first.status, 'ok'); assert.ok(modelBytes(first) <= 1400);
  const ref = end.artifactRefs[0], archived = await artifacts.read({ ...context, ref, offset: 0, limit: 32000 });
  assert.ok(archived.content.includes('model-observed')); assert.ok(!archived.content.includes(raw.secretHostFact));
  const page = received.find(message => message.name === 'ArtifactRead' && message.callId !== 'denied');
  assert.equal(parseMessage(page).uri, ref.uri); assert.ok(parseMessage(page).returned_chars > 0);
  assert.equal(parseMessage(page).next_offset, parseMessage(page).returned_chars);
  assert.ok(Buffer.byteLength(canonical({ content: page.content, media: [], additionalContexts: [] })) <= 1400);
  const search = parseMessage(received.find(message => message.name === 'ArtifactSearch'));
  assert.equal(search.matches.length, 2); assert.equal(search.complete, false);
  const list = parseMessage(received.find(message => message.name === 'ArtifactList'));
  assert.equal(list.total, 1); assert.equal(list.artifacts[0].uri, ref.uri);
  assert.equal(parseMessage(received.find(message => message.callId === 'denied')).code, 'artifact_not_available');
  assert.equal(end.usage.toolCalls, 5); assert.equal(requests.length, 3);
  // Reopening the durable run or asking for its terminal again cannot repeat the original mutation.
  const next = new NativeKernel({ store, owner: 'replacement', digest, ports: { artifacts,
    tools: { execute: async () => { throw new Error('must not replay'); } }, model: { generate: async () => { throw new Error('must not call'); } } } });
  assert.deepEqual(await next.runUntilIdle(scope, 'run'), end); assert.equal(effects, 1);
});

test('archive publication failure and invalid typed write return preserve a successful mutation and bound its model view', async t => {
  const { config } = fixture(policy), original = { status: 'ok', content: { committed: true, output: '中😀'.repeat(6000) },
    workspaceChangedPaths: ['result.txt'] };
  for (const artifacts of [undefined, { write: async () => { throw new Error('full disk'); } },
    { write: async () => ({ uri: 'artifact://fake', digest: 'sha256:bad', mediaType: 'application/json', sizeBytes: 1, metadata: {} }) }]) {
    const result = await governArtifactResult(context, source, original, config, artifacts);
    assert.equal(result.status, 'ok'); assert.deepEqual(result.content, original.content);
    assert.deepEqual(result.workspaceChangedPaths, ['result.txt']); assert.equal(result.artifactRefs, undefined);
    assert.equal(JSON.parse(result.context.content).artifact_state, 'unavailable'); assert.ok(modelBytes(result) <= 1400);
  }
  assert.equal(Object.hasOwn(original, 'context'), false);
});

test('callback-provided artifactRefs cannot grant authority; original observation digest excludes newly written locators', async t => {
  const { artifacts } = await storage(t), { config } = fixture(policy);
  const original = { status: 'ok', content: 'x'.repeat(3000), artifactRefs: [{ uri: 'artifact://forged' }] };
  const first = await governArtifactResult(context, source, original, config, artifacts);
  const second = await governArtifactResult({ ...context, operationKey: 'new-observation' }, source, original, config, artifacts);
  assert.notEqual(first.artifactRefs[0].uri, second.artifactRefs[0].uri);
  assert.equal(first.artifactObservationDigest, second.artifactObservationDigest);
  assert.ok(first.artifactRefs.every(ref => ref.uri !== 'artifact://forged'));
  const small = await governArtifactResult(context, source, { ...original, content: 'small' }, config, artifacts);
  assert.equal(small.artifactRefs, undefined);
});

test('approval and uncertain execution keep their control semantics and cannot publish an archive capability', async t => {
  const { config } = fixture(policy); let writes = 0;
  for (const status of ['approval_required', 'uncertain']) {
    const result = await governArtifactResult(context, source, { status, interactionId: 'original-approval', content: '字'.repeat(5000) },
      config, { write: async () => { writes++; throw new Error('must not write'); } });
    assert.equal(result.status, status); assert.equal(result.interactionId, 'original-approval'); assert.ok(modelBytes(result) <= 1400);
  }
  assert.equal(writes, 0);
});

test('Unicode page continuation is lossless under result byte ceiling and can read an inherited ref without scanning another run', async t => {
  const { artifacts } = await storage(t), { config, snapshot } = fixture(policy), text = 'a😀中\\\n'.repeat(1500);
  const ref = await artifacts.write({ ...context, content: text, mediaType: 'text/plain', metadata: {} });
  const nextSnapshot = { ...snapshot, runId: 'next-run', artifactRefs: [ref] }, nextContext = { ...context, runId: 'next-run' };
  let offset = 0, full = '', pages = 0;
  do {
    const result = await executeArtifactTool(nextContext, call('ArtifactRead', { uri: ref.uri, offset_chars: offset, limit_chars: 32000 }),
      nextSnapshot, config, artifacts);
    assert.equal(result.status, 'ok'); assert.ok(modelBytes(result) <= 1400);
    assert.equal(result.content.offset_chars, offset); assert.equal(Array.from(result.content.content).length, result.content.returned_chars);
    full += result.content.content; offset = result.content.next_offset; pages++;
    assert.ok(pages < 100);
  } while (offset !== null);
  assert.equal(full, text); assert.ok(pages > 1);
  const denied = await executeArtifactTool(nextContext, call('ArtifactRead', { uri: ref.uri }), { ...nextSnapshot, artifactRefs: [] }, config, artifacts);
  assert.equal(denied.content.code, 'artifact_not_available');
  let read = 0;
  const search = await executeArtifactTool(nextContext, call('ArtifactSearch', { uris: [ref.uri, 'artifact://missing'], query: 'a' }),
    nextSnapshot, config, { read: async () => { read++; } });
  assert.equal(search.content.code, 'artifact_not_available'); assert.equal(read, 0, 'all requested grants are checked before any storage read');
});

test('literal search crosses storage pages, does not infer complete on scan limits, and never calls storage-wide search', async t => {
  const { artifacts } = await storage(t), { config, snapshot } = fixture(policy);
  const text = '😀'.repeat(31999) + 'NEEDLE' + 'end';
  const ref = await artifacts.write({ ...context, content: text, mediaType: 'text/plain', metadata: {} });
  const port = { read: artifacts.read, search: async () => { throw new Error('forbidden scan'); } };
  const result = await executeArtifactTool(context, call('ArtifactSearch', { uris: [ref.uri], query: 'NEEDLE', context_chars: 1 }),
    { ...snapshot, artifactRefs: [ref] }, config, port);
  assert.equal(result.status, 'ok'); assert.equal(result.content.complete, true); assert.equal(result.content.matches[0].offset_chars, 31999);
  assert.equal(result.content.matches[0].excerpt, '😀NEEDLEe');
  const huge = await artifacts.write({ ...context, operationKey: 'huge', content: 'a'.repeat(1100000), mediaType: 'text/plain', metadata: {} });
  const limited = await executeArtifactTool(context, call('ArtifactSearch', { uris: [huge.uri], query: 'absent' }),
    { ...snapshot, artifactRefs: [huge] }, config, port);
  assert.equal(limited.content.complete, false); assert.deepEqual(limited.content.matches, []);
});

test('model continuity keeps a bounded inventory while ArtifactList pages the complete granted inventory', async t => {
  const { artifacts } = await storage(t), { config, snapshot } = fixture(policy), refs = [];
  for (let index = 0; index < 12; index++) refs.push(await artifacts.write({ ...context, operationKey: `ref-${index}`,
    content: String(index), mediaType: 'text/plain', metadata: {} }));
  const current = { ...snapshot, artifactRefs: refs }, continuity = contextContinuity(current, config);
  assert.equal(continuity.artifactRefs.length, 8); assert.equal(continuity.artifactCatalog.total, 12); assert.equal(continuity.artifactCatalog.omitted, 4);
  let offset = 0; const listed = [];
  do {
    const page = await executeArtifactTool(context, call('ArtifactList', { offset, limit: 8 }), current, config);
    assert.ok(modelBytes(page) <= 1400); assert.ok(page.content.artifacts.length > 0);
    listed.push(...page.content.artifacts.map(ref => ref.uri)); offset = page.content.next_offset;
  } while (offset !== null);
  assert.deepEqual(listed, refs.map(ref => ref.uri));
});

test('minimum UTF-8 budgets include escaping, omissions and locator framing; duplicate captures do not create progress', async t => {
  const { artifacts } = await storage(t), content = { text: '中😀\\\n\"'.repeat(1200) };
  for (const maximum of [1024, 1025, 1400, 2048]) {
    const { config, snapshot } = fixture({ ...policy, limits: { maxToolResultBytes: maximum } });
    const result = await governArtifactResult({ ...context, operationKey: `budget-${maximum}` }, source,
      { status: 'ok', content }, config, artifacts);
    assert.equal(result.status, 'ok'); assert.equal(result.artifactRefs.length, 1); assert.ok(modelBytes(result) <= maximum);
    const ref = result.artifactRefs[0];
    const search = await executeArtifactTool(context, call('ArtifactSearch', { uris: [ref.uri], query: 'text', context_chars: 256 }),
      { ...snapshot, artifactRefs: [ref] }, config, artifacts);
    assert.ok(modelBytes(search) <= maximum);
    assert.deepEqual(artifactProgressIdentity([ref, { ...ref, uri: 'artifact://another-capture' }]), artifactProgressIdentity([ref]));
  }
});

test('receipt reconciliation archives a known large original result without repeating its effect, and a real next turn inherits the grant', async t => {
  const { root, artifacts } = await storage(t), store = new SqliteRunStore(join(root, 'reconcile.sqlite'));
  t.after(() => store.close());
  const definition = { ...source, recoveryPolicy: 'receipt-observation/v1' }, raw = { committed: true, text: '已提交😀'.repeat(2500) };
  const { config, snapshot } = fixture({ ...policy, tools: [definition, ...artifactToolDefinitions()] });
  let effects = 0, queries = 0, models = 0, originalKey;
  const kernel = new NativeKernel({ store, owner: 'original-owner', digest, ports: { artifacts,
    tools: {
      execute: async request => { effects++; originalKey = request.operationKey; return { status: 'uncertain', content: { code: 'lost_remote_receipt' } }; },
      observeReceipt: async request => { queries++; assert.equal(request.originalOperationKey, originalKey);
        return { contract: 'agentkit.tool-receipt-observation/v1', originalOperationKey: originalKey, callId: request.call.callId,
          result: { status: 'ok', content: raw, context: { content: 'Observed original result'.repeat(200) } } }; },
    }, model: { generate: async () => ++models === 1 ? response([call('source')]) : response() } } });
  kernel.start(snapshot, config);
  const waiting = await kernel.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_reconciliation');
  kernel.reconcileTool(scope, 'run', waiting.toolReconciliation.operationKey, 'observe-original');
  const end = await kernel.runUntilIdle(scope, 'run'); assert.equal(end.phase, 'completed');
  assert.equal(effects, 1); assert.equal(queries, 1); assert.equal(end.usage.toolCalls, 1); assert.equal(end.artifactRefs.length, 1);
  const observation = store.load(scope, 'run').receipts.find(receipt => receipt.result.contract === 'agentkit.tool-receipt-observation/v1');
  assert.deepEqual(observation.result.result.content, raw); assert.ok(modelBytes(observation.result.result) <= 1400);
  const ref = end.artifactRefs[0]; let nextCalls = 0, read;
  const next = new NativeKernel({ store, owner: 'next-turn-owner', digest, ports: { artifacts,
    tools: { execute: async () => { throw new Error('must not invoke Host tool for artifact read'); } },
    model: { generate: async request => {
      if (++nextCalls === 1) return response([call('ArtifactRead', { uri: ref.uri, limit_chars: 40 }, 'next-turn-page')]);
      read = parseMessage(request.messages.find(message => message.callId === 'next-turn-page')); return response();
    } } } });
  const initial = next.start({ ...snapshot, runId: 'next-run', turnId: 'next-turn', parentRunId: 'run' }, config);
  assert.deepEqual(initial.artifactRefs, [ref]);
  const finished = await next.runUntilIdle(scope, 'next-run'); assert.equal(finished.phase, 'completed');
  assert.equal(read.uri, ref.uri); assert.equal(read.returned_chars, 40); assert.equal(effects, 1);
});

test('a forced small archive retains its complete observed view; a pre-existing unearned archive is unavailable within an actual parallel batch', async t => {
  const { root, artifacts } = await storage(t), { config } = fixture(policy);
  const forced = { ...source, resultArchivePolicy: 'archived-model-view/v4' };
  const result = await governArtifactResult(context, forced, { status: 'ok', content: { raw: 'private' }, context: { content: 'complete observed text' } }, config, artifacts);
  assert.equal(result.artifactRefs.length, 1); assert.equal(JSON.parse(result.context.content).observed_content, 'complete observed text');
  const ref = result.artifactRefs[0], store = new SqliteRunStore(join(root, 'parallel.sqlite')); t.after(() => store.close());
  const readOnly = tool({ name: 'observe', contextRole: 'workspace_read', resultArchivePolicy: 'archived-model-view/v4' });
  const data = fixture({ ...policy, tools: [readOnly, ...artifactToolDefinitions()] }); let models = 0, denial, executes = 0;
  const kernel = new NativeKernel({ store, owner: 'parallel-owner', digest, ports: { artifacts,
    tools: { execute: async () => { executes++; return { status: 'ok', content: 'actual observed content' }; } },
    model: { generate: async request => {
      if (++models === 1) return response([call('observe'), call('ArtifactRead', { uri: ref.uri })]);
      denial = parseMessage(request.messages.find(message => message.name === 'ArtifactRead')); return response();
    } } } });
  kernel.start(data.snapshot, data.config); const end = await kernel.runUntilIdle(scope, 'run');
  assert.equal(end.phase, 'completed'); assert.equal(denial.code, 'artifact_not_available'); assert.equal(executes, 1);
  assert.equal(end.artifactRefs.length, 1); assert.notEqual(end.artifactRefs[0].uri, ref.uri);
});
