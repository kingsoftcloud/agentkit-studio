import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantCancelAvailable, assistantRetryAvailable, assistantTranscript, createAssistantSession } from '../src/client/state/assistant-session.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (patch = {}) => ({ messages: [], events: [], status: 'idle', hasMore: false, asOfSeq: 0,
  currentTurn: patch.status === 'running' ? 1 : null, turnStartSeq: patch.status === 'running' ? 0 : null,
  capabilities: { execution: { scopedCancel: true } }, ...patch });
function fixture({ storage, handler, readAttachment } = {}) {
  const values = new Map(), timers = new Map(), calls = []; let sequence = 0, uploadSequence = 0, clock = 0, current = snapshot();
  storage ||= { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const execute = async (agentId, operation, input, signal) => {
    const call = { agentId, operation, input, signal }; calls.push(call);
    if (handler) return handler(call, current);
    if (operation === 'snapshot') return current;
    if (operation === 'submit') return { accepted: true, requestId: input.requestId };
    if (operation === 'cancel-turn') return { accepted: true };
  };
  const options = { storage, execute, readAttachment, createUploadId: () => `upload-${++uploadSequence}`, createRequestId: () => `request-${++sequence}`, timezone: () => 'Etc/UTC',
    setTimer: work => { const id = ++clock; timers.set(id, work); return id; }, clearTimer: id => timers.delete(id) };
  const session = createAssistantSession(options);
  return { session, calls, values, storage, timers, options, setSnapshot: value => { current = value; },
    async connect(id = 'agent-a') { session.connect(id); await settle(); },
    async poll() { const next = timers.entries().next().value; assert.ok(next, 'poll scheduled'); timers.delete(next[0]); next[1](); await settle(); } };
}

test('disconnect never cancels cloud work; reopening observes off-page receipt but requires durable submit ACK', async () => {
  const submit = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'submit' ? submit.promise : current });
  await f.connect(); f.session.setDraft('continue in cloud');
  const operation = f.session.submit();
  assert.equal(f.session.getState().busy, true);
  f.session.disconnect();
  assert.equal(f.calls.some(call => call.operation === 'cancel-turn'), false);
  assert.equal(f.timers.size, 0);
  submit.resolve({ accepted: true, requestId: 'request-1' }); await operation;
  assert.ok(f.storage.getItem('agentkit.assistant.pending.agent-a'));
  f.setSnapshot(snapshot({ status: 'completed', asOfSeq: 450, receipt: { requestId: 'request-1', accepted: true } }));
  const reopened = createAssistantSession(f.options); reopened.connect('agent-a'); await settle();
  assert.equal(f.calls.at(-1).input.requestId, 'request-1');
  assert.equal(reopened.getState().pending.observed, true);
  assert.ok(f.storage.getItem('agentkit.assistant.pending.agent-a'));
  assert.equal(await reopened.submit(), true);
  assert.equal(reopened.getState().pending, null);
  assert.equal(reopened.getState().draft, '');
  assert.equal(f.storage.getItem('agentkit.assistant.pending.agent-a'), null);
  reopened.disconnect();
});

test('rapid submit clicks use one mutation; ACK leaves authoritative status unchanged', async () => {
  const submit = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'submit' ? submit.promise : current });
  await f.connect(); f.session.setDraft('one task');
  const first = f.session.submit();
  assert.equal(await f.session.submit(), false);
  assert.equal(f.calls.filter(call => call.operation === 'submit').length, 1);
  submit.resolve({ accepted: true, requestId: 'request-1' }); assert.equal(await first, true); await settle();
  assert.equal(f.session.getState().view.status, 'idle');
  assert.equal(f.session.getState().busy, false);
  assert.equal(f.session.getState().draft, '');
  assert.equal(assistantTranscript(f.session.getState()).messages[0].delivery, 'accepted');
  assert.equal(await f.session.submit(), false);
});

test('unknown ACK keeps the same request ID through polling, refresh and retry', async () => {
  let attempts = 0;
  const f = fixture({ handler: (call, current) => {
    if (call.operation !== 'submit') return current;
    if (++attempts === 1) throw new Error('Connection lost');
    return { accepted: true, requestId: call.input.requestId };
  } });
  await f.connect(); f.session.setDraft('keep me');
  assert.equal(await f.session.submit(), false); await settle();
  assert.equal(f.session.getState().pending.requestId, 'request-1');
  assert.match(f.session.getState().error, /尚未确认/);
  await f.poll(); assert.match(f.session.getState().error, /尚未确认/);
  f.session.disconnect(); await f.connect();
  assert.equal(await f.session.submit(), true);
  assert.deepEqual(f.calls.filter(call => call.operation === 'submit').map(call => call.input.requestId), ['request-1', 'request-1']);
});

test('observed receipts cannot erase recovery IDs when submit persistence later fails', async () => {
  const submit = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'submit' ? submit.promise : current });
  await f.connect(); f.session.setDraft('persisted task'); const operation = f.session.submit();
  f.setSnapshot(snapshot({ asOfSeq: 5, status: 'queued', receipt: { accepted: true, requestId: 'request-1' } }));
  await f.session.refresh();
  assert.equal(f.session.getState().pending.observed, true);
  assert.ok(f.storage.getItem('agentkit.assistant.pending.agent-a'));
  submit.reject(new Error('Persistence flush failed')); assert.equal(await operation, false); await settle();
  assert.match(f.session.getState().error, /尚未确认/);
  assert.equal(f.session.getState().pending.requestId, 'request-1');
  assert.ok(f.storage.getItem('agentkit.assistant.pending.agent-a'));
  assert.equal(f.session.getState().view.status, 'queued');
});

