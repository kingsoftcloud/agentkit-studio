import { installNativeChildPane } from './native-child-pane.mjs';
import { installNativeCommandPane } from './native-command-pane.mjs';
import { createHarnessComponents } from '@kingsoftcloud/agentkit-harness-ui/react-binding';
import { createMarkdownComponents, markdownStyles } from '@kingsoftcloud/agentkit-harness-ui/markdown';
import { createStatusPanelComponents, statusPanelStyles } from '@kingsoftcloud/agentkit-harness-ui/status-panel';
import { nativeStatusPanelModel } from '../state/native-status-panel.mjs';
import { nativeTaskWorkspaceRoot, taskWorkspaceFileTarget } from '../state/task-links.mjs';
import { createSessionTaskProjector, nativeTaskState, nativeStatusForTurn, bindNativeSubagents, nativeHistoricalToolState } from './session-task-events.mjs';
import { agentFromSessionPreset } from '../state/conversation-agent.mjs';

const labels = { result: '执行结果', thought: '思考', running: '执行中', thinking: '思考中…', ended: '本轮已结束', contextRunning: '正在压缩上下文', contextCompleted: '上下文已自动压缩',
  contextFailed: '上下文压缩失败', contextInterrupted: '上下文压缩已中断', contextNoop: '上下文已是最新，无需压缩', interrupted: '任务已中断', recovered: '已恢复',
  failed: '任务失败', completed: '已完成', cancelled: '已停止', blocked: '任务受阻', unverified: '已结束，结果未验证',
  waiting: '等待确认或回执', paused: '已暂停', toolScheduled: '排队中', toolRunning: '执行中', toolCompleted: '已返回',
  toolFailed: '执行失败', toolUncertain: '执行结果未知', jumpLatest: '回到最新',
  readKind: '读取', readReading: '读取中', listKind: '列出文件', listSearching: '列出文件中', searchKind: '搜索', searchSearching: '搜索中',
  searchListIn: '目录 {cwd}', searchFindQuery: '查找 {query}', searchList: '列出文件', searchFind: '查找',
  copy: '复制', openFile: '打开文件', openTerminal: '查看终端输出', noOutput: '没有输出', inspect: '查看详情',
  expandCommand: '展开命令', collapseCommand: '收起命令',
  toolDetails: '工具详情', close: '关闭', state: '状态', arguments: '调用参数', noSettledResult: '尚无已确认的结果', appliedChanges: '实际文件变更',
  diffTruncated: '差异预览已截断', diffUnavailable: '无可用差异预览', diffFilesOmitted: '个文件预览已省略', plan: '计划',
  writePending: '请求写入', editPending: '请求修改',
  subagent: '子智能体', openSubagent: '在右侧打开', childSyncing: '同步中', childOmitted: '当前显示过程窗口，较早内容或较长字段已省略。',
  toolPreparing: '正在生成工具参数', previewStopped: '工具参数生成已中断', charactersReceived: '字符已接收', previewUncommitted: '尚未执行；这里展示模型生成中的参数草稿' };

