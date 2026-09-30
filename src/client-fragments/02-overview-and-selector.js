    function OverviewPage({ onNavigate }) {
      const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
      const [connection, setConnection] = useState({ status: 'loading', agents: 0, runtimes: 0, error: '' });
      const load = async () => {
        setConnection(current => ({ ...current, status: 'loading', error: '' }));
        try {
          const [health, bootstrap, agentResult, runtimeResult] = await Promise.all([
            hostRemote.health(), hostRemote.bootstrap(), hostRemote.agents(), hostRemote.runtimes(),
          ]);
          const runtimeItems = Array.isArray(runtimeResult?.items)
            ? runtimeResult.items.filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)) : [];
          setConnection({
            status: health?.status === 'ok' && bootstrap?.workspaceReady !== false ? 'ready' : 'error',
            agents: Array.isArray(agentResult?.items) ? agentResult.items.length : 0,
          runtimes: runtimeItems.length,
            error: health?.status === 'ok' ? '' : 'Host health 未通过',
          });
        } catch (reason) {
          setConnection({ status: 'error', agents: 0, runtimes: 0, error: reason?.message || (directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 不可达') });
        }
      };
      useEffect(() => { load(); }, []);
      const hostReady = connection.status === 'ready';
      const readiness = hostReady ? 4 : 3;
      const statusRows = [
        ['AgentKit Studio 应用', true],
        ['官方会话内核', true],
        ['工作台 Dock', true],
        [directServerMode ? 'AgentEngine Server' : 'DSH Host', hostReady],
      ].map(([item, ready], index) => h('div', {
        key: item,
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: index === 3 ? 'none' : '1px solid ' + BRAND.border, fontSize: '13px' },
      }, h('span', { style: { color: BRAND.ink } }, item), h(Pill, { tone: ready ? 'accent' : 'signal' }, ready ? '就绪' : '等待')));
      const hero = h('section', {
        style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.45fr) minmax(260px,0.75fr)', gap: '20px', padding: '24px', borderRadius: '16px', color: BRAND.ink, overflow: 'hidden', background: BRAND.surface, border: '1px solid ' + BRAND.border, boxShadow: '0 8px 24px rgba(0,0,0,0.04)' },
      },
      h('div', null,
        h(Pill, { tone: 'accent' }, '本地工作区'),
        h('h2', { style: { margin: '18px 0 10px', fontSize: '29px', lineHeight: 1.15, letterSpacing: '-0.04em' } }, '把 Agent 从想法交付到运行'),
        h('p', { style: { maxWidth: '560px', color: BRAND.inkMuted, lineHeight: 1.65, margin: 0, fontSize: '14px' } }, '在同一个工作区管理 Agent、运行时、资源和交付版本。对话与工作台会话由底层运行时统一承载。'),
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '22px', flexWrap: 'wrap' } },
          h(DisabledAction, null, '创建第一个 Agent'),
          h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 700 } }, '查看 Agents'))),
      h('div', { style: { alignSelf: 'stretch', borderLeft: '1px solid ' + BRAND.border, paddingLeft: '20px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' } },
        h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'Workspace readiness'),
        h('div', null,
          h('div', { style: { fontSize: '34px', fontWeight: 750, letterSpacing: '-0.04em' } }, `${readiness} / 4`),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '5px' } }, hostReady ? (directServerMode ? 'AgentEngine 控制面已连接' : 'DSH Host 已连接') : (directServerMode ? '等待 AgentEngine Server' : '等待本机 DSH Host')),
          h('div', { style: { marginTop: '18px', height: '5px', borderRadius: '5px', background: BRAND.accentSoft } },
            h('div', { style: { width: `${readiness * 25}%`, height: '100%', borderRadius: '5px', background: BRAND.primaryFill } })))));
      const metrics = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '12px', marginTop: '18px' } },
        h(Metric, { label: 'Agent', value: String(connection.agents), detail: connection.agents ? '当前工作区' : '尚未读取' }), h(Metric, { label: '运行时', value: String(connection.runtimes), detail: hostReady ? 'DSH Native / AgentKit Harness / Codex 可用' : (directServerMode ? '等待 AgentEngine Server' : '等待 DSH Host'), tone: hostReady ? 'neutral' : 'signal' }),
        h(Metric, { label: '资源', value: '—', detail: '尚未绑定' }), h(Metric, { label: '交付', value: '—', detail: '尚未构建' }));
      const cards = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.12fr) minmax(260px,0.88fr)', gap: '18px', marginTop: '18px' } },
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface } },
          h(SectionHeading, { eyebrow: 'Start here', title: '从一个 Agent 开始', detail: directServerMode ? 'Agent、运行时和资源由 AgentEngine Server 控制面提供；本地运行时承载会话与工具执行。' : 'Agent、运行时和资源会在接入 DSH Host 后成为可操作的产品对象。' }),
          connection.status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 DSH Host', detail: directServerMode ? '读取 Server catalog、详情和运行时能力。' : '读取 health、workspace 和 runtime capability。' }) : connection.status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 尚未连接', detail: connection.error || (directServerMode ? '检查 ~/.agentkit 配置、云端凭证和网络。' : '启动本地 DSH Host 后点击重试。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : h(EmptyState, { icon: '✦', title: connection.agents ? '继续配置 Agent' : '创建第一个 Agent', detail: directServerMode ? 'Server catalog 和运行时能力已通过，可以进入 Agents 页面继续。' : 'Host health 与运行时能力已通过，可以进入 Agents 页面创建本地 Agent。', action: h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: buttonStyle() }, '查看 Agents') })),
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface } },
          h(SectionHeading, { eyebrow: 'System', title: '工作区状态', detail: '所有状态都来自唯一的 Host 与会话来源。' }),
          h('div', { style: { display: 'grid', gap: '10px' } }, statusRows)));
      return h('div', null, hero, metrics, cards);
    }

    function AgentCard({ agent, onResources }) {
      const metadata = agent?.metadata || agent || {};
      const spec = agent?.spec || {};
      const runtime = spec.runtime?.type || agent?.runtime?.type || 'harness';
      const bindings = spec.bindings || {};
      const modelCount = Array.isArray(bindings.modelProfileIds) && bindings.modelProfileIds.length
        ? bindings.modelProfileIds.length : bindings.modelProfileId ? 1 : 0;
      const mcpCount = Array.isArray(bindings.mcpServers) ? bindings.mcpServers.length : 0;
      const skillCount = Array.isArray(bindings.skills) ? bindings.skills.length : 0;
      const toolCount = Array.isArray(bindings.tools) ? bindings.tools.length : 0;
      const plugins = Array.isArray(bindings.plugins) ? bindings.plugins : [];
      const platformCount = kind => plugins.filter(item => String(item?.config?.binding?.resource?.kind || '') === kind).length;
      const knowledgeBaseCount = platformCount('knowledge-base');
      const memoryCount = platformCount('memory-instance') || (spec.memory?.enabled ? 1 : 0);
      const skillSpaceCount = platformCount('skill-space');
      return h('article', {
        style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface, boxShadow: '0 8px 24px rgba(11,18,32,0.04)' },
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'flex-start' } },
        h('div', null,
          h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '15px' } }, metadata.name || metadata.id || '未命名 Agent'),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, metadata.id || '—')),
        h(Pill, { tone: runtime === 'dsh-native' || runtime === 'harness' ? 'accent' : 'neutral' }, RUNTIME_LABELS[runtime] || runtime)),
      h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.55, margin: '14px 0 0', fontSize: '12px' } }, spec.description || '本地工作区 Agent，等待绑定模型与首次运行。'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '14px' } },
        h(Pill, { tone: modelCount ? 'accent' : 'signal' }, `模型 ${modelCount}`),
        h(Pill, { tone: mcpCount ? 'accent' : 'neutral' }, `MCP ${mcpCount}`),
        h(Pill, { tone: skillCount ? 'accent' : 'neutral' }, `Skill ${skillCount}`),
        h(Pill, { tone: toolCount ? 'accent' : 'neutral' }, `Tool ${toolCount}`),
        h(Pill, { tone: knowledgeBaseCount ? 'accent' : 'neutral' }, `知识库 ${knowledgeBaseCount}`),
        h(Pill, { tone: memoryCount ? 'accent' : 'neutral' }, `记忆库 ${memoryCount}`),
        h(Pill, { tone: skillSpaceCount ? 'accent' : 'neutral' }, `Skill Center ${skillSpaceCount}`)),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '12px' } },
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #8a97a8)', fontSize: '11px' } }, 'Revision ' + String(metadata.revision || 1)),
        onResources ? h('button', { type: 'button', onClick: () => onResources(metadata.id || agent?.id), style: { border: '1px solid ' + BRAND.border, borderRadius: '7px', padding: '5px 8px', color: BRAND.accentStrong, background: BRAND.surface, fontSize: '10px', fontWeight: 750 } }, '配置资源') : null));
    }

    /**
     * Session-scoped Agent selector. Empty keeps the official DSH native
     * conversation. A dsh-native, no-resource Studio revision is admitted via
     * the Host's public preset registry and selected through DSH's public
     * `agentPresets.select` Remote. Resource-bearing or non-DSH revisions stay
     * The Host admits them through the preset-scoped Studio provider bridge;
     * unsupported resource execution still fails with a typed runtime error.
     */
    function AgentContextSelector({ sessionId, useSessions, studioRemote, inputActions } = {}) {
      const [agents, setAgents] = useState([]);
      const [selected, setSelected] = useState(() => readConversationAgent(sessionId));
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const session = useSessions ? useSessions(state => state?.byId?.[sessionId]) : null;
      const started = Boolean(session && session.blank === false);
      const resourceBound = agent => {
        const bindings = agent?.spec?.bindings || agent?.bindings || {};
        return ['tools', 'mcpServers', 'skills', 'plugins'].some(key => Array.isArray(bindings[key]) ? bindings[key].length > 0 : Boolean(bindings[key]));
      };

      useEffect(() => {
        let alive = true;
        setSelected(readConversationAgent(sessionId));
        setNotice('');
        hostRemote.agents().then(result => {
          if (alive) setAgents(Array.isArray(result?.items) ? result.items : []);
        }).catch(() => { /* no Agent is a valid offline/default state */ });
        return () => { alive = false; };
      }, [sessionId]);

      const select = async event => {
        const value = event.target.value || null;
        setNotice('');
        // Studio patch 007: sync the sidebar filter so the DSH session list
        // narrows to sessions bound to the selected Agent.
        if (window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__) window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__(value || '');
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
          setSelected(value);
          writeConversationAgent(value, sessionId);
          setNotice(resourceBound(selectedRecord) ? '已绑定原生会话适配器' : '已绑定当前会话');
        } catch (error) {
          setNotice(error?.message || 'Agent 尚未具备可用的 DSH provider');
        } finally {
          setBusy(false);
        }
      };
      const selectedAgent = agents.find(agent => (agent?.metadata?.id || agent?.id) === selected);
      return h('div', {
        title: sessionId ? '空白会话可以绑定一个 Agent；首轮发送后锁定。未选择 Agent 时使用 DSH 原生会话。' : '选择 Agent 后请从空白会话开始；首轮发送后绑定关系锁定。',
        style: { display: 'inline-flex', alignItems: 'center', gap: '7px', minWidth: '0', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 },
      },
      h('span', { style: { color: BRAND.accentStrong, whiteSpace: 'nowrap' } }, '智能体'),
      h('select', {
        'aria-label': '选择当前会话智能体',
        value: selected || '',
        onChange: select,
        disabled: busy || started,
        style: { maxWidth: '230px', height: '30px', padding: '0 9px', border: '1px solid ' + BRAND.border, borderRadius: '8px', color: BRAND.ink, background: BRAND.surface, fontSize: '11px', fontWeight: 700 },
      },
      h('option', { value: '' }, '无 Agent · DSH 原生会话'),
      selected && !selectedAgent ? h('option', { value: selected }, `已选：${selected}（暂不可读取）`) : null,
      agents.map(agent => {
        const id = agent?.metadata?.id || agent?.id;
        const name = agent?.metadata?.name || agent?.name || id;
        const runtime = agent?.spec?.runtime?.type || agent?.runtime?.type;
        return h('option', { key: id, value: id }, `${name} · ${RUNTIME_LABELS[runtime] || runtime || 'Agent'}`);
      })),
      h(Pill, { tone: notice && !notice.includes('已绑定') ? 'signal' : selected ? 'accent' : 'neutral' }, busy ? '准入中…' : notice || (selected ? (started ? '已锁定' : '已绑定') : 'DSH 原生')),
      !sessionId && selected && selectedAgent ? h('span', { title: '请从 Agents 页面使用“绑定到新会话”创建原生会话', style: { color: BRAND.inkMuted, fontSize: '10px' } }, '请从 Agents 页面绑定') : null,
      h(NativeAuthoringButton, { inputActions }));

    }

    function StudioSubnav({ items, value, onChange }) {
      return h('nav', {
        'aria-label': 'Studio 二级导航',
        'data-studio-tabs': 'true',
        style: { display: 'flex', flexWrap: 'wrap', gap: 0, padding: 0, marginBottom: '20px', border: 0, borderBottom: '1px solid ' + BRAND.border, borderRadius: 0, background: 'transparent' },
      }, items.map(item => h('button', {
        key: item.id,
        type: 'button',
        onClick: () => onChange(item.id),
        'aria-current': value === item.id ? 'page' : undefined,
        style: { minHeight: '32px', border: 0, borderBottom: '2px solid ' + (value === item.id ? BRAND.accentStrong : 'transparent'), borderRadius: 0, padding: '0 16px', color: value === item.id ? BRAND.accentStrong : BRAND.inkMuted, background: 'transparent', fontSize: '12px', fontWeight: value === item.id ? 800 : 650, cursor: 'pointer' },
      }, item.label)));
    }

    function StudioPageTabs({ items, value, onChange, ariaLabel }) {
      return h('nav', {
        'aria-label': ariaLabel || '页面标签',
        'data-studio-tabs': 'true',
        role: 'tablist',
        style: { display: 'flex', flexWrap: 'wrap', gap: 0, padding: 0, marginBottom: '14px', border: 0, borderBottom: '1px solid ' + BRAND.border, borderRadius: 0, background: 'transparent' },
      }, items.map(item => h('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        'aria-selected': value === item.id,
        onClick: () => onChange(item.id),
        style: { minHeight: '32px', border: 0, borderBottom: '2px solid ' + (value === item.id ? BRAND.accentStrong : 'transparent'), borderRadius: 0, padding: '0 16px', color: value === item.id ? BRAND.accentStrong : BRAND.inkMuted, background: 'transparent', fontSize: '12px', fontWeight: value === item.id ? 800 : 650, cursor: 'pointer' },
      }, item.label)));
    }

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
        h(SectionHeading, { eyebrow: 'Agents / Runtime target', title: '运行目标', detail: '运行时回答“这个 Agent 由谁执行”；它属于 Agent Revision，不是独立会话类型。对话页未选择 Agent 时仍走 DSH 原生会话。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? '目录已读取' : 'Host 待接入') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取运行目标', detail: directServerMode ? '从 AgentEngine Server 读取已注册的运行时能力。' : '从本地 Host 读取可用 Harness capability。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '运行目标不可用', detail: error, action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' && !items.length ? h(EmptyState, { icon: '⌁', title: '没有可用运行目标', detail: 'Host 没有返回 DSH Native、AgentKit Harness 或 Codex capability。' }) : null,
        status === 'ready' && items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' } }, items.map(item => {
          const codexUnavailable = item.runtimeType === 'codex' && !codexProviderReady;
          return h('article', { key: item.runtimeType, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '16px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, RUNTIME_LABELS[item.runtimeType] || item.runtimeType), h(Pill, { tone: codexUnavailable ? 'signal' : 'accent' }, codexUnavailable ? 'Provider 未注册' : '可选')),
          h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, item.runtimeType),
          h('p', { style: { margin: '12px 0 0', color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, codexUnavailable ? '请在插件市场安装并启用官方 @deepseek-ai/dsh-subagent-codex，重启 DSH profile 后再创建 Codex Agent。' : item.description || '由 Host 提供的 Agent 执行目标。'),
          codexUnavailable ? h('button', { type: 'button', onClick: () => { try { window.localStorage.setItem('agentkit-studio:resource-tab', 'marketplace'); } catch {} onNavigate?.('studio-resources'); }, style: { ...buttonStyle(), marginTop: '12px' } }, '打开插件市场') : null);
        })) : null);
    }
