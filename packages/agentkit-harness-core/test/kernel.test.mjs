import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, prepareEffect } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool, acceptance, verificationReport } from './fixtures.mjs';

const response = (kind = 'final_candidate', options = {}) => ({ kind, text: kind === 'final_candidate' ? 'Done' : '', toolCalls: [], usage: emptyUsage(), ...options });
const call = (id = 'call-1', name = 'read') => ({ callId: id, name, arguments: {} });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(t, { backend = 'memory', configuration = {}, model = async () => response(), tools = async () => ({ status: 'ok', content: 'read' }), ports = {}, now, onStream } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-kernel-')), filename = join(dir, 'run.sqlite');
  const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
  t.after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const kernel = new NativeKernel({ store, ports: { model: { generate: model }, tools: { execute: tools }, ...ports }, owner: 'worker', digest, ...(now ? { now } : {}), ...(onStream ? { onStream } : {}) });
  const { config, snapshot } = fixture(configuration);
  kernel.start(snapshot, config);
  return { store, kernel, config, snapshot, filename };
}

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: complete model/tool/final flow seals receipts before terminal`, async t => {
    let calls = 0;
    const { kernel, store } = setup(t, { backend, configuration: { tools: [tool()] }, model: async request => {
      if (++calls === 1) return response('tool_calls', { toolCalls: [call()] });
      assert.equal(request.messages.at(-1).role, 'tool'); return response();
    } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'unverified');
    assert.equal(result.reason, 'verification_report_missing'); assert.equal(result.finalText, 'Done');
    assert.equal(result.usage.modelCalls, 2); assert.equal(result.usage.toolCalls, 1);
    const record = store.load(scope, 'run');
    assert.equal(record.intents.length, 3); assert.equal(record.receipts.length, 3);
    assert.equal(record.events.at(-1).kind, 'run.terminal');
    assert.deepEqual(record.events.map(event => event.seq), Array.from({ length: record.events.length }, (_, index) => index + 1));
  });
  test(`${backend}: cancel wakes an active model and terminal cannot be resumed`, async t => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const { kernel, store } = setup(t, { backend, model: async request => {
      started(); return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('private cancellation detail')), { once: true }));
    } });
    const running = kernel.runUntilIdle(scope, 'run'); await ready;
    kernel.submit(scope, 'run', { commandId: 'cancel', kind: 'cancel', payload: {} });
    const result = await running;
    assert.equal(result.phase, 'canceled'); assert.equal(result.reason, 'user_canceled');
    assert.equal(store.load(scope, 'run').receipts[0].status, 'uncertain');
    assert.doesNotMatch(JSON.stringify(store.events(scope, 'run')), /private cancellation/);
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), result);
  });
  test(`${backend}: pause/resume preserves phase and commands deduplicate`, async t => {
    let calls = 0;
    const { kernel } = setup(t, { backend, model: async () => { calls++; return response(); } });
    const command = { commandId: 'pause', kind: 'pause', payload: {} };
    kernel.submit(scope, 'run', command); assert.equal(kernel.submit(scope, 'run', command).status, 'duplicate');
    const paused = await kernel.runUntilIdle(scope, 'run');
    assert.equal(paused.phase, 'paused'); assert.equal(paused.resumePhase, 'created'); assert.equal(calls, 0);
    kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(calls, 1);
  });
  test(`${backend}: approval rejects a stale interaction identity`, async t => {
    let models = 0, writes = 0;
    const { kernel } = setup(t, { backend, configuration: { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] },
      model: async () => ++models === 1 ? response('tool_calls', { toolCalls: [call('write-1', 'write')] }) : response(),
      tools: async request => {
        if (!request.interaction) return { status: 'approval_required', content: {}, interactionId: 'host-approval-1' };
        assert.deepEqual(request.interaction, { interactionId: 'host-approval-1', callId: 'write-1', decision: 'allow' });
        writes++; return { status: 'ok', content: 'written' };
      },
    });
    const pending = await kernel.runUntilIdle(scope, 'run'); assert.equal(pending.phase, 'awaiting_interaction');
    kernel.submit(scope, 'run', { commandId: 'wrong', kind: 'submit_interaction', payload: { interactionId: 'wrong', decision: 'allow' } });
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'awaiting_interaction'); assert.equal(writes, 0);
    kernel.submit(scope, 'run', { commandId: 'right', kind: 'submit_interaction', payload: { interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(writes, 1);
  });
  test(`${backend}: takeover never repeats a running tool with an unknown side effect`, async t => {
    let writes = 0;
    const { kernel, store, snapshot } = setup(t, { backend, tools: async () => { writes++; return { status: 'ok', content: '' }; } });
    const lease = store.acquire(scope, 'run', 'dead-worker', 0, 1);
    const batch = prepareEffect(snapshot, 'tool', 'executing_tools', { calls: [call()] });
    store.commit(scope, 'run', lease, 0, 0, batch); store.claim(scope, 'run', lease, 0, batch.snapshot.pendingIntent);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.outcome, 'unverified'); assert.equal(result.reason, 'effect_outcome_unknown');
    assert.equal(writes, 0); assert.equal(store.load(scope, 'run').receipts[0].status, 'uncertain');
  });
}

test('independent readers overlap within bounds and settle in model order', async t => {
  let models = 0, active = 0, maximum = 0; const completions = [];
  const { kernel, store } = setup(t, { configuration: { tools: [tool()], limits: { maxParallelTools: 2 } },
    model: async () => ++models === 1 ? response('tool_calls', { toolCalls: [call('a'), call('b'), call('c')] }) : response(),
    tools: async request => { active++; maximum = Math.max(maximum, active); await delay(request.call.callId === 'a' ? 20 : 1);
      active--; completions.push(request.call.callId); return { status: 'ok', content: request.call.callId }; },
  });
  const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(maximum, 2);
  assert.deepEqual(completions.slice(0, 2), ['b', 'a']);
  assert.deepEqual(result.messages.filter(message => message.role === 'tool').map(message => message.callId), ['a', 'b', 'c']);
  assert.equal(store.load(scope, 'run').intents.filter(intent => intent.kind === 'tool').length, 2);
});
test('writers remain serialized even when the model batches them', async t => {
  let models = 0, active = 0, maximum = 0;
  const { kernel } = setup(t, { configuration: { tools: [tool({ readOnly: false, concurrentSafe: false })] },
    model: async () => ++models === 1 ? response('tool_calls', { toolCalls: [call('a'), call('b')] }) : response(),
    tools: async () => { active++; maximum = Math.max(maximum, active); await delay(1); active--; return { status: 'ok', content: '' }; },
  });
  await kernel.runUntilIdle(scope, 'run'); assert.equal(maximum, 1);
});
test('a read-only batch reporting mutations cannot claim successful execution', async t => {
  const { kernel } = setup(t, { configuration: { tools: [tool()] },
    model: async () => response('tool_calls', { toolCalls: [call('a'), call('b')] }),
    tools: async () => ({ status: 'ok', content: '', workspaceChangedPaths: ['modified.txt'] }),
  });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'parallel_readonly_contract_violation'); assert.equal(result.outcome, 'blocked'); assert.equal(result.usage.toolCalls, 2);
});
test('no-tool budget finalization cannot dispatch unadvertised tools', async t => {
  let tools = 0;
  const { kernel } = setup(t, { configuration: { tools: [tool()], limits: { maxModelCalls: 1 } },
    model: async request => { assert.deepEqual(request.tools, []); return response('tool_calls', { toolCalls: [call()] }); },
    tools: async () => { tools++; return { status: 'ok', content: '' }; },
  });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'tool_call_after_finalization_reserve'); assert.equal(result.outcome, 'budget_exhausted'); assert.equal(tools, 0);
  assert.equal(result.phase, 'failed');
});
test('failed verification repairs through another model turn before reporting verified', async t => {
  let reports = 0, models = 0;
  const { kernel } = setup(t, { configuration: { contract: { objective: 'Pass the fixture test', acceptance: [acceptance()] } },
    model: async () => response('final_candidate', { text: `candidate-${++models}` }),
    ports: { verification: { verify: async request => {
      const report = verificationReport(request);
      return ++reports === 1 ? { ...report, status: 'failed', repairable: true, failureFingerprint: 'fixture-failed',
        checks: [{ ...report.checks[0], status: 'failed', safeSummary: 'Fix the failing fixture', evidence: 'exit 1' }] } : report;
    } } },
  });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.outcome, 'verified'); assert.equal(result.finalText, 'candidate-2'); assert.equal(result.repairs, 1);
});
test('provider and invalid-response retries have separate durable budgets', async t => {
  let models = 0;
  const { kernel } = setup(t, { configuration: { profile: { ...fixture().config.profile, maxRetries: 1, maxProviderRetries: 1,
    retryInitialDelayMs: 0, retryMaxDelayMs: 0 } }, model: async () => response(++models === 1 ? 'provider_retryable_error' : 'empty_response') });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.providerErrors, 1); assert.equal(result.modelErrors, 2); assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.reason, 'empty_response_retry_exhausted');
});
test('request timeout consumes the bounded provider retry policy', async t => {
  let models = 0;
  const { kernel } = setup(t, { configuration: { profile: { ...fixture().config.profile, requestTimeoutMs: 5,
    maxProviderRetries: 1, retryInitialDelayMs: 0, retryMaxDelayMs: 0 } }, model: async () => { models++; return new Promise(() => {}); } });
  const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(models, 2); assert.equal(result.reason, 'provider_retryable_error_retry_exhausted');
});
test('truncated tool calls never execute', async t => {
  let models = 0, tools = 0;
  const { kernel } = setup(t, { configuration: { tools: [tool()] },
    model: async () => ++models === 1 ? response('output_limit', { toolCalls: [call()], text: 'unfinished' }) : response(),
    tools: async () => { tools++; return { status: 'ok', content: '' }; },
  });
  await kernel.runUntilIdle(scope, 'run'); assert.equal(tools, 0);
});
test('private replay stays in model history and never leaks into public events', async t => {
  let models = 0;
  const { kernel, store } = setup(t, { configuration: { tools: [tool()], profile: { ...fixture().config.profile, providerReplayMode: 'reasoning_content' } },
    model: async request => {
      if (++models === 1) return response('tool_calls', { toolCalls: [call()], providerReplay: { compatibilityDigest: 'fixture/v1', reasoning: 'private-reasoning' } });
      assert.equal(request.messages.find(message => message.providerReplay).providerReplay.reasoning, 'private-reasoning'); return response();
    },
  });
  await kernel.runUntilIdle(scope, 'run'); assert.doesNotMatch(JSON.stringify(store.events(scope, 'run')), /private-reasoning/);
});

test('a tool deadline seals an unknown result and a late success cannot change the ledger', async t => {
  let resolveTool, toolSignal, executions = 0;
  const { kernel, store } = setup(t, { configuration: { tools: [tool({ timeoutMs: 5, readOnly: false, concurrentSafe: false })] },
    model: async () => response('tool_calls', { toolCalls: [call()] }),
    tools: request => { executions++; toolSignal = request.signal; return new Promise(resolve => { resolveTool = resolve; }); },
  });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(toolSignal.aborted, true);
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.reason, 'effect_outcome_unknown');
  assert.equal(executions, 1);
  const before = store.load(scope, 'run');
  resolveTool({ status: 'ok', content: 'late private result' });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(store.load(scope, 'run'), before);
  assert.doesNotMatch(JSON.stringify(before.events), /late private result/);
  await kernel.runUntilIdle(scope, 'run'); assert.equal(executions, 1);
});

test('a blocking late tool return is unknown even before its timer callback can run', async t => {
  let clock = 0;
  const { kernel, store } = setup(t, { now: () => clock, configuration: { tools: [tool({ timeoutMs: 5 })] },
    model: async () => response('tool_calls', { toolCalls: [call()] }),
    tools: async () => { clock += 20; return { status: 'ok', content: 'too late' }; },
  });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'effect_outcome_unknown');
  assert.equal(result.activeElapsedMs, 20);
  assert.equal(store.load(scope, 'run').receipts.at(-1).result.results[0].status, 'uncertain');
});

test('cancellation during a writing batch prevents later calls and ignores a late first receipt', async t => {
  let entered, resolveTool; const calls = [];
  const ready = new Promise(resolve => { entered = resolve; });
  const { kernel, store } = setup(t, { configuration: { tools: [tool({ readOnly: false, concurrentSafe: false })] },
    model: async () => response('tool_calls', { toolCalls: [call('first'), call('second')] }),
    tools: request => { calls.push(request.call.callId); entered(); return new Promise(resolve => { resolveTool = resolve; }); },
  });
  const running = kernel.runUntilIdle(scope, 'run'); await ready;
  kernel.submit(scope, 'run', { commandId: 'cancel-writing', kind: 'cancel', payload: {} });
  const result = await running;
  assert.equal(result.phase, 'canceled'); assert.deepEqual(calls, ['first']);
  const before = store.load(scope, 'run');
  resolveTool({ status: 'ok', content: 'late write receipt' });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(store.load(scope, 'run'), before);
});
