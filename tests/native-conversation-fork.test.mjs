import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, emptyUsage, configure, initialSnapshot } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, tool, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { nativeDshOwnership } from '../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { nativeDeliveryProjection } from '../packages/agentkit-harness/src/native/session-delivery.mjs';
import { createNativeDshTurnExecutor } from '../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';
import { nativeConversationForkSeed } from '../src/providers/native-conversation-fork.mjs';

const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const call = () => ({ ...final(), text: '', kind: 'tool_calls', toolCalls: [{ callId: 'write-1', name: 'write', arguments: {} }] });
const forkProfile = { profileId: 'fork', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' };
const forkTools = () => [tool({ name: 'write', discovery: { deferred: true }, readOnly: false, concurrentSafe: false })];
const noPolicies = { todoPolicy: false, toolDiscoveryPolicy: false };
const freshSignal = () => new AbortController().signal;

// Build a real completed Native DSH source Run with one tool call then a final,
// then reconstruct the exact turn/owner capsule the source Session would record.
async function completedSource(t, { advance = false, privateReplay = false, activeTool = false } = {}) {
  const store = new MemoryRunStore();
  t.after(() => store.close?.());
  const projection = nativeDeliveryProjection();
  let state = projection.init();
  const sinkEvents = [];
  const session = { id: 'session', append(type, data, options) {
    const event = { type, data: structuredClone(data), ...options, seq: sinkEvents.length + 1 };
    state = projection.apply(state, event); sinkEvents.push(event);
  } };
  session.append('turn/start', { turn: 1 });
  const inputMessages = [{ id: 'input-1', role: 'user', content: [{ type: 'text', text: 'Complete the task' }] }];
  const configuration = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
    inputMessages: [{ role: 'user', content: 'Complete the task' }],
    ...(privateReplay ? { profile: { ...fixture().config.profile, providerReplayMode: 'anthropic_content' } } : {}) }).config;
  const calls = { model: 0, write: 0 };
  let releaseTool, toolStarted;
  const entered = new Promise(resolve => { toolStarted = resolve; });
  const held = new Promise(resolve => { releaseTool = resolve; });
  const binding = { scope, configuration, buildId: 'build', source: { provider: 'fixture', model: 'pinned' }, ports: {
    model: { generate: async () => ++calls.model === 1 ? { ...call(), ...(privateReplay ? { providerReplay: {
      compatibilityDigest: 'fixture/v1', anthropicContent: [{ type: 'tool_use', id: 'write-1', name: 'write', input: {} }] } } : {}) } : final() },
    tools: { execute: async () => { calls.write++; toolStarted(); if (activeTool) await held; return { status: 'ok', content: 'Written' }; } },
  } };
  const controller = new AbortController();
  const payload = { agent: { id: scope.agentId, session }, input: { kind: 'enter', messages: inputMessages }, turn: 1, signal: controller.signal };
  const execute = createNativeDshTurnExecutor({ store, projections: { stateOf: () => state }, flush: async () => true, resolveTurn: async () => binding });
  const running = execute(payload);
  const finish = async () => { releaseTool(); return await running; };
  if (activeTool) { t.after(finish); await entered; }
  else {
    assert.deepEqual(await running, { reason: { kind: 'completed' } });
    assert.deepEqual(calls, { model: 2, write: 1 });
  }
  const turn1Head = store.sessionHead(scope, 'session');
  const turn1Record = store.load(scope, turn1Head.runId);
  assert.equal(turn1Record.snapshot.phase, activeTool ? 'executing_tools' : 'completed');
  const identity = { scope, runId: turn1Head.runId, sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'session' };
  const ownership = nativeDshOwnership({ identity, configuration: turn1Record.configuration, input: { messages: inputMessages }, source: binding.source });
  const sourceEvents = [
    { type: 'turn/start', data: { turn: 1 }, seq: 0 },
    { type: 'turn/owner', data: ownership, seq: 1 },
    { type: 'turn/end', data: { reason: { kind: 'completed' } }, seq: 2 },
  ];
  const publishedEvents = [...sourceEvents.slice(0, 2), ...sinkEvents.slice(1), ...(activeTool ? [] : [sourceEvents[2]])]
    .map((event, seq) => ({ ...event, seq }));
  let advancedEvents = sourceEvents, turn2Head = null;
  if (advance) {
    session.append('turn/start', { turn: 2 });
    const turn2Input = [{ id: 'input-2', role: 'user', content: [{ type: 'text', text: 'Continue the task' }] }];
    await execute({ ...payload, input: { kind: 'enter', messages: turn2Input }, turn: 2 });
    turn2Head = store.sessionHead(scope, 'session');
    advancedEvents = [...sourceEvents,
      { type: 'turn/start', data: { turn: 2 }, seq: 3 },
      { type: 'turn/owner', data: { engine: 'agentkit.native-dsh-turn/v1', turn: 2, binding: '', contract: 'dsh.external-turn/v1' }, seq: 4 },
      { type: 'turn/end', data: { reason: { kind: 'completed' } }, seq: 5 }];
  }
  return { store, binding, calls, session, sinkEvents, identity, ownership, sourceEvents, publishedEvents, advancedEvents, turn1Head, turn1Record, turn2Head, finish };
}

