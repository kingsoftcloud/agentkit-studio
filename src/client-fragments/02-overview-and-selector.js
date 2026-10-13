    function OverviewPage({ onNavigate }) {
      const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
      const [connection, setConnection] = useState({ status: 'loading', agents: 0, runtimes: 0, error: '' });
      const [credential, setCredential] = useState({ status: 'loading', configured: true });
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
            agents: Number(agentResult?.total) || (Array.isArray(agentResult?.items) ? agentResult.items.length : 0),
            cloudConnected: agentResult?.cloudConnected !== false,
            warning: (agentResult?.warnings || []).map(item => item.message).join(' '),
            runtimes: runtimeResult?.source === 'dsh' ? null : runtimeItems.length,
            error: health?.status === 'ok' ? '' : 'Host health 未通过',
          });
        } catch (reason) {
          setConnection({ status: 'error', agents: 0, runtimes: 0, error: reason?.message || (directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 不可达') });
        }
      };
      useEffect(() => { load(); }, []);
      useEffect(() => {
        let active = true;
        hostRemote.modelCredentialStatus().then(result => {
          if (active) setCredential({ status: 'ready', configured: result?.configured === true, source: result?.source || 'unknown' });
        }).catch(error => {
          if (active) setCredential({ status: 'error', configured: true, error: error?.message || '凭证状态暂不可用' });
        });
        return () => { active = false; };
      }, []);
      const hostReady = connection.status === 'ready';
      const hero = h('section', {
        style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: '20px', padding: '24px', borderRadius: '16px', color: BRAND.ink, overflow: 'hidden', background: BRAND.surface, border: '1px solid ' + BRAND.border, boxShadow: '0 8px 24px rgba(0,0,0,0.04)' },
      },
      h('div', null,
        h(Pill, { tone: 'accent' }, '本地工作区'),
        h('h2', { style: { margin: '18px 0 10px', fontSize: '29px', lineHeight: 1.15, letterSpacing: '-0.04em' } }, '把 Agent 从想法交付到运行'),
        h('p', { style: { maxWidth: '560px', color: BRAND.inkMuted, lineHeight: 1.65, margin: 0, fontSize: '14px' } }, '在同一个工作区管理 Agent、运行时、资源和交付版本。对话与工作台会话由底层运行时统一承载。'),
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '22px', flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: buttonStyle() }, '创建第一个 Agent'),
          h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: BRAND.ink, background: BRAND.surface, fontSize: '12px', fontWeight: 700 } }, '查看 Agents'))),
      );
      const metrics = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '12px', marginTop: '18px' } },
        h(Metric, { label: 'Agent', value: String(connection.agents), detail: hostReady ? '当前目录总数' : '尚未读取' }), h(Metric, { label: '运行时', value: connection.runtimes === null ? '未提供' : String(connection.runtimes), detail: connection.runtimes === null ? '当前连接未提供目录' : hostReady ? '已发现的运行时类型' : '等待 DSH Host', tone: hostReady ? 'neutral' : 'signal' }),
        h(Metric, { label: '资源', value: '资源库', detail: '查看与绑定资源' }), h(Metric, { label: '交付', value: '构建与部署', detail: '在 Agent 中管理版本' }));
      const cards = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: '18px', marginTop: '18px' } },
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface } },
          h(SectionHeading, { eyebrow: 'Start here', title: '从一个 Agent 开始', detail: directServerMode ? 'Agent、运行时和资源由 AgentEngine Server 控制面提供；本地运行时承载会话与工具执行。' : 'Agent、运行时和资源会在接入 DSH Host 后成为可操作的产品对象。' }),
          connection.status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 DSH Host', detail: directServerMode ? '读取 Server catalog、详情和运行时能力。' : '读取 health、workspace 和 runtime capability。' }) : connection.status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 尚未连接', detail: connection.error || (directServerMode ? '检查 ~/.agentkit 配置、云端凭证和网络。' : '启动本地 DSH Host 后点击重试。'), action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : h(EmptyState, { icon: '✦', title: connection.agents ? '继续配置 Agent' : '创建第一个 Agent', detail: directServerMode ? (connection.warning || '已读取 Agent 目录，可以进入 Agents 页面继续配置。') : '已连接 Host，可以进入 Agents 页面配置本地 Agent。', action: h('button', { type: 'button', onClick: () => onNavigate && onNavigate('studio-agents'), style: buttonStyle() }, '查看 Agents') })),
      );
      const credentialGuide = credential.status === 'ready' && !credential.configured ? h('section', {
        role: 'status', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '18px', padding: '15px 18px', border: '1px solid ' + BRAND.border, borderRadius: '14px', background: BRAND.surface },
      }, h('div', null, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '14px' } }, '先配置一个模型凭证'), h('span', { style: { display: 'block', marginTop: '5px', color: BRAND.inkMuted, fontSize: '12px' } }, '首次使用前完成 API Key 配置，Agent 对话和 DSH Native 模型目录才能正常工作。')), h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings')), style: buttonStyle() }, '去配置模型凭证')) : null;
      return h('div', null, credentialGuide, h(StartChecks), hero, metrics, cards);
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
          const result = await studioRemote?.commands?.execute?.(targetSessionId, '/permission read-only', []);
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
        window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__?.(selectedAgent || '');
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
            window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__?.(actualAgent || '');
          }
        }).catch(error => { if (alive) setNotice(error?.message || 'Agent 目录暂不可读取'); }).finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
      }, [sessionId, presetId]);

      const select = async value => {
        value = value || null;
        setOpen(false);
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
          if (admission.modelSelection) {
            const selectedModel = await studioRemote.session.selectModel({ sessionId, ...admission.modelSelection, saveDefault: false });
            if (!selectedModel?.ok) throw new Error(selectedModel?.error?.message || 'Agent 绑定的模型不可用');
          }
          await setAgentPermission(sessionId);
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
      const filtered = agents.filter(agent => [agent.metadata?.name, agent.metadata?.id, agent.name, agent.id].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase()));
      const name = selectedAgent?.metadata?.name || selectedAgent?.name || (selected ? '已绑定 Agent' : '选择 Agent');
      const runtime = selectedAgent?.spec?.runtime?.type;
      return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0, color: BRAND.inkMuted, fontSize: '12px' } },
        h('style', null, `.studio-agent-picker { width: 320px; max-width: calc(100vw - 32px); } .studio-agent-picker > [role="presentation"] { max-height: 320px; overflow-y: auto; } .studio-agent-picker [role="menuitem"] { min-width: 0; } .studio-agent-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, #f3f3f3) !important; }`),
        h(Menu, {
          open: open && !busy && !started,
          portal: true, compact: true, listClassName: 'studio-agent-picker',
          onClose: () => setOpen(false),
          anchor: h('button', {
            type: 'button', className: 'studio-agent-trigger', 'aria-label': '选择当前会话智能体',
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
            return h(MenuItemButton, { key: id, disabled: agent.deployment?.available === false, onSelect: () => select(id) }, h('span', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, agent.metadata?.name || agent.name || id), agent.deployment ? h('span', { style: { fontSize: '11px', color: BRAND.inkMuted } }, '云端') : null, selected === id ? h('span', { 'aria-label': '已选择' }, '✓') : null));
          }) : h('div', { role: 'status', style: { padding: '12px', color: BRAND.inkMuted } }, search ? '没有匹配的 Agent' : '还没有本地 Agent')),
        selected && runtime ? h('span', { style: { whiteSpace: 'nowrap', fontSize: '11px' } }, RUNTIME_LABELS[runtime]) : null,
        notice && !notice.startsWith('已') ? h('span', { role: 'status', style: { maxWidth: '320px', color: BRAND.inkMuted, fontSize: '11px' } }, notice) : null,
        h(NativeAuthoringButton, { inputActions }));
    }

    function CloudSessionStatus({ sessionId, useSessions }) {
      const session = useSessions(state => state?.byId?.[sessionId]);
      const presetId = session?.projectionValues?.agentPreset;
      const [agent, setAgent] = useState(null), [open, setOpen] = useState(false), [receipt, setReceipt] = useState(null), [error, setError] = useState('');
      useEffect(() => {
        let active = true; setAgent(null); setReceipt(null); setOpen(false);
        (async () => {
          const first = await hostRemote.agents({ source: 'cloud', pageSize: 100 });
          const items = [...(first.items || [])];
          for (let page = 2; active && items.length < Number(first.total || 0); page++) {
            const next = await hostRemote.agents({ source: 'cloud', pageSize: 100, page });
            if (!next.items?.length) break;
            items.push(...next.items);
          }
          return { items };
        })().then(result => {
          const rows = result.items || [], id = agentFromSessionPreset(presetId, rows);
          if (active) setAgent(rows.find(item => item.metadata?.id === id) || null);
        }).catch(() => {});
        return () => { active = false; };
      }, [sessionId, presetId]);
      useEffect(() => {
        if (!open || !agent) return;
        let active = true;
        const load = async () => {
          try {
            const rows = (await hostRemote.traces(`range=7d&agentId=${encodeURIComponent(agent.metadata.id)}`)).items || [];
            if (active) { setReceipt(rows.find(item => item.sessionId === sessionId && item.executionLocation === 'cloud') || null); setError(''); }
          } catch { if (active) setError('执行凭据读取失败，请稍后刷新。'); }
        };
        void load(); const timer = setInterval(load, 5000);
        return () => { active = false; clearInterval(timer); };
      }, [open, agent, sessionId]);
      if (!agent?.deployment) return null;
      const deployment = agent.deployment, bindings = agent.spec?.bindings || {}, plugins = bindings.plugins || [];
      const pairs = [['云端实例', agent.metadata.id], ['环境', `${deployment.environment === 'pre-online' ? '预发' : deployment.environment} · ${deployment.region}`],
        ['当前部署版本', `r${agent.metadata.revision} · ${deployment.buildId}`], ['当前绑定模型', (deployment.models || [deployment.model]).join('、')],
        ['MCP', (bindings.mcpServers || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id).join('、') || '未绑定'],
        ['Skill', (bindings.skills || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id).join('、') || '未绑定'],
        ...[['knowledge-base', '知识库'], ['memory-instance', '记忆库'], ['skill-space', 'Skill Center']].map(([kind, label]) => {
          const resource = plugins.find(item => item.config?.binding?.resource?.kind === kind)?.config.binding.resource;
          return [label, resource?.id || resource?.resourceId || '未绑定'];
        })];
      return h(React.Fragment, null, h('button', { type: 'button', onClick: () => setOpen(true), title: agent.metadata.id, style: { ...buttonStyle(), fontSize: '11px', padding: '4px 8px' } }, '云端 · ' + (deployment.environment === 'pre-online' ? '预发' : deployment.environment)),
        open ? h(ResourceDialog, { title: '云端 Agent 与执行凭据', detail: '绑定清单来自云端冻结版本；每轮响应身份由 Host 核验。', onClose: () => setOpen(false), wide: true },
          h('dl', { style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '10px 18px', overflowWrap: 'anywhere' } }, pairs.map(([key, value]) => h(React.Fragment, { key }, h('dt', null, key), h('dd', { style: { margin: 0 } }, value)))),
          receipt ? h('div', null, h('h4', null, '最近一轮 · 云端响应已核验'), h('p', null, `${receipt.status} · ${receipt.provenance.model} · ${operationalDate(receipt.completedAt)}`),
            h('p', { style: { overflowWrap: 'anywhere', fontSize: '12px' } }, `本轮版本：r${receipt.provenance.revision || '—'} · ${receipt.provenance.buildId}`),
            receipt.provenance.resourceBindings ? h('p', { style: { fontSize: '12px', overflowWrap: 'anywhere' } }, '本轮绑定：',
              [`MCP ${(receipt.provenance.resourceBindings.mcpServers || []).join('、') || '无'}`, `Skill ${(receipt.provenance.resourceBindings.skills || []).join('、') || '无'}`,
                ...(receipt.provenance.resourceBindings.platform || []).map(item => `${{ 'knowledge-base': '知识库', 'memory-instance': '记忆库', 'skill-space': 'Skill Center' }[item.kind] || item.kind} ${item.id}`)].join(' · ')) : null,
            h('p', { style: { overflowWrap: 'anywhere', fontSize: '12px' } }, `Response ID：${receipt.provenance.responseId}`),
            receipt.provenance.resourceChecks?.length ? h('ul', null, receipt.provenance.resourceChecks.map((check, i) => h('li', { key: i }, `${check.kind} · ${check.action} · ${check.resourceId} · ${check.status}${check.hitCount !== undefined ? ` · 命中 ${check.hitCount}` : ''}${check.definitionCount !== undefined ? ` · 已加载 ${check.definitionCount} 项定义` : ''}${check.accepted !== undefined ? ` · 写入${check.accepted ? '已受理' : '未受理'}` : ''}${check.code ? ' · ' + check.code : ''} · ${check.durationMs} ms`))) : h('p', null, '本轮没有资源调用凭据。旧镜像尚不返回此信息；不能据此判定资源执行成功。'))
            : h('p', null, '此会话尚无云端响应凭据。完成一轮云端对话后可核对，历史版本不会补造凭据。'),
          error ? h('p', { role: 'alert' }, error) : null) : null);
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
          h('p', { style: { margin: '12px 0 0', color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, codexUnavailable ? '请在插件中心安装并启用官方 @deepseek-ai/dsh-subagent-codex，重启 DSH profile 后再创建 Codex Agent。' : item.description || '由 Host 提供的 Agent 执行目标。'),
          codexUnavailable ? h('button', { type: 'button', onClick: () => { window.dispatchEvent(new CustomEvent('agentkit-studio:open-plugin-center')); }, style: { ...buttonStyle(), marginTop: '12px' } }, '打开插件中心') : null);
        })) : null);
    }
