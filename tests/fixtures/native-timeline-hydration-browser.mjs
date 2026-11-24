import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { installTaskTimeline } from '../../src/client/dsh/task-timeline.mjs';
import { installTaskTimeline as installRenderer } from '@kingsoftcloud/agentkit-harness-ui/host/task-timeline';

const gates = new Map(), slots = new Map();let current = 'alpha', failReads = false;
const localAgentId = 'ar-20261118155500-a1b2c3d4';
const presetId = new URLSearchParams(location.search).get('preset') ?? `agentkit-studio-agent-${localAgentId}-r1`;
const gate = () => { let resolve;const promise = new Promise(done => { resolve = done; });return { promise, resolve }; };
const data = sessionId => {
  if (!gates.has(sessionId)) gates.set(sessionId, { status: gate(), children: gate() });
  return gates.get(sessionId);
};
const runStatus = sessionId => ({ contract: 'agentkit.studio-native-recovery/v1', agentId: localAgentId, sessionId,
  runId: 'run-' + sessionId, presentationTurn: 1, state: 'closed', canResume: false, phase: 'failed', outcome: 'failed',
  error: { code: 'NATIVE_EXECUTION_NOT_COMPLETED', message: '模型响应未通过协议校验：' + sessionId } });
const directory = sessionId => ({ contract: 'agentkit.studio-native-child-history/v1', sessionId, runId: 'run-' + sessionId,
  inventoryDigest: 'a'.repeat(64), tasks: [], totalTasks: 0, offset: 0, nextOffset: 0, complete: true });
const context = { theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) }, on: () => () => {},
  sessions: { refreshProjections: async () => {}, binding: () => ({ eventSource: {} }) }, effect: install => install(),
  sidebarRight: { openTab() {} }, sidebarRightTabs: { register: () => () => {} },
  slots: { snapshot: name => [{ type: 'slot', name, kind: 'single' }], inject: (_name, install) => install(), register: (definition, component) => {
    const key = definition.name + ':' + (definition.key ?? 'primary');slots.set(key, component);return () => slots.delete(key);
  } } };
const hostRemote = {
  agents: async ({ source }) => {
    if (source !== 'local') throw Error('云端目录不可用');
    return { items: [{ metadata: { id: localAgentId }, spec: { runtime: { type: 'harness' } } }], total: 1 };
  },
  nativeRecoveryStatus: async ({ sessionId }) => {
    if (failReads) throw Error('private read failure');
    await data(sessionId).status.promise;return runStatus(sessionId);
  },
  nativeChildHistory: async ({ sessionId }) => { await data(sessionId).children.promise;return directory(sessionId); },
};
installTaskTimeline(context, { ui: { React, ReactDOM }, hostRemote }, installRenderer);
const View = slots.get('conversation.chat.presentation:primary');
const entry = (seq, type, payload) => ({ type: 'event', event: { seq, type, time: 1000 + seq, data: { turn: 1, step: 1, ...payload } } });
const windowFor = sessionId => ({ revision: 1, entries: [entry(1, 'turn/start', {}),
  entry(2, 'user/message', { id: 'input-' + sessionId, source: { kind: 'user' }, content: [{ type: 'text', text: '任务 ' + sessionId }] }),
  entry(3, 'assistant/message', { message: { id: 'answer-' + sessionId, content: [{ type: 'text', text: '本轮内容 ' + sessionId }] } }),
  entry(4, 'turn/end', { reason: { kind: 'error', error: { code: 'RAW_TRANSPORT', message: 'LEGACY_TRANSPORT_FOOTER' } } })] });
function App() {
  const [sessionId, setSessionId] = React.useState(current);
  const manager = { byId: { [sessionId]: {} }, projectionsBySession: { [sessionId]: { state: 'ready' } } };
  return React.createElement(React.Fragment, null,
    React.createElement('nav', null,
      React.createElement('button', { onClick: () => data(current).status.resolve() }, '释放运行状态'),
      React.createElement('button', { onClick: () => data(current).children.resolve() }, '释放子任务目录'),
      React.createElement('button', { onClick: () => { failReads = true; } }, '模拟同步失败'),
      React.createElement('button', { onClick: () => { failReads = false; } }, '恢复同步'),
      React.createElement('button', { onClick: () => { current = 'beta';setSessionId(current); } }, '切换会话'),
      React.createElement('button', { onClick: () => { data('alpha').status.resolve();data('alpha').children.resolve(); } }, '释放旧会话')),
    React.createElement('main', { id: 'presentation' }, React.createElement(View, { sessionId, cwd: '/fixture', openFile() {},
      useHarnessEvents: select => select(windowFor(sessionId)),
      useSession: select => select({ running: true, pendingSubmissions: [], openState: 'open' }),
      useSessions: select => select(manager), useProjection: () => presetId,
      fallback: React.createElement('p', null, 'FOREIGN_RENDERER') })),
    React.createElement('output', { id: 'legacy-paints' }, '0'));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
let oldPaints = 0, observingPresentation = false;
const paintObserver = new MutationObserver(() => {
  const presentation = document.getElementById('presentation');
  if (presentation && !observingPresentation) {
    paintObserver.disconnect();paintObserver.observe(presentation, { childList: true, subtree: true, characterData: true });
    observingPresentation = true;
  }
  const text = presentation?.textContent ?? '';
  if (/LEGACY_TRANSPORT_FOOTER|FOREIGN_RENDERER/.test(text)) {
    oldPaints++;document.getElementById('legacy-paints').textContent = String(oldPaints);
  }
});
paintObserver.observe(document.getElementById('root'), { childList: true, subtree: true, characterData: true });
