import { appendCommandOutput, createCommandOutputComponents } from '@kingsoftcloud/agentkit-harness-ui/command-output';

/** Studio owns right-pane docking and authenticated reads; the package owns
 * the output view. Opening a pane never submits a task or executes a tool.
 */
export function installNativeCommandPane(ctx, { React, hostRemote }) {
  const { createElement: h, useEffect, useState } = React;
  const { CommandOutputPane } = createCommandOutputComponents(React), releases = new Map();
  const observations = new Map(), listeners = new Map();
  const sessionKey = target => JSON.stringify([target.agentId, target.sessionId]);
  const publish = (target, output) => {
    const key = sessionKey(target), facts = observations.get(key) ?? new Map();
    observations.delete(key); observations.set(key, facts);
    facts.set(output.taskId, { contract: 'agentkit.command-output-status/v1', agentId: target.agentId,
      sessionId: target.sessionId, runId: output.runId, taskId: output.taskId, status: output.status, command: output.command ?? '' });
    while (facts.size > 128) facts.delete(facts.keys().next().value);
    while (observations.size > 64) observations.delete(observations.keys().next().value);
    for (const listener of listeners.get(key) ?? []) listener([...facts.values()]);
  };
  function Body({ useTabInfo, target }) {
    const info = useTabInfo(), [view, setView] = useState(null), [error, setError] = useState('');
    const [theme, setTheme] = useState(() => ctx.theme.getTheme().active.colorScheme);
    useEffect(() => ctx.on('theme/change', next => setTheme(next.active.colorScheme)), []);
    useEffect(() => {
      if (!info.tab.visible) return;
      const controller = new AbortController(); let timer, current = null;
      const poll = async () => {
        let delay = 750;
        try {
          const request = { agentId: target.agentId, sessionId: target.sessionId, taskId: target.id,
            stdoutCursor: current?.stdoutCursor ?? 0, stderrCursor: current?.stderrCursor ?? 0, maxBytes: 65536 };
          const page = await hostRemote.nativeCommandOutput(request, controller.signal);
          if (controller.signal.aborted) return;
          const advanced = page.stdoutCursor > request.stdoutCursor || page.stderrCursor > request.stderrCursor;
          current = appendCommandOutput(current, page, request); setView(current); setError(''); publish(target, current);
          delay = advanced ? 50 : ['starting', 'running'].includes(page.status) ? 750 : 3000;
        } catch { if (!controller.signal.aborted) setError('命令输出同步失败，正在重新读取'); }
        finally { if (!controller.signal.aborted) timer = setTimeout(poll, delay); }
      };
      setView(null); void poll();
      return () => { controller.abort(); clearTimeout(timer); };
    }, [info.tab.visible, target.agentId, target.sessionId, target.id]);
    return h(CommandOutputPane, { output: view, title: target.title || '终端输出', error, theme,
      onCopy: text => { void navigator.clipboard.writeText(text).catch(() => setError('无法复制')); } });
  }
  const ensure = target => {
    const kind = 'agentkit-native-command-' + target.sessionId + '-' + target.id;
    if (!releases.has(kind)) {
      const disposers = [ctx.sidebarRightTabs.register({ id: kind, kind, title: () => '终端输出' }),
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: kind }, props => h(Body, { ...props, target }))),
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: kind }, () => h('span', null, '终端输出')))];
      releases.set(kind, () => disposers.reverse().forEach(release => release()));
    }
    return kind;
  };
  ctx.effect(() => () => { for (const release of releases.values()) release(); releases.clear(); observations.clear(); listeners.clear(); });
  return { register: ensure,
    subscribe(target, listener) {
      const key = sessionKey(target), active = listeners.get(key) ?? new Set(); listeners.set(key, active); active.add(listener);
      listener([...(observations.get(key)?.values() ?? [])]);
      return () => { active.delete(listener); if (!active.size) listeners.delete(key); };
    },
    open(target) { const kind = ensure(target); ctx.sidebarRight.openTab(kind, { params: target }); } };
}