test('agent switches isolate late submit results and busy ownership', async () => {
  const a = deferred(), b = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'submit' ? (call.agentId === 'agent-a' ? a.promise : b.promise) : current });
  await f.connect(); f.session.setDraft('A task'); const first = f.session.submit();
  await f.connect('agent-b'); f.session.setDraft('B task'); const second = f.session.submit();
  a.resolve({ accepted: true, requestId: 'request-1' }); await first;
  assert.equal(f.session.getState().agentId, 'agent-b');
  assert.equal(f.session.getState().busy, true);
  assert.equal(f.session.getState().pending.text, 'B task');
  assert.ok(f.storage.getItem('agentkit.assistant.pending.agent-a'));
  b.resolve({ accepted: true, requestId: 'request-2' }); await second;
  assert.equal(f.session.getState().busy, false);
  assert.equal(f.session.getState().pending, null);
});

test('late, pre-mutation and regressing snapshots cannot overwrite newer state', async () => {
  let nextRead = null;
  const f = fixture({ handler: (call, current) => {
    if (call.operation === 'snapshot') { const result = nextRead; nextRead = null; return result?.promise || current; }
    return { accepted: true, requestId: call.input.requestId };
  } });
  await f.connect();
  const old = deferred(); nextRead = old; const oldRead = f.session.refresh();
  f.setSnapshot(snapshot({ status: 'running', asOfSeq: 12 })); await f.session.refresh();
  old.resolve(snapshot({ status: 'idle', asOfSeq: 0 })); await oldRead;
  assert.equal(f.session.getState().view.status, 'running');
  const before = deferred(); nextRead = before; const beforeRead = f.session.refresh();
  f.session.setDraft('queued while running'); await f.session.submit(); await settle();
  before.resolve(snapshot({ status: 'completed', asOfSeq: 14 })); await beforeRead;
  assert.equal(f.session.getState().view.status, 'running');
  f.setSnapshot(snapshot({ status: 'idle', asOfSeq: 3 })); await f.session.refresh();
  assert.equal(f.session.getState().view.asOfSeq, 12);
});

test('leaving and switching suppress delayed reads without cancelling', async () => {
  const old = deferred();
  const f = fixture({ handler: call => call.agentId === 'agent-a' ? old.promise : snapshot({ status: 'queued', asOfSeq: 1 }) });
  f.session.connect('agent-a'); await f.connect('agent-b');
  old.resolve(snapshot({ status: 'failed', asOfSeq: 999 })); await settle();
  assert.equal(f.session.getState().agentId, 'agent-b');
  assert.equal(f.session.getState().view.status, 'queued');
  f.session.disconnect(); assert.equal(f.timers.size, 0);
  assert.ok(f.calls.every(call => call.operation === 'snapshot'));
});

test('cancel ACK is stopping, never cancelled until native terminal evidence', async () => {
  const f = fixture(); f.setSnapshot(snapshot({ status: 'running', asOfSeq: 4 })); await f.connect();
  assert.equal(await f.session.cancel(), true); await settle();
  assert.equal(f.session.getState().cancelPhase, 'stopping');
  assert.equal(f.session.getState().view.status, 'running');
  assert.match(f.session.getState().notice, /等待云端确认/);
  assert.equal(await f.session.cancel(), false);
  f.setSnapshot(snapshot({ status: 'cancelled', asOfSeq: 5 })); await f.poll();
  assert.equal(f.session.getState().cancelPhase, null);
  assert.equal(f.session.getState().notice, '任务已停止。');
});

test('rejected and unknown cancellations retain clear warnings while cloud work continues', async () => {
  let reply = { accepted: false };
  const f = fixture({ handler: (call, current) => {
    if (call.operation !== 'cancel-turn') return current;
    if (reply instanceof Error) throw reply;
    return reply;
  } });
  f.setSnapshot(snapshot({ status: 'running', asOfSeq: 3 })); await f.connect();
  assert.equal(await f.session.cancel(), false); await settle();
  assert.match(f.session.getState().error, /未接受停止请求/);
  assert.equal(f.session.getState().notice, '');
  reply = new Error('Network disconnected');
  assert.equal(await f.session.cancel(), false); await settle();
  assert.match(f.session.getState().error, /停止结果尚未确认/);
  await f.poll(); assert.match(f.session.getState().error, /停止结果尚未确认/);
  assert.equal(f.session.getState().view.status, 'running');
  f.setSnapshot(snapshot({ status: 'completed', asOfSeq: 5 })); await f.poll();
  assert.equal(f.session.getState().notice, '任务已完成。');
  assert.equal(f.session.getState().cancelPhase, null);
});

test('an agent switch during confirmation cannot cancel the new assistant or release its busy lock', async () => {
  const confirm = deferred(), submit = deferred(); let confirmations = 0;
  const f = fixture({ handler: (call, current) => call.operation === 'submit' ? submit.promise : current });
  f.setSnapshot(snapshot({ status: 'running' })); await f.connect();
  const cancel = f.session.cancel(() => { confirmations++; return confirm.promise; });
  assert.equal(await f.session.cancel(() => { confirmations++; return true; }), false);
  assert.equal(confirmations, 1);
  await f.connect('agent-b'); f.session.setDraft('B'); const other = f.session.submit();
  confirm.resolve(true); assert.equal(await cancel, false);
  assert.equal(f.session.getState().busy, true);
  assert.equal(f.calls.some(call => call.operation === 'cancel-turn'), false);
  submit.resolve({ accepted: true, requestId: 'request-1' }); await other;
});

test('a terminal snapshot beats a delayed cancellation ACK', async () => {
  const cancel = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'cancel-turn' ? cancel.promise : current });
  f.setSnapshot(snapshot({ status: 'running', asOfSeq: 1 })); await f.connect();
  const operation = f.session.cancel(); await settle();
  f.setSnapshot(snapshot({ status: 'completed', asOfSeq: 2 })); await f.session.refresh();
  cancel.resolve({ accepted: true }); await operation;
  assert.equal(f.session.getState().cancelPhase, null);
  assert.equal(f.session.getState().notice, '任务已完成。');
});

