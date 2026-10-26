import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { NativeKernel, configure, emptyUsage, canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { createNativeModelPort } from '../packages/agentkit-harness/src/native/model-port.mjs';
import { createNativeContextPort } from '../packages/agentkit-harness/src/native/context-counter.mjs';
import { memoryDigest, nativeMemoryScopeBindings } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { createStudioNativeMemoryExtraction } from '../src/host/services/native-memory-extraction.mjs';
import { StudioNativeMemoryExtractionStore } from '../src/host/services/native-memory-extraction-store.mjs';

const prose = '我们公司的发票日期和财务报表统一使用协调世界时，金额必须注明币种，小数位保留两位。客户支持答复应使用简体中文，并保留用户提供的订单编号以便后续核查。';
const final = () => ({ kind: 'final_candidate', text: 'Understood.', toolCalls: [], usage: emptyUsage() });

async function setup(t, { minUserCharacters = 64, mode = 'write', rollout = 'enabled' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-host-'));
  let ledger = new SqliteRunStore(join(root, 'runs.sqlite'));
  const bodies = [], errors = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (mode === 'fail') { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":{"message":"controlled failure"}}'); return; }
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const called = body.messages.some(message => message.role === 'tool');
    const message = mode === 'exhaust' ? { role: 'assistant', content: null, tool_calls: [{ id: `read-${bodies.length}`, type: 'function',
      function: { name: 'read_memory', arguments: JSON.stringify({ memory_id: 'missing-fact' }) } }] }
      : called || mode === 'no-op' ? { role: 'assistant', content: 'Nothing else to save.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'save-fact', type: 'function',
        function: { name: 'manage_memory', arguments: JSON.stringify({ action: 'remember', scope: 'user',
          content: 'Invoices and financial reports use UTC.', memory_type: 'fact',
          source_event_ids: [input.source.messages.find(message => message.role === 'user' && !message.modelOnly).id] }) } }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const binding = { protocol: 'openai-chat', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'local-fixture-key', parameters: { stream: false } };
  const counter = createNativeContextPort(binding);
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec: {
    runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      write: { mode: 'candidate' }, extraction: { enabled: true, minUserCharacters } }, context: { rollout: { memoryWrite: rollout } } } };
  const config = text => configure({ ...fixture().config, profile: { ...fixture().config.profile,
    providerFamily: 'openai-chat', contextWindow: 32000, maxOutputTokens: 1024, streaming: false, maxRetries: 0, maxProviderRetries: 0 },
    inputMessages: [{ role: 'user', kind: 'user_input', content: text }],
    hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
      input: { messages: [{ id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] },
      source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: '' }) });
  const open = () => createStudioNativeMemoryExtraction({ store: ledger, storeDir: root, onError: error => errors.push(error),
    principal: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId },
    resolveRecord: async () => structuredClone(record), resolveModel: async ({ prepared, signal }) => ({
      model: createNativeModelPort({ resolveProfile: async () => binding }),
      countRequest: request => counter.tokens.countRequest(request),
      planner: { countMessage: message => counter.tokens.countMessage({ message, profile: prepared.configuration.profile, signal }) },
    }) });
  let service = open();
  t.after(async () => { await service.close(); ledger.close(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true }); });
  const run = async (runId, text = prose, runScope = scope) => {
    const kernel = new NativeKernel({ store: ledger, owner: 'parent', digest, ports: { model: { generate: async () => final() } } });
    kernel.start({ scope: runScope, runId, sessionId: 'session', turnId: runId, buildId: 'revision-frozen', parentRunId: null,
      taskChainId: 'chain' }, config(text));
    return kernel.runUntilIdle(runScope, runId);
  };
  const request = runId => ({ scope, sessionId: 'session', runId, record });
  return { root, run, request, bodies, errors, record, store: () => ledger, service: () => service,
    memory: () => new SqliteNativeMemoryProvider(join(root, 'native-harness', 'memory-v1', memoryDigest(scope.tenantId).slice(7), 'memory.sqlite'),
      { principal: scope, scopes: ['user'] }),
    async reopen() { await service.close(); ledger.close(); ledger = new SqliteRunStore(join(root, 'runs.sqlite')); service = open(); },
  };
}

