import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHarnessComponents } from '../src/react-binding.mjs';
import { buildViewModel } from '../src/view.mjs';
import { visibleItems } from '../src/project.mjs';
import { initialState, reduce } from '../src/reducer.mjs';
import { findAllByTestId, findByTestId, textOf } from './helpers.mjs';
import { createSessionTaskProjector } from '../src/host/session-task-events.mjs';

const state = events => events.reduce((current, event, index) => reduce(current, { v: 1, id: String(index), ...event }), initialState());
const call = (callId, name, input = {}) => ({ type: 'tool.scheduled', callId, name, input });
const result = (callId, result = 'observed') => ({ type: 'tool.result', callId, result });
const labels = { thought: '思考', listKind: '列出文件', searchList: '列出文件', toolFailed: '执行失败' };
const options = { labels, locale: 'zh-CN' };

test('conversation placement hides internal success while keeping every event and surfacing internal failures', () => {
  const value = state([call('todo', 'TodoWrite'), result('todo'), call('environment', 'sandbox_status'), result('environment'),
    call('failed-probe', 'sandbox_status'), { type: 'tool.error', callId: 'failed-probe', error: '{"code":"policy_denied"}' },
    call('file', 'read_workspace_file', { path: 'README.md' }), result('file')]);
  assert.equal(value.items.filter(item => item.kind === 'tool').length, 4);
  assert.equal(visibleItems(value, { includeInternal: true }).length, 4);
  assert.deepEqual(visibleItems(value).map(item => item.callId), ['failed-probe', 'file']);
  const tree = buildViewModel(value, options);
  assert.equal(findAllByTestId(tree, 'tool-block').length, 2);
  assert.doesNotMatch(textOf(tree), /TodoWrite|sandbox_status/);
  assert.match(textOf(tree), /运行环境/);
});

test('one Chinese semantic title is used for Native task tools; unknown tools keep their real identity', () => {
  const value = state([call('list', 'list_workspace_files'), result('list'), call('search', 'web_search', { query: 'durable agents' }),
    result('search'), call('skill', 'Skill', { name: 'browser-use:control-browser' }), result('skill'),
    call('third-party', 'enterprise_custom_action'), result('third-party')]);
  const text = textOf(buildViewModel(value, options));
  assert.match(text, /网页搜索durable agents/); assert.match(text, /技能browser-use:control-browser/);
  assert.match(text, /enterprise_custom_action/);
  assert.equal(text.match(/列出文件/g)?.length, 1);
  for(const [name,title]of [['ArtifactList','查看产物'],['ArtifactRead','读取产物'],['ArtifactSearch','搜索产物'],['RespondToCoordinator','向主任务汇报']]) {
    const task=state([call('child-tool',name),result('child-tool')]);
    const text=textOf(buildViewModel(task,options));assert.match(text,new RegExp(title));assert.doesNotMatch(text,new RegExp(name));
  }
  const terminal=state([call('command','run_command',{command:'pwd'}),result('command')]);
  assert.equal(textOf(findByTestId(buildViewModel(terminal,options),'tool-title')),'终端');
  const fetch=state([call('fetch','web_fetch',{url:'https://example.invalid'}),result('fetch')]);
  assert.match(textOf(buildViewModel(fetch,options)),/网页抓取/);
});

test('real listing paths are scopes, never search queries or a repeated action label', () => {
  for (const input of [{ path: '.', recursive: true }, { path: '/' }, { cwd: '/repo/src' }]) {
    const value = state([call('list', 'list_workspace_files', input), result('list')]);
    const tree = buildViewModel(value, options);
    assert.equal(textOf(tree).match(/列出文件/g)?.length, 1);
    assert.equal(textOf(findByTestId(tree, 'search-primary')), input.path ?? input.cwd);
  }
  const value = state([call('search', 'search_workspace_files', { path: 'src', pattern: 'TODO' }), result('search')]);
  const primary = textOf(findByTestId(buildViewModel(value, options), 'search-primary'));
  assert.match(primary, /TODO/); assert.doesNotMatch(primary, /Find src/);
});

test('web and generic request details stay collapsed while running and remain explicitly inspectable', () => {
  for (const [name, input] of [['web_fetch', { url: 'https://example.invalid/source', max_chars: 10000 }],
    ['web_search', { query: 'agent runtime' }], ['custom_tool', { argument: 'value' }]]) {
    const value = state([call('request', name, input), { type: 'tool.started', callId: 'request' }]);
    const closed = findByTestId(buildViewModel(value, options), 'tool-details');
    assert.equal(closed.props.open, false);
    const open = findByTestId(buildViewModel(value, { ...options, toolOpen: new Map([['request', true]]) }), 'tool-details');
    assert.equal(open.props.open, true);
    assert.ok(findByTestId(open, 'tool-detail'));
  }
});

test('wire failures have a compact summary and expose the original bounded evidence only after row expansion', () => {
  const value = state([call('web', 'web_search'), { type: 'tool.error', callId: 'web',
    error: '{"code":"web_definition_mismatch","executed":false}' }]);
  const closed = buildViewModel(value, options);
  assert.match(textOf(closed), /接入配置不一致/); assert.doesNotMatch(textOf(closed), /web_definition_mismatch/);
  const open = buildViewModel(value, { ...options, toolOpen: new Map([['web', true]]) });
  assert.match(textOf(open), /web_definition_mismatch/);
  const failedRead = state([call('read', 'read_workspace_file', { path: 'missing.txt' }),
    { type: 'tool.error', callId: 'read', error: '{"code":"policy_denied"}' }]);
  assert.equal(findByTestId(buildViewModel(failedRead, options), 'tool-details').props.open, false);
  assert.match(textOf(buildViewModel(failedRead, { ...options, toolOpen: new Map([['read', true]]) })), /policy_denied/);
});