test('failure retry requires the exact snapshot retry, never the latest arbitrary user task', async () => {
  const f = fixture();
  f.setSnapshot(snapshot({ status: 'failed', messages: [{ id: 'new', seq: 40, role: 'user', text: 'Unrelated task' }] })); await f.connect();
  assert.equal(await f.session.retry(), false);
  assert.equal(f.calls.some(call => call.operation === 'submit'), false);
  f.setSnapshot(snapshot({ status: 'failed', asOfSeq: 50, capabilities: { history: { nativeEvents: true } }, retry: { text: 'Exact failed task', requestId: 'failed-task', turn: 1, endSeq: 30 } }));
  await f.session.refresh(); assert.equal(await f.session.retry(), true);
  assert.equal(f.calls.find(call => call.operation === 'submit').input.text, 'Exact failed task');
  assert.notEqual(f.calls.find(call => call.operation === 'submit').input.requestId, 'failed-task');
});

test('older pages merge rich events without overwriting authoritative running or pagination state', async () => {
  const latest = snapshot({ status: 'running', asOfSeq: 20, beforeSeq: 15, hasMore: true,
    messages: [{ id: 'm20', seq: 20, role: 'assistant', text: 'Current' }], events: [{ seq: 20, type: 'assistant/message' }] });
  const f = fixture({ handler: call => call.input.beforeSeq !== undefined ? snapshot({ status: 'failed', asOfSeq: 20, beforeSeq: 2, hasMore: false,
    messages: [{ id: 'm2', seq: 2, role: 'user', text: 'Old' }], events: [{ seq: 2, type: 'user/message' }] }) : latest });
  await f.connect(); assert.equal(await f.session.loadOlder(), true);
  const transcript = assistantTranscript(f.session.getState());
  assert.equal(transcript.view.status, 'running'); assert.equal(transcript.view.asOfSeq, 20);
  assert.deepEqual(transcript.view.events.map(event => event.seq), [2, 20]);
  assert.deepEqual(transcript.messages.map(message => message.id), ['m2', 'm20']);
  assert.equal(f.session.getState().olderHasMore, false);
});

test('drafts survive reconnect separately for each agent and journal storage failure prevents mutation', async () => {
  const f = fixture(); await f.connect(); f.session.setDraft('A draft');
  await f.connect('agent-b'); assert.equal(f.session.getState().draft, ''); f.session.setDraft('B draft');
  await f.connect('agent-a'); assert.equal(f.session.getState().draft, 'A draft');
  f.storage.setItem = () => { throw new Error('Full'); };
  assert.equal(await f.session.submit(), false);
  assert.match(f.session.getState().error, /无法保存提交标识/);
  assert.equal(f.calls.some(call => call.operation === 'submit'), false);
});

test('acknowledged messages reconcile by receipt outside the visible page without erasing a new draft', async () => {
  const f = fixture(); await f.connect(); f.session.setDraft('accepted task'); await f.session.submit(); await settle();
  assert.equal(f.calls.at(-1).input.requestId, 'request-1');
  f.session.setDraft('accepted task');
  f.setSnapshot(snapshot({ status: 'running', asOfSeq: 900, receipt: { requestId: 'request-1', accepted: true, observed: true } }));
  await f.session.refresh();
  assert.deepEqual(f.session.getState().accepted, []);
  assert.equal(f.session.getState().draft, 'accepted task');
});

test('failed journal cleanup never permits a new request to replace the known request ID', async () => {
  const f = fixture(); await f.connect(); f.session.setDraft('accepted but storage locked');
  const remove = f.storage.removeItem; f.storage.removeItem = () => { throw new Error('Storage locked'); };
  await f.session.submit(); await settle();
  assert.equal(f.session.getState().pending.requestId, 'request-1');
  assert.match(f.session.getState().error, /未能清理/);
  f.storage.removeItem = remove;
  assert.equal(await f.session.submit(), true); await settle();
  assert.equal(f.session.getState().pending, null);
  assert.deepEqual(f.calls.filter(call => call.operation === 'submit').map(call => call.input.requestId), ['request-1', 'request-1']);
});

test('cancel completion does not mutate an assistant after the view unmounts', async () => {
  const cancellation = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'cancel-turn' ? cancellation.promise : current });
  f.setSnapshot(snapshot({ status: 'running' })); await f.connect();
  const request = f.session.cancel(); await settle();
  f.session.disconnect(); const departed = f.session.getState();
  cancellation.resolve({ accepted: true }); await request;
  assert.equal(f.session.getState(), departed);
  assert.equal(f.timers.size, 0);
});

test('an older-page read cannot land in a newly selected assistant', async () => {
  const older = deferred();
  const f = fixture({ handler: call => call.input.beforeSeq !== undefined ? older.promise : snapshot({ hasMore: true, beforeSeq: 10 }) });
  await f.connect(); const loading = f.session.loadOlder(); assert.equal(await f.session.loadOlder(), false);
  await f.connect('agent-b');
  older.resolve(snapshot({ messages: [{ id: 'private-a', seq: 1, role: 'user', text: 'A only' }] })); await loading;
  assert.deepEqual(f.session.getState().older, []);
  assert.equal(f.session.getState().loadingOlder, false);
});

test('reconnect errors preserve queued work and recover on a later successful read', async () => {
  let offline = false;
  const f = fixture({ handler: (call, current) => { if (offline) throw new Error('Offline'); return current; } });
  f.setSnapshot(snapshot({ status: 'queued', queuedCount: 1, asOfSeq: 8 })); await f.connect();
  offline = true; await f.poll();
  assert.equal(f.session.getState().view.status, 'queued'); assert.match(f.session.getState().readError, /仍在继续/);
  offline = false; f.setSnapshot(snapshot({ status: 'running', asOfSeq: 9 })); await f.poll();
  assert.equal(f.session.getState().view.status, 'running'); assert.equal(f.session.getState().readError, '');
});

