import test from 'node:test';
import assert from 'node:assert/strict';
import { browserResponseGroups } from '../src/browser-response-groups.mjs';
import { activityGroups, activityGroupSummary } from '../src/activity-groups.mjs';
import { initialState, reduce } from '../src/reducer.mjs';
import { normalizeEvent } from '../src/protocol.mjs';
import { buildViewModel } from '../src/view.mjs';
import { findAllByTestId, findByTestId, textOf } from './helpers.mjs';

const browser = (id, responseId, status = 'completed') => ({ kind: 'tool', callId: id,
  name: 'browser_inspect_workspace', input: { entry: 'index.html' }, status, ...(responseId ? { responseId } : {}) });
const text = (id, responseId, streaming = false) => ({ kind: 'text', id, text: id, responseId, streaming });
const thought = (id, responseId) => ({ kind: 'thought', id, text: id, responseId });

test('pure browser responses fold reasoning, prose and calls in original order; the final answer stays outside', () => {
  const items = [thought('inspect first', 'r1'), text('open page', 'r1'), browser('navigate', 'r1'),
    thought('inspect again', 'r2'), text('check result', 'r2'), browser('screenshot', 'r2'), text('Final answer', 'r3')];
  const before = structuredClone(items), groups = browserResponseGroups(items, { stageTailIsRunning: true });
  assert.equal(groups.length, 2); assert.equal(groups[0].family, 'browser');
  assert.deepEqual(groups[0].events, items.slice(0, -1));
  assert.deepEqual(groups[0].children.map(item => item.callId), ['navigate', 'screenshot']);
  assert.equal(groups[0].active, false); assert.equal(groups[1], items.at(-1));
  assert.deepEqual(items, before, 'grouping is a read-only view');
});

test('mixed tool responses keep prose outside and produce independent stable browser stages', () => {
  const shell = { ...browser('shell', 'mixed'), name: 'run_command', input: { command: 'npm test' } };
  const items = [text('prose', 'mixed'), browser('before', 'mixed'), shell, browser('after', 'mixed')];
  const groups = browserResponseGroups(items, { stageTailIsRunning: true });
  assert.equal(groups[0], items[0]); assert.equal(groups[2], shell);
  assert.equal(groups[1].active, false); assert.equal(groups[3].active, true);
  assert.notEqual(groups[1].id, groups[3].id);
  assert.deepEqual(groups.map(item => item.id), browserResponseGroups(items).map(item => item.id));
});

test('unclassified streaming responses remain in place until actual tool facts arrive', () => {
  const prefix = browser('first', 'r1'), pending = text('streaming prose', 'r2', true), reasoning = thought('thinking', 'r2');
  const live = browserResponseGroups([prefix, reasoning, pending], { stageTailIsRunning: true });
  assert.equal(live[0].active, true); assert.equal(live[1], reasoning); assert.equal(live[2], pending);
  const classified = browserResponseGroups([prefix, reasoning, pending, browser('second', 'r2')], { stageTailIsRunning: true });
  assert.equal(classified.length, 1); assert.equal(classified[0].id, live[0].id);
  assert.deepEqual(classified[0].events, [prefix, reasoning, pending, browser('second', 'r2')]);
  assert.equal(browserResponseGroups([prefix, { ...pending, streaming: false }], { stageTailIsRunning: true })[0].active, false);
});

test('legacy content is not attributed to nearby browser responses; markers never become browser evidence', () => {
  const a = browser('a'), b = browser('b'), legacyThought = thought('legacy'), marker = { kind: 'context-marker', id: 'compact' };
  const groups = browserResponseGroups([a, legacyThought, marker, b], { stageTailIsRunning: true });
  assert.equal(groups[1], legacyThought); assert.equal(groups[2], marker);
  assert.deepEqual(groups[0].events, [a, b]); assert.equal(groups[0].active, true);
  const final = text('legacy final');
  assert.equal(browserResponseGroups([a, final, b]).length, 3);
  const child = { ...browser('child', 'c'), child: { runId: 'child-run' } };
  assert.equal(browserResponseGroups([a, child, b])[1], child);
});

test('response keys survive argument drafts becoming committed calls without inventing execution status', () => {
  const draft = { kind: 'tool-preview', id: 'draft', responseId: 'r1', name: 'browser_inspect_workspace', input: {}, streaming: true };
  const live = browserResponseGroups([draft], { stageTailIsRunning: true })[0];
  const done = browserResponseGroups([browser('actual-call', 'r1')])[0];
  assert.equal(live.id, done.id); assert.equal(live.active, true); assert.equal(done.active, false);
  assert.equal(draft.status, undefined); assert.equal(draft.callId, undefined);
  const failed = browserResponseGroups([browser('failed', 'r1', 'failed'), browser('unknown', 'r2', 'uncertain')])[0];
  assert.deepEqual(activityGroupSummary(failed, 'zh-CN'), { title: '浏览器', detail: '2 次调用, 1 失败, 1 待核对' });
});

test('browser response bodies use the same text, reasoning and tool renderers without recursive regrouping', () => {
  const items = [thought('Actual reasoning', 'r1'), text('Actual narrative', 'r1'), browser('call', 'r1')];
  const group = activityGroups(items)[0];
  const tree = buildViewModel({ ...initialState(), taskState: 'running', items }, {
    locale: 'zh-CN', toolOpen: new Map([[group.id, true]]) });
  assert.equal(findAllByTestId(tree, 'activity-group').length, 1);
  assert.equal(findAllByTestId(tree, 'tool-block').length, 1);
  assert.equal(findAllByTestId(tree, 'thought-block').length, 1);
  assert.match(textOf(tree), /Actual narrative/);
  assert.equal(findByTestId(tree, 'activity-details').props.open, true);
});

test('presentation lineage is optional, bounded, and survives late schedules without reopening results', () => {
  for (const responseId of [undefined, '', {}, 'x'.repeat(1025)]) {
    const event = normalizeEvent({ v: 1, id: 'a', type: 'text.delta', itemId: 'text', delta: 'value', responseId });
    assert.equal(Object.hasOwn(event, 'responseId'), false);
  }
  const events = [
    { type: 'text.delta', itemId: 'text', delta: 'value', responseId: 'response' },
    { type: 'text.done', itemId: 'text', text: 'value' },
    { type: 'thinking.delta', itemId: 'thought', delta: 'reason', responseId: 'response' },
    { type: 'thinking.done', itemId: 'thought', text: 'reason' },
    { type: 'tool.result', callId: 'browser', result: 'observed' },
    { type: 'tool.scheduled', callId: 'browser', name: 'browser_inspect_workspace', input: {}, responseId: 'response' },
  ];
  const state = events.reduce((s, event, index) => reduce(s, { v: 1, id: String(index), ...event }), initialState());
  assert.deepEqual(state.items.map(item => item.responseId), ['response', 'response', 'response']);
  assert.equal(state.items.at(-1).status, 'completed'); assert.equal(state.items.at(-1).result, 'observed');
});