// Child Session snapshot: inherited prefix (seq < markerSeq, not own) then the
// session/end-seed marker (own from markerSeq onward).
function childSession({ id = 'child-session', parentSession = 'session', prefix }) {
  const markerSeq = prefix.length;
  return {
    id, header: { isSeeded: true, parentSession },
    snapshotEvents: () => [...prefix, { type: 'session/end-seed', data: { inherited: true }, seq: markerSeq }],
    isOwnSeq: seq => seq >= markerSeq,
  };
}

function queryCtx(observedEvents, parentSession = 'session', disposed = { value: false }) {
  return { get: key => key === 'sessionQuery' ? {
    observeSession: async () => ({ header: { id: parentSession }, events: observedEvents, [Symbol.dispose]: () => { disposed.value = true; } }),
  } : undefined };
}

test('a real completed Native source with one tool then final yields a fork seed with paired child-local tool IDs and leaves the source immutable', async t => {
  const src = await completedSource(t);
  const before = structuredClone(src.turn1Record);
  const child = childSession({ prefix: src.sourceEvents });
  const disposed = { value: false };
  const ctx = queryCtx(src.sourceEvents, 'session', disposed);
  const seed = await nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.equal(disposed.value, true);
  assert.equal(seed.contract, 'native-conversation-fork/v1');
  assert.deepEqual(seed.source, { parentSessionId: 'session', sessionId: 'session', runId: src.turn1Head.runId, turnId: '1', boundarySeq: 2,
    snapshotRevision: src.turn1Record.snapshot.revision, configDigest: src.turn1Record.snapshot.configDigest,
    snapshotDigest: digest(src.turn1Record.snapshot), transcriptDigest: digest(src.sourceEvents) });
  // The seed carries only history projection — no live tools, leases, children or budgets.
  assert.deepEqual(Object.keys(seed).sort(), ['contract', 'messages', 'source']);
  const assistant = seed.messages.find(m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length);
  assert.ok(assistant, 'projected history includes the assistant tool call');
  assert.notEqual(assistant.toolCalls[0].callId, 'write-1', 'historical tool call id is remapped into the child namespace');
  const toolMessage = seed.messages.find(m => m.role === 'tool');
  assert.ok(toolMessage, 'projected history includes the tool result');
  assert.equal(toolMessage.callId, assistant.toolCalls[0].callId, 'tool result is paired to the child-local call id');
  assert.deepEqual(src.store.load(scope, src.turn1Head.runId), before);
});

test('the fork selects the old closed source Run even after the source session head has advanced', async t => {
  const src = await completedSource(t, { advance: true });
  assert.notEqual(src.turn2Head.runId, src.turn1Head.runId);
  assert.equal(src.store.sessionHead(scope, 'session').runId, src.turn2Head.runId);
  const child = childSession({ prefix: src.sourceEvents });
  const disposed = { value: false };
  const ctx = queryCtx(src.advancedEvents, 'session', disposed);
  const seed = await nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.equal(disposed.value, true);
  assert.equal(seed.source.runId, src.turn1Head.runId);
  assert.equal(seed.source.turnId, '1');
  assert.equal(seed.source.boundarySeq, 2);
});

test('an altered inherited prefix is rejected as a changed source and still disposes the observation', async t => {
  const src = await completedSource(t);
  const alteredPrefix = [src.sourceEvents[0],
    { type: 'turn/owner', data: { ...src.ownership, binding: 'altered' }, seq: 1 }, src.sourceEvents[2]];
  const child = childSession({ prefix: alteredPrefix });
  const disposed = { value: false };
  const ctx = queryCtx(src.sourceEvents, 'session', disposed);
  await assert.rejects(nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() }), /native_conversation_fork_source_changed/);
  assert.equal(disposed.value, true);
});

