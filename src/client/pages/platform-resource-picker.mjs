export function createPlatformResourcePicker({ ui, window = globalThis.window, hostRemote }) {
  const { React, BRAND, buttonStyle, inputStyle } = ui;
  const { createElement: h, useState, useEffect } = React;
  const PLATFORM_RESOURCE_META = [
    { kind: 'knowledge-base', label: '知识库', description: '绑定云端知识库，Agent 通过只读检索使用。' },
    { kind: 'memory-instance', label: '记忆库', description: '绑定长期记忆实例，用于跨会话召回与写入。' },
    { kind: 'skill-space', label: 'Skill Center', description: '选择云端 Skill Space；与本地 Skill 分开管理。' },
  ];

  function PlatformResourcePicker({ value, onChange, onMemory }) {
    const [catalogs, setCatalogs] = useState({});
    const [status, setStatus] = useState('loading');
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');
    const load = async () => {
      setStatus('loading'); setError('');
      const results = await Promise.allSettled(PLATFORM_RESOURCE_META.map(item => hostRemote.platformResources(item.kind)));
      const next = {};
      PLATFORM_RESOURCE_META.forEach((item, index) => {
        const result = results[index];
        if (result?.status === 'fulfilled') next[item.kind] = result.value;
      });
      setCatalogs(next);
      const failed = results.find(item => item.status === 'rejected');
      setError(failed?.reason?.message || '');
      setStatus(Object.keys(next).length ? 'ready' : 'error');
    };
    useEffect(() => { void load(); }, []);
    useEffect(() => {
      const changed = () => void load();
      window.addEventListener('agentkit-studio:local-agent-changed', changed);
      return () => window.removeEventListener('agentkit-studio:local-agent-changed', changed);
    }, []);
    const bindingKind = binding => String(binding?.config?.binding?.resource?.kind || '');
    const selectedId = kind => String(value.find(binding => bindingKind(binding) === kind)?.config?.binding?.resource?.id || '');
    const missingBindings = PLATFORM_RESOURCE_META.map(meta => {
      const id = selectedId(meta.kind);
      const catalog = catalogs[meta.kind];
      if (!id || status === 'loading' || !catalog?.connectionRef) return null;
      return (catalog.items || []).some(item => item.id === id) ? null : { ...meta, id };
    }).filter(Boolean);
    const select = (kind, resourceId) => {
      const catalog = catalogs[kind];
      if (!catalog?.connectionRef) { setError('请先在设置中填写云端凭证，再连接平台资源。'); return; }
      const retained = value.filter(binding => bindingKind(binding) !== kind);
      if (!resourceId) { onChange(retained); if (kind === 'memory-instance') onMemory(false); return; }
      const resource = (catalog.items || []).find(item => item.id === resourceId);
      if (!resource || resource.disabled) return;
      const config = { schemaVersion: 1, binding: { id: `platform-${kind}`, connectionRef: catalog.connectionRef, resource: { kind, id: resource.id, name: resource.name, region: resource.region }, required: true } };
      if (kind === 'knowledge-base') config.retrieval = { mode: 'tool', topK: 5, maxChars: 16000 };
      if (kind === 'skill-space') Object.assign(config, { selectionMode: 'discovery', selectedSkills: [], includePublic: false, executionMode: 'outer-agent' });
      onChange([...retained, { ecosystem: 'dsh', pluginRef: catalog.pluginRef, snapshotDigest: catalog.pluginSnapshotDigest, components: [catalog.componentId], enabled: true, config }]);
      if (kind === 'memory-instance') onMemory(true);
    };
    const connect = async () => {
      setConnecting(true); setError('');
      try { await hostRemote.bootstrapPlatformResources(); await load(); }
      catch (reason) { setError(reason?.message || '平台资源连接失败'); }
      finally { setConnecting(false); }
    };
    const hasConnection = Object.values(catalogs).some(catalog => Boolean(catalog?.connectionRef));
    return h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface, marginTop: '10px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '6px' } },
        h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, '平台资源'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px' } }, '创建时绑定知识库、记忆库和 Skill Center，引用会写入 Agent Revision。')),
        h('button', { type: 'button', onClick: connect, disabled: connecting || hasConnection, style: buttonStyle() }, connecting ? '连接中…' : hasConnection ? '平台已连接' : '连接金山云')),
      status === 'loading' ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', padding: '8px 0' } }, '正在读取平台资源…') : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px', marginTop: '8px' } }, PLATFORM_RESOURCE_META.map(meta => {
        const catalog = catalogs[meta.kind];
        return h('label', { key: meta.kind, style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, meta.label,
          h('select', { value: selectedId(meta.kind), onChange: event => select(meta.kind, event.target.value), style: inputStyle() },
            h('option', { value: '' }, catalog?.connectionRef ? `不绑定${meta.label}` : '请先连接云端'),
            selectedId(meta.kind) && !(catalog?.items || []).some(item => item.id === selectedId(meta.kind))
              ? h('option', { value: selectedId(meta.kind), disabled: true }, `${selectedId(meta.kind)}（当前不可用，请重新选择）`)
              : null,
            (catalog?.items || []).map(item => h('option', { key: item.id, value: item.id, disabled: item.disabled }, item.disabled ? `${item.name}（不可绑定）` : `${item.name} · ${item.region}`))),
          h('div', { style: { marginTop: '4px', color: BRAND.inkMuted, fontSize: '10px', fontWeight: 400, lineHeight: 1.4 } }, meta.description));
      })),
      missingBindings.length ? h('div', { role: 'alert', style: { marginTop: '8px', color: BRAND.danger, fontSize: '11px', lineHeight: 1.5 } }, `检测到已失效的平台资源：${missingBindings.map(item => `${item.label}（${item.id}）`).join('、')}。请重新选择后再保存。`) : null,
      error ? h('div', { role: 'alert', style: { marginTop: '8px', color: BRAND.danger, fontSize: '11px' } }, error) : null);
  }
  return PlatformResourcePicker;
}
