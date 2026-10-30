import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialState, reduceAll } from '../src/reducer.mjs';
import { visibleItems } from '../src/project.mjs';
import { createHarnessComponents } from '../src/react-binding.mjs';
import { nativeContextMarkers } from '../../agentkit-harness-node/src/native/context-markers.mjs';
const { HarnessTimeline } = createHarnessComponents(React);
const marker = { id: 'compression', status: 'completed', origin: 'auto', after: { kind: 'message', id: 'response' } };
const events = [
  { type: 'task.started', taskId: 'task' },
  { type: 'text.done', itemId: 'before', sourceMessageId: 'response', text: 'Read observations' },
  { type: 'text.done', itemId: 'after', sourceMessageId: 'next', text: 'Task answer' },
  { type: 'context.marker', marker },
].map((event, index) => ({ v: 1, id: String(index), ...event }));
test('compaction is a one-line notice at the committed boundary, without a diagnostic panel', () => {
  const state = reduceAll(initialState(), events);
  assert.deepEqual(visibleItems(state).map(item => item.id), ['before', 'compression', 'after']);
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state, styleSheet: null,
    labels: { contextCompleted: '上下文已自动压缩' } }));
  assert.match(html, /上下文已自动压缩/); assert.doesNotMatch(html, /context-status|<details|tokens/);
  const next = reduceAll(state, [{ v: 1, id: 'new-status', type: 'context.marker', marker: { ...marker, status: 'failed' } }]);
  assert.equal(next.contextMarkers.length, 1); assert.equal(state.contextMarkers[0].status, 'completed');
});
test('missing history anchors are not relocated or rendered as fabricated latest events', () => {
  const state = reduceAll(initialState(), events.slice(0, 1).concat(events[3]));
  assert.equal(visibleItems(state).length, 0);
  const invalid = reduceAll(state, [{ v: 1, id: 'bad', type: 'context.marker', marker: { ...marker, status: 'success?' } }]);
  assert.equal(invalid, state);
});
test('only adoption completes a Native marker; multiple summary responses remain one compaction', () => {
  const record = { snapshot: { scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' }, runId: 'r', phase: 'compacting' }, events: [
    { eventId: 'model', kind: 'model.completed', payload: {} },
    { eventId: 'tool', kind: 'tool.completed', payload: { callId: 'read' } },
    { eventId: 'begin', kind: 'context.planned', payload: { action: 'compact', compactions: 0 } },
    { eventId: 'summary', kind: 'context.summary_completed', payload: { proposalAvailable: true } },
    { eventId: 'continue', kind: 'context.planned', payload: { action: 'compact', compactions: 0 } },
  ] };
  let markers = nativeContextMarkers(record, { driving: true });
  assert.equal(markers.length, 1); assert.equal(markers[0].status, 'running'); assert.equal(markers[0].after.kind, 'tool');
  assert.equal(nativeContextMarkers(record)[0].status, 'interrupted');
  record.events.push({ eventId: 'adopt', kind: 'context.planned', payload: { action: 'ready', compactions: 1 } });
  markers = nativeContextMarkers(record);
  assert.equal(markers.length, 1); assert.equal(markers[0].status, 'completed');
  assert.doesNotMatch(JSON.stringify(markers), /proposal|summary/);
});