test('migration-required history retains drafts and blocks submission until restored', async () => {
  const f = fixture(); f.setSnapshot(snapshot({ status: 'migration-required', historyState: 'migration-required' })); await f.connect();
  f.session.setDraft('resume after upgrade');
  assert.equal(await f.session.submit(), false);
  assert.equal(f.calls.some(call => call.operation === 'submit'), false);
  assert.equal(f.session.getState().draft, 'resume after upgrade');
  f.setSnapshot(snapshot({ historyState: 'ready', asOfSeq: 1 })); await f.session.refresh();
  assert.equal(await f.session.submit(), true);
});

test('confirmed cancellation of one turn does not hide queued work that already started', async () => {
  const cancel = deferred();
  const f = fixture({ handler: (call, current) => call.operation === 'cancel-turn' ? cancel.promise : current });
  f.setSnapshot(snapshot({ status: 'running', currentTurn: 1, turnStartSeq: 1, asOfSeq: 10, events: [{ type: 'turn/start', seq: 1, data: { turn: 1 } }] })); await f.connect();
  const operation = f.session.cancel(); await settle();
  f.setSnapshot(snapshot({ status: 'running', currentTurn: 2, turnStartSeq: 13, asOfSeq: 15, events: [
    { type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'aborted' } } },
    { type: 'turn/start', seq: 13, data: { turn: 2 } },
  ] }));
  await f.session.refresh();
  assert.equal(f.session.getState().cancelPhase, null);
  assert.equal(f.session.getState().view.status, 'running');
  assert.equal(f.session.getState().notice, '上一项任务已停止，助理正在处理后续任务。');
  cancel.resolve({ accepted: true }); await operation;
  assert.equal(f.session.getState().cancelPhase, null);
});

test('confirmation for an ended turn cannot stop the next turn', async () => {
  const confirm = deferred(), f = fixture();
  f.setSnapshot(snapshot({ status: 'running', currentTurn: 1, turnStartSeq: 1, asOfSeq: 10, events: [{ type: 'turn/start', seq: 1, data: { turn: 1 } }] })); await f.connect();
  const operation = f.session.cancel(() => confirm.promise);
  f.setSnapshot(snapshot({ status: 'running', currentTurn: 2, turnStartSeq: 13, asOfSeq: 15, events: [{ type: 'turn/start', seq: 13, data: { turn: 2 } }] }));
  await f.session.refresh(); confirm.resolve(true); await operation;
  assert.equal(f.calls.some(call => call.operation === 'cancel-turn'), false);
  assert.match(f.session.getState().notice, /状态已变化/);
});

test('identity events cannot overwrite another selected assistant', async () => {
  const f = fixture(); await f.connect('agent-b');
  f.session.updateIdentity({ assistantName: 'A' }, 'agent-a');
  assert.equal(f.session.getState().view.identity, undefined);
});

test('reconciling an earlier submission never clears a rejected cancellation warning', async () => {
  let readReceipt = false;
  const f = fixture({ handler: (call, current) => {
    if (call.operation === 'submit') throw new Error('Lost ACK');
    if (call.operation === 'cancel-turn') { readReceipt = true; return { accepted: false }; }
    return readReceipt ? { ...current, receipt: { accepted: true, requestId: 'request-1' } } : current;
  } });
  f.setSnapshot(snapshot({ status: 'running' })); await f.connect(); f.session.setDraft('one task');
  await f.session.submit(); await settle(); assert.ok(f.session.getState().pending);
  await f.session.cancel(); await settle();
  assert.equal(f.session.getState().pending.observed, true);
  assert.match(f.session.getState().error, /未接受停止请求/);
});

test('currentTurn metadata resolves an off-page cancelled task without claiming an unobserved cancelled result', async () => {
  const f = fixture();
  f.setSnapshot(snapshot({ status: 'running', currentTurn: 7, turnStartSeq: 1, asOfSeq: 1000, events: [] })); await f.connect();
  await f.session.cancel(); await settle();
  assert.equal(f.session.getState().cancelPhase, 'stopping');
  f.setSnapshot(snapshot({ status: 'running', currentTurn: 8, turnStartSeq: 1100, asOfSeq: 2000, events: [] }));
  await f.session.refresh();
  assert.equal(f.session.getState().cancelPhase, null);
  assert.equal(f.session.getState().notice, '上一项任务已结束，助理正在处理后续任务。');
  assert.doesNotMatch(f.session.getState().notice, /停止/);
});

test('rolling latest pages preserve viewed tail and expose any missing history for backfill', async () => {
  const f = fixture();
  f.setSnapshot(snapshot({ asOfSeq: 100, beforeSeq: 100, hasMore: true, messages: [{ id: 'm100', seq: 100, role: 'user', text: 'Seen tail' }], events: [{ type: 'user/message', seq: 100 }] }));
  await f.connect();
  f.setSnapshot(snapshot({ asOfSeq: 100, beforeSeq: 1, hasMore: false, messages: [{ id: 'm1', seq: 1, role: 'user', text: 'First' }], events: [{ type: 'user/message', seq: 1 }] }));
  await f.session.loadOlder();
  assert.equal(assistantTranscript(f.session.getState()).view.hasMore, false);
  f.setSnapshot(snapshot({ asOfSeq: 200, beforeSeq: 200, hasMore: true, messages: [{ id: 'm200', seq: 200, role: 'user', text: 'New tail' }], events: [{ type: 'user/message', seq: 200 }] }));
  await f.session.refresh();
  const transcript = assistantTranscript(f.session.getState());
  assert.deepEqual(transcript.messages.map(message => message.seq), [1, 100, 200]);
  assert.deepEqual(transcript.view.events.map(event => event.seq), [1, 100, 200]);
  assert.equal(f.session.getState().olderHasMore, true);
  assert.equal(f.session.getState().olderCursor, 200);
  f.setSnapshot(snapshot({ asOfSeq: 200, beforeSeq: 1, hasMore: false, messages: [{ id: 'm150', seq: 150, role: 'user', text: 'Backfilled' }] }));
  await f.session.loadOlder();
  assert.deepEqual(assistantTranscript(f.session.getState()).messages.map(message => message.seq), [1, 100, 150, 200]);
  assert.equal(assistantTranscript(f.session.getState()).view.hasMore, false);
});