test('real HTTP model and SQLite Memory use an independent Native Run, durable cursor and usage', async t => {
  const f = await setup(t);
  await f.run('one');
  const before = f.store().load(scope, 'one');
  const queued = f.service().schedule(f.request('one'));
  assert.equal(queued.status, 'queued');
  await f.service().drain();
  assert.deepEqual(f.errors, []);
  const status = f.service().status(f.request('one'));
  assert.equal(status.jobs[0].status, 'success', canonical(status));
  assert.equal(status.jobs[0].usage.modelCalls, 2);
  assert.equal(status.jobs[0].usage.inputTokens, 22);
  assert.equal(status.jobs[0].usage.outputTokens, 14);
  assert.ok(status.cursor);
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(f.store().load(scope, 'one'), before);
  const memory = f.memory();
  const saved = memory.list(); memory.close();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].memoryType, 'fact');
  assert.equal(saved[0].metadata.extractionPolicy, 'native-model-memory/v1');
  assert.equal(saved[0].writePolicy, 'auto');
  assert.doesNotMatch(canonical(status), /local-fixture-key|existingMemories|source_event_ids/);
  assert.equal(f.service().schedule(f.request('one')).status, 'already_consumed');
  await f.reopen();
  assert.deepEqual(f.service().status(f.request('one')), status);
  await f.run('two', prose.replace('两位', '三位'));
  f.service().schedule(f.request('two')); await f.service().drain();
  const second = JSON.parse(f.bodies[2].messages.find(message => message.role === 'user').content);
  assert.equal(second.source.messages.filter(message => message.role === 'user' && !message.modelOnly).length, 1);
  assert.match(second.source.messages.find(message => message.role === 'user' && !message.modelOnly).id, /two#message/);
  assert.equal(f.service().status(f.request('two')).jobs.length, 2);
});

test('short multilingual windows accumulate without a model call or premature cursor', async t => {
  const f = await setup(t, { minUserCharacters: 64, mode: 'no-op' });
  await f.run('one', '财务报表统一使用协调世界时。');
  assert.equal(f.service().schedule(f.request('one')).status, 'deferred');
  assert.equal(f.service().status(f.request('one')).cursor, null);
  assert.equal(f.bodies.length, 0);
  await f.run('two'); f.service().schedule(f.request('two')); await f.service().drain();
  assert.equal(f.bodies.length, 1);
  const input = JSON.parse(f.bodies[0].messages.find(message => message.role === 'user').content);
  assert.equal(input.source.messages.filter(message => message.role === 'user' && !message.modelOnly).length, 2);
  assert.equal(f.service().status(f.request('two')).jobs[0].status, 'success');
});

test('cold discovery admits a completed parent missed before enqueue and does not repeat it on the next reopen', async t => {
  const f = await setup(t);
  await f.run('missed');
  assert.equal(f.service().status(f.request('missed')).jobs.length, 0);
  await f.reopen();
  await f.service().recover(); await f.service().drain();
  const accepted = f.service().status(f.request('missed'));
  assert.equal(accepted.jobs.length, 1);
  assert.equal(accepted.jobs[0].status, 'success', canonical(accepted));
  assert.equal(accepted.jobs[0].parentRunId, 'missed');
  assert.equal(f.bodies.length, 2);
  await f.reopen(); await f.service().recover(); await f.service().drain();
  assert.deepEqual(f.service().status(f.request('missed')), accepted);
  assert.equal(f.bodies.length, 2, 'auxiliary completed runs and consumed parents are not submitted again');
  assert.deepEqual(f.errors, []);
});

test('cold discovery considers only the current completed parent and keeps failed extraction terminal', async t => {
  const f = await setup(t, { mode: 'fail' });
  await f.run('old'); await f.run('current');
  await f.reopen(); await f.service().recover(); await f.service().drain();
  const state = f.service().status(f.request('current'));
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].parentRunId, 'current');
  assert.equal(state.jobs[0].status, 'error');
  assert.equal(f.bodies.length, 1);
  await f.reopen(); await f.service().recover(); await f.service().drain();
  assert.deepEqual(f.service().status(f.request('current')), state);
  assert.equal(f.bodies.length, 1, 'startup must not turn a terminal provider error into an unbounded retry');
});

test('a Host cannot discover, dispatch, inspect or schedule another principal in the same SQLite files', async t => {
  const f = await setup(t);
  const foreign = { ...scope, tenantId: 'another-tenant' };
  await f.run('foreign-parent', prose, foreign);
  const other = createStudioNativeMemoryExtraction({ store: f.store(), storeDir: f.root,
    principal: { tenantId: foreign.tenantId, workspaceId: foreign.workspaceId, userId: foreign.userId },
    resolveRecord: async () => f.record, resolveModel: async () => { throw Error('Foreign dispatch must not occur'); } });
  const request = { scope: foreign, sessionId: 'session', runId: 'foreign-parent', record: f.record };
  const queued = other.schedule(request); await other.close();
  await f.run('ours'); await f.reopen();
  await f.service().recover(); await f.service().drain();
  assert.equal(f.service().status(f.request('ours')).jobs[0].status, 'success');
  assert.equal(f.bodies.length, 2);
  const jobs = new StudioNativeMemoryExtractionStore(join(f.root, 'native-harness', 'memory-extraction.sqlite'));
  try { assert.equal(jobs.get(queued.jobId).status, 'queued'); assert.equal(jobs.get(queued.jobId).fence, 0); }
  finally { jobs.close(); }
  assert.throws(() => f.service().status(request), { code: 'studio_native_memory_extraction_scope_unbound' });
  assert.throws(() => f.service().schedule(request), { code: 'studio_native_memory_extraction_scope_unbound' });
  assert.deepEqual(f.errors, []);
});

