import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { memoryDigest } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';
import { buildExecutionEngine } from '../src/build-engine.mjs';
import { StudioNativeMemoryExtractionStore } from '../src/host/services/native-memory-extraction-store.mjs';

// Host-level Memory integration. Real SqliteRunStore, real Memory provider
// opened by the Host, and the production createNativeDshTools gateway. The DSH
// tool pre/guard/around/post pipeline here is a thin fixture
// (toolCtx.tools.execute calls registered.execute directly); it exercises the
// real gateway registration/dispatch/standing-policy/consent wiring but does
// NOT reproduce the full packed DSH permission pipeline. The model HTTP
// response and the approval service are fixtures. Parent verifies the real
// packed DSH pipeline via mountStudioHost separately.

const finish = text => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] });
const toolCall = (id, name, args) => ({ choices: [{ index: 0, delta: { tool_calls: [
  { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

function memoryPath(root, scope) {
  return join(root, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite');
}

async function setup(t, { spec, approval = async () => 'allowed-once', respond, observeMemory } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-memory-host-'));
  const workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root });
  let ledger = new SqliteRunStore(join(root, 'runs.sqlite'));
  const fullSpec = { ...spec, bindings: { modelProfileIds: ['fixture'] } };
  const record = await agents.create({ name: 'Native', runtimeType: 'harness', spec: fullSpec });
  const events = [], definitions = new Map(), requests = [];
  let modelCalls = 0;
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned',
    baseUrl: 'https://model.invalid/v1', contextWindow: 16000, maxOutputTokens: 1024 }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) },
    credentials: { resolve: async () => ({ value: 'secret' }) } });
  const session = { id: 'session', append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 });
  const approvalService = { request: async req => approval(req) };
  const toolRegistry = new Map();
  // The production DSH tool pipeline: register + execute + the standing Node
  // builtin policy. The Memory tool body is registered by the Host's bindMemory
  // and dispatched through this pipeline exactly like a workspace builtin.
  const toolCtx = {
    effect: install => install(),
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: approvalService,
    tools: {
      register: tool => { toolRegistry.set(tool.name, tool); return () => toolRegistry.delete(tool.name); },
      execute: async input => {
        requests.push({ tool: input.name });
        const registered = toolRegistry.get(input.name);
        const value = await registered.execute(input.arguments, input);
        return { isError: false, value, content: registered.output.render(input.arguments, value) };
      },
    },
    get: id => id === 'approval' ? approvalService : id === 'sandboxPolicy' ? toolCtx.sandboxPolicy : undefined,
  };
  const nativeTools = createNativeDshTools({ ctx: toolCtx, config: { toolBindings: [], toolContracts: [] },
    workspaceRoot, stateDir: join(root, 'state') });
  if (observeMemory) {
    const bindMemory = nativeTools.bindMemory;
    nativeTools.bindMemory = memory => { observeMemory(memory); return bindMemory(memory); };
  }
  const services = { sessions: { flush: async () => true }, llm: {},
    sessionController: { resolveAgent: async sessionId => ({ agent: sessionId === session.id
      ? { session, externalTurns: nativeOwnershipHost(session, events) } : null }) },
    sessionProjections: { register(definition) { definitions.set(definition.key, definition); return () => definitions.delete(definition.key); },
      stateOf(_session, id) { const definition = definitions.get(id); return definition ? events.reduce(definition.apply, definition.init()) : undefined; } } };
  // One ctx serves the harness services, the DSH tool pipeline and the Memory
  // consent (the real approval service), exactly as production bootstrap wires.
  const ctx = { get: id => services[id] ?? toolCtx.get(id), effect: toolCtx.effect,
    tools: toolCtx.tools, sandboxPolicy: toolCtx.sandboxPolicy, approval: approvalService };
  const builds = { resolve: async (agentId, buildId) => ({ ...structuredClone(record),
    executionEngine: buildExecutionEngine(record.spec, 'agentkit.native-dsh-turn/v1') }) };
  const openHost = () => createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, builds, models, ledger,
    renderPrompt: () => 'Trusted Host instructions', fetchImpl: async (url, options) => {
      modelCalls++;
      const body = JSON.parse(options.body);
      const response = respond ? respond(modelCalls, body) : finish('Done.');
      return new Response(`data: ${JSON.stringify({ id: `response-${modelCalls}`, ...response,
        usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  let host = await openHost();
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const payload = (text, turn = 1, buildId) => ({ agent: { session, externalTurns: nativeOwnershipHost(session, events),
    options: { provider: 'agentkit-studio-fixture', model: 'pinned' } },
    input: { kind: 'enter', messages: [{ id: `input-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text }] }], assembly: { tools: [] } },
    turn, signal: new AbortController().signal, prepareInput: async () => ({ kind: 'enter', messages: [], assembly: { tools: [] } }),
    binding: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools, ...(buildId ? { buildId } : {}) } });
  const head = () => ledger.sessionHead({ tenantId: 'local',
    workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
    userId: 'local-user', agentId: record.metadata.id }, 'session');
  const run = async (text, turn, buildId) => { await host.executeTurn(payload(text, turn, buildId)); return head(); };
  const memoryProvider = scope => new SqliteNativeMemoryProvider(memoryPath(root, scope), { principal: scope });
  return { root, get host() { return host; }, record, get ledger() { return ledger; }, agents,
    run, head, payload, memoryProvider, requests, events, toolRegistry,
    async reopenHost() { await host.close(); ledger = new SqliteRunStore(join(root, 'runs.sqlite')); host = await openHost(); } };
}

