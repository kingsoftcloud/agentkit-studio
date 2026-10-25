import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeConversationState } from '../src/client/state/native-conversation.mjs';

const AGENT = 'agent-1', SESSION = 'sess-1';

function okStatus(over = {}) {
  return {
    contract: 'agentkit.studio-native-conversation/v1',
    agentId: AGENT, sessionId: SESSION,
    headRunId: 'run-3', generation: 2, canRewind: true,
    inputs: [{ messageId: 'm1', text: '第一条用户输入' }, { messageId: 'm2', text: '第二条用户输入' }],
    ...over,
  };
}

function okRewind(pending, over = {}) {
  return {
    contract: 'agentkit.studio-native-conversation-rewind/v1',
    agentId: AGENT, sessionId: SESSION, commandId: pending.commandId,
    generation: 3, state: 'applied', surfacePersisted: true,
    ...over,
  };
}

function mockHost({ status = okStatus(), rewind = okRewind } = {}) {
  const calls = { status: [], rewind: [] };
  return {
    calls,
    async nativeConversationStatus(req, signal) {
      calls.status.push(req);
      return typeof status === 'function' ? status(req, calls.status.length) : status;
    },
    async rewindNativeConversation(req, signal) {
      calls.rewind.push(req);
      return typeof rewind === 'function' ? rewind(req, calls.rewind.length) : rewind;
    },
  };
}

function makeState(host, newCommandId = () => 'cmd-1') {
  return createNativeConversationState({ hostRemote: host, agentId: AGENT, sessionId: SESSION, newCommandId });
}

test('refresh loads status, clears error, and validates identity', async () => {
  const host = mockHost();
  const state = makeState(host);
  assert.equal(state.getSnapshot().status, null);
  await state.refresh();
  const snap = state.getSnapshot();
  assert.equal(snap.status.agentId, AGENT);
  assert.equal(snap.status.sessionId, SESSION);
  assert.equal(snap.status.canRewind, true);
  assert.deepEqual(snap.status.inputs.map(i => i.messageId), ['m1', 'm2']);
  assert.equal(snap.loading, false);
  assert.equal(snap.error, '');
});

test('a running Native status exposes stop-and-rewind without changing the request authority', async () => {
  const host = mockHost({ status: okStatus({ requiresStop: true }) }), state = makeState(host);
  await state.refresh(); assert.equal(state.getSnapshot().status.requiresStop, true);
  await state.rewind('m1');
  assert.deepEqual(Object.keys(host.calls.rewind[0]).sort(), ['agentId', 'sessionId', 'expectedHeadRunId', 'expectedGeneration', 'targetMessageId', 'commandId'].sort());
});

test('unsettled cancellation explains the stopped task and keeps the exact rewind pending', async () => {
  const host = mockHost({ rewind: () => { throw Object.assign(Error('unsettled'), { code: 'native_conversation_rewind_stop_unsettled' }); } });
  const state = makeState(host); await state.refresh(); await state.rewind('m1');
  const pending = state.getSnapshot().pending;
  assert.match(state.getSnapshot().error, /仍有执行结果或任务待核实/);
  await state.retry(); assert.deepEqual(state.getSnapshot().pending, pending);
  assert.deepEqual(host.calls.rewind[0], host.calls.rewind[1]);
});

test('invalid status contract leaves status null and sets error', async () => {
  const host = mockHost({ status: okStatus({ contract: 'agentkit.wrong/v1' }) });
  const state = makeState(host);
  await state.refresh();
  const snap = state.getSnapshot();
  assert.equal(snap.status, null);
  assert.ok(snap.error);
});

test('status identity mismatch leaves status null', async () => {
  const host = mockHost({ status: okStatus({ agentId: 'wrong-agent' }) });
  const state = makeState(host);
  await state.refresh();
  assert.equal(state.getSnapshot().status, null);
});

test('successful rewind clears pending and re-fetches status', async () => {
  const host = mockHost();
  const state = makeState(host);
  await state.refresh();
  assert.equal(host.calls.status.length, 1);
  assert.equal(host.calls.rewind.length, 0);
  await state.rewind('m1');
  assert.equal(host.calls.rewind.length, 1);
  assert.equal(host.calls.status.length, 2, 'status refetched after rewind');
  assert.equal(state.getSnapshot().pending, null);
  assert.deepEqual(host.calls.rewind[0], {
    agentId: AGENT, sessionId: SESSION, expectedHeadRunId: 'run-3', expectedGeneration: 2,
    targetMessageId: 'm1', commandId: 'cmd-1',
  });
});