test('a queued job cold-recovers its original prepared manifest, never a later memory snapshot', async t => {
  const f = await setup(t);
  await f.run('one'); const queued = f.service().schedule(f.request('one'));
  await f.reopen(); // Stops before the scheduled dispatch microtask can claim.
  const jobs = new StudioNativeMemoryExtractionStore(join(f.root, 'native-harness', 'memory-extraction.sqlite'));
  const frozen = jobs.get(queued.jobId);
  assert.equal(frozen.status, 'queued'); assert.deepEqual(frozen.manifest, { records: [] });
  const memory = f.memory(); memory.applyMutation({ action: 'remember', ...nativeMemoryScopeBindings(scope, ['user'])[0],
    content: 'An unrelated manually confirmed fact.', authority: 'explicit_user', operationKey: 'late-manual',
    requestDigest: memoryDigest('late'), sourceSessionId: 'other', sourceEventId: 'other-source',
    sourceGoalRevision: '1', sourceGoalDigest: memoryDigest('other') }); memory.close();
  const duplicate = f.service().schedule(f.request('one'));
  assert.equal(duplicate.jobId, queued.jobId);
  f.service().recover(); await f.service().drain();
  assert.deepEqual(jobs.get(queued.jobId).prepared, frozen.prepared);
  const input = JSON.parse(f.bodies[0].messages.find(message => message.role === 'user').content);
  assert.deepEqual(input.existingMemories, { records: [] });
  jobs.close();
  assert.equal(f.service().status(f.request('one')).jobs[0].status, 'success');
});

test('a newer parent head revokes a queued source and cold discovery extracts only the current head', async t => {
  const f = await setup(t);
  await f.run('one'); f.service().schedule(f.request('one')); await f.reopen();
  await f.run('two'); f.service().recover(); await f.service().drain();
  const state = f.service().status(f.request('one'));
  assert.equal(state.jobs[0].status, 'error');
  assert.equal(state.jobs[0].errorCode, 'studio_native_memory_extraction_not_current_head');
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[1].parentRunId, 'two');
  assert.equal(state.jobs[1].status, 'success');
  assert.match(state.cursor, /two#message/);
  assert.equal(f.bodies.length, 2);
  const input = JSON.parse(f.bodies[0].messages.find(message => message.role === 'user').content);
  assert.equal(input.parent.runId, 'two', 'the revoked job never called the model');
});

test('provider failure preserves the cursor and records auxiliary cost separately', async t => {
  const f = await setup(t, { mode: 'fail' });
  await f.run('one'); f.service().schedule(f.request('one')); await f.service().drain();
  const state = f.service().status(f.request('one'));
  assert.equal(state.jobs[0].status, 'error'); assert.equal(state.cursor, null);
  assert.equal(state.jobs[0].usage.modelCalls, 1); assert.equal(f.bodies.length, 1);
  assert.equal(f.store().load(scope, 'one').snapshot.usage.modelCalls, 1);
});

test('an extraction that spends its model budget stays incomplete with a visible budget reason', async t => {
  const f = await setup(t, { mode: 'exhaust' });
  await f.run('one'); f.service().schedule(f.request('one')); await f.service().drain();
  const state = f.service().status(f.request('one'));
  assert.equal(state.jobs[0].status, 'error');
  assert.equal(state.jobs[0].errorCode, 'native_memory_extraction_budget_exhausted');
  assert.equal(state.jobs[0].usage.modelCalls, 5); assert.equal(f.bodies.length, 5);
  assert.equal(state.cursor, null);
  const memory = f.memory(); assert.deepEqual(memory.list(), []); memory.close();
});

test('shadow performs bounded model evaluation without writing Memory', async t => {
  const f = await setup(t, { rollout: 'shadow' });
  await f.run('one'); f.service().schedule(f.request('one')); await f.service().drain();
  assert.equal(f.service().status(f.request('one')).jobs[0].status, 'success');
  const memory = f.memory(); assert.deepEqual(memory.list(), []); memory.close();
  assert.equal(f.bodies.length, 2);
});
