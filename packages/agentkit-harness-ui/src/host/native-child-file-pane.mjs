import { createFilePreviewComponents } from '@kingsoftcloud/agentkit-harness-ui/file-preview';

/** The reusable package renders a read-only page; the Host authenticates the
 * exact parent/child and owns byte paging and right-pane docking.
 */
export function installNativeChildFilePane(ctx, { React, hostRemote }) {
  const { createElement: h, useEffect, useState } = React;
  const { FilePreviewPane } = createFilePreviewComponents(React);
  const releases = new Map();
  function Body({ useTabInfo, target }) {
    const info = useTabInfo(), [page, setPage] = useState(null), [loading, setLoading] = useState(false);
    const [error, setError] = useState(''), [offset, setOffset] = useState(0), [previous, setPrevious] = useState([]);
    const [theme, setTheme] = useState(() => ctx.theme.getTheme().active.colorScheme);
    useEffect(() => ctx.on('theme/change', next => setTheme(next.active.colorScheme)), []);
    useEffect(() => {
      if (!info.tab.visible) return;
      const controller = new AbortController(); setLoading(true); setError(''); setPage(null);
      void hostRemote.nativeChildFile({ agentId: target.agentId, sessionId: target.parentSessionId,
        runId: target.parentRunId, childRunId: target.runId, path: target.path, offset, limit: 32768 }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setPage(value); })
        .catch(() => { if (!controller.signal.aborted) setError('无法读取该子工作区文件；不会打开父工作区的同名文件。'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
      return () => controller.abort();
    }, [info.tab.visible, target.agentId, target.parentSessionId, target.parentRunId, target.runId, target.path, offset]);
    return h(FilePreviewPane, { page, loading, error, theme,
      labels: { loading: '正在读取文件', unavailable: '文件预览不可用', readOnly: '子工作区 · 只读',
        observation: '当前文件观察，不代表任务验证结果', copy: '复制此页', next: '下一页', previous: '上一页', bytes: '字节' },
      onCopy: text => { void navigator.clipboard.writeText(text).catch(() => setError('无法复制此页')); },
      onNext: page?.nextOffset !== null && Number.isSafeInteger(page?.nextOffset) ? () => {
        setPrevious([...previous, offset]); setOffset(page.nextOffset);
      } : undefined,
      onPrevious: previous.length ? () => { setOffset(previous.at(-1)); setPrevious(previous.slice(0, -1)); } : undefined });
  }
  ctx.effect(() => () => { for (const release of releases.values()) release(); releases.clear(); });
  return { open(target) {
    const kind = `agentkit-native-child-file-${target.runId}-${encodeURIComponent(target.path)}`;
    if (!releases.has(kind)) {
      const title = target.path.split('/').at(-1), disposers = [
        ctx.sidebarRightTabs.register({ id: kind, kind, title: () => title }),
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: kind },
          props => h(Body, { ...props, target }))),
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: kind },
          () => h('span', null, title))),
      ];
      releases.set(kind, () => disposers.reverse().forEach(release => release()));
    }
    ctx.sidebarRight.openTab(kind, { params: target });
  } };
}
