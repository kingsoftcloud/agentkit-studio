import { ALLOWED_RUNTIME_TYPES as DEFAULT_ALLOWED_RUNTIME_TYPES, BRAND as DEFAULT_BRAND, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';

export function createRuntimeCatalogPage({
  ui: { React: { createElement: h, useEffect, useState }, EmptyState, Pill, SectionHeading, buttonStyle, ALLOWED_RUNTIME_TYPES = DEFAULT_ALLOWED_RUNTIME_TYPES, BRAND = DEFAULT_BRAND, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS },
  hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent
}) {
  function RuntimeCatalogPage({ onNavigate }) {
    const [status, setStatus] = useState('loading');
    const [items, setItems] = useState([]);
    const [codexProviderReady, setCodexProviderReady] = useState(true);
    const [error, setError] = useState('');
    const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
    const load = async () => {
      setStatus('loading'); setError('');
      try {
        const [result, pluginResult] = await Promise.all([
          hostRemote.runtimes(),
          directServerMode ? Promise.resolve(null) : hostRemote.dshPlugins().catch(() => null),
        ]);
        setItems((result?.items || []).filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)));
        if (!directServerMode && pluginResult) {
          const codex = (pluginResult.items || []).find(item => String(item.pluginId || item.id || item.name || '').includes('subagent-codex'));
          setCodexProviderReady(Boolean(codex?.installed && codex?.enabled !== false));
        }
        setStatus('ready');
      } catch (reason) { setError(reason?.message || 'Host 尚未连接'); setStatus('error'); }
    };
    useEffect(() => { void load(); }, []);
    return h('div', null,
      h(SectionHeading, { compact: true, title: '运行目标', detail: '当前 Host 可用的 Agent 执行目标，创建 Agent 时在「运行时」中选择。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? '目录已读取' : 'Host 待接入') }),
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取运行目标', detail: directServerMode ? '从 AgentEngine Server 读取已注册的运行时能力。' : '从本地 Host 读取可用 Harness capability。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '运行目标不可用', detail: error, action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取') }) : null,
      status === 'ready' && !items.length ? h(EmptyState, { icon: '⌁', title: '没有可用运行目标', detail: 'Host 没有返回 DSH Native、AgentKit Harness 或 Codex capability。' }) : null,
      status === 'ready' && items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' } }, items.map(item => {
        const codexUnavailable = item.runtimeType === 'codex' && !codexProviderReady;
        return h('article', { key: item.runtimeType, style: { border: '0.5px solid var(--dsw-alias-border-l2, #e5e5e5)', borderRadius: 'var(--dsw-radius-xl, 16px)', padding: '16px', background: BRAND.surface } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, RUNTIME_LABELS[item.runtimeType] || item.runtimeType), h(Pill, { tone: codexUnavailable ? 'signal' : 'accent' }, codexUnavailable ? 'Provider 未注册' : '可选')),
        h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, item.runtimeType),
        h('p', { style: { margin: '12px 0 0', color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, codexUnavailable ? '请在插件中心安装并启用官方 @deepseek-ai/dsh-subagent-codex，重启 DSH profile 后再创建 Codex Agent。' : item.description || '由 Host 提供的 Agent 执行目标。'),
        codexUnavailable ? h('button', { type: 'button', onClick: () => { window.dispatchEvent(new CustomEvent('agentkit-studio:open-plugin-center')); }, style: { ...buttonStyle(), marginTop: '12px' } }, '打开插件中心') : null);
      })) : null);
  }
  return RuntimeCatalogPage;
}