async function exportMemoryUiEvidence(name, h, snapshot) {
  const status = await h.host.recoveryStatus({ agentId: h.record.metadata.id, sessionId: snapshot.sessionId });
  assert.equal(status.accounting.own.modelCalls, 1);
  assert.equal(status.memoryExtraction.jobs.length, 1);
  if (process.env.AGENTKIT_NATIVE_MEMORY_UI_EVIDENCE_DIR) {
    await mkdir(process.env.AGENTKIT_NATIVE_MEMORY_UI_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AGENTKIT_NATIVE_MEMORY_UI_EVIDENCE_DIR, `${name}.json`),
      JSON.stringify({ record: h.record, status }, null, 2));
  }
  return status;
}

test('production Host completion persists and dispatches opt-in model Memory after the main turn', async t => {
  let auxiliaryCalls = 0;
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate' }, extraction: { enabled: true, minUserCharacters: 8 }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } }, respond: (_count, body) => {
      const automatic = body.tools?.some(tool => tool.function?.parameters?.properties?.source_event_ids);
      if (!automatic) return finish('Main answer delivered.');
      auxiliaryCalls++;
      if (body.messages.some(message => message.role === 'tool')) return finish('Memory extraction finished.');
      const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const source = input.source.messages.find(message => message.role === 'user' && !message.modelOnly);
      return toolCall('automatic-fact', 'manage_memory', { action: 'remember', scope: 'user',
        content: 'Company invoices use UTC.', memory_type: 'fact', source_event_ids: [source.id] });
    } });
  const snapshot = await h.run('公司财务报表和发票日期统一使用协调世界时。');
  assert.equal(snapshot.phase, 'completed');
  const jobs = new StudioNativeMemoryExtractionStore(join(h.root, 'native-harness', 'memory-extraction.sqlite'));
  try {
    const deadline = Date.now() + 5000;
    let rows;
    do {
      rows = jobs.list({ scope: snapshot.scope, sessionId: snapshot.sessionId });
      if (rows.some(row => ['success', 'error', 'aborted'].includes(row.status))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'success', JSON.stringify(rows.map(row => ({ status: row.status, error: row.errorCode }))));
    assert.equal(rows[0].usage.modelCalls, 2); assert.equal(auxiliaryCalls, 2);
    const status = await exportMemoryUiEvidence('success', h, snapshot);
    assert.equal(status.memoryExtraction.jobs[0].status, 'success');
    assert.equal(status.memoryExtraction.jobs[0].usage.modelCalls, 2);
    assert.equal(h.ledger.load(snapshot.scope, snapshot.runId).snapshot.usage.modelCalls, 1);
    assert.equal(rows[0].prepared.identity.buildId, snapshot.buildId);
    assert.equal(rows[0].source.parent.buildId, null, 'live revision and published Build identities remain distinct');
    const provider = h.memoryProvider(snapshot.scope);
    try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].memoryType, 'fact'); }
    finally { provider.close(); }
  } finally { jobs.close(); }
});

