import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTaskTimeline } from '../src/host/task-timeline.mjs';
import { installNativeCommandPane } from '../src/host/native-command-pane.mjs';
import { installNativeChildPane } from '../src/host/native-child-pane.mjs';
import { createNativeChildPanel } from '../src/host/native-run-panel.mjs';

function host() {
  const slots = new Map(), tabs = new Map(), cleanups = [], opened = [], eventSource = {};
  const context = { theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
    on: () => () => {}, sessions: { binding: () => ({ eventSource }) },
    effect: install => { const cleanup = install(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    sidebarRight: { openTab: (kind, options) => opened.push({ kind, ...options }) },
    sidebarRightTabs: { register: definition => { tabs.set(definition.id, definition); return () => tabs.delete(definition.id); } },
    slots: {
      register: (definition, component) => { const key = definition.name + ':' + (definition.key ?? 'primary');
        slots.set(key, { definition, component }); return () => slots.delete(key); },
      inject: (_name, install) => { const cleanup = install(); if (typeof cleanup === 'function') cleanups.push(cleanup);
        return typeof cleanup === 'function' ? cleanup : () => {}; },
    } };
  return { context, slots, tabs, opened, eventSource, close() { for (const cleanup of cleanups.reverse()) cleanup(); } };
}

test('the npm installer binds the host event source and releases the primary seat without product imports', () => {
  const h = host();
  installTaskTimeline(h.context, { ui: { React, ReactDOM }, hostRemote: {}, resolveAgentFromPreset: () => 'agent' });
  const seat = h.slots.get('conversation.chat.presentation:primary');
  assert.equal(typeof seat.component, 'function');
  assert.equal(seat.definition.inject('session').hooks.harnessEvents, h.eventSource);
  h.close(); assert.equal(h.slots.size, 0); assert.equal(h.tabs.size, 0);
});

test('a cold Native conversation shows an explicit loading route instead of briefly rendering the foreign transcript', () => {
  const h = host();
  installTaskTimeline(h.context, { ui: { React, ReactDOM }, hostRemote: {}, resolveAgentFromPreset: () => 'agent' });
  const View = h.slots.get('conversation.chat.presentation:primary').component;
  const html = renderToStaticMarkup(React.createElement(View, { sessionId: 'session', cwd: '/work',
    useHarnessEvents: select => select({ revision: 0, entries: [] }),
    useSession: select => select({ running: false, pendingSubmissions: [] }),
    useProjection: key => key === 'agentPreset' ? 'native' : undefined,
    useSessions: select => select({ byId: { session: { projectionValues: { agentPreset: 'native' } } } }),
    fallback: React.createElement('p', null, 'Foreign transcript'), openFile() {},
  }));
  assert.match(html, /task-runtime-loading/); assert.doesNotMatch(html, /Foreign transcript/);
  h.close();
});

test('terminal and child sidebars retain original identities and dispose every registration without executing a task', () => {
  const h = host();
  const remote = new Proxy({}, { get: (_target, key) => () => assert.fail(`Opening a pane must not execute ${String(key)}`) });
  const commands = installNativeCommandPane(h.context, { React, hostRemote: remote });
  const children = installNativeChildPane(h.context, { React, hostRemote: remote, labels: {}, renderText: text => text });
  commands.open({ agentId: 'agent', sessionId: 'parent-session', id: 'owned-command' });
  children.bindHost({ agentId: 'agent', parentSessionId: 'parent-session' }, { cwd: '/work', children: [] });
  children.open({ agentId: 'agent', parentSessionId: 'parent-session', parentRunId: 'original-parent',
    runId: 'owned-child', sessionId: 'child-session', role: 'reader' });
  children.openDirectory({ agentId: 'agent', parentSessionId: 'parent-session' });
  assert.equal(h.opened[0].params.id, 'owned-command');
  assert.equal(h.opened[1].params.parentRunId, 'original-parent');
  assert.equal(h.opened[1].params.sessionId, 'child-session');
  assert.ok(h.slots.size > 0); assert.equal(h.tabs.size, 3);
  h.close(); assert.equal(h.slots.size, 0); assert.equal(h.tabs.size, 0);
});

test('product preset mapping is a required host port, never inferred by the reusable task UI', () => {
  assert.throws(() => installTaskTimeline(host().context, { ui: { React, ReactDOM }, hostRemote: {} }), /resolver is required/);
  assert.throws(() => createNativeChildPanel({ ui: { React }, hostRemote: {} }), /resolver is required/);
});
