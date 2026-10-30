import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialState, reduceAll } from '../src/reducer.mjs';
import { createHarnessComponents } from '../src/react-binding.mjs';
const { HarnessTimeline, SubagentPane } = createHarnessComponents(React);
const call = { type: 'tool.scheduled', callId: 'parent-call', name: 'native_start_child', input: { role: 'reader', task: 'Read the source' } };
const child = { type: 'subagent.bound', callId: 'parent-call', child: { runId: 'child', sessionId: 'child-session', parentRunId: 'parent', role: 'reader', title: 'Read the source', phase: 'requesting_model' } };
const state = events => reduceAll(initialState(), events.map((e, i) => ({ v: 1, id: String(i), ...e })));
test('a child tool is one row and opens its authenticated child session without a detail button', () => {
  const value = state([{ type: 'task.started', taskId: 'parent' }, child, call]);
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, onOpenSubagent() {}, styleSheet: null }));
  assert.match(html, /data-action="open-subagent"/); assert.match(html, /reader/); assert.match(html, /Read the source/);
  assert.doesNotMatch(html, /<summary|查看详情|Inspect|harness-tool-status-scheduled/);
  assert.equal(value.items[0].child.runId, 'child');
  const unbound = state([call]);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(HarnessTimeline, { state: unbound, onOpenSubagent() {}, styleSheet: null })), /data-action="open-subagent"/);
});
test('parent completion is not reopened by a child still running in the background', () => {
  const value = state([call, { type: 'tool.result', callId: 'parent-call', result: 'started' }, child]);
  assert.equal(value.items[0].status, 'completed');
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, styleSheet: null }));
  assert.doesNotMatch(html, /harness-tool-title-streaming|data-status="running"/);
});
test('the independent child pane is read only and ordinary completion adds no status row', () => {
  const value = state([{ type: 'task.started', taskId: 'child' }, { type: 'text.done', itemId: 'answer', text: 'Observed child answer' },
    { type: 'task.finished', outcome: 'unverified', verificationRequired: false }]);
  const html = renderToStaticMarkup(React.createElement(SubagentPane, { state: value, styleSheet: null }));
  assert.match(html, /aria-readonly="true"/); assert.match(html, /Observed child answer/);
  assert.doesNotMatch(html, /status-line|contenteditable|<textarea|type="submit"/);
});