test('production recovery status exposes exhausted auxiliary usage separately from the completed parent', async t => {
  let auxiliaryCalls = 0;
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate' }, extraction: { enabled: true, minUserCharacters: 8 }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } }, respond: (_count, body) => {
      if (!body.tools?.some(tool => tool.function?.parameters?.properties?.source_event_ids)) return finish('Delivered.');
      auxiliaryCalls++;
      return toolCall(`read-${auxiliaryCalls}`, 'read_memory', { memory_id: 'missing-fact' });
    } });
  const snapshot = await h.run('公司的财务报表和发票日期统一使用协调世界时。');
  const jobs = new StudioNativeMemoryExtractionStore(join(h.root, 'native-harness', 'memory-extraction.sqlite'));
  try {
    const deadline = Date.now() + 5000;
    let rows;
    do {
      rows = jobs.list({ scope: snapshot.scope, sessionId: snapshot.sessionId });
      if (rows[0]?.status === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(rows[0]?.status, 'error'); assert.equal(auxiliaryCalls, 5);
    const status = await exportMemoryUiEvidence('budget', h, snapshot);
    assert.equal(status.memoryExtraction.jobs[0].errorCode, 'native_memory_extraction_budget_exhausted');
    assert.equal(status.memoryExtraction.jobs[0].usage.modelCalls, 5);
    assert.equal(status.memoryExtraction.cursor, null);
  } finally { jobs.close(); }
});

test('production Host startup recovers missed extraction from the frozen revision after the mutable draft disables Memory', async t => {
  let auxiliaryCalls = 0;
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate' }, extraction: { enabled: true, minUserCharacters: 8 }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    observeMemory: memory => {
      memory.memoryTurn.consume = async () => { throw Error('controlled failure before extraction enqueue'); };
    },
    respond: (_count, body) => {
      if (!body.tools?.some(tool => tool.function?.parameters?.properties?.source_event_ids)) return finish('Delivered.');
      auxiliaryCalls++;
      return finish('No additional memory needed.');
    } });
  await h.run('公司的财务报表和发票日期统一使用协调世界时。');
  const snapshot = h.head(); assert.equal(snapshot.phase, 'completed');
  const jobs = new StudioNativeMemoryExtractionStore(join(h.root, 'native-harness', 'memory-extraction.sqlite'));
  try {
    assert.equal(jobs.list({ scope: snapshot.scope, sessionId: snapshot.sessionId }).length, 0);
    await h.agents.update(h.record.metadata.id, { expectedRevision: 1,
      spec: { ...h.record.spec, memory: { ...h.record.spec.memory, extraction: { enabled: false } } } });
    await h.reopenHost();
    let rows;
    const deadline = Date.now() + 5000;
    do {
      rows = jobs.list({ scope: snapshot.scope, sessionId: snapshot.sessionId });
      if (rows[0]?.status === 'success' || rows[0]?.status === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source.parent.revision, 1, 'startup must resolve the original immutable revision');
    assert.equal(rows[0].status, 'success', JSON.stringify(rows.map(row => ({ status: row.status, error: row.errorCode }))));
    assert.equal(auxiliaryCalls, 1);
    await h.reopenHost(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(jobs.list({ scope: snapshot.scope, sessionId: snapshot.sessionId }).length, 1);
    assert.equal(auxiliaryCalls, 1);
  } finally { jobs.close(); }
});

test('an enabled Memory Build exposes read/search/manage tools through the real DSH pipeline', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: true, maxTokens: 1600 } },
    context: { rollout: { memoryWrite: 'enabled' } } } });
  await h.run('Deliver a response.', 1);
  const snapshot = h.head();
  const run = h.ledger.load(snapshot.scope, snapshot.runId);
  const names = run.configuration.tools.map(tool => tool.name);
  assert.ok(names.includes('read_memory'));
  assert.ok(names.includes('search_memory'));
  assert.ok(names.includes('manage_memory'));
  assert.equal(typeof run.configuration.hostBindingDigest, 'string');
  assert.equal(run.configuration.hostBindingDigest.length, 64);
});

test('two independent original human sources converge to one Memory fact via the completed-turn consumer', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true },
    recall: { enabled: false, maxTokens: 0 } }, context: { rollout: { memoryWrite: 'enabled' } } },
    respond: () => finish('Delivered.') });
  for (const turn of [1, 2]) {
    if (turn > 1) h.events.push({ type: 'turn/start', data: { turn }, seq: h.events.length + 1 });
    const snapshot = await h.run('我喜欢用Vim', turn);
    assert.equal(snapshot.phase, 'completed', snapshot.reason);
  }
  const snapshot = h.head();
  const provider = h.memoryProvider(snapshot.scope);
  try {
    const records = provider.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].content, '我喜欢用Vim');
    assert.equal(records[0].version, 1);
    assert.equal(records[0].sourceEventIds.length, 2, 'two independent runs each observed once');
  } finally { provider.close(); }
});

