import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeA2aTaskState } from '../src/client/state/native-a2a.mjs';
import { createNativeA2aPanel } from '../src/client/dsh/native-a2a.mjs';
import { createNativeRecoveryState } from '../src/client/state/native-recovery.mjs';
import { createStudioHostRemote } from '../src/host-remote.mjs';
import { createProductClient } from '../src/remote/control-client.mjs';

const task = { agentId: 'agent', sessionId: 'session', runId: 'run', operationKey: 'operation', callId: 'call' };
const response = (input, extra = {}) => ({ contract: 'agentkit.studio-a2a-task-control/v1', bindingDigest: 'b'.repeat(64),
  operation_locator: { scope: { agentId: task.agentId }, ...Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'agentId')) },
  task_id: 'a2a-task-original', remote_task_id: 'remote-original', remote_context_id: 'context-original',
  state: 'input_required', phase: 'paused', pauseDigest: 'a'.repeat(64), pause: { parts: [{ text: '请输入答案' }] },
  commandId: input.commandId, outcome: input.kind === 'get' ? 'observed' : 'unknown', ...extra });

test('UI refresh is read-only and a lost continuation reply retains exactly the original input and command', async () => {
  const calls = []; let lost = true;
  const state = createNativeA2aTaskState({ task, commandId: () => 'fixed', hostRemote: {
    controlNativeA2aTask: async input => { calls.push(structuredClone(input));
      if (input.kind !== 'get' && lost) { lost = false; throw Error('lost'); }
      return response(input, input.kind === 'get' ? {} : { outcome: 'submitted', state: 'completed', pauseDigest: null }); },
  } });
  await state.refresh(); assert.deepEqual(calls.map(row => row.kind), ['get']);
  const parts = [{ data: { answer: 42 } }]; await state.continue(parts); parts[0].data.answer = 100;
  assert.equal(state.getSnapshot().pending.parts[0].data.answer, 42);
  await state.refresh(); assert.deepEqual(calls.map(row => row.kind), ['get', 'continue', 'get']);
  await state.retry(); assert.deepEqual(calls[1], calls[3]); assert.equal(state.getSnapshot().pending, null);
  await state.cancel(); assert.equal(calls.length, 4, 'terminal observations cannot start another effect'); state.dispose();
});
test('unknown control stays pending until a read confirms terminal or a different remote question', async () => {
  const calls = []; let nextPause = 'a'.repeat(64);
  const state = createNativeA2aTaskState({ task, hostRemote: { controlNativeA2aTask: async input => {
    calls.push(input.kind); return response(input, { pauseDigest: nextPause });
  } } });
  await state.refresh(); await state.continue([{ text: 'answer' }]); assert.ok(state.getSnapshot().pending);
  await state.continue([{ text: 'unsafe new answer' }]); assert.equal(calls.length, 2);
  await state.refresh(); assert.ok(state.getSnapshot().pending);
  nextPause = 'c'.repeat(64); await state.refresh(); assert.equal(state.getSnapshot().pending, null);
  assert.equal(state.getSnapshot().outcome, 'unknown', 'a new observation does not claim the previous delivery succeeded'); state.dispose();
});
for (const code of ['A2A_CONTINUATION_DEADLINE_EXCEEDED', 'A2A_CONTROL_PERMISSION_DENIED']) test(`UI ${code} releases a rejected command and leaves explicit remote cancellation available`, async () => {
  const calls = [];
  const state = createNativeA2aTaskState({ task, hostRemote: { controlNativeA2aTask: async input => {
    calls.push(input.kind); if (input.kind === 'continue') throw Object.assign(new Error('not dispatched'), { code });
    return response(input, input.kind === 'cancel' ? { state: 'cancelled', outcome: 'remote_cancelled', pauseDigest: null } : {});
  } } });
  await state.refresh(); await state.continue([{ text: 'input' }]); assert.equal(state.getSnapshot().pending, null);
  assert.match(state.getSnapshot().error, /未执行/); assert.deepEqual(calls, ['get', 'continue']);
  await state.cancel(); assert.deepEqual(calls, ['get', 'continue', 'cancel']); state.dispose();
});
test('a foreign task, changed binding or command cannot replace the accepted remote state', async () => {
  let alter = value => value;
  const state = createNativeA2aTaskState({ task, hostRemote: { controlNativeA2aTask: async input => alter(response(input)) } });
  await state.refresh(); const accepted = state.getSnapshot().task;
  for (const mutation of [value => { value.operation_locator.runId = 'other'; }, value => { value.bindingDigest = 'c'.repeat(64); },
    value => { value.commandId = 'different'; }, value => { value.contract = 'future/v2'; }]) {
    alter = value => { mutation(value); return value; }; await state.refresh();
    assert.equal(state.getSnapshot().task, accepted); assert.match(state.getSnapshot().error, /核对失败/);
  }
  state.dispose();
});
test('disposing a task aborts the call and suppresses late responses and sends', async () => {
  let resolve, signal, calls = 0;
  const state = createNativeA2aTaskState({ task, hostRemote: { controlNativeA2aTask: (input, current) => {
    calls++; signal = current; return new Promise(done => { resolve = () => done(response(input)); });
  } } });
  const read = state.refresh(); state.dispose(); resolve(); await read; await state.cancel(); await state.retry();
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(state.getSnapshot().task, null);
});
test('recovery inventory rejects task locators belonging to a different Run', async () => {
  const valid = { contract: 'agentkit.studio-native-recovery/v1', agentId: 'agent', sessionId: 'session', runId: 'run',
    state: 'reconciliation_required', canResume: false, a2aTasks: [{ runId: 'run', operationKey: 'operation', callId: 'call' }] };
  let value = structuredClone(valid);
  const state = createNativeRecoveryState({ hostRemote: { nativeRecoveryStatus: async () => value }, agentId: 'agent', sessionId: 'session' });
  await state.refresh(); value = { ...valid, a2aTasks: [{ ...valid.a2aTasks[0], runId: 'other' }] }; await state.refresh();
  assert.deepEqual(state.getSnapshot().status, valid); assert.match(state.getSnapshot().error, /读取失败/); state.dispose();
});
for (const [name, create] of [
  ['browser', connection => createProductClient(connection, { window: { location: { origin: 'http://localhost', hash: '' } } })],
  ['Node', connection => createStudioHostRemote({ connection })],
]) test(`${name} A2A control uses authenticated RPC and carries AbortSignal outside JSON`, async () => {
  const calls = [], signal = new AbortController().signal;
  const remote = create({ rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: response(args[2]) }; } } });
  const input = { ...task, kind: 'get', commandId: 'one' };
  await remote.controlNativeA2aTask(input, signal);
  assert.deepEqual(calls, [['/agentkit', 'sessions/native-a2a-control', input, signal]]);
});
test('HTTP compatibility facade retains authenticated A2A command envelope and cancellation', async () => {
  const calls = [], signal = new AbortController().signal;
  const remote = createStudioHostRemote({ baseUrl: 'http://localhost', sessionToken: 'session-token', csrfToken: 'csrf-token',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ result: { ok: true, value: response(JSON.parse(init.body).payload) } })); } });
  const input = { ...task, kind: 'get', commandId: 'one' }; await remote.controlNativeA2aTask(input, signal);
  assert.equal(calls[0].url, 'http://localhost/agentkit'); assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.headers.get('X-AgentKit-Session'), 'session-token'); assert.equal(calls[0].init.headers.get('X-CSRF-Token'), 'csrf-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { method: 'sessions/native-a2a-control', payload: input });
});
test('rendered task panel offers explicit inspection, structured input and original-command confirmation', async () => {
  // Deterministic hook harness, not a browser/Electron rendering claim.
  const slots = [], effects = []; let index = 0, dirty = false, calls = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useEffect(effect, deps) { const i = index++; if (!slots[i] || deps.some((value, j) => value !== slots[i][j])) { slots[i] = deps; effects.push(effect); } } };
  const Panel = createNativeA2aPanel({ React, buttonStyle: () => ({}), hostRemote: { controlNativeA2aTask: async input => {
    calls.push(structuredClone(input)); return response(input);
  } } });
  const render = () => { let tree; do { dirty = false; index = 0; tree = Panel({ task }); for (const effect of effects.splice(0)) effect(); } while (dirty); return tree; };
  const find = (tree, predicate) => { if (!tree || typeof tree !== 'object') return null;
    if (predicate(tree)) return tree; for (const child of tree.children ?? []) { const found = find(child, predicate); if (found) return found; } return null; };
  const button = (tree, label) => find(tree, node => node.type === 'button' && node.children.includes(label));
  let tree = render(); assert.equal(calls.length, 0); button(tree, '核对远端任务').props.onClick(); await new Promise(resolve => setImmediate(resolve));
  tree = render(); assert.ok(button(tree, '提交补充输入')); assert.ok(button(tree, '请求远端取消'));
  find(tree, node => node.type === 'input').props.onChange({ target: { checked: true } });
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: '{"answer":42}' } });
  tree = render(); button(tree, '提交补充输入').props.onClick(); await new Promise(resolve => setImmediate(resolve));
  tree = render(); assert.equal(calls[1].json, '{"answer":42}'); assert.ok(button(tree, '确认原操作回执'));
  assert.equal(button(tree, '请求远端取消').props.disabled, true);
});
