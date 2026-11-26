import { refreshStarHarnessUI } from '../dsh/star-harness-ui.mjs';
import { STAR_HARNESS_INTRODUCTION_PATH } from '../../star-harness-detail.mjs';

export const STAR_HARNESS_CHANGED = 'agentkit-studio:star-harness-changed';

const releasesUrl = 'https://github.com/kingsoftcloud/ksadk-harness/releases';
const description = '金山云自研 Agent 运行框架，适配 AgentKit、星流模型和金山云服务，支持按需定制工具与执行策略。';
const bannerAlt = 'Star Harness 金山云自研 Agent 运行框架，适配 AgentKit、星流模型和金山云服务。按需定制、加速执行、节省 Token。';
const overview = `${description} 启用后，它使用会话在 Studio 中选择的工作区。

- **执行多步任务**。在工作区调用工具、修改文件并交付结果。
- **恢复未完成的任务**。重新打开 Studio 后，可以在原会话继续可恢复的运行。
- **独立更新**。在下方选择已验证的发布，或者回退到上一已安装版本。`;

const components = [
  ['Core', '任务执行、工具调用和运行状态', '@kingsoftcloud/agentkit-harness-core'],
  ['Node 运行时', '在本机工作区启动任务引擎', '@kingsoftcloud/agentkit-harness-node'],
  ['Studio 界面', '显示运行进度、工具操作和恢复入口', '@kingsoftcloud/agentkit-harness-ui'],
];