test('Host completed-turn consumption confirms a direct Memory write with the original owner receipt', async t => {
  const consumed = [], ownerRequests = [];
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate', flushBeforeCompaction: false, flushAfterTurn: true },
    recall: { enabled: false, maxTokens: 0 } }, context: { rollout: { memoryWrite: 'enabled' } } },
    observeMemory: memory => {
      const consume = memory.memoryTurn.consume;
      memory.memoryTurn.consume = async (snapshot, options) => {
        const directWriteReceipt = options.directWriteReceipt;
        const result = await consume(snapshot, { ...options, directWriteReceipt: async request => {
          const receipt = await directWriteReceipt(request);
          ownerRequests.push({ request, receipt });
          return receipt;
        } });
        consumed.push(result);
        return result;
      };
    }, respond: count => count === 1 ? toolCall('direct-memory', 'manage_memory',
      { action: 'remember', scope: 'user', content: '我喜欢用Vim' }) : finish('Done.') });
  // Ordinary preference input exercises direct-write verification. An explicit
  // "remember" request is handled by its dedicated verifier and skips this path.
  const snapshot = await h.run('我喜欢用Vim');
  assert.equal(snapshot.phase, 'completed', snapshot.reason);
  assert.deepEqual(consumed, [{ status: 'direct_write_already_committed' }]);
  assert.equal(ownerRequests.length, 1);
  const { request, receipt } = ownerRequests[0];
  assert.deepEqual(request.scope, snapshot.scope);
  assert.equal(request.runId, snapshot.runId);
  assert.equal(request.call.callId, 'direct-memory');
  assert.equal(request.definition.name, 'manage_memory');
  assert.equal(receipt.committed, true);
  assert.deepEqual(receipt, request.toolResultContent);
  const run = h.ledger.load(snapshot.scope, snapshot.runId);
  const intent = run.intents.find(item => item.kind === 'tool');
  assert.equal(request.operationKey, intent.operationKey);
  const provider = h.memoryProvider(snapshot.scope);
  try {
    assert.equal(provider.list().length, 1);
    assert.equal(provider.list()[0].content, '我喜欢用Vim');
    assert.equal(provider.list()[0].version, 1);
  } finally { provider.close(); }
});

test('an explicit remember qualified only with an actual owner fact and matching receipt verifies the task', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'explicit_only', flushAfterTurn: false }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    respond: (count, body) => {
      const toolResults = body.messages.filter(message => message.role === 'tool');
      if (count === 1) return toolCall('call-1', 'manage_memory',
        { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' });
      return finish('已记住。');
    } });
  const snapshot = await h.run('记住我的编辑器是 Vim');
  assert.equal(snapshot.phase, 'completed', snapshot.reason);
  assert.equal(snapshot.outcome, 'verified', snapshot.reason);
  assert.equal(snapshot.verification.checks[0].status, 'passed');
  const provider = h.memoryProvider(snapshot.scope);
  try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].content, '我的编辑器是 Vim'); }
  finally { provider.close(); }
});

test('an explicit task where the model only promises (no manage_memory write) is not verified and does not auto-write', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'explicit_only', flushAfterTurn: true }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    respond: () => finish('我会记住你的编辑器是 Vim。') });
  const snapshot = await h.run('记住我的编辑器是 Vim');
  assert.equal(snapshot.phase, 'completed');
  assert.notEqual(snapshot.outcome, 'verified');
  assert.equal(snapshot.verification.checks[0].status, 'failed');
  // explicit_only + no recognized write: the completed-turn consumer does not
  // fall back to auto-extracting the promised content.
  const provider = h.memoryProvider(snapshot.scope);
  try { assert.equal(provider.list().length, 0); } finally { provider.close(); }
});

test('write off exposes no manage_memory tool and an explicit task fails closed without auto-write', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'off', flushAfterTurn: false }, recall: { enabled: true, maxTokens: 1600 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    respond: () => finish('Delivered.') });
  const snapshot = await h.run('Deliver a response.');
  const run = h.ledger.load(snapshot.scope, snapshot.runId);
  const names = run.configuration.tools.map(tool => tool.name);
  assert.ok(names.includes('read_memory'));
  assert.ok(!names.includes('manage_memory'));
  // An explicit Memory task with write off fails closed: no owner, no tool.
  h.events.push({ type: 'turn/start', data: { turn: 2 }, seq: h.events.length + 1 });
  const explicit = await h.run('记住我的编辑器是 Vim', 2);
  assert.notEqual(explicit.outcome, 'verified');
  const provider = h.memoryProvider(snapshot.scope);
  try { assert.equal(provider.list().length, 0); } finally { provider.close(); }
});

