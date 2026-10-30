import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHarnessComponents, resolveVerticalMaskState } from '../src/react-binding.mjs';
import { createToolInspector } from '../src/inspector.mjs';
import { initialState, reduceAll } from '../src/reducer.mjs';
const { HarnessTimeline } = createHarnessComponents(React);
const state = events => reduceAll(initialState(), events.map((event, i) => ({ v: 1, id: String(i), ...event })));

test('unchanged scroll masks retain state identity instead of scheduling a render loop', () => {
  const previous = { showTop: true, showBottom: true };
  assert.equal(resolveVerticalMaskState({ clientHeight: 100, scrollHeight: 500, scrollTop: 100 }, previous), previous);
  assert.deepEqual(resolveVerticalMaskState({ clientHeight: 500, scrollHeight: 500, scrollTop: 0 }, previous), { showTop: false, showBottom: false });
});

test('tool argument drafts have no execution row, applied diff or successful result', () => {
  const value = state([{ type: 'task.started', taskId: 'preview' },
    { type: 'tool.preview', previewId: 'preview:attempt:0', name: 'write_workspace_file', input: { path: 'draft.mjs', content: 'unfinished code' }, receivedChars: 42 }]);
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, styleSheet: null }));
  assert.match(html, /data-uncommitted="true"/); assert.match(html, /unfinished code/);
  assert.doesNotMatch(html, /data-testid="tool-block"|data-testid="edit-diff"|data-status="completed"/);
});

test('static file reads expose errors without redundant detail or disclosure buttons', () => {
  const value = state([{ type: 'task.started', taskId: 'read' },
    { type: 'tool.scheduled', callId: 'r', name: 'read_workspace_file', input: { path: 'missing.txt' } },
    { type: 'tool.error', callId: 'r', error: 'File was not found' }]);
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, styleSheet: null, onInspectTool() {} }));
  assert.match(html, /File was not found/); assert.doesNotMatch(html, /data-action="inspect-tool"/);
  assert.doesNotMatch(html, /<summary/);
});

test('the independent inspector renders only the selected observation and redacts structured secrets', () => {
  const ToolInspector = createToolInspector(React);
  const html = renderToStaticMarkup(React.createElement(ToolInspector, { item: { name: 'read', callId: 'r', status: 'completed',
    input: { path: 'sample.txt', apiKey: 'do-not-display' }, result: '{"value":"accepted observation","token":"also-secret"}' }, onClose() {} }));
  assert.match(html, /accepted observation/); assert.match(html, /sample.txt/);
  assert.doesNotMatch(html, /do-not-display|also-secret/);
});