test('retry after a lost response resends the same commandId and full payload', async () => {
  const host = mockHost({
    rewind: (req, count) => {
      if (count === 1) throw Error('network lost');
      return okRewind(req);
    },
  });
  const state = makeState(host);
  await state.refresh();
  await state.rewind('m1');
  let snap = state.getSnapshot();
  assert.ok(snap.pending, 'pending retained after lost response');
  assert.equal(snap.pending.commandId, 'cmd-1');
  assert.equal(snap.pending.targetMessageId, 'm1');
  const firstPayload = { ...snap.pending };
  assert.equal(host.calls.rewind.length, 1);
  await state.retry();
  snap = state.getSnapshot();
  assert.equal(snap.pending, null, 'pending cleared on successful retry');
  assert.equal(host.calls.rewind.length, 2);
  assert.equal(host.calls.rewind[1].commandId, 'cmd-1', 'retry reused the same commandId');
  assert.deepEqual(host.calls.rewind[1], firstPayload, 'retry resent the full payload unchanged');
  assert.equal(host.calls.rewind[0], host.calls.rewind[1], 'same pending object resent');
});

test('rewind response identity mismatch keeps pending and does not corrupt status', async () => {
  const host = mockHost({ rewind: req => okRewind(req, { agentId: 'wrong-agent' }) });
  const state = makeState(host);
  await state.refresh();
  const statusBefore = state.getSnapshot().status;
  await state.rewind('m1');
  const snap = state.getSnapshot();
  assert.ok(snap.pending, 'pending retained on identity mismatch');
  assert.equal(snap.pending.commandId, 'cmd-1');
  assert.equal(snap.status, statusBefore, 'status not overwritten by an invalid response');
  assert.ok(snap.error);
});

test('rewind response commandId mismatch keeps pending', async () => {
  const host = mockHost({ rewind: req => okRewind(req, { commandId: 'different-cmd' }) });
  const state = makeState(host);
  await state.refresh();
  await state.rewind('m1');
  const snap = state.getSnapshot();
  assert.ok(snap.pending, 'pending retained on commandId mismatch');
  assert.equal(snap.pending.commandId, 'cmd-1');
});

test('dispose during in-flight rewind prevents writeback and listener notifications', async () => {
  let resolveRewind;
  const host = {
    calls: { status: [], rewind: [] },
    nativeConversationStatus(req, signal) { host.calls.status.push(req); return Promise.resolve(okStatus()); },
    rewindNativeConversation(req, signal) { host.calls.rewind.push(req); return new Promise(r => { resolveRewind = () => r(okRewind(req)); }); },
  };
  const state = makeState(host);
  let updates = 0;
  state.subscribe(() => updates++);
  await state.refresh();
  const updatesAfterRefresh = updates;
  const p = state.rewind('m1');
  const updatesAfterSync = updates;
  assert.ok(updatesAfterSync > updatesAfterRefresh, 'rewind notified listeners synchronously');
  const snapshotAtDispose = state.getSnapshot();
  assert.ok(snapshotAtDispose.pending, 'pending was set before dispose');
  state.dispose();
  resolveRewind();
  await p;
  assert.equal(state.getSnapshot(), snapshotAtDispose, 'snapshot unchanged after a disposed response');
  assert.equal(updates, updatesAfterSync, 'no listener notifications after dispose');
});

test('dispose makes refresh, rewind, and retry no-ops', async () => {
  const host = mockHost();
  const state = makeState(host);
  state.dispose();
  await state.refresh();
  await state.rewind('m1');
  await state.retry();
  assert.equal(host.calls.status.length, 0);
  assert.equal(host.calls.rewind.length, 0);
  assert.equal(state.getSnapshot().status, null);
});

test('rewind is a no-op when canRewind is false', async () => {
  const host = mockHost({ status: okStatus({ canRewind: false }) });
  const state = makeState(host);
  await state.refresh();
  await state.rewind('m1');
  assert.equal(state.getSnapshot().pending, null);
  assert.equal(host.calls.rewind.length, 0);
});

