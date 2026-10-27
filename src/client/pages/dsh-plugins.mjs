import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

const ALL_CATEGORIES = '全部';
const CATEGORY_ORDER = [
  ALL_CATEGORIES, '视觉外观', '界面增强', '记忆与上下文', '搜索与联网', '图像与媒体',
  '文档与办公', '模型与路由', '成本与用量', '效率与通知', '协作与工作流', '输入与编辑', '安全与质量', '其他'
];
const SORTS = ['推荐', '下载量', '最近更新', '名称'];

const STATUS_LABELS = {
  active: '已启用',
  available: '可安装',
  disabled: '已停用',
  partial: '部分加载',
  error: '加载失败',
  selected: '已配置',
  'not-installed': '未安装'
};

const VERIFICATION_LABELS = {
  ready: '验证通过',
  failed: '验证失败',
  'not-installed': '未安装',
  disabled: '已停用',
  'pending-restart': '待重启',
  loaded: '已加载'
};

/** Discovery is the product; installed management is the second tab. */
export function createDshPluginPages({
  ui: { React: { createElement: h, useEffect, useState, Fragment }, Pill, buttonStyle, EmptyState, ResourceDialog, inputStyle, BRAND = DEFAULT_BRAND },
  hostRemote
}) {
  function DshPluginMarketItem({ view } = {}) {
    const [tab, setTab] = useState('discover');
    const [discovery, setDiscovery] = useState(null);
    const [items, setItems] = useState([]);
    const [status, setStatus] = useState('idle');
    const [catalog, setCatalog] = useState(null);
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState(ALL_CATEGORIES);
    const [sort, setSort] = useState(SORTS[0]);
    const [selectedId, setSelectedId] = useState('');
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [installOpen, setInstallOpen] = useState(false);
    const [installSpec, setInstallSpec] = useState('');

    const loadInstalled = async () => {
      const result = await hostRemote.dshPlugins();
      const next = Array.isArray(result?.items) ? result.items : [];
      setItems(next);
      setCatalog(result?.catalog && typeof result.catalog === 'object' ? result.catalog : null);
      return next;
    };

    const loadDiscovery = async (force = false) => {
      const result = await hostRemote.discoverDshPlugins({ force });
      const next = {
        items: Array.isArray(result?.items) ? result.items : [],
        info: result?.info && typeof result.info === 'object' ? result.info : null
      };
      setDiscovery(next);
      return next;
    };

    const load = async (options = {}) => {
      setStatus('loading');
      setError('');
      try {
        const [nextDiscovery, nextItems] = await Promise.all([
          loadDiscovery(options.force === true),
          loadInstalled()
        ]);
        setStatus('ready');
        return { discovery: nextDiscovery, items: nextItems };
      } catch (reason) {
        setStatus('error');
        setError(reason?.message || '插件市场数据读取失败');
        return null;
      }
    };

    useEffect(() => {
      if (view === 'page') void load();
    }, [view]);

    if (view !== 'page') {
      return h('p', { style: { margin: 0, color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, '发现 npm 与 GitHub 上的社区 DSH 插件，搜索、分类浏览并一键安装；已安装插件在第二个 tab 里管理。');
    }

    const idOf = item => String(item?.pluginId || item?.id || item?.name || '');
    const labelOf = item => item?.displayName || item?.packageName || item?.name || idOf(item) || '未命名插件';
    const installed = item => item?.installed === true;
    const restricted = item => item?.lifecycleAvailable === false || Boolean(item?.readOnlyReason);
    const stateLabel = item => STATUS_LABELS[item?.status] || '状态未确认';
    const stateTone = item => restricted(item) || item?.status === 'error' || item?.status === 'partial' ? 'signal' : item?.status === 'active' ? 'accent' : 'neutral';

    const formatCount = value => {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return '';
      if (number >= 100000000) return `${(number / 100000000).toFixed(1).replace(/\.0$/u, '')} 亿`;
      if (number >= 10000) return `${(number / 10000).toFixed(1).replace(/\.0$/u, '')} 万`;
      return String(Math.round(number));
    };
    const formatDate = value => {
      const text = String(value || '');
      const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text);
      return match ? `${match[1]}-${match[2]}` : '';
    };
    const statsLine = item => {
      const parts = [];
      const downloads = formatCount(item?.stats?.monthlyDownloads);
      const stars = formatCount(item?.stats?.stars);
      if (downloads) parts.push(`↓ ${downloads}/月`);
      if (stars) parts.push(`★ ${stars}`);
      if (item?.version) parts.push(`v${item.version}`);
      const updated = formatDate(item?.stats?.updatedAt);
      if (updated) parts.push(`更新 ${updated}`);
      return parts;
    };

    const actionButton = (key, text, onClick, options = {}) => h('button', {
      type: 'button',
      disabled: Boolean(busy),
      onClick,
      style: {
        ...buttonStyle(),
        padding: options.compact === false ? '7px 12px' : '5px 9px',
        fontSize: options.compact === false ? '12px' : '10px',
        ...(options.primary ? { color: BRAND.primaryText, background: BRAND.primaryFill, borderColor: 'transparent' } : { background: BRAND.surface }),
        ...(options.danger ? { color: BRAND.danger } : {})
      }
    }, busy === key ? '处理中…' : text);

    const refreshAll = async () => {
      if (busy) return;
      setBusy('refresh');
      setMessage('');
      setError('');
      try {
        // Refresh both layers: the ecosystem catalog and the optional remote index.
        if (typeof hostRemote.refreshDshPluginIndex === 'function') {
          await hostRemote.refreshDshPluginIndex().catch(() => undefined);
        }
        await load({ force: true });
        setMessage('插件目录已刷新。');
      } catch (reason) {
        setError(reason?.message || '插件目录刷新失败');
      } finally {
        setBusy('');
      }
    };

    const applyInstalled = pluginId => {
      setDiscovery(current => {
        if (!current) return current;
        return {
          ...current,
          items: current.items.map(entry => idOf(entry) === pluginId ? { ...entry, installed: true, enabled: true } : entry)
        };
      });
    };

    const installItem = async (item, spec) => {
      const target = String(spec || item?.installSpec || item?.packageName || '').trim();
      if (!target || busy) return false;
      const key = `install:${idOf(item)}`;
      setBusy(key);
      setMessage('');
      setError('');
      try {
        const result = await hostRemote.installDshPlugin(target, true);
        applyInstalled(idOf(item));
        await loadInstalled();
        const note = String(result?.note || '').trim();
        setMessage(`${labelOf(item)} 已安装。${note}`.trim());
        return true;
      } catch (reason) {
        setError(reason?.message || `安装 ${labelOf(item)} 失败`);
        return false;
      } finally {
        setBusy('');
      }
    };

    const mutateInstalled = async (item, operation) => {
      const pluginId = idOf(item).trim();
      if (!pluginId || busy) return false;
      setBusy(`${operation}:${pluginId}`);
      setMessage('');
      setError('');
      try {
        let result;
        if (operation === 'install') result = await hostRemote.installDshPlugin(item?.installSpec || pluginId);
        else if (operation === 'enable') result = await hostRemote.enableDshPlugin(pluginId);
        else if (operation === 'disable') result = await hostRemote.disableDshPlugin(pluginId);
        else if (operation === 'update') result = await hostRemote.updateDshPlugin(pluginId);
        else result = await hostRemote.uninstallDshPlugin(pluginId);
        await loadInstalled();
        const verbs = { install: '已安装', enable: '已启用', disable: '已停用', update: '已更新', uninstall: '已卸载' };
        const note = String(result?.note || '').trim();
        setMessage(`${labelOf(item)}：${verbs[operation]}。${note}`.trim());
        if (operation === 'uninstall') setSelectedId(current => current === pluginId ? '' : current);
        return true;
      } catch (reason) {
        setError(reason?.message || 'DSH 插件操作失败');
        return false;
      } finally {
        setBusy('');
      }
    };

    const lifecycleActions = (item, compact = false) => {
      if (restricted(item)) return null;
      const pluginId = idOf(item);
      const buttons = [];
      if (!installed(item)) {
        buttons.push(actionButton(`install:${pluginId}`, '安装', () => { void mutateInstalled(item, 'install'); }, { primary: true, compact }));
      } else {
        const enable = item?.enabled === false;
        buttons.push(actionButton(`${enable ? 'enable' : 'disable'}:${pluginId}`, enable ? '启用' : '停用', () => { void mutateInstalled(item, enable ? 'enable' : 'disable'); }, { compact }));
        if (item?.installTarget) buttons.push(actionButton(`update:${pluginId}`, '更新', () => { void mutateInstalled(item, 'update'); }, { compact }));
        if (item?.removable === true) buttons.push(actionButton(`uninstall:${pluginId}`, '卸载', () => { void mutateInstalled(item, 'uninstall'); }, { compact, danger: true }));
      }
      return buttons.length ? h(Fragment, null, ...buttons) : null;
    };

    const pill = (text, tone = 'neutral') => h(Pill, { tone }, text);
    const sourceBadge = item => item?.source === 'github'
      ? pill('GitHub', 'neutral')
      : item?.source === 'npm' ? pill('npm', 'neutral') : pill('内置', 'neutral');

    const iconSquare = item => {
      const icon = item?.icon;
      const seed = String(labelOf(item)).replace(/^@[^/]+\//u, '');
      return h('div', { style: { width: '38px', height: '38px', flex: '0 0 38px', display: 'grid', placeItems: 'center', borderRadius: '10px', overflow: 'hidden', background: BRAND.accentSoft, color: BRAND.ink, fontWeight: 800, fontSize: '15px' } }, icon
        ? h('img', { src: icon, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', style: { width: '70%', height: '70%', objectFit: 'contain' } })
        : seed.charAt(0).toUpperCase());
    };

    const cardBadges = item => [
      item?.featured === true ? pill('精选', 'accent') : null,
      sourceBadge(item)
    ].filter(Boolean);

    const discoveryCard = item => h('article', {
      key: idOf(item),
      style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface, minWidth: 0 }
    },
      h('div', { style: { display: 'flex', gap: '9px', alignItems: 'center', minWidth: 0 } },
        iconSquare(item),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('button', {
            type: 'button',
            onClick: () => setSelectedId(idOf(item)),
            style: { display: 'block', width: '100%', padding: 0, border: 0, background: 'transparent', textAlign: 'left', color: BRAND.ink, cursor: 'pointer' }
          },
            h('strong', { style: { display: 'block', fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, labelOf(item)),
            h('code', { style: { display: 'block', marginTop: '2px', color: BRAND.inkMuted, fontSize: '9.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.packageName || item.repo || '')),
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } }, ...cardBadges(item), installed(item) ? pill('已安装', 'accent') : null))),
      h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '2.9em' } }, item.description || '未提供描述'),
      h('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap', color: BRAND.inkMuted, fontSize: '10px' } }, ...statsLine(item).map(text => h('span', { key: text }, text))),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: '4px' } },
        h('button', { type: 'button', onClick: () => setSelectedId(idOf(item)), style: { ...buttonStyle(), padding: '4px 8px', fontSize: '10px', background: BRAND.surface } }, '详情'),
        installed(item)
          ? pill(item?.enabled === false ? '已装·停用' : '已装·启用', item?.enabled === false ? 'neutral' : 'accent')
          : actionButton(`install:${idOf(item)}`, '安装', () => { void installItem(item); }, { primary: true, compact: true })));

    const installedRow = item => h('article', { key: idOf(item), style: { display: 'flex', flexWrap: 'wrap', gap: '11px', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid ' + BRAND.border } },
      iconSquare(item),
      h('button', { type: 'button', onClick: () => setSelectedId(idOf(item)), style: { flex: '1 1 180px', minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left', color: BRAND.ink, cursor: 'pointer' } },
        h('strong', { style: { display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, labelOf(item)),
        h('span', { style: { display: 'block', marginTop: '3px', color: BRAND.inkMuted, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item?.description || item?.category || idOf(item))),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
        pill(stateLabel(item), stateTone(item)),
        lifecycleActions(item, true)));

    const section = (title, rows, extra = '') => rows.length ? h('section', { key: title },
      h('h3', { style: { margin: '12px 0 0', color: BRAND.ink, fontSize: '14px' } }, `${title} · ${rows.length}${extra}`),
      rows.map(installedRow)) : null;

    const detailLink = (label, url) => url ? h('a', {
      key: label,
      href: url,
      target: '_blank',
      rel: 'noreferrer noopener',
      style: { color: BRAND.accentStrong, fontSize: '11px', textDecoration: 'none' }
    }, `${label} ↗`) : null;

    const discoveryDetail = item => h('section', { style: { display: 'grid', gap: '12px' } },
      h('button', { type: 'button', onClick: () => setSelectedId(''), style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.surface } }, '← 返回插件市场'),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 } },
          iconSquare(item),
          h('div', { style: { minWidth: 0 } },
            h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '17px' } }, labelOf(item)),
            h('code', { style: { display: 'block', marginTop: '5px', color: BRAND.inkMuted, fontSize: '10px', wordBreak: 'break-word' } }, item.packageName || item.repo || '')),
          ...cardBadges(item)),
        installed(item)
          ? pill(item?.enabled === false ? '已安装（停用中）' : '已安装', 'accent')
          : actionButton(`install:${idOf(item)}`, '安装到当前 Host', () => { void installItem(item); }, { primary: true, compact: false })),
      item.description ? h('p', { style: { margin: 0, color: BRAND.ink, lineHeight: 1.65, fontSize: '12px', whiteSpace: 'pre-wrap' } }, item.description) : null,
      h('dl', { style: { margin: 0, padding: '10px 0', borderTop: '1px solid ' + BRAND.border, borderBottom: '1px solid ' + BRAND.border, display: 'grid', gap: '6px' } },
        [
          ['分类', item.category || '未分类'],
          ['版本', item.version || '—'],
          ['来源', item.source === 'github' ? 'GitHub 仓库' : 'npm registry'],
          ['作者', item.author || '—'],
          ['下载', item.stats?.monthlyDownloads ? `${formatCount(item.stats.monthlyDownloads)}/月` : '—'],
          ['星标', item.stats?.stars ? formatCount(item.stats.stars) : '—'],
          ['最近更新', item.stats?.updatedAt ? formatDate(item.stats.updatedAt) || item.stats.updatedAt : '—'],
          ['安装源', item.installSpec || '—']
        ].map(([key, value]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: '10px', fontSize: '11px' } },
          h('dt', { style: { color: BRAND.inkMuted } }, key),
          h('dd', { style: { margin: 0, color: BRAND.ink, wordBreak: 'break-word' } }, value)))),
      (item.homepage || item.repository || item.npmUrl)
        ? h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } }, detailLink('主页', item.homepage), detailLink('GitHub', item.repository), detailLink('npm', item.npmUrl))
        : null,
      Array.isArray(item.tags) && item.tags.length
        ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ...item.tags.map((tag, index) => pill(String(tag), 'neutral')))
        : null,
      item.source === 'github'
        ? h('p', { style: { margin: 0, padding: '8px 10px', borderLeft: '2px solid ' + BRAND.signal, background: BRAND.surface, color: BRAND.signal, fontSize: '11px', lineHeight: 1.6 } }, '该项目从 GitHub 直装，需要仓库自带可安装的构建产物；如果安装失败，请优先寻找同名 npm 包。')
        : null,
      h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.6 } }, '安装会交给 DSH 官方插件管理器：校验插件声明、写入当前 profile，并在 Host 支持时立即生效。'));

    const installedDetail = item => {
      const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
      const verification = item?.verification && typeof item.verification === 'object' ? item.verification : {};
      const verificationChecks = Array.isArray(verification.checks) ? verification.checks : [];
      const verificationFailed = verification.state === 'failed';
      return h('section', { style: { display: 'grid', gap: '12px' } },
        h('button', { type: 'button', onClick: () => setSelectedId(''), style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.surface } }, '← 返回插件市场'),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 } },
            iconSquare(item),
            h('div', { style: { minWidth: 0 } },
              h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '17px' } }, labelOf(item)),
              h('code', { style: { display: 'block', marginTop: '5px', color: BRAND.inkMuted, fontSize: '10px', wordBreak: 'break-word' } }, idOf(item)))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            pill(stateLabel(item), stateTone(item)),
            lifecycleActions(item, false))),
        item.description ? h('p', { style: { margin: 0, color: BRAND.ink, lineHeight: 1.65, fontSize: '12px', whiteSpace: 'pre-wrap' } }, item.description) : null,
        h('dl', { style: { margin: 0, padding: '10px 0', borderTop: '1px solid ' + BRAND.border, borderBottom: '1px solid ' + BRAND.border, display: 'grid', gap: '6px' } },
          [['版本', item.version || '—'], ['来源', item.source || '—'], ['分类', item.category || '未分类'], ['安装源', item.installTarget?.spec || item.installSpec || '—'], ['状态', stateLabel(item)]]
            .map(([key, value]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: '10px', fontSize: '11px' } },
              h('dt', { style: { color: BRAND.inkMuted } }, key),
              h('dd', { style: { margin: 0, color: BRAND.ink, wordBreak: 'break-word' } }, value)))),
        item.error ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.danger, whiteSpace: 'pre-wrap', fontSize: '12px' } }, item.error.diagnostic || item.error.message || item.error.code || '插件加载错误') : null,
        h('section', null,
          h('h3', { style: { margin: '0 0 8px', color: BRAND.ink, fontSize: '14px' } }, '能力'),
          capabilities.length
            ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ...capabilities.map((capability, index) => pill(String(capability), 'neutral')))
            : h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px' } }, '该插件未声明 Studio 能力清单。')),
        h('section', { style: { borderTop: '1px solid ' + BRAND.border, paddingTop: '12px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' } },
            h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '能力验证'),
            pill(VERIFICATION_LABELS[verification.state] || '状态未确认', verificationFailed ? 'signal' : verification.state === 'ready' ? 'accent' : 'neutral')),
          verification.note ? h('p', {
            role: verificationFailed ? 'alert' : 'status',
            style: verificationFailed
              ? { margin: 0, padding: '8px 10px', borderLeft: '2px solid ' + BRAND.signal, background: BRAND.surface, color: BRAND.signal, fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }
              : { margin: 0, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }
          }, verification.note) : null,
          verificationChecks.length ? h('ul', { style: { margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '5px' } },
            ...verificationChecks.map((check, index) => h('li', { key: index, style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '11px' } },
              h('code', { style: { color: BRAND.ink } }, String(check?.entry || check?.method || '检查项')),
              h('span', { style: { color: check?.ok ? BRAND.accentStrong : BRAND.danger } }, check?.ok ? '通过' : '未通过'),
              check?.phase ? h('span', { style: { color: BRAND.inkMuted } }, `阶段：${check.phase}`) : null,
              check?.observed ? h('span', { style: { color: BRAND.inkMuted } }, `观察：${check.observed}`) : null))) : null),
        restricted(item) ? h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '该插件由 Host 只读管理，本页不提供安装、启停、更新或卸载操作。') : null);
    };

    const discoveryItems = discovery?.items || [];
    const selectedDiscovery = discoveryItems.find(item => idOf(item) === selectedId) || null;
    const selectedInstalled = items.find(item => idOf(item) === selectedId) || null;
    const selected = selectedDiscovery || selectedInstalled;

    const normalized = query.trim().toLowerCase();
    const activeCategory = category || ALL_CATEGORIES;
    const presentCategories = new Set(discoveryItems.map(item => item?.category || '其他'));
    const categories = CATEGORY_ORDER.filter(name => name === ALL_CATEGORIES || presentCategories.has(name));
    const remoteInfo = discovery?.info || null;

    const visibleDiscovery = discoveryItems.filter(item => {
      if (activeCategory !== ALL_CATEGORIES && (item?.category || '其他') !== activeCategory) return false;
      if (!normalized) return true;
      const haystack = [labelOf(item), item.packageName, item.repo, item.description, item.category, ...(Array.isArray(item.tags) ? item.tags : [])].join(' ');
      return haystack.toLowerCase().includes(normalized);
    });
    const sortedDiscovery = [...visibleDiscovery].sort((left, right) => {
      if (sort === '下载量') return (right.stats?.monthlyDownloads || 0) - (left.stats?.monthlyDownloads || 0);
      if (sort === '最近更新') return String(right.stats?.updatedAt || '').localeCompare(String(left.stats?.updatedAt || ''));
      if (sort === '名称') return labelOf(left).localeCompare(labelOf(right), 'zh-Hans-CN');
      return (right.featured === true) - (left.featured === true)
        || (right.installed === true) - (left.installed === true)
        || (right.stats?.monthlyDownloads || 0) - (left.stats?.monthlyDownloads || 0)
        || labelOf(left).localeCompare(labelOf(right), 'zh-Hans-CN');
    });
    const errorRows = items.filter(item => item?.status === 'error' || item?.status === 'partial');
    const activeRows = items.filter(item => item?.enabled !== false && !errorRows.includes(item));
    const disabledRows = items.filter(item => item?.enabled === false && !errorRows.includes(item));

    const tabButton = (name, text) => h('button', {
      key: name,
      type: 'button',
      onClick: () => { setTab(name); setSelectedId(''); setError(''); },
      style: {
        ...buttonStyle(),
        padding: '6px 14px',
        fontSize: '12px',
        ...(tab === name ? { color: BRAND.primaryText, background: BRAND.primaryFill, borderColor: 'transparent' } : { background: BRAND.surface })
      }
    }, text);

    const toolbar = h(Fragment, null,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        tabButton('discover', '发现插件'),
        tabButton('installed', `已安装${items.length ? `（${items.length}）` : ''}`),
        h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', onClick: () => { void refreshAll(); }, disabled: Boolean(busy) || status === 'loading', style: buttonStyle() }, busy === 'refresh' ? '刷新中…' : '刷新目录'),
        h('button', { type: 'button', onClick: () => { setInstallSpec(''); setError(''); setInstallOpen(true); }, disabled: Boolean(busy), style: buttonStyle() }, '手动安装')));

    const discoverPanel = h(Fragment, null,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索插件名称、描述或标签', 'aria-label': '搜索插件', style: { ...inputStyle(), marginTop: 0, flex: '1 1 240px' } }),
        h('select', {
          value: sort,
          'aria-label': '排序方式',
          onChange: event => setSort(event.target.value),
          style: { ...inputStyle(), marginTop: 0, flex: '0 0 auto', width: 'auto', padding: '7px 9px', fontSize: '11px' }
        }, ...SORTS.map(name => h('option', { key: name, value: name }, name)))),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
        ...categories.map(name => h('button', {
          key: name,
          type: 'button',
          'aria-label': `筛选分类：${name}`,
          onClick: () => setCategory(name),
          style: {
            ...buttonStyle(),
            padding: '4px 10px',
            fontSize: '11px',
            ...(activeCategory === name ? { color: BRAND.primaryText, background: BRAND.primaryFill, borderColor: 'transparent' } : { background: BRAND.surface })
          }
        }, name))),
      h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.6 } },
        `来自 npm 与 GitHub 的社区插件${remoteInfo ? ` · npm 收录 ${formatCount(remoteInfo.npmTotal) || remoteInfo.npmTotal || 0} 个 · 精选 ${remoteInfo.curated || 0} 个` : ''}${remoteInfo?.updatedAt ? ` · 目录更新于 ${formatDate(remoteInfo.updatedAt) || remoteInfo.updatedAt}` : ''}`),
      remoteInfo?.stale ? h('p', { role: 'status', style: { margin: 0, color: BRAND.signal, fontSize: '11px' } }, '目录刷新失败，正在展示上一次成功获取的数据。') : null,
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在发现社区插件', detail: '从 npm 与 GitHub 聚合插件目录，并读取本地安装状态。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '插件目录不可用', detail: error, action: h('button', { type: 'button', onClick: () => { void load({ force: true }); }, style: buttonStyle() }, '重新加载') }) : null,
      status === 'ready' && sortedDiscovery.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(248px,1fr))', gap: '10px' } }, ...sortedDiscovery.map(discoveryCard)) : null,
      status === 'ready' && !sortedDiscovery.length ? h(EmptyState, { icon: '⌕', title: '没有匹配的插件', detail: discoveryItems.length ? '试试其他关键词，或清空搜索与分类筛选。' : '目录暂时为空，可以刷新目录或手动安装。' }) : null,
      status === 'ready' && sortedDiscovery.length ? h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px' } }, `共 ${sortedDiscovery.length} 个结果。`) : null);

    const catalogLabel = value => ({ builtin: '内置清单', 'builtin+remote': '内置 + 远程索引', remote: '远程索引', profile: 'profile 清单' }[value] || value || '未知来源');
    const installedPanel = h(Fragment, null,
      catalog ? h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.6 } }, `清单来源：${catalogLabel(catalog.source)}${catalog.updatedAt ? `（更新于 ${catalog.updatedAt}）` : ''}`) : null,
      catalog?.error?.message ? h('p', { role: 'status', style: { margin: 0, color: BRAND.signal, fontSize: '11px', lineHeight: 1.6 } }, String(catalog.error.message)) : null,
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取已安装插件', detail: '读取当前 profile 的 bundle 清单与加载状态。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '已安装插件不可用', detail: error, action: h('button', { type: 'button', onClick: () => { void load(); }, style: buttonStyle() }, '重新读取') }) : null,
      status === 'ready'
        ? h(Fragment, null,
          section('异常', errorRows),
          section('已启用', activeRows),
          section('已停用', disabledRows),
          !items.length ? h(EmptyState, { icon: '⌕', title: '还没有安装插件', detail: '到「发现插件」里安装，或使用右上角「手动安装」。' }) : null)
        : null);

    const marketBody = selected
      ? (selectedDiscovery ? discoveryDetail(selected) : installedDetail(selected))
      : h(Fragment, null, toolbar, tab === 'discover' ? discoverPanel : installedPanel);

    return h('div', { 'data-dsh-plugin-center': 'true', style: { display: 'grid', gap: '13px' } },
      error && status !== 'error' ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.signal, fontSize: '12px', lineHeight: 1.55 } }, error) : null,
      message ? h('p', { role: 'status', style: { margin: 0, color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
      busy && !selected ? h('p', { role: 'status', style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px' } }, '正在应用插件变更，请稍候…') : null,
      marketBody,
      installOpen ? h(ResourceDialog, {
        title: '手动安装 DSH 插件',
        detail: '输入 npm 包名、GitHub 仓库（github:owner/repo）或本地 tarball 路径。安装会请求宿主权限，并在当前 Host 生效。',
        onClose: () => { if (!busy) setInstallOpen(false); }
      },
        h('form', { onSubmit: event => { event.preventDefault(); const spec = installSpec.trim(); if (!spec || busy) return; setBusy('manual'); setError(''); setMessage(''); hostRemote.installDshPlugin(spec, true).then(async result => { setInstallSpec(''); setInstallOpen(false); await loadInstalled(); setMessage(`${spec} 已安装。${String(result?.note || '').trim()}`.trim()); }).catch(reason => setError(reason?.message || '安装 DSH 插件失败')).finally(() => setBusy('')); }, style: { display: 'grid', gap: '14px' } },
          h('input', { 'aria-label': 'DSH 插件标识', value: installSpec, onChange: event => setInstallSpec(event.target.value), required: true, placeholder: '@scope/dsh-plugin 或 github:owner/repo', style: inputStyle() }),
          error ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.danger, whiteSpace: 'pre-wrap' } }, error) : null,
          h('button', { type: 'submit', disabled: Boolean(busy) || !installSpec.trim(), style: buttonStyle() }, busy === 'manual' ? '处理中…' : '安装插件'))) : null);
  }
  return { DshPluginMarketItem };
}
