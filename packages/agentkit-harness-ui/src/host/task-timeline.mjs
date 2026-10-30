import { installNativeChildPane } from './native-child-pane.mjs';
import { installNativeCommandPane } from './native-command-pane.mjs';
import { createHarnessComponents } from '@kingsoftcloud/agentkit-harness-ui/react-binding';
import { createMarkdownComponents, markdownStyles } from '@kingsoftcloud/agentkit-harness-ui/markdown';
import { createStatusPanelComponents, statusPanelStyles } from '@kingsoftcloud/agentkit-harness-ui/status-panel';
import { nativeStatusPanelModel } from './state/native-status-panel.mjs';
import { nativeTaskWorkspaceRoot, taskWorkspaceFileTarget } from './state/task-links.mjs';
import { resolveNativeRuntimeRoute, nativeRuntimeRouteInput } from './state/native-runtime-route.mjs';
import { createNativeTaskReadModel } from './state/native-task-read-model.mjs';
import { createSessionTaskProjector, nativeTaskState, nativeStatusForTurn, bindNativeSubagents, nativeHistoricalToolState } from './session-task-events.mjs';

const labels = { result: '执行结果', thought: '思考', running: '执行中', thinking: '思考中…', ended: '本轮已结束', contextRunning: '正在压缩上下文', contextCompleted: '上下文已自动压缩',
  contextFailed: '上下文压缩失败', contextInterrupted: '上下文压缩已中断', contextNoop: '上下文已是最新，无需压缩', interrupted: '任务已中断', recovered: '已恢复',
  failed: '任务失败', completed: '已完成', cancelled: '已停止', blocked: '任务受阻', unverified: '已结束，结果未验证',
  waiting: '等待确认或回执', paused: '已暂停', toolScheduled: '排队中', toolRunning: '执行中', toolCompleted: '已返回',
  toolFailed: '执行失败', toolUncertain: '执行结果未知', toolNotDispatched: '未执行', jumpLatest: '回到最新',
  readKind: '读取', readReading: '读取中', listKind: '列出文件', listSearching: '列出文件中', searchKind: '搜索', searchSearching: '搜索中',
  searchListIn: '目录 {cwd}', searchFindQuery: '查找 {query}', searchList: '列出文件', searchFind: '查找',
  copy: '复制', openFile: '打开文件', openTerminal: '查看终端输出', noOutput: '没有输出', inspect: '查看详情',
  expandCommand: '展开命令', collapseCommand: '收起命令',
  toolDetails: '工具详情', close: '关闭', state: '状态', arguments: '调用参数', noSettledResult: '尚无已确认的结果', appliedChanges: '实际文件变更',
  diffTruncated: '差异预览已截断', diffUnavailable: '无可用差异预览', diffFilesOmitted: '个文件预览已省略', plan: '计划',
  writePending: '请求写入', editPending: '请求修改',
  subagent: '子智能体', openSubagent: '在右侧打开', childSyncing: '同步中', childOmitted: '当前显示过程窗口，较早内容或较长字段已省略。',
  toolPreparing: '正在生成工具参数', previewStopped: '工具参数生成已中断' };

