import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createHarnessComponents } from '@kingsoftcloud/agentkit-harness-ui/react-binding';
import { createSessionTaskProjector } from '@kingsoftcloud/agentkit-harness-ui/host/session-task-events';

const { HarnessTimeline } = createHarnessComponents(React);
const entry = (seq, type, data) => ({ type: 'event', event: { seq, type, time: 1000 + seq,
  data: { turn: 1, step: 1, ...data } } });
const initial = [entry(1, 'turn/start', {}), entry(2, 'assistant/live-chunk', {
  attemptId: 'attempt', chunk: { type: 'reasoning-delta', index: 0, text: '实际浏览器思考' } }),
entry(3, 'assistant/live-chunk', { attemptId: 'attempt', chunk: { type: 'text-delta', index: 1, text: '实际浏览器说明' } }),
entry(4, 'assistant/live-chunk', { attemptId: 'attempt', chunk: { type: 'tool-call-delta', index: 2,
  name: 'browser_inspect_workspace', argumentsDelta: '{"entry":"index.html"}' } })];
const committed = [entry(5, 'assistant/message', { message: { id: 'message-1', content: [
  { type: 'reasoning', text: '实际浏览器思考' }, { type: 'text', text: '实际浏览器说明' },
  { type: 'tool-call', id: 'browser-call', name: 'browser_inspect_workspace', arguments: '{"entry":"index.html"}' }] } }),
entry(6, 'tool/call', { callId: 'browser-call', name: 'browser_inspect_workspace', arguments: '{"entry":"index.html"}' }),
entry(7, 'tool/result', { message: { toolCallId: 'browser-call', content: [{ type: 'text', text: '实际观察结果' }] } })];
const final = [entry(8, 'assistant/message', { step: 2, message: { id: 'final', content: [{ type: 'text', text: '最终交付答复' }] } }),
entry(9, 'turn/end', { step: 2, reason: { kind: 'completed' } })];
function App() {
  const [phase, setPhase] = React.useState(0), [epoch, setEpoch] = React.useState(0);
  const projector = React.useMemo(() => createSessionTaskProjector({ sessionId: 'fixture' }), [epoch]);
  const entries = [...initial, ...(phase > 0 ? committed : []), ...(phase > 1 ? final : [])];
  const state = projector.project({ revision: phase + 1, entries, change: { kind: 'replace', entries } })[0].state;
  return React.createElement(React.Fragment, null,
    React.createElement('nav', null,
      React.createElement('button', { onClick: () => setPhase(1) }, '提交工具'),
      React.createElement('button', { onClick: () => setPhase(2) }, '完成本轮'),
      React.createElement('button', { onClick: () => setEpoch(value => value + 1) }, '冷回放')),
    React.createElement(HarnessTimeline, { key: epoch, state, locale: 'zh-CN' }));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