test('rewind with an unknown messageId is a no-op', async () => {
  const host = mockHost();
  const state = makeState(host);
  await state.refresh();
  await state.rewind('no-such-input');
  assert.equal(state.getSnapshot().pending, null);
  assert.equal(host.calls.rewind.length, 0);
});

test('a pending rewind blocks a second rewind', async () => {
  let resolveRewind;
  const host = mockHost();
  host.rewindNativeConversation = (req, signal) => { host.calls.rewind.push(req); return new Promise(r => { resolveRewind = () => r(okRewind(req)); }); };
  const state = makeState(host);
  await state.refresh();
  const p = state.rewind('m1');
  await state.rewind('m2');
  assert.equal(host.calls.rewind.length, 1, 'second rewind did not fire');
  assert.equal(state.getSnapshot().pending.targetMessageId, 'm1', 'first pending retained');
  resolveRewind();
  await p;
});

test('loading prevents duplicate refresh', async () => {
  let resolveStatus;
  const host = {
    calls: { status: [], rewind: [] },
    nativeConversationStatus(req, signal) { host.calls.status.push(req); return new Promise(r => { resolveStatus = r; }); },
    rewindNativeConversation(req, signal) { return Promise.resolve(okRewind(req)); },
  };
  const state = makeState(host);
  const p1 = state.refresh();
  const p2 = state.refresh();
  resolveStatus(okStatus());
  await Promise.all([p1, p2]);
  assert.equal(host.calls.status.length, 1);
});

test('sending prevents a duplicate retry', async () => {
  let resolveRewind;
  const host = mockHost();
  host.rewindNativeConversation = (req, signal) => { host.calls.rewind.push(req); return new Promise(r => { resolveRewind = () => r(okRewind(req)); }); };
  const state = makeState(host);
  await state.refresh();
  const p1 = state.rewind('m1');
  const p2 = state.retry();
  resolveRewind();
  await Promise.all([p1, p2]);
  assert.equal(host.calls.rewind.length, 1);
});

test('subscribe notifies on changes and stops after unsubscribe', async () => {
  const host = mockHost();
  const state = makeState(host);
  const seen = [];
  const stop = state.subscribe(s => seen.push(s));
  await state.refresh();
  assert.ok(seen.length >= 2, 'notified on loading and on status');
  stop();
  const countAfterStop = seen.length;
  await state.refresh();
  assert.equal(seen.length, countAfterStop, 'no notifications after unsubscribe');
});

test('an old in-flight refresh cannot restore the removed branch after acknowledgement', async () => {
  let resolveOld;
  const next = okStatus({ generation: 3, inputs: [] });
  const host = mockHost({ status: (_request, count) => count === 2 ? new Promise(resolve => { resolveOld = resolve; })
    : count >= 3 ? next : okStatus() });
  const state = makeState(host);
  await state.refresh();
  const oldRefresh = state.refresh();
  await state.rewind('m1');
  assert.equal(state.getSnapshot().status.generation, 3);
  assert.deepEqual(state.getSnapshot().status.inputs, []);
  resolveOld(okStatus()); await oldRefresh;
  assert.equal(state.getSnapshot().status.generation, 3);
  assert.deepEqual(state.getSnapshot().status.inputs, []);
});

for (const code of ['native_conversation_rewind_head_conflict', 'native_conversation_rewind_target_not_active',
  'studio_native_conversation_rewind_requires_idle']) test(`${code}: a confirmed pre-append rejection permits a fresh selection`, async () => {
  const host = mockHost({ rewind: () => { throw Object.assign(Error('Rejected before append'), { code }); } });
  const state = makeState(host);
  await state.refresh(); await state.rewind('m1');
  assert.equal(state.getSnapshot().pending, null);
  assert.match(state.getSnapshot().error, /未执行/);
  assert.equal(host.calls.status.length, 2);
  await state.rewind('m2'); assert.equal(host.calls.rewind.length, 2);
});

test('a persistence failure keeps the exact original command pending', async () => {
  const host = mockHost({ rewind: () => { throw Object.assign(Error('Not durable'), { code: 'native_conversation_rewind_not_durable' }); } });
  const state = makeState(host);
  await state.refresh(); await state.rewind('m1');
  const pending = state.getSnapshot().pending;
  assert.ok(pending); await state.retry();
  assert.equal(host.calls.rewind[1], pending);
  assert.equal(state.getSnapshot().pending, pending);
});