test('adjacent reasoning is one disclosure with complete source text; empty blocks never create repeated headings', () => {
  const value = state([{ type: 'thinking.done', itemId: 'first', text: 'Actual first observation' },
    { type: 'thinking.done', itemId: 'empty', text: '' },
    { type: 'thinking.delta', itemId: 'second', delta: 'Actual next step' }]);
  const projected = visibleItems(value);
  assert.equal(projected.length, 1); assert.equal(projected[0].streaming, true);
  assert.deepEqual(projected[0].memberIds, ['first', 'second']);
  assert.equal(projected[0].text, 'Actual first observation\n\nActual next step');
  const tree = buildViewModel(value, { ...options, thoughtOpen: new Map([['first', true]]) });
  assert.equal(findAllByTestId(tree, 'thought-block').length, 1);
  assert.match(textOf(tree), /Actual first observation/); assert.match(textOf(tree), /Actual next step/);
  assert.equal(value.items.length, 2);
});

test('the injected React component carries locale and panel placement through to the actual rendered UI', () => {
  const { HarnessTimeline } = createHarnessComponents(React);
  const value = state([call('web', 'web_search', { query: 'source' }), result('web'),
    { type: 'plan.updated', items: [{ id: 'task', content: 'Verify task', status: 'in_progress' }] }]);
  const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: value, ...options, showPlanDock: false, styleSheet: null }));
  assert.match(html, /网页搜索/); assert.doesNotMatch(html, /data-testid="plan-dock"/);
});

test('argument streams and committed calls share semantic presentation without conferring execution authority', () => {
  const { HarnessTimeline } = createHarnessComponents(React);
  const entry = (seq, type, data, transient = false) => ({ type: transient ? 'transient' : 'event',
    event: { seq, type, time: seq, data: { turn: 1, step: 1, ...data } } });
  for (const [name, input] of [['write_workspace_file', { path: 'game.js', content: 'UNCOMMITTED_CONTENT' }],
    ['run_command', { command: 'npm test' }], ['web_search', { query: 'agent runtime' }],
    ['read_workspace_file', { path: 'report.md' }], ['custom_tool', { query: 'source' }]]) {
    const projector = createSessionTaskProjector();
    const live = entry(1, 'assistant/live-chunk', { attemptId: 'attempt', chunk: { type: 'tool-call-delta',
      index: 0, name, argumentsDelta: JSON.stringify(input) } }, true);
    const draft = projector.project({ revision: 1, entries: [live] })[0].state;
    const tree = buildViewModel(draft, { ...options, onOpenFile() {}, onOpenTerminal() {}, onCopy() {} });
    const block = findByTestId(tree, 'tool-block');
    assert.equal(block.props['data-uncommitted'], 'true');
    assert.equal(block.props['data-call-id'], undefined);
    assert.equal(block.props['data-status'], undefined);
    assert.equal(block.props['data-streaming'], 'true');
    const html = renderToStaticMarkup(React.createElement(HarnessTimeline, { state: draft, ...options, styleSheet: null }));
    assert.doesNotMatch(html, /UNCOMMITTED_CONTENT|data-action=|characters received|Not executed|data-testid="tool-preview"/);
    assert.equal(findByTestId(tree, 'edit-diff'), null);
    assert.equal(findByTestId(tree, 'execute-exit'), null);
    const message = entry(2, 'assistant/message', { message: { content: [
      { type: 'tool-call', id: 'call', name, arguments: JSON.stringify(input) }] } });
    const call = entry(3, 'tool/call', { callId: 'call', name, arguments: JSON.stringify(input) });
    const committed = projector.project({ revision: 2, entries: [live, message, call] })[0].state;
    const accepted = buildViewModel(committed, options);
    assert.equal(findAllByTestId(accepted, 'tool-block').length, 1);
    const scheduled = findByTestId(accepted, 'tool-block');
    assert.equal(scheduled.props['data-renderer'], block.props['data-renderer']);
    assert.equal(textOf(findByTestId(accepted, 'tool-title')), textOf(findByTestId(tree, 'tool-title')));
    assert.equal(scheduled.props['data-uncommitted'], undefined);
    assert.equal(scheduled.props['data-status'], 'scheduled');
    assert.equal(findByTestId(accepted, 'edit-diff'), null);
    if (name === 'run_command') assert.equal(findByTestId(accepted, 'tool-details').props.open, false);
  }
});

test('internal argument drafts follow the same placement as their committed tools, with raw state retained', () => {
  const value = state(['TodoWrite', 'sandbox_status', 'declare_deliverables'].map((name, index) => ({
    type: 'tool.preview', previewId: `preview:${index}`, name, input: {}, receivedChars: 2 })));
  assert.equal(value.items.length, 3);
  assert.equal(visibleItems(value).length, 0);
  assert.equal(visibleItems(value, { includeInternal: true }).length, 3);
});
