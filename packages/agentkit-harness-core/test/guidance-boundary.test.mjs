import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, emptyUsage, validateContextMessages, plan, prepareEffect, reduceCommand, transition,
  canonical, hookResult } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const guide = id => ({ commandId: id, kind: 'guide', payload: { text: `Requirement ${id}`, expectedGoalRevision: 0 } });
function setup(t, sqlite, input = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-guidance-')), file = join(directory, 'ledger.sqlite');
  let store = sqlite ? new SqliteRunStore(file) : new MemoryRunStore();
  const { config, snapshot } = fixture({ guidancePolicy: 'boundary-guide/v1', tools: [tool()], ...input });
  store.create(config, snapshot);
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return { config, snapshot, file, get store() { return store; }, reopen() {
    if (sqlite) { store.close(); store = new SqliteRunStore(file); }
  }, kernel(ports, options = {}) { return new NativeKernel({ store, ports, digest, owner: 'guidance-worker', ...options }); } };
}

for (const sqlite of [false, true]) {
  const backend = sqlite ? 'SQLite' : 'memory';
  test(`${backend}: queued guides follow the sealed tool batch and each receives an effective model step`, async t => {
    const run = setup(t, sqlite); let calls = 0, reads = 0;
    const seen = [];
    const kernel = run.kernel({ model: { generate: async request => {
      validateContextMessages(request.messages);
      seen.push(request.messages);
      if (++calls === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'read', name: 'read', arguments: {} }] };
      if (calls === 2) {
        assert.ok(request.messages.some(message => message.content === 'Requirement g1'));
        assert.ok(!request.messages.some(message => message.content === 'Requirement g2'));
        return final('First guided response');
      }
      assert.ok(request.messages.some(message => message.content === 'First guided response'));
      assert.ok(request.messages.some(message => message.content === 'Requirement g2'));
      return final('Final guided response');
    } }, tools: { execute: async () => {
      reads++;
      kernel.submit(scope, 'run', guide('g1')); kernel.submit(scope, 'run', guide('g2'));
      return { status: 'ok', content: 'Sealed read observation' };
    } } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Final guided response');
    assert.equal(reads, 1); assert.equal(calls, 3); assert.equal(result.goalRevision, 0);
    assert.deepEqual(result.pendingGuidanceIds, []);
    assert.ok(seen[1].some(message => message.role === 'tool' && message.content.includes('Sealed read observation')));
    const events = run.store.events(scope, 'run');
    for (const kind of ['input.guidance_applied', 'input.guidance_consumed'])
      assert.deepEqual(events.filter(event => event.kind === kind).map(event => event.payload.inputId), ['g1', 'g2']);
  });

  test(`${backend}: a prepared original model is dispatched once before newly queued guidance`, async t => {
    const run = setup(t, sqlite), lease = run.store.acquire(scope, 'run', 'preparer', 1, 1);
    let snapshot = run.snapshot;
    while (!snapshot.pendingIntent) snapshot = run.store.commit(scope, 'run', lease, 1, snapshot.revision,
      plan(snapshot, run.config, {}));
    const originalKey = snapshot.pendingIntent;
    run.store.enqueue(scope, 'run', guide('g1'));
    run.store.release(scope, 'run', lease); run.reopen();
    let calls = 0;
    const result = await run.kernel({ model: { generate: async request => {
      if (++calls === 1) {
        assert.equal(request.operationKey, originalKey);
        assert.ok(!request.messages.some(message => message.inputId === 'g1'));
        return final('Original draft');
      }
      assert.ok(request.messages.some(message => message.content === 'Original draft'));
      assert.ok(request.messages.some(message => message.inputId === 'g1'));
      return final('Guided delivery');
    } } }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(calls, 2);
    assert.ok(!run.store.events(scope, 'run').some(event => event.kind === 'effect.not_dispatched'));
  });

  test(`${backend}: retries and context overflow retain the first guidance until a meaningful response`, async t => {
    const run = setup(t, sqlite, { profile: { profileId: 'retry', profileVersion: '1', providerFamily: 'fixture',
      compatibilityDigest: 'retry/v1', retryInitialDelayMs: 0, rateLimitCooldownMs: 0 } });
    const outcomes = ['provider_retryable_error', 'empty_response', 'context_overflow', 'final_candidate', 'final_candidate'];
    let calls = 0, contexts = 0;
    run.store.enqueue(scope, 'run', guide('g1')); run.store.enqueue(scope, 'run', guide('g2'));
    const result = await run.kernel({ context: { prepare: async ({ snapshot }) => {
      contexts++; return { messages: snapshot.messages, context: {} };
    } }, model: { generate: async request => {
      const kind = outcomes[calls++], ids = request.messages.filter(message => message.inputId).map(message => message.inputId);
      assert.deepEqual(ids, calls <= 4 ? ['g1'] : ['g1', 'g2']);
      assert.deepEqual(run.store.load(scope, 'run').snapshot.pendingGuidanceIds, [calls <= 4 ? 'g1' : 'g2']);
      return { ...final(kind === 'final_candidate' ? `Response ${calls}` : ''), kind };
    } } }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(calls, 5); assert.ok(contexts >= 3);
    const consumed = run.store.events(scope, 'run').filter(event => event.kind === 'input.guidance_consumed');
    assert.deepEqual(consumed.map(event => event.payload.inputId), ['g1', 'g2']);
    const intents = run.store.load(scope, 'run').intents.filter(intent => intent.kind === 'model');
    assert.equal(consumed[0].payload.operationKey, intents[3].operationKey);
  });

  test(`${backend}: deferred guidance does not hide approval or split its original tool protocol`, async t => {
    const run = setup(t, sqlite), toolCall = { callId: 'protected', name: 'read', arguments: {} };
    let models = 0, writes = 0;
    const kernel = run.kernel({ model: { generate: async request => {
      validateContextMessages(request.messages);
      if (++models === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [toolCall] };
      assert.ok(request.messages.some(message => message.inputId === 'g2'));
      assert.equal(writes, 1); return final('Approved guided answer');
    } }, tools: { execute: async request => {
      if (!request.interaction) return { status: 'approval_required', content: '', interactionId: 'approval' };
      assert.equal(request.interaction.decision, 'allow'); writes++;
      return { status: 'ok', content: 'Original approved observation' };
    } } });
    kernel.submit(scope, 'run', guide('g1')); kernel.submit(scope, 'run', guide('g2'));
    const waiting = await kernel.runUntilIdle(scope, 'run');
    assert.equal(waiting.phase, 'awaiting_interaction'); assert.equal(writes, 0);
    assert.equal(run.store.load(scope, 'run').commands.find(row => row.command.commandId === 'g2').consumed, false);
    kernel.submit(scope, 'run', { commandId: 'allow', kind: 'submit_interaction',
      payload: { interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(writes, 1); assert.equal(models, 2);
    assert.deepEqual(run.store.events(scope, 'run').filter(event => event.kind === 'input.guidance_consumed')
      .map(event => event.payload.inputId), ['g1', 'g2']);
  });

  for (const kind of ['cancel', 'policy_revoked', 'steer']) test(`${backend}: ${kind} preempts a pending guidance step`, async t => {
    const run = setup(t, sqlite); let models = 0, sent = false;
    const kernel = run.kernel({ model: { generate: async request => {
      models++; assert.ok(request.messages.some(message => message.kind === 'steering')); return final('Replaced objective');
    } } }, { onCheckpoint: async snapshot => {
      if (!sent && snapshot.pendingGuidanceIds?.includes('g1')) {
        sent = true;
        kernel.submit(scope, 'run', { commandId: 'control', kind,
          payload: kind === 'steer' ? { text: 'New objective', expectedGoalRevision: 0 } : {} });
      }
    } });
    kernel.submit(scope, 'run', guide('g1')); kernel.submit(scope, 'run', guide('g2'));
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, { cancel: 'canceled', policy_revoked: 'failed', steer: 'completed' }[kind]);
    assert.equal(models, Number(kind === 'steer')); assert.deepEqual(result.pendingGuidanceIds, []);
    assert.deepEqual(run.store.events(scope, 'run').filter(event => event.kind === 'input.guidance_discarded')
      .map(event => event.payload), [{ inputId: 'g1', reason: kind }]);
    assert.ok(!run.store.events(scope, 'run').some(event => event.kind === 'input.guidance_consumed'));
    assert.ok(run.store.load(scope, 'run').commands.every(row => row.consumed));
    if (kind !== 'steer') {
      const discarded = run.store.events(scope, 'run').find(event => event.kind === 'command.discarded');
      assert.equal(discarded.payload.commandId, 'g2'); assert.equal(discarded.payload.terminatingCommandId, 'control');
      assert.equal(run.store.events(scope, 'run').at(-1).kind, 'run.terminal');
    }
  });

  test(`${backend}: model budget exhaustion settles undelivered guidance without an infinite drain`, async t => {
    const run = setup(t, sqlite, { limits: { maxModelCalls: 1 } }); let calls = 0;
    const kernel = run.kernel({ model: { generate: async () => {
      calls++; kernel.submit(scope, 'run', guide('g1')); kernel.submit(scope, 'run', guide('g2'));
      return final('Original answer');
    } } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.outcome, 'budget_exhausted'); assert.equal(calls, 1);
    assert.deepEqual(result.pendingGuidanceIds, []);
    assert.ok(!run.store.events(scope, 'run').some(event => event.kind === 'input.guidance_consumed'));
    assert.deepEqual(run.store.events(scope, 'run').filter(event => event.kind === 'input.guidance_discarded')
      .map(event => event.payload.inputId), ['g1']);
    assert.equal(run.store.events(scope, 'run').find(event => event.kind === 'command.applied'
      && event.payload.commandId === 'g2').payload.reason, 'guidance_previous_unconsumed');
    assert.ok(run.store.load(scope, 'run').commands.every(row => row.consumed));
  });

  test(`${backend}: a Host context projection cannot silently omit pending guidance`, async t => {
    const run = setup(t, sqlite); let models = 0;
    run.store.enqueue(scope, 'run', guide('g1'));
    const result = await run.kernel({ context: { prepare: async ({ snapshot }) => ({
      messages: snapshot.messages.filter(message => !message.inputId), context: {},
    }) }, model: { generate: async () => { models++; return final('Must not execute'); } } }).runUntilIdle(scope, 'run');
    assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'context_guidance_missing'); assert.equal(models, 0);
    assert.deepEqual(result.pendingGuidanceIds, []);
    assert.ok(!run.store.events(scope, 'run').some(event => event.kind === 'input.guidance_consumed'));
  });

  test(`${backend}: terminal inbox settlement and its original commit replay are atomic`, t => {
    const run = setup(t, sqlite), command = { commandId: 'stop', kind: 'cancel', payload: {} };
    run.store.enqueue(scope, 'run', guide('g1')); run.store.enqueue(scope, 'run', command);
    const lease = run.store.acquire(scope, 'run', 'terminal', 1, 100);
    const batch = reduceCommand(run.snapshot, command, null, { configuration: run.config });
    const saved = run.store.commit(scope, 'run', lease, 1, 0, batch);
    assert.equal(saved.eventSeq, batch.snapshot.eventSeq + 1);
    assert.deepEqual(run.store.commit(scope, 'run', lease, 2, 0, batch), saved);
    const events = run.store.events(scope, 'run');
    assert.equal(events.filter(event => event.kind === 'command.discarded').length, 1);
    assert.deepEqual(events.map(event => event.seq), Array.from({ length: events.length }, (_, index) => index + 1));
    assert.equal(new Set(events.map(event => event.eventId)).size, events.length); assert.equal(events.at(-1).kind, 'run.terminal');
  });

  test(`${backend}: guidance cannot replay a lost write claim or conceal its unknown outcome`, async t => {
    const run = setup(t, sqlite, { tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
    const lease = run.store.acquire(scope, 'run', 'lost-writer', 1, 1), call = { callId: 'write-once', name: 'write', arguments: {} };
    const prepared = run.store.commit(scope, 'run', lease, 1, 0,
      prepareEffect(run.snapshot, 'tool', 'executing_tools', { calls: [call], interaction: null }, {
        pendingTools: [call], messages: [...run.snapshot.messages, { role: 'assistant', content: '', toolCalls: [call] }],
      }));
    run.store.claim(scope, 'run', lease, 1, prepared.pendingIntent);
    run.store.release(scope, 'run', lease); run.reopen();
    run.store.enqueue(scope, 'run', guide('g1'));
    const result = await run.kernel({ tools: { execute: async () => assert.fail('lost write must not be replayed') },
      model: { generate: async () => assert.fail('unknown write must not be bypassed') } }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
    const events = run.store.events(scope, 'run');
    assert.ok(!events.some(event => event.kind === 'input.guidance_applied' || event.kind === 'input.guidance_consumed'));
    assert.equal(events.find(event => event.kind === 'command.applied').payload.reason, 'recovery_required');
  });

  test(`${backend}: a historical guidance command ID cannot stand in for the current Run input`, async t => {
    const run = setup(t, sqlite);
    const first = run.kernel({ model: { generate: async () => final('Old answer') } });
    first.submit(scope, 'run', guide('g1')); await first.runUntilIdle(scope, 'run');
    const current = run.kernel({ context: { prepare: async ({ snapshot }) => ({
      messages: snapshot.messages.filter(message => !message.inputId || message.history), context: {},
    }) }, model: { generate: async () => assert.fail('old guidance cannot satisfy the current input') } });
    current.start({ ...run.snapshot, runId: 'next', parentRunId: null, turnId: '2' }, run.config);
    current.submit(scope, 'next', { ...guide('g1'), payload: { text: 'Different current requirement', expectedGoalRevision: 0 } });
    const result = await current.runUntilIdle(scope, 'next');
    assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'context_guidance_missing');
    assert.ok(result.messages.some(message => message.inputId === 'g1' && message.history));
  });

  for (const dropFeedback of [false, true]) test(`${backend}: guidance preserves sealed PostToolUse feedback (${dropFeedback ? 'reject omission' : 'deliver together'})`, async t => {
    const hook = { hookId: 'post', sourceRef: 'fixture://post', bindingDigest: `sha256:${'a'.repeat(64)}`,
      executionPolicyDigest: `sha256:${'b'.repeat(64)}`, events: ['PostToolUse'], readOnly: true,
      timeoutMs: 1000, maxInputBytes: 100000, maxOutputBytes: 10000, failureMode: 'block' };
    const run = setup(t, sqlite, { hooks: [hook] }); let models = 0, hooks = 0;
    const kernel = run.kernel({ context: { prepare: async ({ snapshot }) => ({
      messages: dropFeedback ? snapshot.messages.filter(message => message.kind !== 'hook_context') : snapshot.messages, context: {},
    }) }, model: { generate: async request => {
      if (++models === 1) return { ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'observe', name: 'read', arguments: {} }] };
      assert.ok(request.messages.some(message => message.inputId === 'g1'));
      assert.ok(request.messages.some(message => message.kind === 'hook_context' && message.content.includes('Keep observed limitations')));
      return final('Guided result with observed limitations');
    } }, tools: { execute: async () => {
      kernel.submit(scope, 'run', guide('g1')); return { status: 'ok', content: 'Original observation' };
    } }, hooks: { invoke: async request => {
      hooks++; return hookResult(request, 'ok', { action: 'continue', additionalContext: ['Keep observed limitations'], updatedArguments: null });
    } } });
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(hooks, 1); assert.equal(models, dropFeedback ? 1 : 2);
    if (dropFeedback) { assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'context_hook_feedback_missing'); }
    else { assert.equal(result.phase, 'completed'); assert.deepEqual(result.hookState.feedback, []); }
  });
}

test('boundary guidance validates its own revision and leaves goal, contract and prepared requests intact on rejection', () => {
  const { config, snapshot } = fixture({ guidancePolicy: 'boundary-guide/v1' });
  for (const payload of [{ text: ' ' }, { text: 'x'.repeat(32769), expectedGoalRevision: 0 },
    { text: 'detail', expectedGoalRevision: 1 }, { text: 'detail', expectedGoalRevision: -1 }]) {
    const batch = reduceCommand(snapshot, { ...guide('bad'), payload }, null, { configuration: config });
    assert.equal(batch.snapshot.goal, snapshot.goal); assert.equal(batch.snapshot.configDigest, snapshot.configDigest);
    assert.deepEqual(batch.snapshot.messages, snapshot.messages); assert.deepEqual(batch.snapshot.pendingGuidanceIds, []);
    assert.ok(!batch.events.some(event => event.kind === 'input.guidance_applied'));
  }
  assert.throws(() => fixture({ guidancePolicy: 'unknown' }), { code: 'invalid_guidance_policy' });
});

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'memory'}: summary-model calls retain pending guidance until the next task-model receipt`, async t => {
  const policy = { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true, triggerRatio: .72, targetRatio: .45,
    summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 };
  const run = setup(t, sqlite, { contextPolicy: policy,
    profile: { profileId: 'compact', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'compact/v1',
      contextWindow: 2400, maxOutputTokens: 128 } });
  const lease = run.store.acquire(scope, 'run', 'seed', 1, 1);
  run.store.commit(scope, 'run', lease, 1, 0, transition(run.snapshot, {
    messages: [...run.snapshot.messages, ...Array.from({ length: 5 }, (_, i) => ({ role: 'assistant', content: `Earlier discussion ${i}. `.repeat(150) }))],
  }));
  run.store.release(scope, 'run', lease);
  run.store.enqueue(scope, 'run', guide('g1')); run.store.enqueue(scope, 'run', guide('g2'));
  let summaries = 0, tasks = 0;
  const result = await run.kernel({ context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
    countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } }, model: { generate: async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      summaries++; assert.deepEqual(run.store.load(scope, 'run').snapshot.pendingGuidanceIds, ['g1']);
      assert.ok(!run.store.events(scope, 'run').some(event => event.kind === 'input.guidance_consumed'));
      return final('Earlier observed discussion.');
    }
    tasks++;
    assert.ok(request.messages.some(message => message.inputId === (tasks === 1 ? 'g1' : 'g2')));
    assert.deepEqual(run.store.load(scope, 'run').snapshot.pendingGuidanceIds, [tasks === 1 ? 'g1' : 'g2']);
    return final(`Task response ${tasks}`);
  } } }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.ok(summaries > 0); assert.equal(tasks, 2);
  assert.equal(result.usage.modelCalls, tasks + summaries);
  assert.deepEqual(run.store.events(scope, 'run').filter(event => event.kind === 'input.guidance_consumed')
    .map(event => event.payload.inputId), ['g1', 'g2']);
});

for (const position of ['applied', 'receipted']) test(`SQLite: actual process exit after guidance ${position} resumes the original FIFO without replay`, async t => {
  const run = setup(t, true, { limits: { leaseMs: 5000 } }), marker = join(tmpdir(), `native-guidance-marker-${process.pid}-${position}`);
  t.after(() => rmSync(marker, { force: true }));
  run.store.enqueue(scope, 'run', guide('g1')); run.store.enqueue(scope, 'run', guide('g2'));
  // The file path belongs to the fixture's temporary directory, not a user database.
  const file = run.file;
  assert.equal(typeof file, 'string');
  const worker = spawnSync(process.execPath, [new URL('./fixtures/guidance-crash-worker.mjs', import.meta.url).pathname,
    file, position, marker], { encoding: 'utf8', timeout: 20000 });
  assert.equal(worker.status, position === 'applied' ? 77 : 78, worker.stderr);
  run.reopen();
  const saved = run.store.load(scope, 'run');
  assert.deepEqual(saved.snapshot.pendingGuidanceIds, position === 'applied' ? ['g1'] : []);
  assert.equal(saved.snapshot.usage.modelCalls, Number(position === 'receipted'));
  assert.equal(existsSync(marker), position === 'receipted');
  assert.ok(saved.lease?.expiresAt > 0);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, saved.lease.expiresAt - Date.now()) + 25));
  assert.ok(saved.lease.expiresAt <= Date.now());
  let calls = 0;
  const result = await run.kernel({ model: { generate: async () => {
    calls++; return final(`Recovered guided response ${calls}`);
  } } }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.usage.modelCalls, 2);
  assert.equal(calls, position === 'applied' ? 2 : 1);
  if (existsSync(marker)) assert.equal(readFileSync(marker, 'utf8'), 'original-model\n');
  for (const kind of ['input.guidance_applied', 'input.guidance_consumed'])
    assert.deepEqual(run.store.events(scope, 'run').filter(event => event.kind === kind).map(event => event.payload.inputId), ['g1', 'g2']);
});