/** Only the transport adapter and runtime controls belong to Studio. */
export function installTaskTimeline(ctx, { ui, hostRemote }) {
  const { React, ReactDOM } = ui;
  const { createElement: h, useMemo, useEffect, useState } = React;
  const { HarnessTimeline } = createHarnessComponents(React);
  const { ConversationStatusPanel } = createStatusPanelComponents(React, ReactDOM);
  const { MarkdownResponse } = createMarkdownComponents(React, ReactDOM);
  const commandPane = installNativeCommandPane(ctx, { React, hostRemote });
  const childPane = installNativeChildPane(ctx, { React, hostRemote, labels, theme: 'system',
    renderText: (text, { streaming, cwd, onOpenFile }) => h(MarkdownResponse, { streaming, theme: ctx.theme.getTheme().active.colorScheme,
      onOpenExternalUrl: url => { if (['http:', 'https:'].includes(new URL(url).protocol)) window.open(url, '_blank', 'noopener,noreferrer'); },
      onOpenFileLink: onOpenFile && (({ href }) => { const target = taskWorkspaceFileTarget(href, cwd); if (target) onOpenFile(target); }) }, text) });
  const markdownLabels = { copyCode: '复制代码', copied: '已复制', wrapLines: '自动换行', languageLabel: '代码' };
  function TaskView({ sessionId, useHarnessEvents, useSession, useSessions, cwd, openFile, fallback, statusPanel }) {
    const [variant, setVariant] = useState(() => {
      try { const saved = localStorage.getItem('native.status-panel.variant'); return ['auto', 'mini', 'panel'].includes(saved) ? saved : 'auto'; }
      catch { return 'auto'; }
    });
    const [theme, setTheme] = useState(() => ctx.theme.getTheme());
    useEffect(() => ctx.on('theme/change', setTheme), []);
    const eventWindow = useHarnessEvents(value => value);
    const running = useSession(value => value.running);
    const pending = useSession(value => value.pendingSubmissions);
    const presetId = useSessions(value => value.byId[sessionId]?.projectionValues?.agentPreset);
    const [childTasks, setChildTasks] = useState([]);
    const [commandObservations, setCommandObservations] = useState([]);
    const [nativeAgent, setNativeAgent] = useState(null), [status, setStatus] = useState(null), [error, setError] = useState(null);
    const projector = useMemo(() => createSessionTaskProjector({ sessionId }), [sessionId]);
    const tasks = useMemo(() => projector.project(eventWindow), [projector, eventWindow]);
    useEffect(() => {
      const controller = new AbortController(); setNativeAgent(null); setStatus(null); setChildTasks([]);
      void (async () => {
        const first = await hostRemote.agents({ source: 'local', pageSize: 100 }), items = [...first.items ?? []];
        for (let page = 2; !controller.signal.aborted && items.length < Number(first.total || 0); page++) {
          const next = await hostRemote.agents({ source: 'local', pageSize: 100, page });
          if (!next.items?.length) break; items.push(...next.items);
        }
        const id = agentFromSessionPreset(presetId, items);
        if (!controller.signal.aborted && items.find(item => item.metadata?.id === id)?.spec.runtime?.type === 'harness') setNativeAgent(id);
      })().catch(() => {});
      return () => controller.abort();
    }, [sessionId, presetId]);
    useEffect(() => {
      if (!nativeAgent) return;
      const controller = new AbortController(); let timer;
      const refresh = async () => {
        try {
          const next = await hostRemote.nativeRecoveryStatus({ agentId: nativeAgent, sessionId }, controller.signal);
          if (!controller.signal.aborted) { setStatus(next); setError(null); }
          const first = await hostRemote.nativeChildHistory({ agentId: nativeAgent, sessionId, limit: 64 }, controller.signal);
          const children = [...first.tasks];
          let offset = first.nextOffset;
          while (!controller.signal.aborted && offset < first.totalTasks) {
            const page = await hostRemote.nativeChildHistory({ agentId: nativeAgent, sessionId, limit: 64,
              offset, inventoryDigest: first.inventoryDigest }, controller.signal);
            if (page.inventoryDigest !== first.inventoryDigest || page.nextOffset <= offset) throw Error('子会话目录已变化');
            children.push(...page.tasks); offset = page.nextOffset;
          }
          if (!controller.signal.aborted) setChildTasks(children);
        } catch (failure) { if (!controller.signal.aborted) setError(failure.message || '无法读取运行状态'); }
        finally { if (!controller.signal.aborted) timer = setTimeout(refresh, running ? 1500 : 3000); }
      };
      void refresh();
      return () => { controller.abort(); clearTimeout(timer); };
    }, [nativeAgent, sessionId, running]);
    useEffect(() => {
      if (!nativeAgent) return;
      childPane.bindHost({ agentId: nativeAgent, parentSessionId: sessionId }, { cwd, openFile, children: childTasks });
      for (const task of childTasks) childPane.register({ agentId: nativeAgent, parentSessionId: sessionId,
        parentRunId: task.parentRunId, runId: task.childRunId, sessionId: task.sessionId, role: task.role, title: task.goalPreview });
    }, [childTasks, nativeAgent, sessionId, cwd, openFile]);
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
    useEffect(() => {
      statusPanel?.setLayout(panelVisible ? variant : null);
      return () => statusPanel?.setLayout(null);
    }, [statusPanel, panelVisible, variant]);
    const openSubagent = target => {
      try { childPane.open({ ...target, agentId: nativeAgent, parentSessionId: sessionId }); }
      catch (failure) { setError(failure.message || '无法打开子会话'); }
    };
    const presented = tasks.map(task => ({ ...task, state: bindNativeSubagents(nativeHistoricalToolState(nativeStatusForTurn(status, task.turn)
      ? nativeTaskState(task.state, status, running) : task.state, status, task.turn, sessionId), childTasks) }));
    const resume = async () => {
      try { setError(null); setStatus(await hostRemote.resumeNativeRun({ agentId: nativeAgent, sessionId, runId: status.runId })); }
      catch (failure) { setError(failure.message || '原任务尚未恢复'); }
    };
    if (!nativeAgent) return fallback;
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
        state, labels, theme: theme.active.colorScheme,
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
