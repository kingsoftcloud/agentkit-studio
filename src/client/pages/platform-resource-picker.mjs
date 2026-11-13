import { createFormKit } from '../components/form-kit.mjs';

export function createPlatformResourcePicker({
  ui: { React },
  window = globalThis.window, hostRemote
}) {
  const { createElement: h, useState, useEffect } = React;
  const { Section, Row, Select, Button, Note } = createFormKit({ React });
  const PLATFORM_RESOURCE_META = [
    { kind: 'knowledge-base', label: '知识库', description: '绑定云端知识库，Agent 通过只读检索使用。' },
    { kind: 'memory-instance', label: '记忆库', description: '绑定长期记忆实例，用于跨会话召回与写入。' },
    { kind: 'skill-space', label: 'Skill Center', description: '选择云端 Skill Space；与本地 Skill 分开管理。' },
  ];

  function PlatformResourcePicker({ value, onChange, onMemory }) {
    const [catalogs, setCatalogs] = useState({});
    const [status, setStatus] = useState('loading');
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
    const connect = () => {
      window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings'));
      setError('配置云端凭证后，点击刷新资源。');
    };
    const hasConnection = Object.values(catalogs).some(catalog => Boolean(catalog?.connectionRef));
    return Section({ title: h('span', { title: '绑定知识库、记忆库和 Skill Center；引用会随 Agent 配置版本保存。' }, '平台资源'),
      action: h('div', { style: { display: 'flex', gap: '8px' } },
        !hasConnection ? Button({ size: 'sm', onClick: connect }, '配置云端连接') : null,
        Button({ size: 'sm', onClick: load, disabled: status === 'loading' }, '刷新资源')) },
      status === 'loading' ? Note(null, '正在读取平台资源…') : null,
      h('div', null, PLATFORM_RESOURCE_META.map(meta => {
        const catalog = catalogs[meta.kind];
        return Row({ key: meta.kind, className: 'af-row studio-srow', title: h('span', { title: meta.description }, meta.label), desc: meta.description },
          Select({ 'aria-label': meta.label, value: selectedId(meta.kind), onChange: event => select(meta.kind, event.target.value) },
            h('option', { value: '' }, catalog?.connectionRef ? `不绑定${meta.label}` : '请先连接云端'),
            selectedId(meta.kind) && !(catalog?.items || []).some(item => item.id === selectedId(meta.kind))
              ? h('option', { value: selectedId(meta.kind), disabled: true }, `${selectedId(meta.kind)}（当前不可用，请重新选择）`)
              : null,
            (catalog?.items || []).map(item => h('option', { key: item.id, value: item.id, disabled: item.disabled }, item.disabled ? `${item.name}（不可绑定）` : `${item.name} · ${item.region}`))));
      })),
      missingBindings.length ? Note({ role: 'alert', tone: 'danger' }, `检测到已失效的平台资源：${missingBindings.map(item => `${item.label}（${item.id}）`).join('、')}。请重新选择后再保存。`) : null,
      error ? Note({ role: 'alert', tone: 'danger', title: error }, error) : null);
  }
  return PlatformResourcePicker;
}
