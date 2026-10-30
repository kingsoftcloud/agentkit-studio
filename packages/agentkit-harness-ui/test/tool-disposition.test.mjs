import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTaskProjector, nativeHistoricalToolState } from '../src/host/session-task-events.mjs';
import { initialState, reduce } from '../src/reducer.mjs';
import { buildViewModel } from '../src/view.mjs';
import { findAllByTestId, textOf } from './helpers.mjs';

const callId = 'ak-native-' + 'a'.repeat(64);
const fact = { contract: 'agentkit.native-tool-outcome/v1', sessionId: 'session', runId: 'run', turn: 1, callId, status: 'not_dispatched' };
const entry = (seq, type, data, extra = {}) => ({ type: 'event', event: { seq, type, time: 1000 + seq, data: { turn: 1, step: 1, ...data }, ...extra } });
const call = entry(1, 'tool/call', { callId, name: 'browser_inspect_workspace', arguments: '{"actions":[{"type":"click"}]}' });
const disposition = entry(2, 'agentkit-native/tool-outcome', fact, { ignorable: true });
const result = entry(3, 'tool/result', { message: { toolCallId: callId, isError: true,
  content: [{ type: 'text', text: '{"status":"not_dispatched","reason":"browser_context_invalidated","executed":false}' }] } });
const window = (revision, entries, delta) => ({ revision, entries, change: delta ? { kind: 'append', entries: delta } : { kind: 'replace', entries } });

test('the independent Native disposition is visible before the coarse SDK error and survives incremental/cold replay', () => {
  const projector = createSessionTaskProjector({ sessionId: 'session' });
  assert.equal(projector.project(window(1, [call]))[0].state.items[0].status, 'scheduled');
  const beforeResult = projector.project(window(2, [call, disposition], [disposition]))[0].state;
  assert.equal(beforeResult.items[0].status, 'not_dispatched');
  const warm = projector.project(window(3, [call, disposition, result], [result]))[0].state;
  assert.equal(warm.items[0].status, 'not_dispatched');
  const cold = createSessionTaskProjector({ sessionId: 'session' }).project(window(1, [call, disposition, result]))[0].state;
  assert.equal(cold.items[0].status, 'not_dispatched');
  const tree = buildViewModel(cold, { locale: 'zh-CN' });
  assert.match(textOf(tree), /未执行/);assert.doesNotMatch(textOf(tree), /failed|执行失败|工具调用失败/);
  assert.equal(findAllByTestId(tree, 'tool-error').length, 0);
});

test('Native disposition can enrich legacy results additively; body text and foreign facts cannot assert non-execution', () => {
  const raw = createSessionTaskProjector({ sessionId: 'session' }).project(window(1, [call, result]))[0].state;
  assert.equal(raw.items[0].status, 'failed');
  const late = { ...disposition, event: { ...disposition.event, seq: 4 } };
  const projected = createSessionTaskProjector({ sessionId: 'session' }).project(window(1, [call, result, late]))[0].state;
  assert.equal(projected.items[0].status, 'not_dispatched');
  const status = { uncertainTools: { contract: 'agentkit.native-session-tool-outcomes/v1', sessionId: 'session', facts: [fact] } };
  assert.equal(nativeHistoricalToolState(raw, status, 1, 'session').items[0].status, 'not_dispatched');
  assert.equal(raw.items[0].status, 'failed', 'legacy SDK facts are not rewritten');
  for (const mutate of [e => { e.event.ignorable = false; }, e => { e.event.data.sessionId = 'foreign'; }, e => { e.event.data.turn = 2; }, e => { e.event.data.callId = 'foreign-call'; }]) {
    const invalid = structuredClone(disposition);mutate(invalid);
    assert.equal(createSessionTaskProjector({ sessionId: 'session' }).project(window(1, [call, invalid, result]))[0].state.items[0].status, 'failed');
  }
});

test('late progress cannot reopen a definitively undispatched call', () => {
  let state = reduce(initialState(), { v: 1, id: 'call', type: 'tool.scheduled', callId, name: 'browser_inspect_workspace', input: {} });
  state = reduce(state, { v: 1, id: 'closed', type: 'tool.state', callId, status: 'not_dispatched' });
  for (const type of ['tool.started', 'tool.progress', 'tool.scheduled']) {
    state = reduce(state, { v: 1, id: type, type, callId, name: 'browser_inspect_workspace', input: {}, message: 'late' });
    assert.equal(state.items[0].status, 'not_dispatched');
  }
});