export function createStarHarnessPage({ ui, hostRemote, window, Switch, Button, RefreshIcon }) {
  const { React: { createElement: h, useEffect, useRef, useState }, BRAND, MarkdownText, buttonStyle, inputStyle } = ui;
  const button = (label, onClick, disabled, variant) => h('button', {
    type: 'button', style: { ...buttonStyle(variant), opacity: disabled ? 0.5 : 1 }, onClick, disabled,
  }, label);
  const muted = { color: BRAND.inkMuted, margin: 0 };
  const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' };
  const stack = { display: 'grid', gap: '14px' };
  const section = { ...stack, paddingBlockStart: '20px', borderTop: '1px solid ' + BRAND.border };
  const aside = { ...row, justifyContent: 'space-between' };
  const title = { margin: 0, fontSize: '16px', fontWeight: 600 };
  const itemRow = { ...aside, padding: '12px 0', borderBottom: '1px solid ' + BRAND.border };
  const pill = { color: BRAND.ink, background: BRAND.canvas, borderRadius: '999px', padding: '2px 9px', fontSize: '12px' };

  return function StarHarnessItem({ view, renderDetail } = {}) {
    const useNativeDetail = typeof renderDetail === 'function';
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState('');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [version, setVersion] = useState('');
    const [bannerUrl, setBannerUrl] = useState('');
    const pending = useRef(false);

    useEffect(() => {
      const lifetime = new AbortController();
      async function refresh() {
        try {
          const value = await hostRemote.starHarnessStatus({}, lifetime.signal);
          if (!lifetime.signal.aborted && !pending.current) setStatus(value);
          return value;
        } catch (reason) {
          if (!lifetime.signal.aborted) setError(reason.message || '读取 Star Harness 状态失败。');
          return null;
        }
      }
      async function load() {
        const value = await refresh();
        if (view !== 'page' || !value || value.supported === false || lifetime.signal.aborted) return;
        setChecking(true);
        try {
          const next = await hostRemote.starHarnessStatus({ checkUpdates: true, includeVersions: true }, lifetime.signal);
          if (!lifetime.signal.aborted && !pending.current) setStatus(next);
        } catch (reason) {
          if (!lifetime.signal.aborted) setError(reason.message || '读取 Star Harness 版本失败。');
        } finally {
          if (!lifetime.signal.aborted) setChecking(false);
        }
      }
      void load();
      window.addEventListener(STAR_HARNESS_CHANGED, refresh);
      return () => {
        lifetime.abort();
        window.removeEventListener(STAR_HARNESS_CHANGED, refresh);
      };
    }, [view]);

    useEffect(() => {
      if (!useNativeDetail) return;
      const lifetime = new AbortController();
      let url;
      const route = new URL(STAR_HARNESS_INTRODUCTION_PATH.slice(1), window.document.baseURI);
      void window.fetch(route, { signal: lifetime.signal }).then(response => {
        if (!response.ok) return null;
        return response.blob();
      }).then(image => {
        if (image?.type === 'image/jpeg' && !lifetime.signal.aborted) {
          url = window.URL.createObjectURL(image);
          setBannerUrl(url);
        }
      }).catch(() => {});
      return () => {
        lifetime.abort();
        if (url) window.URL.revokeObjectURL(url);
      };
    }, [useNativeDetail]);

    useEffect(() => {
      if (!status?.busy || busy) return;
      const lifetime = new AbortController();
      let timer;
      const schedule = () => { timer = window.setTimeout(poll, 1000); };
      const poll = async () => {
        try {
          const next = await hostRemote.starHarnessStatus({}, lifetime.signal);
          if (lifetime.signal.aborted || pending.current) return;
          setStatus(next);
          if (!next.busy) return;
        } catch { /* Keep the last status while a subsequent poll retries. */ }
        if (!lifetime.signal.aborted && !pending.current) schedule();
      };
      schedule();
      return () => {
        lifetime.abort();
        window.clearTimeout(timer);
      };
    }, [busy, status?.busy]);

    async function perform(label, operation, success, changed = true) {
      if (pending.current) return;
      pending.current = true;
      setBusy(label); setError(''); setMessage('');
      try {
        const next = await operation();
        setStatus(next);
        setMessage(success);
        if (changed) {
          window.dispatchEvent(new window.Event(STAR_HARNESS_CHANGED));
          refreshStarHarnessUI(window, ui.harnessUIDescriptor, next.clientUI, ui.harnessUIError);
        }
      } catch (reason) {
        setError(reason?.message || 'Star Harness 操作失败。');
        try { setStatus(await hostRemote.starHarnessStatus()); } catch { /* keep the last known state */ }
      } finally { pending.current = false; setBusy(''); }
    }

    const disabled = Boolean(busy || status?.busy);
    if (view !== 'page') {
      return h('span', { className: 'studio-star-harness-summary', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
        h('span', { role: error ? 'alert' : undefined, title: error || undefined,
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        error || (status?.version ? '已安装 ' + status.version : '管理 Star Harness 版本')),
        status?.version ? h(Switch, {
          checked: status.enabled === true, disabled, label: '启用 Star Harness', className: 'studio-star-harness-toggle',
          onChange: next => perform(next ? '正在启用…' : '正在停用…', () => hostRemote.enableStarHarness(next), ''),
        }) : null);
    }

    const installed = status?.version ?? undefined;
    const latest = installed ? status.availableUpgrade : status?.recommendedVersion;
    const rollback = status?.rollbackVersion;
    const repair = Boolean(status?.repairNeeded || ui.harnessUIError);
    const requested = version.trim() || latest || installed || '';
    const reinstall = installed === requested;
    const select = (target, action) => perform(action,
      async () => {
        const value = await hostRemote.installStarHarness(target);
        setVersion('');
        return value;
      }, target === rollback ? '已切回上一版本。' : '版本已通过握手验证。');
    const install = target => select(target, target === installed ? '正在重新安装 Star Harness…'
      : installed ? '正在升级 Star Harness…' : '正在安装 Star Harness…');
    const versionTag = (release, current = false) => h('a', {
      'aria-current': current || undefined,
      href: releasesUrl + '/tag/v' + release, target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.ink },
    }, 'v' + release);
    const catalog = status?.releaseVersions ?? [];
    const versions = [
      { version: latest, action: installed ? 'upgrade' : 'install', tag: '推荐' },
      { version: installed, action: 'current', tag: '当前版本' },
      { version: rollback, action: 'rollback', tag: '上一版本' },
    ].filter(item => item.version).map(item => ({
      ...item, publishedAt: catalog.find(release => release.version === item.version)?.publishedAt,
    }));

    function releaseRow({ version, publishedAt, action, tag }) {
      const control = action === 'rollback'
        ? button('回退到 ' + version, () => select(version, '正在切回上一版本…'), disabled)
        : action === 'upgrade' || action === 'install'
          ? button((action === 'upgrade' ? '升级到 ' : '安装 ') + version, () => install(version), disabled,
            tag === '推荐' ? 'primary' : undefined)
          : null;
      return h('li', { key: version, style: itemRow },
        h('div', { style: { ...row, gap: '8px' } }, versionTag(version, action === 'current'),
          tag ? h('span', { style: pill }, tag) : null,
          publishedAt ? h('time', { dateTime: publishedAt, style: muted }, publishedAt.slice(0, 10)) : null),
        control);
    }

    const runtimeRunning = status?.workspaces?.some(workspace => !workspace.external && workspace.running);
    const componentState = !status?.version ? ['未安装', '未安装', '未安装'] : [
      '随版本安装', runtimeRunning ? '运行中' : status.enabled ? '就绪' : '已停用',
      repair ? '需要修复' : status.enabled && status.clientUI ? '已加载' : '未加载',
    ];
    const list = { listStyle: 'none', padding: 0, margin: 0 };
    const supported = status && status.supported !== false;

    if (useNativeDetail) {
      const action = (label, onClick, inactive = disabled, variant = 'outline', icon) => h(Button, {
        variant, size: 'sm', onClick, disabled: inactive, icon,
      }, label);
      const toggle = installed ? h(Switch, {
        checked: status.enabled === true, disabled, label: '启用 Star Harness',
        onChange: next => perform(next ? '正在启用…' : '正在停用…', () => hostRemote.enableStarHarness(next), ''),
      }) : null;
      const versionAction = (label, target, onClick) => h(Button, {
        variant: 'outline', size: 'sm', onClick, disabled, 'aria-label': (label === '安装' ? '安装 ' : label + '到 ') + target,
      }, label);
      const rowModels = versions.map(item => ({
        version: item.version,
        url: releasesUrl + '/tag/v' + item.version,
        date: item.publishedAt?.slice(0, 10),
        current: item.action === 'current',
        tag: item.tag,
        action: item.action === 'rollback'
          ? versionAction('回退', item.version, () => select(item.version, '正在切回上一版本…'))
          : ['install', 'upgrade'].includes(item.action)
            ? versionAction(item.action === 'upgrade' ? '升级' : '安装', item.version, () => install(item.version))
            : undefined,
      }));
      const states = !installed ? ['off', 'off', 'off'] : [
        'idle', runtimeRunning ? 'active' : status.enabled ? 'idle' : 'off',
        repair ? 'failed' : status.enabled && status.clientUI ? 'active' : 'off',
      ];
      const feature = bannerUrl ? `![${bannerAlt}](star-harness-introduction.jpg)` : '';
      const introduction = '在 AgentKit 中调用工具、管理上下文并恢复任务。可按业务需要定制运行策略，减少重复执行和无效的上下文开销。';
      const updating = Boolean(checking || busy);
      return renderDetail({
        name: '@kingsoftcloud/ksadk-harness', regionLabel: 'Star Harness 管理', version: installed, description,
        source: { label: 'kingsoftcloud/ksadk-harness', url: releasesUrl },
        updateAvailable: Boolean(installed && latest),
        headerActions: h(ui.React.Fragment, null,
          latest ? action((installed ? '升级到 ' : '安装 ') + latest, () => install(latest), disabled,
            'primary', RefreshIcon ? h(RefreshIcon, { size: 13 }) : undefined) : null, toggle),
        notice: h('div', { style: { display: 'contents' } },
          !status && !busy && !error ? h('p', { role: 'status', style: muted }, '正在读取 Star Harness 状态…') : null,
          busy || message ? h('p', { role: 'status', style: muted }, busy || message) : null,
          !busy && status?.busy ? h('p', { role: 'status', style: muted }, '任务运行中，结束后可以更改版本。') : null,
          error ? h('p', { role: 'alert', style: muted }, error) : null,
          repair ? h('p', { role: 'alert', style: muted }, 'Star Harness 前端需要修复，请重新安装或回退。') : null,
          status?.supported === false ? h('p', { style: muted }, '此 Studio 部署由管理员管理。') : null),
        document: { markdown: [feature, introduction].filter(Boolean).join('\n\n'),
          images: bannerUrl ? { 'star-harness-introduction.jpg': bannerUrl } : {} },
        components: supported ? components.map(([title, detail, moduleName], index) => ({
          id: ['core', 'node', 'ui'][index], title, description: detail, moduleName,
          state: states[index], stateLabel: componentState[index],
        })) : [],
        versions: supported ? {
          title: checking ? '正在检查已签名的发布…' : latest ? (installed ? '可升级到 ' : '可安装 ') + latest
            : installed ? '已安装 ' + installed : '未找到可验证的发布',
          subtitle: status.registryUnavailable ? '暂时无法刷新版本列表。已安装的版本仍可使用。' : '签名发布',
          tone: status.registryUnavailable ? 'warn' : latest ? 'info' : installed ? 'success' : 'neutral',
          checking: updating,
          onCheck: () => perform('正在检查更新…',
            () => hostRemote.starHarnessStatus({ checkUpdates: true, includeVersions: true, refreshVersions: true }), '', false),
          rows: rowModels,
          expandLabel: rowModels.length + ' 个版本',
          advanced: h('details', null, h('summary', null, '按版本号安装或修复'),
            h('div', { style: { ...row, marginTop: '10px' } },
              h('input', { 'aria-label': '版本', style: { ...inputStyle(), width: '112px', marginTop: 0 },
                value: version, placeholder: requested, onChange: event => setVersion(event.target.value), disabled }),
              action(reinstall ? '重新安装' : installed ? '升级' : '安装', () => requested === rollback
                ? select(requested, '正在切回上一版本…') : install(requested), disabled || !requested || reinstall && !version.trim() && !repair))),
        } : undefined,
      });
    }

    return h('section', { 'aria-label': 'Star Harness 管理', style: { ...stack, gap: '22px', color: BRAND.ink } },
      !status && !busy && !error ? h('p', { role: 'status', style: muted }, '正在读取 Star Harness 状态…') : null,
      busy || message ? h('p', { role: 'status', style: muted }, busy || message) : null,
      !busy && status?.busy ? h('p', { role: 'status', style: muted }, '任务运行中，结束后可以更改版本。') : null,
      error ? h('p', { role: 'alert', style: muted }, error) : null,
      status?.repairNeeded ? h('p', { role: 'alert', style: muted }, 'Star Harness 前端校验失败，请重新安装。') : null,
      ui.harnessUIError ? h('p', { role: 'alert', style: muted }, 'Star Harness 前端加载失败，请重新安装或回退。') : null,
      status?.supported === false ? h('p', { style: muted }, '此 Studio 部署由管理员管理。') : null,
      h('section', { style: { ...stack, padding: '16px 20px', background: BRAND.canvas, borderRadius: '14px' } },
        h('h3', { style: title }, '关于 Star Harness'),
        h(MarkdownText, { text: overview })),
      supported ? h('section', { style: section },
        h('div', { style: aside }, h('h3', { style: title }, '包含的组件'),
          h('span', { style: muted }, '3 个组件 · 随版本一起更新')),
        h('ul', { style: list }, components.map(([name, description, id], index) =>
          h('li', { key: id, style: itemRow },
            h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
              h('strong', null, name),
              h('span', { style: muted }, description),
              h('code', { style: { ...muted, overflowWrap: 'anywhere' } }, id)),
            h('span', { style: pill }, componentState[index]))))) : null,
      supported ? h('section', { style: section },
        h('div', { style: aside }, h('h3', { style: title }, '版本'),
          h('div', { style: row },
            repair && installed ? button('重新安装当前版本', () => install(installed), disabled, 'primary') : null,
            button('检查更新', () => perform('正在检查更新…',
              () => hostRemote.starHarnessStatus({ checkUpdates: true, includeVersions: true, refreshVersions: true }), '', false), checking || Boolean(busy)))),
        checking ? h('p', { role: 'status', style: muted }, '正在检查已签名的发布…') : null,
        status.registryUnavailable ? h('p', { role: 'status', style: muted },
          '暂时无法刷新版本列表。已安装的版本仍可使用。') : null,
        !checking && !status.registryUnavailable && !versions.length ? h('p', { style: muted },
          '未找到可验证的发布。') : null,
        versions.length ? h('ul', { style: list }, versions.map(releaseRow)) : null,
        h('details', null,
          h('summary', { style: { ...muted, cursor: 'pointer' } }, '按版本号安装或修复'),
          h('div', { style: { ...row, marginTop: '10px' } },
            h('input', { 'aria-label': '版本', style: { ...inputStyle(), width: '112px', marginTop: 0 },
              value: version, placeholder: requested, onChange: event => setVersion(event.target.value), disabled }),
            button(reinstall ? '重新安装' : installed ? '升级' : '安装', () => requested === rollback
              ? select(requested, '正在切回上一版本…') : install(requested),
            disabled || !requested || reinstall && !version.trim() && !repair)))) : null,
      h('section', { style: section },
        h('h3', { style: title }, '来源信息'),
        h('div', { style: aside }, h('span', { style: muted }, '代码来源'),
          h('a', { href: releasesUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.ink } },
            'kingsoftcloud/ksadk-harness')),
        installed ? h('div', { style: aside }, h('span', { style: muted }, '当前版本'), versionTag(installed)) : null));
  };
}