test('a wrong fork scope is rejected before loading the source and still disposes', async t => {
  const src = await completedSource(t);
  const child = childSession({ prefix: src.sourceEvents });
  const disposed = { value: false };
  const ctx = queryCtx(src.sourceEvents, 'session', disposed);
  const wrongScope = { ...scope, workspaceId: 'other-workspace' };
  await assert.rejects(nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope: wrongScope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() }), /native_conversation_fork_scope_mismatch/);
  assert.equal(disposed.value, true);
});

test('a root cut before the admitted input imports no source future and still disposes', async t => {
  const src = await completedSource(t);
  const openPrefix = [src.sourceEvents[0], src.sourceEvents[1]]; // turn/start, turn/owner — no turn/end in the inherited prefix
  const child = childSession({ prefix: openPrefix });
  const disposed = { value: false };
  const ctx = queryCtx(src.sourceEvents, 'session', disposed); // source closes turn/end at seq2, outside the child prefix
  const seed = await nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.deepEqual(seed.messages, []);
  assert.equal(disposed.value, true);
});

test('a cut before the first owner authenticates scope but imports nothing; a later turn before its owner preserves the completed prefix', async t => {
  const src = await completedSource(t);
  const rootPrefix = src.sourceEvents.slice(0, 1);
  const root = await nativeConversationForkSeed({ ctx: queryCtx(src.sourceEvents),
    agent: { session: childSession({ prefix: rootPrefix }) }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.deepEqual(root.messages, []);
  const nextPrefix = [...src.publishedEvents, { seq: src.publishedEvents.length, type: 'turn/start', data: { turn: 2 } }];
  const next = await nativeConversationForkSeed({ ctx: queryCtx(nextPrefix),
    agent: { session: childSession({ prefix: nextPrefix }) }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.ok(next.messages.some(message => message.content === 'Done'));
  assert.ok(next.messages.some(message => message.content === '"Written"'));
});

test('published in-turn cuts import only the selected input, assistant call or settled result after the source has finished', async t => {
  const src = await completedSource(t), before = structuredClone(src.turn1Record);
  const cuts = src.publishedEvents.filter(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type));
  assert.equal(cuts.length, 4);
  for (const [index, boundary] of cuts.entries()) {
    const prefix = src.publishedEvents.slice(0, boundary.seq + 1);
    const seed = await nativeConversationForkSeed({ ctx: queryCtx(src.publishedEvents),
      agent: { session: childSession({ id: `partial-${index}`, prefix }) }, store: src.store, scope, turn: 1,
      profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
    assert.equal(seed.messages[0].content, 'Complete the task');
    assert.equal(seed.messages.some(message => message.content === 'Done'), index === 3, `cut ${index}: ${JSON.stringify(seed.messages)}`);
    if (index === 0) assert.equal(seed.messages.length, 1);
    else {
      const call = seed.messages.find(message => message.toolCalls)?.toolCalls[0];
      const result = seed.messages.find(message => message.role === 'tool');
      assert.ok(call && result); assert.equal(result.callId, call.callId);
      if (index === 1) {
        assert.equal(JSON.parse(result.content).executionStatus, 'unknown');
        assert.doesNotMatch(result.content, /Written/);
      } else assert.match(result.content, /Written/);
    }
    // The exact partial data must also survive being copied by a later fork of
    // this DSH fork, whose synthetic closer lies inside the next inherited prefix.
    const synthetic = [...prefix, { seq: prefix.length, type: 'session/end-seed', data: { inherited: true } },
      { seq: prefix.length + 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } }];
    const nested = await nativeConversationForkSeed({ ctx: queryCtx(synthetic, 'partial-parent'),
      agent: { session: childSession({ id: `nested-${index}`, parentSession: 'partial-parent', prefix: synthetic }) },
      store: src.store, scope, turn: 1, profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
    assert.deepEqual(nested.messages.map(message => message.content), seed.messages.map(message => message.content));
  }
  assert.deepEqual(src.store.load(scope, src.turn1Head.runId), before);
  assert.deepEqual(src.calls, { model: 2, write: 1 });
});

test('forking while the source tool is running imports unknown history without taking its lease or replaying its write', async t => {
  const src = await completedSource(t, { activeTool: true });
  const boundary = src.publishedEvents.find(event => event.type === 'assistant/message');
  const prefix = src.publishedEvents.slice(0, boundary.seq + 1);
  const request = { ctx: queryCtx(src.publishedEvents), agent: { session: childSession({ prefix }) }, store: src.store,
    scope, turn: 1, profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() };
  const seed = await nativeConversationForkSeed(request);
  assert.equal(JSON.parse(seed.messages.find(message => message.role === 'tool').content).executionStatus, 'unknown');
  assert.deepEqual(src.store.load(scope, src.turn1Head.runId), src.turn1Record);
  assert.deepEqual(src.calls, { model: 1, write: 1 });
  await src.finish();
  assert.equal(src.store.load(scope, src.turn1Head.runId).snapshot.phase, 'completed');
  const afterSourceFinished = await nativeConversationForkSeed(request);
  assert.deepEqual(afterSourceFinished.messages, seed.messages);
  assert.deepEqual(src.calls, { model: 2, write: 1 });
});

test('cancellation after the awaited source query cannot return a seed but still disposes', async t => {
  const src = await completedSource(t);
  const child = childSession({ prefix: src.sourceEvents });
  const disposed = { value: false };
  let resolveObserve;
  const observed = { header: { id: 'session' }, events: src.sourceEvents, [Symbol.dispose]: () => { disposed.value = true; } };
  const ctx = { get: key => key === 'sessionQuery' ? { observeSession: () => new Promise(resolve => { resolveObserve = () => resolve(observed); }) } : undefined };
  const controller = new AbortController();
  const seedPromise = nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: controller.signal });
  controller.abort(new Error('canceled after query'));
  resolveObserve();
  await assert.rejects(seedPromise, /canceled after query/);
  assert.equal(disposed.value, true);
});

test('same-turn redelivery reuses the frozen seed without re-querying and the next turn returns no new seed', async t => {
  const src = await completedSource(t);
  const child = childSession({ prefix: src.sourceEvents });
  const ctx = queryCtx(src.sourceEvents);
  const seed = await nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  // Freeze the derived seed into a child turn-1 Run, as the framework would.
  const childConfig = configure({ profile: forkProfile, contract: { objective: 'Project fork history' },
    hostBindingDigest: 'fork-history-projection', conversationSeed: seed });
  const childSnapshot = initialSnapshot({ scope, runId: 'child-run-1', sessionId: 'child-session', turnId: '1',
    buildId: 'build', parentRunId: null, taskChainId: 'child-session' }, childConfig, digest(childConfig));
  src.store.create(childConfig, childSnapshot);
  assert.equal(src.store.sessionHead(scope, 'child-session').runId, 'child-run-1');
  // The head path short-circuits before any source query.
  const noQueryCtx = { get: key => { if (key === 'sessionQuery') throw Error('head path must not query the source'); } };
  const redelivered = await nativeConversationForkSeed({ ctx: noQueryCtx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.deepEqual(redelivered, seed);
  const nextTurn = await nativeConversationForkSeed({ ctx: noQueryCtx, agent: { session: child }, store: src.store, scope, turn: 2,
    profile: forkProfile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.equal(nextTurn, undefined);
});

test('fork admissions never embed private provider replay, even for an identical model profile', async t => {
  const src = await completedSource(t, { privateReplay: true });
  assert.ok(src.turn1Record.snapshot.messages.some(message => message.providerReplay), 'Source really contains private replay');
  const child = childSession({ prefix: src.sourceEvents });
  const ctx = queryCtx(src.sourceEvents);
  const seed = await nativeConversationForkSeed({ ctx, agent: { session: child }, store: src.store, scope, turn: 1,
    profile: src.turn1Record.configuration.profile, tools: forkTools(), policies: noPolicies, signal: freshSignal() });
  assert.ok(Array.isArray(seed.messages) && seed.messages.length > 0);
  for (const message of seed.messages) {
    assert.equal(message.providerReplay, undefined); assert.equal(message.replayToolIds, undefined);
    assert.equal('operatorGuidance' in message, false);
    assert.equal('inputId' in message, false);
    assert.equal('inputGoalRevision' in message, false);
  }
  assert.equal(JSON.stringify(seed).includes('anthropicContent'), false);
});