test('a non-explicit manage_memory write requires exact-call approval; a denied consent blocks the write', async t => {
  let decided;
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    approval: async () => (decided === 'deny' ? 'rejected' : 'allowed-once'),
    respond: count => count === 1 ? toolCall('call-1', 'manage_memory',
      { action: 'remember', scope: 'user', content: 'my coffee is flat white' }) : finish('Saved.') });
  const ok = await h.run('Help me save a preference.');
  assert.equal(ok.phase, 'completed');
  const provider = h.memoryProvider(ok.scope);
  try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].writePolicy, 'auto'); }
  finally { provider.close(); }
  // A second run with denied consent must not write.
  decided = 'deny';
  h.events.push({ type: 'turn/start', data: { turn: 2 }, seq: h.events.length + 1 });
  const denied = await h.run('Help me save another preference.', 2);
  assert.equal(denied.phase, 'completed', denied.reason);
  const provider2 = h.memoryProvider(denied.scope);
  try { assert.equal(provider2.list().length, 1, 'denied consent wrote nothing new'); }
  finally { provider2.close(); }
});

test('a manage_memory write to a scope outside the locked policy is rejected before the provider writes', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    respond: count => count === 1 ? toolCall('call-1', 'manage_memory',
      { action: 'remember', scope: 'workspace', content: 'leaked fact' }) : finish('Saved.') });
  const snapshot = await h.run('Save a workspace fact.');
  assert.equal(snapshot.phase, 'completed');
  const provider = h.memoryProvider(snapshot.scope);
  try { assert.equal(provider.list().length, 0, 'workspace scope is not in the locked policy'); }
  finally { provider.close(); }
});

test('a Frozen Build (actual buildId) and a Revision Build (revision-<hash>) both persist an explicit Memory fact and survive a reopened database', async t => {
  const rememberRespond = (count, body) => {
    const toolResults = body.messages.filter(message => message.role === 'tool');
    if (count === 1) return toolCall('call-1', 'manage_memory',
      { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' });
    return finish('已记住。');
  };
  for (const frozen of [false, true]) {
    const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      write: { mode: 'explicit_only', flushAfterTurn: false }, recall: { enabled: false, maxTokens: 0 } },
      context: { rollout: { memoryWrite: 'enabled' } } }, respond: rememberRespond });
    const snapshot = await h.run('记住我的编辑器是 Vim', 1, frozen ? 'frozen-build-1' : undefined);
    assert.equal(snapshot.phase, 'completed', snapshot.reason);
    assert.equal(snapshot.outcome, 'verified', snapshot.reason);
    if (frozen) assert.equal(snapshot.buildId, 'frozen-build-1');
    else assert.match(snapshot.buildId, /^revision-/);
    const provider = h.memoryProvider(snapshot.scope);
    try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].content, '我的编辑器是 Vim'); }
    finally { provider.close(); }
    await h.host.close();
    // Reopen the same database file: the committed fact survives (real SQLite, WAL).
    const reopened = new SqliteNativeMemoryProvider(memoryPath(h.root, snapshot.scope), { principal: snapshot.scope });
    try { assert.equal(reopened.list().length, 1); assert.equal(reopened.list()[0].content, '我的编辑器是 Vim'); }
    finally { reopened.close(); }
  }
});

test('after the Host closes, the Memory database is stable: no teardown or late completed-turn write duplicates the committed fact', async t => {
  const h = await setup(t, { spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'explicit_only', flushAfterTurn: true }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } },
    respond: count => count === 1 ? toolCall('call-1', 'manage_memory',
      { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }) : finish('已记住。') });
  const snapshot = await h.run('记住我的编辑器是 Vim');
  assert.equal(snapshot.phase, 'completed');
  assert.equal(snapshot.outcome, 'verified', snapshot.reason);
  // A second turn repeats the same explicit write. The completed-turn consumer
  // sees the direct manage_memory receipt (direct_write_already_committed) and
  // does not auto-extract the same input; the store receipt is idempotent.
  h.events.push({ type: 'turn/start', data: { turn: 2 }, seq: h.events.length + 1 });
  const second = await h.run('记住我的编辑器是 Vim', 2);
  assert.equal(second.phase, 'completed');
  let provider = h.memoryProvider(snapshot.scope);
  try { assert.equal(provider.list().length, 1); assert.equal(provider.list()[0].version, 1); }
  finally { provider.close(); }
  await h.host.close();
  // After the Host closes (consumer/provider released in releaseResources), a
  // late callback cannot write: the fact set is unchanged on reopen.
  const reopened = new SqliteNativeMemoryProvider(memoryPath(h.root, snapshot.scope), { principal: snapshot.scope });
  try { assert.equal(reopened.list().length, 1); assert.equal(reopened.list()[0].version, 1); }
  finally { reopened.close(); }
});