test('old-cloud retry text alone cannot retry an unrelated manual task after scheduled failure', async () => {
  const f = fixture();
  f.setSnapshot(snapshot({ status: 'failed', asOfSeq: 50, capabilities: undefined, retry: { text: 'Unrelated most recent manual task' },
    messages: [{ id: 'manual', role: 'user', seq: 1, text: 'Unrelated most recent manual task' }, { id: 'timer', role: 'user', source: 'schedule', seq: 40, text: 'Scheduled failure' }] }));
  await f.connect();
  assert.equal(assistantRetryAvailable(f.session.getState().view), false);
  assert.equal(await f.session.retry(), false);
  assert.equal(f.calls.some(call => call.operation === 'submit'), false);
  f.session.setDraft('A new manual request'); assert.equal(await f.session.submit(), true);
});

test('stop requires scoped capability and sends the exact native turn identity without legacy fallback', async () => {
  const f = fixture(); f.setSnapshot(snapshot({ status: 'running', currentTurn: 7, turnStartSeq: 42, asOfSeq: 56 })); await f.connect();
  await f.session.cancel();
  assert.deepEqual(f.calls.find(call => call.operation === 'cancel-turn').input, { turn: 7, turnStartSeq: 42 });
  assert.equal(f.calls.some(call => call.operation === 'cancel'), false);
  const old = fixture(); old.setSnapshot(snapshot({ status: 'running', capabilities: undefined })); await old.connect();
  assert.equal(assistantCancelAvailable(old.session.getState().view), false);
  assert.equal(await old.session.cancel(), false);
  assert.equal(old.calls.some(call => call.operation.startsWith('cancel')), false);
});

test('an old pagination response cannot hide a newly discovered rolling history gap', async () => {
  const older = deferred();
  const f = fixture({ handler: (call, current) => call.input.beforeSeq !== undefined ? older.promise : current });
  f.setSnapshot(snapshot({ asOfSeq: 100, beforeSeq: 100, hasMore: true, messages: [{ id: '100', seq: 100, role: 'user', text: '100' }] })); await f.connect();
  const loading = f.session.loadOlder();
  f.setSnapshot(snapshot({ asOfSeq: 200, beforeSeq: 200, hasMore: true, messages: [{ id: '200', seq: 200, role: 'user', text: '200' }] })); await f.session.refresh();
  older.resolve(snapshot({ beforeSeq: 0, hasMore: false, messages: [{ id: '0', seq: 0, role: 'user', text: '0' }] })); await loading;
  assert.equal(f.session.getState().olderCursor, 200);
  assert.equal(f.session.getState().olderHasMore, true);
  assert.deepEqual(assistantTranscript(f.session.getState()).messages.map(message => message.seq), [0, 100, 200]);
});

test('turn-changed cancellation is rejected without claiming stopping or attempting legacy cancel', async () => {
  const f = fixture({ handler: (call, current) => call.operation === 'cancel-turn' ? { accepted: false, reason: 'turn-changed' } : current });
  f.setSnapshot(snapshot({ status: 'running' })); await f.connect();
  assert.equal(await f.session.cancel(), false); await settle();
  assert.equal(f.session.getState().cancelPhase, null);
  assert.match(f.session.getState().error, /未停止其他任务/);
  assert.equal(f.calls.filter(call => call.operation.startsWith('cancel')).length, 1);
  assert.equal(f.calls.some(call => call.operation === 'cancel'), false);
});

test('retry proof must be complete and within the authoritative snapshot cut', () => {
  const base = snapshot({ status: 'failed', asOfSeq: 10, capabilities: { history: { nativeEvents: true } }, retry: { requestId: 'r', turn: 1, endSeq: 8, text: 'Exact task' } });
  assert.equal(assistantRetryAvailable(base), true);
  for (const retry of [{ text: 'Exact task' }, { ...base.retry, requestId: '' }, { ...base.retry, endSeq: 11 }, { ...base.retry, turn: null }]) {
    assert.equal(assistantRetryAvailable({ ...base, retry }), false);
  }
});

const attachmentSnapshot = (extra = {}) => snapshot({ capabilities: { input: { attachments: true, images: true, files: true } }, ...extra });
const uploaded = (kind = 'image', name = 'diagram.png', bytes = 4) => ({ kind, receiptId: 'upload-receipt', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name, bytes }, ...(kind === 'image' ? { mediaType: 'image/png' } : {}) });
const picture = { name: 'diagram.png', size: 4, type: 'image/png' };
function attachmentFixture({ readAttachment = async () => 'YWJjZA==', handler } = {}) {
  const f = fixture({ readAttachment, handler: (call, current) => handler ? handler(call, current)
    : call.operation === 'attachment-upload' ? uploaded(call.input.kind, call.input.name, 4)
      : call.operation === 'submit' ? { accepted: true, requestId: call.input.requestId } : current });
  f.setSnapshot(attachmentSnapshot());
  return f;
}