/** Only the transport adapter and runtime controls belong to Studio. */
export function installTaskTimeline(ctx, { ui, hostRemote, resolveAgentFromPreset }) {
  if (typeof resolveAgentFromPreset !== 'function') throw TypeError('The host preset-to-Agent resolver is required');
  const { React, ReactDOM } = ui;
  const { createElement: h, useMemo, useEffect, useLayoutEffect, useState, useRef } = React;
  const { HarnessTimeline } = createHarnessComponents(React);
  const { ConversationStatusPanel } = createStatusPanelComponents(React, ReactDOM);
  const { MarkdownResponse } = createMarkdownComponents(React, ReactDOM);
  const commandPane = installNativeCommandPane(ctx, { React, hostRemote });
  const childPane = installNativeChildPane(ctx, { React, hostRemote, labels, theme: 'system',
    renderText: (text, { streaming, cwd, onOpenFile }) => h(MarkdownResponse, { streaming, theme: ctx.theme.getTheme().active.colorScheme,
      onOpenExternalUrl: url => { if (['http:', 'https:'].includes(new URL(url).protocol)) window.open(url, '_blank', 'noopener,noreferrer'); },
      onOpenFileLink: onOpenFile && (({ href }) => { const target = taskWorkspaceFileTarget(href, cwd); if (target) onOpenFile(target); }) }, text) });
  const markdownLabels = { copyCode: '复制代码', copied: '已复制', wrapLines: '自动换行', languageLabel: '代码' };
  function TaskView({ sessionId, useHarnessEvents, useSession, useSessions, useProjection, cwd, openFile, fallback, statusPanel }) {
    const [variant, setVariant] = useState(() => {
      try { const saved = localStorage.getItem('native.status-panel.variant'); return ['auto', 'mini', 'panel'].includes(saved) ? saved : 'auto'; }
      catch { return 'auto'; }
    });
    const [theme, setTheme] = useState(() => ctx.theme.getTheme());
    useEffect(() => ctx.on('theme/change', setTheme), []);
    const eventWindow = useHarnessEvents(value => value);
    const running = useSession(value => value.running);
    const pending = useSession(value => value.pendingSubmissions);
    const openState = useSession(value => value.openState);
    const session = useSessions(value => value.byId[sessionId]);
    const projection = useSessions(value => value.projectionsBySession?.[sessionId]);
    const boundPresetId = useProjection('agentPreset');
    const { presetId, ready: routeReady } = nativeRuntimeRouteInput(session, openState, projection, boundPresetId);
    const routeKey = JSON.stringify([sessionId, presetId ?? null]);
    const [route, setRoute] = useState({ key: routeKey, kind: 'loading', agentId: null });
    const routeGeneration = useRef(0);
    const [routeAttempt, setRouteAttempt] = useState(0);
    const [projectionError, setProjectionError] = useState(null);
    const [commandObservations, setCommandObservations] = useState([]);
    const nativeAgent = route.key === routeKey && route.kind === 'native' ? route.agentId : null;
    const observationKey = JSON.stringify([routeKey, nativeAgent, route.generation ?? 0]);
    const readerRef = useRef(null), runningRef = useRef(running);runningRef.current = running;
    const [readFrame, setReadFrame] = useState(null), [localError, setError] = useState(null);
    const readSnapshot = readFrame?.key === observationKey ? readFrame.snapshot : null;
    const observation = readSnapshot?.observation;
    const status = observation?.status ?? null, childTasks = observation?.children ?? [];
    const error = localError ?? readSnapshot?.error;
    const projector = useMemo(() => createSessionTaskProjector({ sessionId }), [sessionId]);
    const tasks = useMemo(() => projector.project(eventWindow), [projector, eventWindow]);
    useEffect(() => {
      let active = true;
      setProjectionError(null);
      if (typeof ctx.sessions.refreshProjections !== 'function') setProjectionError('宿主尚未提供会话运行时确认接口');
      else void ctx.sessions.refreshProjections(sessionId).catch(failure => {
        if (active) setProjectionError(failure.message || '无法读取会话运行时');
      });
      return () => { active = false; };
    }, [sessionId, routeAttempt]);
    useEffect(() => {
      const controller = new AbortController();
      const generation = ++routeGeneration.current;
      setRoute({ key: routeKey, kind: 'loading', agentId: null, generation }); setError(null);
      if (routeReady) void resolveNativeRuntimeRoute({ hostRemote, presetId, resolveAgentFromPreset, signal: controller.signal })
        .then(next => { if (!controller.signal.aborted) setRoute({ ...next, key: routeKey, generation }); })
        .catch(failure => { if (!controller.signal.aborted) setRoute({ key: routeKey, kind: 'error', agentId: null, generation,
          error: failure.message || '无法读取当前会话的运行时' }); });
      return () => controller.abort();
    }, [routeKey, routeReady, routeAttempt]);
    useEffect(() => {
      if (!nativeAgent) return;
      const reader = createNativeTaskReadModel({ hostRemote, agentId: nativeAgent, sessionId });
      readerRef.current = reader;
      const publish = snapshot => setReadFrame({ key: observationKey, snapshot });
      publish(reader.getSnapshot());
      const unsubscribe = reader.subscribe(publish);
      const stop = reader.startPolling(() => runningRef.current ? 1500 : 3000);
      return () => { unsubscribe();stop();reader.dispose();if (readerRef.current === reader) readerRef.current = null; };
    }, [nativeAgent, sessionId, observationKey]);
    useEffect(() => {
      if (!nativeAgent || !observation) return;
      childPane.bindHost({ agentId: nativeAgent, parentSessionId: sessionId }, { cwd, openFile, children: childTasks });
      for (const task of childTasks) childPane.register({ agentId: nativeAgent, parentSessionId: sessionId,
        parentRunId: task.parentRunId, runId: task.childRunId, sessionId: task.sessionId, role: task.role, title: task.goalPreview });
    }, [childTasks, nativeAgent, sessionId, cwd, openFile, observation]);
    useEffect(() => {
      setCommandObservations([]);
      if (nativeAgent) return commandPane.subscribe({ agentId: nativeAgent, sessionId }, setCommandObservations);
    }, [nativeAgent, sessionId]);
    const panelModel = useMemo(() => nativeStatusPanelModel(status, childTasks, commandObservations), [status, childTasks, commandObservations]);
    useEffect(() => {
      if (nativeAgent) for (const terminal of panelModel.terminals)
        commandPane.register({ ...terminal, agentId: nativeAgent, sessionId });
    }, [nativeAgent, sessionId, panelModel.terminals]);
    const executionRoot = nativeTaskWorkspaceRoot(status, { agentId: nativeAgent, sessionId, fallback: cwd });
    const openWorkspaceFile = path => {
      const target = taskWorkspaceFileTarget(path, executionRoot);
      if (!target) { setError('文件链接不在执行工作区或位置无效'); return; }
      void Promise.resolve(openFile(target.path)).catch(failure => setError(failure.message || '无法打开文件'));
    };
    const panelVisible = nativeAgent && (panelModel.git || panelModel.plan || panelModel.agents.length || panelModel.terminals.length || panelModel.isRunning);
    useLayoutEffect(() => {
      // The presentation owns the summary seat while routing/loading too.
      // Lack of polled data is not permission to paint the resident Todo dock.
      const resident = route.key === routeKey && route.kind === 'other';
      statusPanel?.setLayout(resident ? null : panelVisible ? variant : 'mini');
      return () => statusPanel?.setLayout(null);
    }, [statusPanel, panelVisible, variant, routeKey, route.key, route.kind]);
    const openSubagent = target => {
      try { childPane.open({ ...target, agentId: nativeAgent, parentSessionId: sessionId }); }
      catch (failure) { setError(failure.message || '无法打开子会话'); }
    };
    const presented = tasks.map(task => ({ ...task, state: bindNativeSubagents(nativeHistoricalToolState(nativeStatusForTurn(status, task.turn)
      ? nativeTaskState(task.state, status, running) : task.state, status, task.turn, sessionId), childTasks) }));
    const resume = async () => {
      const reader = readerRef.current;
      try { setError(null); await hostRemote.resumeNativeRun({ agentId: nativeAgent, sessionId, runId: status.runId });await reader?.refresh({ fresh: true }); }
      catch (failure) { setError(failure.message || '原任务尚未恢复'); }
    };
    if (projectionError || ['error', 'migration-required'].includes(projection?.state)) return h('div', { role: 'alert', 'data-testid': 'task-runtime-error' },
      h('p', null, projectionError || (projection.state === 'migration-required' ? '会话元数据需要迁移，暂时无法确认运行时' : '无法读取会话运行时')),
      h('button', { type: 'button', onClick: () => setRouteAttempt(value => value + 1) }, '重试加载'));
    if (!routeReady || route.key !== routeKey || route.kind === 'loading') return h('div', { role: 'status', 'data-testid': 'task-runtime-loading' }, '正在加载任务过程…');
    if (route.kind === 'error') return h('div', { role: 'alert', 'data-testid': 'task-runtime-error' },
      h('p', null, route.error), h('button', { type: 'button', onClick: () => setRouteAttempt(value => value + 1) }, '重试加载'));
    if (route.kind === 'other') return fallback;
    if (!observation) return readSnapshot?.phase === 'error'
      ? h('div', { role: 'alert', 'data-testid': 'task-observation-error' }, h('p', null, readSnapshot.error),
        h('button', { type: 'button', onClick: () => void readerRef.current?.refresh() }, '重试加载任务过程'))
      : h('div', { role: 'status', 'data-testid': 'task-observation-loading' }, '正在同步任务过程…');
    return h('div', { 'data-testid': 'studio-task-timeline', style: { width: '100%', boxSizing: 'border-box', '--ui-font-size': 'var(--dsh-content-font-size, 14px)' } },
      h('style', { 'data-harness-markdown': true }, markdownStyles),
      statusPanel?.target ? ReactDOM.createPortal(h(React.Fragment, null,
        h('style', { 'data-harness-status-panel': true }, statusPanelStyles),
        h(ConversationStatusPanel, { model: panelModel, variant, theme: theme.active.colorScheme,
          onVariantChange: mode => { setVariant(mode); try { localStorage.setItem('native.status-panel.variant', mode); } catch {} },
          onOpenSubagent: openSubagent,
          onOpenTerminal: terminal => commandPane.open({ ...terminal, agentId: nativeAgent, sessionId }),
          onOpenSubagentDirectory: () => childPane.openDirectory({ agentId: nativeAgent, parentSessionId: sessionId }) })), statusPanel.target) : null,
      ...presented.map(({ turn, state }) => h(HarnessTimeline, { key: turn,
        state, labels, locale: 'zh-CN', showPlanDock: false, theme: theme.active.colorScheme,
        workspaceRoot: executionRoot,
        onOpenFile: ({ path }) => openWorkspaceFile(path),
        onOpenSubagent: openSubagent,
        onCopy: text => { void Promise.resolve().then(() => navigator.clipboard.writeText(text)).catch(() => setError('无法复制，请检查剪贴板权限')); },
        renderText: (text, { streaming }) => h(MarkdownResponse, { streaming, theme: theme.active.colorScheme, scopeKey: sessionId + ':' + executionRoot,
          labels: markdownLabels,
          onCopyCode: text => navigator.clipboard.writeText(text),
          onOpenExternalUrl: url => { if (['http:', 'https:'].includes(new URL(url).protocol)) window.open(url, '_blank', 'noopener,noreferrer'); },
          onOpenFileLink: ({ href }) => openWorkspaceFile(href) }, text) })),
      ...(pending ?? []).filter(item => item.placement === 'transcript').map(item => h('p', { key: item.requestId, 'aria-label': '待发送输入' }, item.text)),
      error ? h('p', { role: 'alert' }, error) : null,
      status?.canResume ? h('button', { type: 'button', onClick: () => void resume() }, '恢复原任务') : null);

  }
  ctx.slots.inject('conversation.chat.presentation', () => ctx.slots.register({
    name: 'conversation.chat.presentation',
    inject: sessionId => {
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw Error('Task timeline session is unavailable');
      return { hooks: { harnessEvents: binding.eventSource } };
    },
  }, TaskView));
}
