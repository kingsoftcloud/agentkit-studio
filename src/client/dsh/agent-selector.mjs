import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { BRAND as DEFAULT_BRAND, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';

export function createAgentSelector({
  ui: { React: { createElement: h, useEffect, useState }, IconChevronDownOutlineRegular, Input, Menu, MenuItemButton, NativeAuthoringButton, BRAND = DEFAULT_BRAND, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS },
  hostRemote, readConversationAgent, writeConversationAgent
}) {
  function AgentContextSelector({ sessionId, useSessions, studioRemote, modelDirectories, inputActions } = {}) {
    const [agents, setAgents] = useState([]);
    const [selected, setSelected] = useState(() => readConversationAgent(sessionId));
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState('');
    const session = useSessions ? useSessions(state => state?.byId?.[sessionId]) : null;
    const presetId = session?.projectionValues?.agentPreset;
    const started = Boolean(session && session.blank === false);
    const resourceBound = agent => {
      const bindings = agent?.spec?.bindings || agent?.bindings || {};
      return ['tools', 'mcpServers', 'skills', 'plugins'].some(key => Array.isArray(bindings[key]) ? bindings[key].length > 0 : Boolean(bindings[key]));
    };
    const setAgentPermission = async targetSessionId => {
      try {
        const result = await studioRemote?.commands?.execute?.(targetSessionId, '/permission workspace-write', []);
        if (result && result.ok === false) console.warn('[agentkit-studio] Agent permission default was not applied:', result.error?.message || result.error);
      } catch (error) {
        // Older DSH profiles may not expose the permission command. The
        // Agent binding remains valid because runtime context is already
        // disabled in the Studio persona configuration.
        console.warn('[agentkit-studio] Agent permission default unavailable:', error?.message || error);
      }
    };

    useEffect(() => {
      let alive = true;
      const selectedAgent = readConversationAgent(sessionId);
      setSelected(selectedAgent);
      setNotice('');
      setOpen(false);
      setLoading(true);
      (async () => {
        const first = await hostRemote.agents({ source: 'all', pageSize: 100 });
        const items = [...(first?.items || [])];
        for (let page = 2; alive && items.length < Number(first?.total || 0); page += 1) {
          const next = await hostRemote.agents({ source: 'all', pageSize: 100, page });
          if (!next?.items?.length) break;
          items.push(...next.items);
        }
        return { items };
      })().then(result => {
        if (!alive) return;
        const items = Array.isArray(result?.items) ? result.items : [];
        setAgents(items);
        if (typeof presetId === 'string') {
          const actualAgent = agentFromSessionPreset(presetId, items);
          setSelected(actualAgent);
          writeConversationAgent(actualAgent, sessionId);
        }
      }).catch(error => { if (alive) setNotice(error?.message || 'Agent 目录暂不可读取'); }).finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }, [sessionId, presetId]);

    const select = async value => {
      value = value || null;
      setOpen(false);
      setNotice('');
      if (!value) {
        if (started || !sessionId || typeof studioRemote?.agentPresets?.select !== 'function') {
          setSelected(null);
          writeConversationAgent(null, sessionId);
          if (started) setNotice('会话已开始，Agent 不能中途切换');
          return;
        }
        setBusy(true);
        try {
          // DSH's public registry has no "unbind" operation. Selecting its
          // published default preset is the official way to restore the
          // native DSH composition before the first turn.
          const roster = await studioRemote.agentPresets.list?.();
          const presets = roster?.value?.presets || roster?.presets || [];
          const fallback = presets.find(preset => preset?.isDefault)?.id || 'standard';
          const restored = await studioRemote.agentPresets.select(sessionId, fallback);
          if (restored === undefined || restored === null
            || (typeof restored === 'object' && restored.ok === false)) {
            throw new Error(restored?.error?.message || 'DSH 默认 preset 恢复失败');
          }
          setSelected(null);
          writeConversationAgent(null, sessionId);
          setNotice('已恢复 DSH 原生会话');
        } catch (error) {
          setNotice(error?.message || 'DSH 默认会话恢复失败');
        } finally {
          setBusy(false);
        }
        return;
      }
      if (started) {
        setNotice('会话已开始，Agent 不能中途切换');
        return;
      }
      if (!sessionId) {
        setNotice('请先打开一个空白会话再绑定 Agent');
        return;
      }
      const selectedRecord = agents.find(agent => (agent?.metadata?.id || agent?.id) === value);
      if (typeof studioRemote?.agentPresets?.select !== 'function') {
        // Never present a localStorage value as a successful binding when
        // the official DSH Remote is absent. The profile must mount the
        // public agent-preset service, otherwise the choice has no effect.
        setNotice('DSH Agent preset 服务未启用，当前选择未生效');
        return;
      }
      setBusy(true);
      try {
        const admission = await hostRemote.ensureDshPreset(value);
        const selectedPreset = await studioRemote.agentPresets.select(sessionId, admission.presetId);
        // The public DSH Remote returns {ok,value}; direct registry
        // adapters return the selected preset id. Accept both contracts.
        if (selectedPreset === undefined || selectedPreset === null
          || (typeof selectedPreset === 'object' && selectedPreset.ok === false)) {
          const refusal = new Error(selectedPreset?.error?.message || 'DSH 拒绝绑定该 Agent');
          refusal.code = selectedPreset?.error?.code || 'DSH_PRESET_SELECT_FAILED';
          refusal.details = selectedPreset?.error?.details;
          throw refusal;
        }
        if (admission.modelSelection) {
          const selectedModel = await studioRemote.session.selectModel({ sessionId, ...admission.modelSelection, saveDefault: false });
          if (!selectedModel?.ok) throw new Error(selectedModel?.error?.message || 'Agent 绑定的模型不可用');
        }
        await setAgentPermission(sessionId);
        setSelected(admission.agentId || value);
        writeConversationAgent(admission.agentId || value, sessionId);
        setNotice(resourceBound(selectedRecord) ? '已绑定原生会话适配器' : '已绑定当前会话');
      } catch (error) {
        setNotice(error?.message || 'Agent 尚未具备可用的 DSH provider');
      } finally {
        setBusy(false);
      }
    };
    const selectedAgent = agents.find(agent => (agent?.metadata?.id || agent?.id) === selected);
    const filtered = agents.filter(agent => !agent.assistant?.configuration && !(agent.metadata?.purpose === 'personal-assistant' && !agent.deployment)).filter(agent => [agent.metadata?.name, agent.metadata?.id, agent.name, agent.id].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase()));
    const name = selectedAgent?.metadata?.name || selectedAgent?.name || (selected ? '已绑定 Agent' : '选择 Agent');
    const runtime = selectedAgent?.spec?.runtime?.type;
    return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0, color: BRAND.inkMuted, fontSize: '12px' } },
      h('style', null, `.studio-agent-picker { width: 320px; max-width: calc(100vw - 32px); } .studio-agent-picker > [role="presentation"] { max-height: 320px; overflow-y: auto; } .studio-agent-picker [role="menuitem"] { min-width: 0; } .studio-agent-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, #f3f3f3) !important; }`),
      h(Menu, {
        open: open && !busy && !started,
        portal: true, compact: true, listClassName: 'studio-agent-picker',
        onClose: () => setOpen(false),
        anchor: h('button', {
          type: 'button', className: 'studio-agent-trigger', 'data-studio-session-id': sessionId, 'aria-label': '选择当前会话智能体',
          'aria-haspopup': 'menu', 'aria-expanded': open, disabled: busy || started,
          title: started ? '会话已开始，Agent 已锁定' : name,
          onClick: () => { setSearch(''); setOpen(current => !current); },
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: '240px', height: '30px', padding: '0 8px', border: 0, borderRadius: '8px', color: BRAND.ink, background: 'transparent', fontSize: '13px', cursor: 'pointer' },
        }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, busy ? '正在绑定…' : name), h(IconChevronDownOutlineRegular, { size: 12 })),
      },
        h('div', { style: { display: 'grid', padding: '6px 6px 10px' } }, h(Input, { autoFocus: true, type: 'search', value: search, placeholder: '搜索 Agent', 'aria-label': '搜索会话 Agent', onChange: event => setSearch(event.target.value), onKeyDown: event => { if (['Home', 'End'].includes(event.key)) event.stopPropagation(); } })),
        h(MenuItemButton, { onSelect: () => select(null) }, '不使用 Agent'),
        h('div', { role: 'separator', style: { margin: '6px 0', borderTop: '1px solid ' + BRAND.border } }),
        loading ? h('div', { role: 'status', style: { padding: '12px', color: BRAND.inkMuted } }, '正在加载…') : filtered.length ? filtered.map(agent => {
          const id = agent.metadata?.id || agent.id;
          return h(MenuItemButton, { key: id, disabled: agent.deployment?.available === false, onSelect: () => select(id) }, h('span', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, agent.metadata?.name || agent.name || id), h('span', { style: { fontSize: '11px', color: BRAND.inkMuted } }, agent.deployment ? (agent.metadata?.purpose === 'personal-assistant' ? '个人助理 · 云端' : '云端') : '本地'), selected === id ? h('span', { 'aria-label': '已选择' }, '✓') : null));
        }) : h('div', { role: 'status', style: { padding: '12px', color: BRAND.inkMuted } }, search ? '没有匹配的 Agent' : '还没有本地 Agent')),
      selected && runtime ? h('span', { style: { whiteSpace: 'nowrap', fontSize: '11px' } }, `${selectedAgent?.deployment ? '云端 · ' : '本地 · '}${RUNTIME_LABELS[runtime]}`) : null,
      selectedAgent?.assistant?.configuration ? h('span', { role: 'status', style: { maxWidth: '320px', fontSize: '11px' } }, '此历史会话使用本地配置，请选择云端个人助理开启新会话。') : null,
      notice && !notice.startsWith('已') ? h('span', { role: 'status', style: { maxWidth: '320px', color: BRAND.inkMuted, fontSize: '11px' } }, notice) : null,
      h(NativeAuthoringButton, { inputActions }));
  }
  return AgentContextSelector;
}