test('image-only uploads persist receipts, block partial submission, and send receipt-only content', async () => {
  const upload = deferred(); let reportProgress;
  const f = attachmentFixture({ readAttachment: async (_file, { onProgress }) => { reportProgress = onProgress; onProgress(37); return 'YWJjZA=='; },
    handler: (call, current) => call.operation === 'attachment-upload' ? upload.promise : call.operation === 'submit' ? { accepted: true, requestId: call.input.requestId } : current });
  await f.connect(); assert.equal(f.session.addAttachments([picture]), true);
  assert.equal(f.session.getState().attachments[0].progress, 37);
  await settle(); assert.equal(f.session.getState().attachments[0].status, 'uploading');
  assert.equal(await f.session.submit(), false); assert.equal(f.values.size, 0);
  upload.resolve(uploaded()); await settle();
  assert.equal(f.session.getState().attachments[0].status, 'ready');
  assert.equal([...f.values.values()].some(value => value.includes('YWJjZA==')), false);
  assert.equal(await f.session.submit(), true); await settle();
  const sent = f.calls.find(call => call.operation === 'submit').input;
  assert.deepEqual(sent.content, [{ type: 'image', receiptId: 'upload-receipt', mediaType: 'image/png', name: 'diagram.png' }]);
  assert.equal(sent.text, undefined); assert.equal(sent.attachments, undefined);
  assert.deepEqual(f.session.getState().attachments, []);
  assert.equal(assistantTranscript(f.session.getState()).messages[0].attachments[0].attachment.name, 'diagram.png');
  reportProgress(99); assert.deepEqual(f.session.getState().attachments, []);
});

test('mixed attachment unknown ACK replays the complete immutable content and request ID after reconnect', async () => {
  let attempts = 0, uploads = 0;
  const f = attachmentFixture({ handler: (call, current) => {
    if (call.operation === 'attachment-upload') return { ...uploaded(call.input.kind, call.input.name), receiptId: `receipt-${++uploads}` };
    if (call.operation === 'submit') { if (++attempts === 1) throw Error('Lost ACK'); return { accepted: true, requestId: call.input.requestId }; }
    return current;
  } });
  await f.connect(); f.session.setDraft('Compare both'); f.session.addAttachments([picture, { name: 'notes.txt', size: 4, type: 'text/plain' }]); await settle();
  assert.equal(await f.session.submit(), false); await settle();
  const journal = JSON.parse(f.values.get('agentkit.assistant.pending.agent-a'));
  assert.deepEqual(journal.content.map(part => part.type), ['text', 'image', 'file']);
  assert.equal(JSON.stringify([...f.values.values()]).includes('YWJjZA=='), false);
  f.session.disconnect(); await f.connect();
  assert.equal(f.session.getState().attachments.length, 2);
  assert.equal(await f.session.submit(), true);
  const submissions = f.calls.filter(call => call.operation === 'submit');
  assert.deepEqual(submissions[0].input, submissions[1].input);
  assert.equal(f.calls.filter(call => call.operation === 'attachment-upload').length, 2);
});

test('cancel and remove abort upload transport, ignore late receipts, and never cancel cloud tasks', async () => {
  const upload = deferred(), f = attachmentFixture({ handler: (call, current) => call.operation === 'attachment-upload' ? upload.promise : current });
  await f.connect(); f.session.addAttachments([picture]); await settle();
  const call = f.calls.find(call => call.operation === 'attachment-upload');
  f.session.cancelUpload('upload-1'); assert.equal(call.signal.aborted, true);
  assert.equal(f.session.getState().attachments[0].status, 'cancelled');
  upload.resolve(uploaded()); await settle();
  assert.equal(f.session.getState().attachments[0].receiptId, undefined);
  f.session.removeAttachment('upload-1'); assert.deepEqual(f.session.getState().attachments, []);
  assert.equal(f.calls.some(call => call.operation.startsWith('cancel')), false);
  assert.equal(f.values.get('agentkit.assistant.attachments.agent-a'), '[]');
});

test('cancel during local read prevents upload and retry can use the still-selected file', async () => {
  const reading = deferred(); let reads = 0, signal;
  const f = attachmentFixture({ readAttachment: (_file, options) => { signal = options.signal; return ++reads === 1 ? reading.promise : Promise.resolve('YWJjZA=='); } });
  await f.connect(); f.session.addAttachments([picture]); f.session.cancelUpload('upload-1');
  assert.equal(signal.aborted, true); reading.resolve('YWJjZA=='); await settle();
  assert.equal(f.calls.some(call => call.operation === 'attachment-upload'), false);
  assert.equal(await f.session.retryUpload('upload-1'), true);
  assert.equal(f.session.getState().attachments[0].status, 'ready');
});

test('failed upload keeps its row and can retry without persisting selected bytes', async () => {
  let attempt = 0;
  const f = attachmentFixture({ handler: (call, current) => {
    if (call.operation !== 'attachment-upload') return current;
    if (++attempt === 1) throw Error('Upload unavailable');
    return uploaded();
  } });
  await f.connect(); f.session.addAttachments([picture]); await settle();
  assert.equal(f.session.getState().attachments[0].status, 'failed');
  assert.equal(await f.session.submit(), false);
  assert.equal(await f.session.retryUpload('upload-1'), true);
  assert.equal(f.session.getState().attachments[0].status, 'ready');
});

test('agent switch isolates a late upload and restores ready receipts only to their original assistant', async () => {
  const late = deferred(); let count = 0;
  const f = attachmentFixture({ handler: (call, current) => call.operation === 'attachment-upload' ? ++count === 1 ? uploaded() : late.promise : current });
  await f.connect(); f.session.addAttachments([picture]); await settle();
  f.session.addAttachments([{ ...picture, name: 'late.png' }]); await settle();
  await f.connect('agent-b');
  late.resolve({ ...uploaded('image', 'late.png'), receiptId: 'late-receipt' }); await settle();
  assert.deepEqual(f.session.getState().attachments, []);
  assert.equal(f.values.has('agentkit.assistant.attachments.agent-b'), false);
  await f.connect('agent-a'); assert.equal(f.session.getState().attachments.length, 1);
  assert.equal(f.session.getState().attachments[0].receiptId, 'upload-receipt');
});

