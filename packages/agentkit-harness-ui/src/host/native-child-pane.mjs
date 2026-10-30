import { createStatusPanelComponents } from '@kingsoftcloud/agentkit-harness-ui/status-panel';
import { nativeStatusPanelModel } from './state/native-status-panel.mjs';
import { createHarnessComponents } from '@kingsoftcloud/agentkit-harness-ui/react-binding';
import { nativeChildObservationState } from './state/native-child-observation.mjs';
import { installNativeChildFilePane } from './native-child-file-pane.mjs';

/** The Host owns docking only. Child content uses the same independent timeline. */
export function installNativeChildPane(ctx, { React, hostRemote, labels, renderText, theme }) {
  const { createElement: h, useEffect, useState } = React;
  const { SubagentPane } = createHarnessComponents(React);
  const { SubagentDirectory } = createStatusPanelComponents(React);
  const filePane = installNativeChildFilePane(ctx, { React, hostRemote });
  const releases = new Map(), hostBindings = new Map(), observers = new Map(), kindPrefix = 'agentkit-native-child-';
  const hostKey = target => JSON.stringify([target.agentId, target.parentSessionId]);
  function Body({ useTabInfo, target }) {
    const info = useTabInfo();
    const [view, setView] = useState(null), [error, setError] = useState('');
    const [activeTheme, setActiveTheme] = useState(() => ctx.theme.getTheme().active.colorScheme);
    useEffect(() => ctx.on('theme/change', next => setActiveTheme(next.active.colorScheme)), []);
    useEffect(() => {
      if (!info.tab.visible || !target) return;
      const controller = new AbortController(); let timer, terminal = false;
      const read = async () => {
        try {
          const detail = await hostRemote.nativeChildResult({ agentId: target.agentId, sessionId: target.parentSessionId,
            runId: target.parentRunId, childRunId: target.runId }, controller.signal);
          if (!controller.signal.aborted) { setView(nativeChildObservationState(detail)); setError(''); terminal = ['completed', 'failed', 'canceled'].includes(detail.observation.phase); }
        } catch { if (!controller.signal.aborted) setError('子会话同步失败，请重新打开'); }
        finally { if (!controller.signal.aborted) timer = setTimeout(read, terminal ? 3000 : 500); }
      };
      setView(null); void read();
      return () => { controller.abort(); clearTimeout(timer); };
    }, [info.tab.visible, target?.agentId, target?.parentSessionId, target?.parentRunId, target?.runId]);
    const host = target && hostBindings.get(hostKey(target));
    const onOpenFile = view?.workspaceView === 'isolated' ? ({ path }) => filePane.open({ ...target, path })
      : view?.workspaceView === 'parent' && host ? ({ path }) => {
        void Promise.resolve().then(() => host.openFile(path)).catch(() => setError('无法打开子会话文件'));
      } : undefined;
    return h(SubagentPane, { state: view?.state, labels, locale: 'zh-CN', showPlanDock: false, loading: !view, error, onOpenFile,
      onCopy: text => { void navigator.clipboard.writeText(text).catch(() => setError('无法复制')); },
      omittedRows: view?.omittedRows, omittedChars: view?.omittedChars,
      renderText: (text, meta) => renderText(text, { ...meta, target,
        cwd: view?.workspaceView === 'parent' ? host?.cwd : undefined, onOpenFile }), theme: activeTheme, autoFollow: true });
  }
  function Directory({ target }) {
    const key = hostKey(target), [tasks, setTasks] = useState(() => hostBindings.get(key)?.children ?? []);
    const [activeTheme, setActiveTheme] = useState(() => ctx.theme.getTheme().active.colorScheme);
    useEffect(() => ctx.on('theme/change', next => setActiveTheme(next.active.colorScheme)), []);
    useEffect(() => { const listeners = observers.get(key) ?? new Set(); observers.set(key, listeners); listeners.add(setTasks);
      setTasks(hostBindings.get(key)?.children ?? []);
      return () => { listeners.delete(setTasks); if (!listeners.size) observers.delete(key); };
    }, [key]);
    return h(SubagentDirectory, { theme: activeTheme, agents: nativeStatusPanelModel(null, tasks).agents,
      onOpenSubagent: child => {
        const kind = ensure({ ...child, ...target }); ctx.sidebarRight.openTab(kind, { params: { ...child, ...target } });
      } });
  }
  const ensureDirectory = target => {
    const kind = kindPrefix + 'directory-' + target.parentSessionId;
    if (!releases.has(kind)) {
      const disposers = [ctx.sidebarRightTabs.register({ id: kind, kind, title: () => '已结束的智能体' }),
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: kind }, () => h(Directory, { target }))),
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: kind }, () => h('span', null, '已结束的智能体')))];
      releases.set(kind, () => disposers.reverse().forEach(release => release()));
    }
    return kind;
  };
  function Title({ target }) { return h('span', null, target.title || target.role || '子智能体'); }
  const ensure = target => {
    const kind = kindPrefix + target.runId;
    if (!releases.has(kind)) {
      const disposers = [ctx.sidebarRightTabs.register({ id: kind, kind, title: () => target.title || target.role || '子智能体' }),
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: kind }, props => h(Body, { ...props, target }))),
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: kind }, () => h(Title, { target })))];
      releases.set(kind, () => disposers.reverse().forEach(release => release()));
    }
    return kind;
  };
  ctx.effect(() => () => { for (const release of releases.values()) release(); releases.clear(); hostBindings.clear(); observers.clear(); });
  return {
    bindHost(target, binding) {
      const key = hostKey(target); hostBindings.delete(key); hostBindings.set(key, binding);
      ensureDirectory(target);
      for (const listener of observers.get(key) ?? []) listener(binding.children ?? []);
      while (hostBindings.size > 64) hostBindings.delete(hostBindings.keys().next().value);
    },
    register: ensure,
    openDirectory(target) { const kind = ensureDirectory(target); ctx.sidebarRight.openTab(kind, { params: target }); },
    open(target) {
      if (!ctx.sidebarRight || !ctx.sidebarRightTabs) throw Error('子会话侧栏尚未就绪');
      const kind = ensure(target); ctx.sidebarRight.openTab(kind, { params: target });
    },
  };
}
