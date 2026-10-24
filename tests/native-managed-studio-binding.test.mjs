import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { createHash } from 'node:crypto';

import { MemoryRunStore, NativeKernel, canonical, copy } from '../packages/agentkit-harness-core/dist/index.mjs';

import { tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';

import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';

import { memoryDigest } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';

import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';

import { createAgentStore } from '../src/agent-store.mjs';

import { createModelService } from '../src/model-service.mjs';

import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';

import { createStudioManagedNativeBinding } from '../src/host/services/native-managed-binding.mjs';

import { buildExecutionEngine } from '../src/build-engine.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Build a real createStudioNativeHarness against synthetic Host services plus a
 * separate managed ledger. The harness wires the real model/tool/Memory/Skill/
 * MCP/Browser/children/hooks assembler; only the DSH Session lifecycle and the
 * managed execution are test doubles. The local ledger is the harness's own
 * store; the managed ledger is the one a trusted caller passes to
 * resolveManagedBinding, so tests can prove the managed Run never touches it. */
async function setup(t, { spec = {}, profile = {}, respond, frozen = false, text = 'Finish the managed task', sqlite = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'managed-binding-unit-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const agents = createAgentStore({ storeDir: root });
  const localStore = new MemoryRunStore();
  const managedStore = sqlite ? new SqliteRunStore(join(root, 'managed-runs.sqlite')) : new MemoryRunStore();
  const fullSpec = { ...spec, bindings: { modelProfileIds: ['fixture'], ...spec.bindings } };
  const record = await agents.create({ name: 'Managed', runtimeType: 'harness', spec: fullSpec });
  const events = [], definitions = new Map(), requests = [];
  let apiKey = 'secret-managed';
  const values = { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned',
    baseUrl: 'https://model.invalid/v1', ...profile }] };
  const models = createModelService({ configuration: { resolve: async () => ({ values }) },
    credentials: { resolve: async () => ({ value: apiKey }) },
    fetchImpl: async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }) });
  const session = { id: 'managed-session',
    append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 });
  const assembly = { tools: [], variables: { provider: 'agentkit-studio-fixture', model: 'pinned' } };
  const agent = { session, options: { provider: 'agentkit-studio-fixture', model: 'pinned' }, whenIdle: async () => {} };
  const services = {
    sessions: { flush: async () => true }, llm: {},
    sessionProjections: {
      register(definition) { definitions.set(definition.key, definition); return () => { definitions.delete(definition.key); }; },
      stateOf(_session, id) { const definition = definitions.get(id); return definition ? events.reduce(definition.apply, definition.init()) : undefined; },
    },
    systemPrompt: { assemble: async () => assembly },
    sessionController: { resolveAgent: async id => ({ agent }) },
  };
  const ctx = { get: id => services[id] };
  const resolutions = [];
  const builds = { resolve: async (agentId, buildId) => {
    resolutions.push({ agentId, buildId });
    return { ...structuredClone(record), executionEngine: buildExecutionEngine(record.spec, 'agentkit.native-dsh-turn/v1') };
  } };
  const agentBinding = { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1',
    nativeTools: { definitions: () => [], forAgent: () => ({ tools: { execute: async () => assert.fail('No tool dispatched') } }) } };
  if (frozen) agentBinding.buildId = 'frozen-managed-build';
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, builds, models, ledger: localStore,
    agentEvents: () => ({ serial: async () => agentBinding }),
    assembleContextFor: () => ({ agent }),
    renderPrompt: () => 'Trusted Host instructions',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const response = respond ? respond(requests.length, JSON.parse(options.body))
        : { choices: [{ index: 0, delta: { content: 'Complete' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify({ id: `response-${requests.length}`, ...response,
        usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); localStore.close?.(); managedStore.close?.(); await rm(root, { recursive: true, force: true }); });
  const workspaceId = createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex');
  const target = { tenantId: 'tenant-managed', agentInstanceId: record.metadata.id };
  const principal = { userId: 'managed-user' };
  const expectedScope = { tenantId: target.tenantId, workspaceId, userId: principal.userId, agentId: target.agentInstanceId };
  const makePayload = (overrides = {}) => ({
    agent, signal: new AbortController().signal,
    input: { kind: 'enter', messages: [{ id: 'input-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text }] }] },
    prepareInput: async () => ({ kind: 'enter', messages: [], assembly }),
    ...overrides,
  });
  const makeCommand = (overrides = {}) => ({
    tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, command_type: 'enqueue',
    session_id: session.id, command_id: 'cmd-1', payload: { content: text },
    ...overrides,
  });
  return { root, workspaceRoot, host, localStore, managedStore, record, agents, models, builds, resolutions, values,
    requests, events, services, ctx, assembly, session, agent, target, principal, expectedScope,
    agentBinding, workspaceId, makePayload, makeCommand };
}

/** Drive a real NativeKernel against a resolved managed binding's ports and the
 * managed ledger. During withExecution the deferred ports delegate to the live
 * binding's ports, so the kernel exercises the real model/tool/verification stack. */
async function runManagedKernel({ binding, store, runId, sessionId, signal, turn = 1, parentRunId = null }) {
  const kernel = new NativeKernel({ store, ports: binding.ports, digest: hash, owner: 'test-managed-owner' });
  const identity = { scope: copy(binding.scope), runId, sessionId: String(sessionId),
    turnId: String(turn), buildId: binding.buildId, parentRunId, taskChainId: parentRunId ?? runId };
  kernel.start(identity, binding.configuration, { expectedParentRunId: parentRunId });
  return kernel.runUntilIdle(binding.scope, runId, { signal });
}

// --- Part A: createStudioNativeHarness.resolveManagedBinding (real assembler + real NativeKernel + managed SQLite) ---

test('managed resolveManagedBinding runs model->tool->result through the managed SQLite ledger and leaves the local ledger untouched', async t => {
  let toolCalls = 0;
  const h = await setup(t, { sqlite: true,
    respond: count => count === 1
      ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function',
        function: { name: 'inspect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
      : { choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] },
  });
  const inspectTool = tool({ name: 'inspect' });
  h.agentBinding.nativeTools = { definitions: () => [inspectTool],
    forAgent: () => ({ tools: { execute: async () => { toolCalls++; return { status: 'ok',
      content: 'TOOL_RESULT_IN_MANAGED_LEDGER',
      resourceUsage: { modelCalls: 0, toolCalls: 1, inputTokens: 0, outputTokens: 0, cost: 0 } }; } } }) };
  const runId = 'managed-run-1';
  const payload = h.makePayload();
  const binding = await h.host.resolveManagedBinding(payload, { store: h.managedStore, runId,
    target: h.target, principal: h.principal });
  assert.deepEqual(binding.scope, h.expectedScope);
  assert.equal(typeof binding.ports.model.generate, 'function');
  assert.equal(typeof binding.ports.tools.execute, 'function');
  const snapshot = await runManagedKernel({ binding, store: h.managedStore, runId,
    sessionId: h.session.id, signal: payload.signal });
  assert.equal(snapshot.phase, 'completed');
  assert.equal(toolCalls, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, 'https://model.invalid/v1/chat/completions');
  const record = h.managedStore.load(binding.scope, runId);
  assert.equal(record.snapshot.phase, 'completed');
  assert.equal(record.snapshot.usage.modelCalls, 2);
  assert.equal(record.snapshot.usage.toolCalls, 1);
  const toolReceipt = record.receipts.flatMap(receipt => receipt.result?.results ?? [])
    .find(result => result.content === 'TOOL_RESULT_IN_MANAGED_LEDGER');
  assert.ok(toolReceipt, 'the tool result is sealed in the managed ledger');
  assert.equal(JSON.stringify(record).includes('secret-managed'), false, 'credentials stay outside the ledger');
  // The local harness ledger is untouched: no Run, no session head.
  assert.equal(h.localStore.sessionHead(h.expectedScope, h.session.id), null);
  assert.deepEqual(h.localStore.list(h.expectedScope), []);
  assert.throws(() => h.localStore.load(h.expectedScope, runId), { code: 'run_not_found' });
  await binding.releaseResources?.({ scope: binding.scope, runId, sessionId: h.session.id });
});

test('managed resolveManagedBinding resolves a Frozen Build through builds.resolve', async t => {
  const h = await setup(t, { frozen: true });
  h.agentBinding.nativeTools = { definitions: () => [],
    forAgent: () => ({ tools: { execute: async () => ({ status: 'ok', content: 'ok' }) } }) };
  const payload = h.makePayload();
  const binding = await h.host.resolveManagedBinding(payload, { store: h.managedStore, runId: 'frozen-run-1',
    target: h.target, principal: h.principal });
  assert.equal(binding.buildId, 'frozen-managed-build');
  assert.deepEqual(h.resolutions, [{ agentId: h.record.metadata.id, buildId: 'frozen-managed-build' }]);
  assert.equal(binding.configuration.hostRecoveryBinding.buildId, 'frozen-managed-build');
  await binding.releaseResources?.({ scope: binding.scope, runId: 'frozen-run-1', sessionId: h.session.id });
});

test('withExecution invokes the completed-Turn consumer at a completed terminal through managed SQLite', async t => {
  const h = await setup(t, { sqlite: true,
    spec: { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      write: { mode: 'candidate', flushAfterTurn: true } },
      context: { rollout: { memoryWrite: 'enabled' } } },
    // Explicit "remember" tasks belong to the main Run's governed Memory
    // tools. This ordinary preference exercises completed-turn extraction.
    text: '我喜欢用Vim',
    respond: () => ({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] }),
  });
  const hostPrepareInput = async () => ({ kind: 'enter', messages: [], assembly: h.assembly });
  const receiver = createStudioManagedNativeBinding({ ctx: h.ctx, target: h.target, principal: h.principal,
    resolveHost: async () => h.host,
    execution: { run: async req => req.execute({ signal: req.signal, prepareInput: req.prepareInput }) } });
  for (const turn of [1, 2]) {
    const runId = `managed-run-${turn}`, parentRunId = turn === 1 ? null : 'managed-run-1';
    const result = await receiver({ command: h.makeCommand({ command_id: `cmd-${turn}` }), stage: 'execute', runId,
      signal: new AbortController().signal, store: h.managedStore });
    const snapshot = await result.withExecution({
      identity: { scope: result.scope, runId, sessionId: h.session.id, turnId: String(turn), buildId: result.buildId,
        parentRunId, taskChainId: parentRunId ?? runId },
      execute: async options => runManagedKernel({ binding: result, store: h.managedStore, runId,
        sessionId: h.session.id, signal: options.signal, turn, parentRunId }),
      signal: new AbortController().signal, prepareInput: hostPrepareInput,
    });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(h.managedStore.load(result.scope, runId).snapshot.phase, 'completed');
    // The completed-Turn consumer ran: the local-default memory DB holds the extracted fact.
    const memoryDb = join(h.root, 'native-harness', 'memory-v1', memoryDigest(result.scope.tenantId).slice(7), 'memory.sqlite');
    const provider = new SqliteNativeMemoryProvider(memoryDb, { principal: copy(result.scope) });
    try {
      const records = provider.list();
      // The policy needs two independent original observations, not duplicate
      // delivery of one completed turn, before promoting an implicit preference.
      assert.equal(records.length, turn === 1 ? 0 : 1);
      if (turn === 2) {
        assert.equal(records[0].content, '我喜欢用Vim');
        assert.equal(records[0].sourceEventIds.length, 2);
      }
    } finally { provider.close(); }
    await result.release({ scope: result.scope, runId, sessionId: h.session.id });
  }
  assert.equal(h.requests.length, 2);
});