test('unsupported and oversized attachments fail before reading or transmitting any bytes', async () => {
  let reads = 0;
  const f = attachmentFixture({ readAttachment: async () => { reads++; return 'YWJjZA=='; } }); await f.connect();
  assert.equal(f.session.addAttachments([{ ...picture, type: 'image/svg+xml' }, { ...picture, size: 21 * 1024 * 1024 }]), false);
  assert.equal(reads, 0); assert.match(f.session.getState().attachmentError, /格式.*大小/);
  f.setSnapshot(attachmentSnapshot({ capabilities: { input: { attachments: true, images: true, files: true, limits: { maxAttachments: 1 } } } })); await f.session.refresh();
  f.session.addAttachments([picture, picture]); await settle();
  assert.equal(reads, 1); assert.match(f.session.getState().attachmentError, /上限/);
  f.session.removeAttachment('upload-1'); f.setSnapshot(snapshot()); await f.session.refresh();
  assert.equal(f.session.addAttachments([picture]), false);
});

test('invalid cloud attachment receipts cannot become durable composer references', async () => {
  const f = attachmentFixture({ handler: (call, current) => call.operation === 'attachment-upload' ? { ...uploaded(), attachment: { attachmentId: '/local/private.png', name: 'private.png', bytes: 4 } } : current });
  await f.connect(); f.session.addAttachments([picture]); await settle();
  assert.equal(f.session.getState().attachments[0].status, 'failed');
  assert.equal(f.values.has('agentkit.assistant.attachments.agent-a'), false);
});

test('expired attachment recovery is explicit and unavailable for unknown submission outcomes', async () => {
  let expired = false;
  const f = attachmentFixture({ handler: (call, current) => {
    if (call.operation === 'attachment-upload') return uploaded();
    if (call.operation === 'submit') throw Object.assign(Error('Unavailable'), { code: expired ? 'ASSISTANT_ATTACHMENT_EXPIRED' : 'NETWORK_ERROR' });
    return current;
  } });
  await f.connect(); f.session.setDraft('Keep the instructions'); f.session.addAttachments([picture]); await settle();
  await f.session.submit(); await settle();
  assert.equal(f.session.replaceExpiredAttachments(), false);
  expired = true; await f.session.submit(); await settle();
  assert.equal(f.session.getState().errorKind, 'attachment-expired');
  assert.equal(f.session.replaceExpiredAttachments(), true);
  assert.equal(f.session.getState().pending, null); assert.deepEqual(f.session.getState().attachments, []);
  assert.equal(f.session.getState().draft, 'Keep the instructions');
  assert.equal(f.values.has('agentkit.assistant.pending.agent-a'), false);
});

const liveApproval = (patch = {}) => ({ kind: 'approval', requestId: 'approval-one', generation: 'host-generation', hostId: 'cloud-host', sessionId: 'cloud-session', turn: 1, turnStartSeq: 0, toolName: 'write_report', presentation: 'Save the report', canAllow: true, expiresAt: Date.now() + 60000, choices: ['allowed-once', 'rejected'], ...patch });
const approvalSnapshot = (request = liveApproval(), patch = {}) => snapshot({ status: 'running', currentTurn: 1, turnStartSeq: 0, pendingInteractions: [request], capabilities: { approval: { interactive: true } }, ...patch });
test('approval decisions require current live scope and never derive authorization from history', async () => {
  const request = liveApproval();
  const f = fixture({ handler: (call, current) => call.operation === 'approval-decide' ? { accepted: true, outcome: call.input.decision } : current });
  f.setSnapshot(approvalSnapshot(request, { capabilities: { approval: { interactive: false } } })); await f.connect();
  assert.equal(await f.session.decideApproval(request, 'allowed-once'), false);
  f.setSnapshot(approvalSnapshot(request, { pendingInteractions: [], events: [{ type: 'approval/asked', seq: 1, data: request }] })); await f.session.refresh();
  assert.equal(await f.session.decideApproval(request, 'allowed-once'), false);
  f.setSnapshot(approvalSnapshot(request)); await f.session.refresh();
  assert.equal(await f.session.decideApproval({ ...request, generation: 'old' }, 'allowed-once'), false);
  assert.equal(await f.session.decideApproval(request, 'allowed-always'), false);
  assert.equal(await f.session.decideApproval(request, 'allowed-once'), true);
  assert.deepEqual(f.calls.find(call => call.operation === 'approval-decide').input, { requestId: request.requestId, generation: request.generation, hostId: request.hostId, sessionId: request.sessionId, turn: 1, turnStartSeq: 0, decision: 'allowed-once' });
  assert.equal(await f.session.decideApproval(request, 'allowed-once'), false);
  assert.equal(f.session.getState().view.status, 'running'); assert.match(f.session.getState().notice, /执行结果请查看/);
});

test('missing approval details allow rejection only and expired or advanced-turn requests cannot be answered', async () => {
  const request = liveApproval({ canAllow: false, choices: ['rejected'], presentation: 'No operation details' });
  const f = fixture({ handler: (call, current) => call.operation === 'approval-decide' ? { accepted: true, outcome: call.input.decision } : current });
  f.setSnapshot(approvalSnapshot(request)); await f.connect();
  assert.equal(await f.session.decideApproval(request, 'allowed-once'), false);
  assert.equal(await f.session.decideApproval(request, 'rejected'), true);
  f.setSnapshot(approvalSnapshot(liveApproval({ expiresAt: Date.now() - 1 }))); await f.session.refresh();
  assert.equal(await f.session.decideApproval(liveApproval(), 'allowed-once'), false);
  f.setSnapshot(approvalSnapshot(liveApproval(), { currentTurn: 2, turnStartSeq: 99 })); await f.session.refresh();
  assert.equal(await f.session.decideApproval(liveApproval(), 'allowed-once'), false);
  assert.equal(f.calls.filter(call => call.operation === 'approval-decide').length, 1);
});

test('an approval ACK after an agent switch cannot overwrite the new assistant or release its operation', async () => {
  const approval = deferred(), submit = deferred(), request = liveApproval();
  const f = fixture({ handler: (call, current) => call.operation === 'approval-decide' ? approval.promise : call.operation === 'submit' ? submit.promise : current });
  f.setSnapshot(approvalSnapshot(request)); await f.connect();
  const first = f.session.decideApproval(request, 'allowed-once');
  await f.connect('agent-b'); f.session.setDraft('B task'); const second = f.session.submit();
  approval.resolve({ accepted: true, outcome: 'allowed-once' }); assert.equal(await first, false);
  assert.equal(f.session.getState().busyOperation, 'submit'); assert.equal(f.session.getState().approvalDecision, null);
  submit.resolve({ accepted: true, requestId: 'request-1' }); await second;
});

test('unknown approval outcomes remain visible until a new snapshot resolves the live request', async () => {
  const request = liveApproval();
  const f = fixture({ handler: (call, current) => { if (call.operation === 'approval-decide') throw Error('Connection lost'); return current; } });
  f.setSnapshot(approvalSnapshot(request)); await f.connect();
  assert.equal(await f.session.decideApproval(request, 'rejected'), false); await settle();
  assert.match(f.session.getState().error, /审批结果尚未确认/);
  f.setSnapshot(approvalSnapshot(request, { pendingInteractions: [] })); await f.session.refresh();
  assert.equal(f.session.getState().approvalDecision, null); assert.equal(f.session.getState().error, '');
  assert.equal(f.session.getState().notice, '该审批已结束，请查看云端后续记录。');
});

test('failed receipt or draft cleanup retains the original journal even after a durable ACK', async () => {
  const f = attachmentFixture(); await f.connect(); f.session.setDraft('Safe cleanup'); f.session.addAttachments([picture]); await settle();
  const setItem = f.storage.setItem;
  f.storage.setItem = (key, value) => { if (key.startsWith('agentkit.assistant.attachments.') && value === '[]') throw Error('Locked'); setItem(key, value); };
  assert.equal(await f.session.submit(), true); await settle();
  assert.equal(f.session.getState().pending.requestId, 'request-1');
  assert.match(f.session.getState().error, /草稿未能清理/);
  assert.equal(JSON.parse(f.values.get('agentkit.assistant.pending.agent-a')).requestId, 'request-1');
  f.storage.setItem = setItem; assert.equal(await f.session.submit(), true);
  assert.deepEqual(f.calls.filter(call => call.operation === 'submit').map(call => call.input.requestId), ['request-1', 'request-1']);
  assert.equal(f.values.has('agentkit.assistant.pending.agent-a'), false);
});

test('malformed or inline-byte recovery journals block new request IDs and retain the original record', async () => {
  for (const raw of ['not-json', JSON.stringify({ requestId: 'existing-request', content: [{ type: 'image', mediaType: 'image/png', data: 'encoded-private' }] })]) {
    const f = fixture(); f.values.set('agentkit.assistant.pending.agent-a', raw); await f.connect(); f.session.setDraft('New text');
    assert.equal(f.session.getState().pendingInvalid, true); assert.match(f.session.getState().error, /暂停发送/);
    assert.equal(await f.session.submit(), false); assert.equal(f.calls.some(call => call.operation === 'submit'), false);
    assert.equal(f.values.get('agentkit.assistant.pending.agent-a'), raw);
    f.values.set('agentkit.assistant.pending.agent-a', JSON.stringify({ requestId: 'existing-request', text: 'Recovered exact task' }));
    await f.session.refresh(); assert.equal(f.session.getState().pendingInvalid, false);
    assert.equal(await f.session.submit(), true);
    assert.equal(f.calls.find(call => call.operation === 'submit').input.requestId, 'existing-request');
  }
});

test('advertised native image byte and media limits are enforced before upload', async () => {
  const f = attachmentFixture();
  f.setSnapshot(attachmentSnapshot({ capabilities: { input: { attachments: true, images: true, files: true, maxImageBytes: 3, imageMediaTypes: ['image/png'] } } }));
  await f.connect();
  assert.equal(f.session.addAttachments([picture, { name: 'image.gif', size: 2, type: 'image/gif' }]), false);
  assert.match(f.session.getState().attachmentError, /大小.*格式/);
  assert.equal(f.calls.some(call => call.operation === 'attachment-upload'), false);
});

test('new pure-text requests use full content on capable clouds while legacy journals replay unchanged', async () => {
  const f = fixture(); f.setSnapshot(snapshot({ capabilities: { input: { content: true } } })); await f.connect();
  f.session.setDraft('Bind the timezone'); assert.equal(await f.session.submit(), true);
  assert.deepEqual(f.calls.find(call => call.operation === 'submit').input, { requestId: 'request-1', timezone: 'Etc/UTC', content: [{ type: 'text', text: 'Bind the timezone' }] });
  f.values.set('agentkit.assistant.pending.agent-a', JSON.stringify({ requestId: 'legacy-pending', text: 'Legacy exact task', timezone: 'Etc/UTC' }));
  await f.connect(); assert.equal(await f.session.submit(), true);
  assert.deepEqual(f.calls.filter(call => call.operation === 'submit').at(-1).input, { requestId: 'legacy-pending', timezone: 'Etc/UTC', text: 'Legacy exact task' });
});
