    function ChannelsPage() {
      const [status, setStatus] = useState('loading');
      const [error, setError] = useState('');
      const [connection, setConnection] = useState(null);
      const [channels, setChannels] = useState([]);
      const [pairings, setPairings] = useState([]);
      const [bindings, setBindings] = useState([]);
      const [messages, setMessages] = useState([]);
      const [tab, setTab] = useState('channels');
      const [config, setConfig] = useState({ serverUrl: '', accountId: '', workspaceId: '', apiToken: '' });
      const [saving, setSaving] = useState(false);
      const [actionBusy, setActionBusy] = useState('');
      const [channelEditor, setChannelEditor] = useState(null);
      const [channelQr, setChannelQr] = useState(null);
      const [channelForm, setChannelForm] = useState({ AppId: '', AppSecret: '', AgentId: '', ConnectorWorkspaceId: '', Channel: 'wps-xiezuo', ChannelAccountId: '', DmPolicy: 'pairing', GroupPolicy: 'allowlist', RequireMention: true, SessionScope: 'per-peer', Enabled: true, ConfigJson: '{}' });
      const [channelSaving, setChannelSaving] = useState(false);
      const [channelPage, setChannelPage] = useState(0);
      const [pairingPage, setPairingPage] = useState(0);
      const [bindingPage, setBindingPage] = useState(0);
      const [messagePage, setMessagePage] = useState(0);
      const [activeTakeovers, setActiveTakeovers] = useState({});
      const [selectedConversationId, setSelectedConversationId] = useState('');
      const [connectorAgentId, setConnectorAgentId] = useState('');
      const [connectorToken, setConnectorToken] = useState('');
      const [connectorBusy, setConnectorBusy] = useState(false);
      const channelPageSize = 10;
      const channelSecondaryPageSize = 10;
      const channelData = payload => payload?.Data || payload?.data || payload;
      const listAction = async action => channelData(await hostRemote.channelAction(action, { Offset: 0, Limit: 100 }));
      const load = async () => {
        setStatus('loading'); setError('');
        const results = await Promise.allSettled([hostRemote.channelConnection(), listAction('ListChannels'), listAction('ListPairingRequests'), listAction('ListBindings'), listAction('ListMessages')]);
        if (results[0].status === 'fulfilled') {
          const value = results[0].value || {}; setConnection(value); setConfig(previous => ({ ...previous, serverUrl: value.serverUrl || '', accountId: value.accountId || '', workspaceId: value.workspaceId || '' }));
        }
        if (results[1].status === 'fulfilled') setChannels(operationalCollection(results[1].value, ['Items', 'items']));
        if (results[2].status === 'fulfilled') setPairings(operationalCollection(results[2].value, ['Items', 'items']));
        if (results[3].status === 'fulfilled') setBindings(operationalCollection(results[3].value, ['Items', 'items']));
        if (results[4].status === 'fulfilled') setMessages(operationalCollection(results[4].value, ['Items', 'items']));
        setChannelPage(0); setPairingPage(0); setBindingPage(0); setMessagePage(0);
        if (results[3].status === 'fulfilled') {
          const bindingItems = operationalCollection(results[3].value, ['Items', 'items']);
          const takeoverPairs = await Promise.all(bindingItems.slice(0, 100).map(async binding => {
            try {
              const value = await hostRemote.channelAction('GetActiveTakeover', { BindingId: operationalId(binding) });
              const takeover = value?.Takeover || value?.takeover || value?.Data?.Takeover;
              return [operationalId(binding), takeover?.Id || takeover?.id || null];
            } catch { return [operationalId(binding), null]; }
          }));
          setActiveTakeovers(Object.fromEntries(takeoverPairs.filter(([, id]) => id)));
        }
        const firstError = results.find(item => item.status === 'rejected');
        if (results.every(item => item.status === 'rejected')) { setStatus('error'); setError(firstError.reason?.message || 'Channel Host 不可用'); return; }
        setStatus('ready');
        if (firstError) setError(firstError.reason?.message || '部分渠道数据读取失败，请检查连接配置。');
      };
      useEffect(() => { void load(); }, []);
      useEffect(() => {
        let active = true, pending = false;
        const timer = setInterval(async () => {
          if (pending) return;
          pending = true;
          try { const value = await hostRemote.channelConnection(); if (active) setConnection(value); } catch {} finally { pending = false; }
        }, 3000);
        return () => { active = false; clearInterval(timer); };
      }, []);
      const saveConnection = async event => {
        event.preventDefault(); setSaving(true); setError('');
        try { const value = await hostRemote.updateChannelConnection({ serverUrl: config.serverUrl.trim(), accountId: config.accountId.trim(), workspaceId: config.workspaceId.trim(), ...(config.apiToken ? { apiToken: config.apiToken } : {}) }); setConnection(value); setConfig(previous => ({ ...previous, apiToken: '' })); await load(); }
        catch (reason) { setError(reason?.message || '保存 Channel 连接失败'); }
        finally { setSaving(false); }
      };
      const saveAgentConnection = async (agentId, enabled) => {
        if (!agentId || connectorBusy) return;
        setConnectorBusy(true); setError('');
        try {
          const value = await hostRemote.updateAgentChannelConnection(agentId, { enabled, ...(enabled && connectorToken && agentId === connectorAgentId ? { token: connectorToken } : {}) });
          setConnection(value); setConnectorToken('');
        } catch (reason) { setError(reason?.message || '本地 Agent 连接失败'); }
        finally { setConnectorBusy(false); }
      };
      const pairingAction = async (id, action) => { setActionBusy(id); try { await hostRemote.channelAction(action, { Id: id }); await load(); } catch (reason) { setError(reason?.message || `${action} 失败`); } finally { setActionBusy(''); } };
      const openChannelEditor = channel => {
        setChannelEditor(channel ? operationalId(channel) : 'new');
        setChannelForm(channel ? { AppId: '', AppSecret: '', AgentId: channel?.AgentId || channel?.agentId || '', ConnectorWorkspaceId: channel?.ConnectorWorkspaceId || channel?.connectorWorkspaceId || '', Channel: channel?.Channel || channel?.channel || 'wps-xiezuo', ChannelAccountId: channel?.ChannelAccountId || channel?.channelAccountId || '', DmPolicy: channel?.DmPolicy || channel?.dmPolicy || 'pairing', GroupPolicy: channel?.GroupPolicy || channel?.groupPolicy || 'allowlist', RequireMention: channel?.RequireMention ?? channel?.requireMention ?? true, SessionScope: channel?.SessionScope || channel?.sessionScope || 'per-peer', Enabled: channel?.Enabled ?? channel?.enabled ?? true, ConfigJson: channel?.ConfigJson || channel?.configJson || '{}' } : { AppId: '', AppSecret: '', AgentId: '', ConnectorWorkspaceId: '', Channel: 'wps-xiezuo', ChannelAccountId: '', DmPolicy: 'pairing', GroupPolicy: 'allowlist', RequireMention: true, SessionScope: 'per-peer', Enabled: true, ConfigJson: '{}' });
      };
      const saveChannel = async event => {
        event.preventDefault();
        if (!channelForm.AgentId.trim() || !channelForm.ChannelAccountId.trim() || channelSaving) return;
        setChannelSaving(true); setError('');
        try {
          const action = channelEditor && channelEditor !== 'new' ? 'UpdateChannel' : 'CreateChannel';
          const creating = action === 'CreateChannel';
          if (creating && (!channelForm.AppId.trim() || !channelForm.AppSecret.trim())) throw new Error('请填写应用 App ID 和 App Secret');
          const { AppId, AppSecret, Channel, ChannelAccountId, Enabled, ...policy } = channelForm;
          const payload = { ...policy, AgentId: channelForm.AgentId.trim(), ...(creating
            ? { Channel, ChannelAccountId: ChannelAccountId.trim(), AppId: AppId.trim(), AppSecret: AppSecret.trim() }
            : { Id: channelEditor, Enabled, ...(AppId.trim() ? { AppId: AppId.trim() } : {}), ...(AppSecret.trim() ? { AppSecret: AppSecret.trim() } : {}) }) };
          await hostRemote.channelAction(action, payload);
          setChannelForm(previous => ({ ...previous, AppSecret: '' })); setChannelEditor(null); await load();
        } catch (reason) { setError(reason?.message || '渠道保存失败'); }
        finally { setChannelSaving(false); }
      };
      const deleteChannel = async channel => {
        const id = operationalId(channel);
        if (!id || !(await (window.__AGENTKIT_CONFIRM__ ? window.__AGENTKIT_CONFIRM__({ title: '删除渠道', detail: `删除渠道“${channelLabel(channel)}”？此操作不可撤销。`, confirmLabel: '删除', danger: true }) : Promise.resolve(window.confirm(`删除渠道“${channelLabel(channel)}”？`))))) return;
        setActionBusy(id); setError('');
        try { await hostRemote.channelAction('DeleteChannel', { Id: id }); await load(); }
        catch (reason) { setError(reason?.message || '渠道删除失败'); }
        finally { setActionBusy(''); }
      };
      const openChannelQr = async channel => {
        const id = operationalId(channel);
        if (!id) return;
        setChannelQr({ loading: true, channel, url: '', label: '', error: '' });
        try {
          const response = await hostRemote.channelAction('GetConnectQr', { Id: id });
          const data = response?.Data || response?.data || response || {};
          setChannelQr({ loading: false, channel, url: data.QrUrl || data.qrUrl || data.Url || data.url || '', label: data.Label || data.label || '', error: '' });
        } catch (reason) {
          setChannelQr({ loading: false, channel, url: '', label: '', error: reason?.message || '获取连接地址失败' });
        }
      };
      const deleteBinding = async binding => {
        const id = operationalId(binding);
        if (!id || !(await (window.__AGENTKIT_CONFIRM__ ? window.__AGENTKIT_CONFIRM__({ title: '解除会话绑定', detail: '解除这个渠道会话绑定？', confirmLabel: '解除', danger: true }) : Promise.resolve(window.confirm('解除这个渠道会话绑定？'))))) return;
        setActionBusy(id); setError('');
        try { await hostRemote.channelAction('DeleteBinding', { Id: id }); await load(); }
        catch (reason) { setError(reason?.message || '解除绑定失败'); }
        finally { setActionBusy(''); }
      };
      const updateBinding = async binding => {
        const id = operationalId(binding);
        if (!id) return;
        const current = binding?.SessionId || binding?.sessionId || '';
        const sessionId = window.prompt('关联的 Session ID（留空表示取消关联）', current);
        if (sessionId === null) return;
        setActionBusy(id); setError('');
        try { await hostRemote.channelAction('UpdateBinding', { Id: id, SessionId: sessionId.trim() }); await load(); }
        catch (reason) { setError(reason?.message || '会话关联更新失败'); }
        finally { setActionBusy(''); }
      };
      const takeoverBinding = async binding => {
        const id = operationalId(binding);
        if (!id) return;
        const reason = window.prompt('接管原因（可选）', '人工处理');
        if (reason === null) return;
        setActionBusy(id); setError('');
        try {
          const value = await hostRemote.channelAction('Takeover', { BindingId: id, TakenOverBy: 'studio-user', TakenOverByName: 'Studio 用户', Reason: reason.trim() || undefined });
          const takeover = value?.Takeover || value?.takeover || value?.Data?.Takeover;
          if (takeover?.Id || takeover?.id) setActiveTakeovers(previous => ({ ...previous, [id]: takeover.Id || takeover.id }));
          else await load();
        } catch (reasonValue) { setError(reasonValue?.message || '会话接管失败'); }
        finally { setActionBusy(''); }
      };
      const releaseBinding = async binding => {
        const id = operationalId(binding);
        const takeoverId = activeTakeovers[id];
        if (!id || !takeoverId) return;
        setActionBusy(id); setError('');
        try { await hostRemote.channelAction('ReleaseTakeover', { Id: takeoverId }); setActiveTakeovers(previous => { const next = { ...previous }; delete next[id]; return next; }); }
        catch (reason) { setError(reason?.message || '释放接管失败'); }
        finally { setActionBusy(''); }
      };
      const summary = [['渠道总数', channels.length, 'Connector 配置'], ['已启用', channels.filter(item => item.Enabled ?? item.enabled).length, '接收消息'], ['待配对', pairings.filter(item => String(item.Status || item.status).toLowerCase() === 'pending').length, '等待处理'], ['会话绑定', bindings.length, '渠道会话']];
      const channelLabel = item => ({ 'wps-xiezuo': 'WPS 协作', feishu: '飞书', wecom: '企业微信' }[item?.Channel || item?.channel] || item?.Channel || item?.channel || '渠道');
      const messageText = item => {
        const payload = item?.Payload ?? item?.payload;
        if (typeof payload === 'string') return payload;
        if (payload && typeof payload === 'object') return String(payload.text || payload.content || payload.message || JSON.stringify(payload));
        return '—';
      };
      const conversationMap = messages.reduce((groups, item) => {
        const payload = item?.Payload ?? item?.payload;
        const parsed = typeof payload === 'object' && payload ? payload : {};
        const chat = parsed.chat || parsed.conversation || {};
        const peer = item?.PeerId || item?.peerId || chat.id || parsed.peerId || 'default';
        const key = `${item?.Channel || item?.channel || 'channel'}|${item?.ChannelAccountId || item?.channelAccountId || ''}|${peer}`;
        const existing = groups[key] || { id: key, title: peer, channel: item?.Channel || item?.channel, account: item?.ChannelAccountId || item?.channelAccountId, items: [] };
        existing.items.push(item); groups[key] = existing; return groups;
      }, {});
      const conversations = Object.values(conversationMap).map(group => ({
        ...group,
        items: group.items.slice().sort((a, b) => new Date(a?.CreatedAt || a?.createdAt || 0) - new Date(b?.CreatedAt || b?.createdAt || 0)),
      })).sort((a, b) => new Date(b.items[b.items.length - 1]?.CreatedAt || b.items[b.items.length - 1]?.createdAt || 0) - new Date(a.items[a.items.length - 1]?.CreatedAt || a.items[a.items.length - 1]?.createdAt || 0));
      const visibleChannels = channels.slice(channelPage * channelPageSize, (channelPage + 1) * channelPageSize);
      const visiblePairings = pairings.slice(pairingPage * channelSecondaryPageSize, (pairingPage + 1) * channelSecondaryPageSize);
      const visibleBindings = bindings.slice(bindingPage * channelSecondaryPageSize, (bindingPage + 1) * channelSecondaryPageSize);
      const visibleConversations = conversations.slice(messagePage * channelSecondaryPageSize, (messagePage + 1) * channelSecondaryPageSize);
      const selectedConversation = conversations.find(item => item.id === selectedConversationId) || visibleConversations[0] || null;
      const conversationBody = selectedConversation ? h(React.Fragment, null,
        h('div', { style: { padding: '11px 13px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, selectedConversation.title), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, `${channelLabel(selectedConversation)} · ${selectedConversation.account || '—'}`)),
        h('div', { style: { padding: '12px 13px', overflow: 'auto', display: 'grid', alignContent: 'start', gap: '8px' } }, selectedConversation.items.map((item, index) => h('div', { key: operationalId(item, String(index)), style: { maxWidth: '82%', justifySelf: String(item?.Direction || item?.direction).toLowerCase() === 'outbound' ? 'end' : 'start', padding: '8px 10px', borderRadius: '10px', background: String(item?.Direction || item?.direction).toLowerCase() === 'outbound' ? BRAND.accentSoft : BRAND.canvas, color: BRAND.ink, fontSize: '12px', lineHeight: 1.5 } },
          h('div', null, messageText(item)),
          h('div', { style: { marginTop: '4px', color: BRAND.inkMuted, fontSize: '10px' } }, `${String(item?.Direction || item?.direction).toLowerCase() === 'outbound' ? '发送' : '接收'} · ${operationalDate(item?.CreatedAt || item?.createdAt)}`, item?.Error || item?.error ? ` · ${item.Error || item.error}` : '')))))
        : h('div', { style: { display: 'grid', placeItems: 'center', color: BRAND.inkMuted, fontSize: '12px' } }, '选择左侧会话查看消息');
      const messageWorkspace = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(180px, .7fr) minmax(320px, 1.5fr)', gap: '12px', minHeight: '330px', overflowX: 'auto' } },
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', overflow: 'auto', background: BRAND.surface } },
          h('div', { style: { padding: '11px 13px', borderBottom: '1px solid ' + BRAND.border, color: BRAND.ink, fontWeight: 750, fontSize: '12px' } }, `会话列表 ${conversations.length}`),
          conversations.length ? visibleConversations.map(item => h('button', { key: item.id, type: 'button', onClick: () => setSelectedConversationId(item.id), style: { display: 'block', width: '100%', padding: '11px 13px', textAlign: 'left', border: 0, borderBottom: '1px solid ' + BRAND.border, color: BRAND.ink, background: selectedConversation?.id === item.id ? BRAND.accentSoft : BRAND.surface, cursor: 'pointer' } },
            h('div', { style: { fontWeight: 750, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
            h('div', { style: { marginTop: '4px', color: BRAND.inkMuted, fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${channelLabel(item)} · ${item.items.length} 条`)))
            : h('div', { style: { padding: '28px 14px', color: BRAND.inkMuted, fontSize: '12px', textAlign: 'center' } }, '渠道接入并产生对话后，消息会出现在这里。')),
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' } }, conversationBody));
      return h('div', null,
        h(OperationalPageHeading, { title: 'Channels', detail: '连接、渠道、配对、会话绑定和消息记录分开管理；数据通过 Channel API 读取，不在插件内复制一套存储。', action: h(Pill, { tone: connection?.configured ? 'accent' : 'signal' }, connection?.configured ? '连接已配置' : '待配置') }),
        h('details', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface, marginBottom: '14px' } },
          h('summary', { style: { cursor: 'pointer', padding: '11px 14px', color: BRAND.ink, fontWeight: 750, fontSize: '12px' } }, connection?.configured ? '连接配置 · 已配置' : '连接配置 · 点击设置'),
          h('form', { onSubmit: saveConnection, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '9px', alignItems: 'end', padding: '0 14px 14px' } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Channel 服务地址', h('input', { value: config.serverUrl, onChange: event => setConfig({ ...config, serverUrl: event.target.value }), placeholder: 'https://channel.example.com', style: inputStyle() })),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '账号 ID', h('input', { value: config.accountId, onChange: event => setConfig({ ...config, accountId: event.target.value }), style: inputStyle() })),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '工作区 ID（可选）', h('input', { value: config.workspaceId, onChange: event => setConfig({ ...config, workspaceId: event.target.value }), style: inputStyle() })),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '服务凭证', h('input', { type: 'password', value: config.apiToken, onChange: event => setConfig({ ...config, apiToken: event.target.value }), placeholder: connection?.tokenConfigured ? '已保存，留空保留' : '可选', style: inputStyle() })),
            h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, saving ? '保存中…' : '保存连接'))),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取 Channel 数据', detail: '读取连接状态、渠道、配对和消息。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: 'Channels 暂不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('section', { style: { padding: '14px', border: '1px solid ' + BRAND.border, borderRadius: '12px', marginBottom: '14px' } },
            h('strong', null, '本地 Agent 接入'),
            h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '让渠道消息在当前设备的原生会话中执行。先在连接配置中填写工作区 ID，再填写平台签发给该 Agent 的连接凭证。工作区 ID 仅用于渠道路由，不会绑定本地文件目录；设备离线时消息无法交给本地 Agent。'),
            h('form', { onSubmit: event => { event.preventDefault(); return saveAgentConnection(connectorAgentId, true); }, style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'end' } },
              h('label', null, '本地 Agent', h('select', { required: true, value: connectorAgentId, onChange: event => { setConnectorAgentId(event.target.value); setConnectorToken(''); }, style: inputStyle() }, h('option', { value: '' }, '选择 Agent'), (connection?.localAgents || []).map(agent => h('option', { key: agent.id, value: agent.id }, agent.name)))),
              h('label', null, 'Agent 连接凭证', h('input', { type: 'password', autoComplete: 'new-password', value: connectorToken, onChange: event => setConnectorToken(event.target.value), placeholder: connection?.agentConnections?.find(item => item.agentId === connectorAgentId)?.tokenConfigured ? '已保存，留空保留' : '短期 Connector JWT', style: inputStyle() })),
              h('button', { type: 'submit', disabled: connectorBusy || !connectorAgentId, style: buttonStyle() }, connectorBusy ? '连接中…' : '启用连接'),
              h('button', { type: 'button', onClick: async () => { try { setConnection(await hostRemote.channelConnection()); } catch (reason) { setError(reason?.message || '读取连接状态失败'); } }, style: buttonStyle() }, '刷新连接状态')),
            (connection?.agentConnections || []).map(item => h('div', { key: item.agentId, style: { display: 'flex', gap: '10px', alignItems: 'center', paddingTop: '10px', fontSize: '12px' } },
              h('span', null, connection?.localAgents?.find(agent => agent.id === item.agentId)?.name || item.agentId),
              h(Pill, { tone: item.connected ? 'accent' : 'neutral' }, ({ connected: '已连接', connecting: '连接中', registering: '注册中', reconnecting: '正在重连', stopped: '已停用', unavailable: '暂不可用', error: '连接失败' })[item.state] || item.state),
              item.lastError ? h('span', { style: { color: BRAND.danger } }, ({ authentication_failed: '凭证无效或已过期', connection_failed: '无法连接渠道服务', protocol_error: '渠道协议或身份不匹配', configuration_invalid: '连接配置无效', connection_replaced: '连接已被另一设备替换' })[item.lastError] || '连接中断，请检查服务后刷新') : null,
              item.enabled ? h('button', { type: 'button', disabled: connectorBusy, onClick: () => saveAgentConnection(item.agentId, false), style: buttonStyle() }, '停用连接') : null))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '14px' } }, summary.map(item => h(Metric, { key: item[0], label: item[0], value: String(item[1]), detail: item[2] }))),
          h(OperationalToolbar, { onRefresh: () => void load(), busy: status === 'loading' }, h(Pill, { tone: 'neutral' }, 'Channel Connector API'), tab === 'channels' ? h('button', { type: 'button', onClick: () => openChannelEditor(null), style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, '新增渠道') : null),
          channelEditor ? h(ResourceDialog, { title: channelEditor === 'new' ? '新增渠道' : '编辑渠道', detail: '配置渠道连接和会话策略；保存后由 Channel API 管理凭证、配对和消息。', wide: true, onClose: () => { if (!channelSaving) setChannelEditor(null); } }, h('form', { onSubmit: saveChannel, style: { display: 'grid', gap: '10px' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '9px' } },
              h('label', null, '绑定 Agent', h('select', { required: true, value: channelForm.AgentId, onChange: event => setChannelForm({ ...channelForm, AgentId: event.target.value, ConnectorWorkspaceId: '' }), style: inputStyle() },
                h('option', { value: '' }, '选择 Agent'),
                channelForm.AgentId && ![...(connection?.localAgents || []), ...(connection?.cloudAgents || [])].some(item => item.id === channelForm.AgentId) ? h('option', { value: channelForm.AgentId, disabled: true }, '原绑定目标不可用，请重新选择') : null,
                h('optgroup', { label: '本地 · 需要保持应用运行' }, (connection?.localAgents || []).map(item => h('option', { key: item.id, value: item.id }, item.name))),
                h('optgroup', { label: '云端部署 · 由云端持续运行' }, (connection?.cloudAgents || []).map(item => h('option', { key: item.id, value: item.id }, item.name))))),
              connection?.cloudError ? h('p', { role: 'status', style: { color: BRAND.signal } }, connection.cloudError) : null,
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '渠道类型', h('select', { value: channelForm.Channel, disabled: channelEditor !== 'new', onChange: event => setChannelForm({ ...channelForm, Channel: event.target.value }), style: inputStyle() }, h('option', { value: 'wps-xiezuo' }, 'WPS 协作'), h('option', { value: 'feishu' }, '飞书'), h('option', { value: 'wecom' }, '企业微信'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '渠道账号 ID', h('input', { value: channelForm.ChannelAccountId, disabled: channelEditor !== 'new', onChange: event => setChannelForm({ ...channelForm, ChannelAccountId: event.target.value }), style: inputStyle(), required: true }))),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '9px' } },
              h('label', null, '应用 App ID', h('input', { value: channelForm.AppId, required: channelEditor === 'new', placeholder: channelEditor === 'new' ? '渠道平台的应用 ID' : '留空保留已保存的应用 ID', autoComplete: 'off', onChange: event => setChannelForm({ ...channelForm, AppId: event.target.value }), style: inputStyle() })),
              h('label', null, '应用 App Secret', h('input', { type: 'password', value: channelForm.AppSecret, required: channelEditor === 'new', placeholder: channelEditor === 'new' ? '渠道平台的应用密钥' : '留空保留已保存的密钥', autoComplete: 'new-password', onChange: event => setChannelForm({ ...channelForm, AppSecret: event.target.value }), style: inputStyle() }))),
            error ? h('p', { role: 'alert', style: { color: BRAND.danger, margin: 0 } }, error) : null,
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '9px' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '私聊策略', h('select', { value: channelForm.DmPolicy, onChange: event => setChannelForm({ ...channelForm, DmPolicy: event.target.value }), style: inputStyle() }, h('option', { value: 'pairing' }, '需配对'), h('option', { value: 'open' }, '开放'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '群聊策略', h('select', { value: channelForm.GroupPolicy, onChange: event => setChannelForm({ ...channelForm, GroupPolicy: event.target.value }), style: inputStyle() }, h('option', { value: 'allowlist' }, '白名单'), h('option', { value: 'open' }, '开放'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '会话范围', h('select', { value: channelForm.SessionScope, onChange: event => setChannelForm({ ...channelForm, SessionScope: event.target.value }), style: inputStyle() }, h('option', { value: 'per-peer' }, '按用户'), h('option', { value: 'per-group' }, '按群聊'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '7px', paddingTop: '22px' } }, h('input', { type: 'checkbox', disabled: channelEditor === 'new', checked: channelForm.Enabled, onChange: event => setChannelForm({ ...channelForm, Enabled: event.target.checked }) }), channelEditor === 'new' ? '新渠道创建后启用' : '启用渠道')),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: () => setChannelEditor(null), disabled: channelSaving, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: channelSaving, style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, channelSaving ? '保存中…' : '保存渠道')))) : null,
          channelQr ? h(ResourceDialog, { title: `连接渠道 · ${channelLabel(channelQr.channel)}`, detail: '连接地址由 Connector 返回；Studio 不生成或保存二维码内容。', onClose: () => setChannelQr(null) },
            channelQr.loading ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, '正在读取连接地址…') : channelQr.error ? h('p', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px', margin: 0 } }, channelQr.error) : channelQr.url ? h('div', { style: { display: 'grid', gap: '8px' } }, h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, channelQr.label || '请打开下面的连接地址完成渠道授权。'), h('a', { href: channelQr.url, target: '_blank', rel: 'noreferrer', style: { color: BRAND.accentStrong, fontSize: '12px', wordBreak: 'break-all' } }, channelQr.url)) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, 'Host 未返回连接地址。')) : null,
          h(StudioPageTabs, { value: tab, onChange: next => { setTab(next); if (next === 'channels') setChannelPage(0); if (next === 'pairings') setPairingPage(0); if (next === 'bindings') setBindingPage(0); if (next === 'messages') setMessagePage(0); }, items: [{ id: 'channels', label: `渠道 ${channels.length}` }, { id: 'pairings', label: `配对请求 ${pairings.length}` }, { id: 'bindings', label: `会话绑定 ${bindings.length}` }, { id: 'messages', label: `消息记录 ${messages.length}` }], ariaLabel: 'Channels 管理视图' }),
          tab === 'channels' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'channel', label: '渠道', cell: row => h('div', null, h('strong', null, `${channelLabel(row)} · ${row?.ChannelAccountId || row?.channelAccountId || '—'}`), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, operationalId(row))) }, { id: 'agent', label: '绑定 Agent', cell: row => h('div', null, [...(connection?.localAgents || []), ...(connection?.cloudAgents || [])].find(item => item.id === (row?.AgentId || row?.agentId))?.name || row?.AgentId || row?.agentId || '未绑定', (row?.ConnectorWorkspaceId || row?.connectorWorkspaceId) ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '本地设备执行') : h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '云端执行')) }, { id: 'policy', label: '策略', cell: row => `${row?.DmPolicy || row?.dmPolicy || '—'} / ${row?.GroupPolicy || row?.groupPolicy || '—'}` }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.Enabled ?? row?.enabled ? 'enabled' : 'disabled') }, { id: 'action', label: '操作', cell: row => h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ['feishu', 'wecom'].includes(String(row?.Channel || row?.channel).toLowerCase()) ? h('button', { type: 'button', onClick: event => { event.stopPropagation(); void openChannelQr(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '扫码连接') : null, h('button', { type: 'button', onClick: event => { event.stopPropagation(); openChannelEditor(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '编辑'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void deleteChannel(row); }, style: { ...buttonStyle(), padding: '5px 8px', color: BRAND.danger, background: BRAND.surface } }, '删除')) }], rows: visibleChannels, empty: '还没有渠道配置，请先保存连接并创建渠道。' }), h(OperationalPager, { page: channelPage, pageSize: channelPageSize, total: channels.length, onChange: setChannelPage })) : null,
          tab === 'pairings' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'sender', label: '申请人', cell: row => h('strong', null, row?.SenderName || row?.senderName || row?.SenderId || '—') }, { id: 'channel', label: '渠道', cell: row => `${channelLabel(row)} · ${row?.ChannelAccountId || '—'}` }, { id: 'chat', label: '会话', cell: row => row?.ChatType || row?.chatType || row?.PeerId || '—' }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.Status || row?.status) }, { id: 'action', label: '操作', cell: row => String(row?.Status || row?.status).toLowerCase() === 'pending' ? h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void pairingAction(operationalId(row), 'ApprovePairing'); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '通过'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void pairingAction(operationalId(row), 'RejectPairing'); }, style: { ...buttonStyle(), padding: '5px 8px', background: BRAND.surface } }, '拒绝')) : '—' }], rows: visiblePairings, empty: '没有待处理的配对请求。' }), h(OperationalPager, { page: pairingPage, pageSize: channelSecondaryPageSize, total: pairings.length, onChange: setPairingPage })) : null,
          tab === 'bindings' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'channel', label: '渠道', cell: row => `${channelLabel(row)} · ${row?.ChannelAccountId || '—'}` }, { id: 'agent', label: 'Agent', cell: row => row?.AgentId || row?.agentId || '—' }, { id: 'peer', label: '对端', cell: row => row?.PeerId || row?.peerId || '—' }, { id: 'session', label: 'Session', cell: row => h('div', null, h('span', null, row?.SessionId || row?.sessionId || '未关联'), activeTakeovers[operationalId(row)] ? h(Pill, { tone: 'signal' }, '已接管') : null) }, { id: 'createdAt', label: '更新时间', cell: row => operationalDate(row?.UpdatedAt || row?.updatedAt || row?.CreatedAt) }, { id: 'action', label: '操作', cell: row => h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } }, h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void updateBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '编辑会话'), activeTakeovers[operationalId(row)] ? h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void releaseBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '释放接管') : h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void takeoverBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '接管'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void deleteBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px', color: BRAND.danger, background: BRAND.surface } }, '解除绑定')) }], rows: visibleBindings, empty: '没有会话绑定；用户完成渠道配对后会出现在这里。' }), h(OperationalPager, { page: bindingPage, pageSize: channelSecondaryPageSize, total: bindings.length, onChange: setBindingPage })) : null,
          tab === 'messages' ? h(React.Fragment, null, messageWorkspace, h(OperationalPager, { page: messagePage, pageSize: channelSecondaryPageSize, total: conversations.length, onChange: next => { setMessagePage(next); setSelectedConversationId(''); } })) : null,
          error ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.signal, fontSize: '12px' } }, error) : null) : null);
    }

    function OperationalPage({ page }) {
      if (page === 'evaluation') return h(EvaluationPage);
      if (page === 'observability') return h(ObservabilityPage);
      if (page === 'channels') return h(ChannelsPage);
      return null;
    }
    function HostStatusPill() {
      const [status, setStatus] = useState('loading');
      useEffect(() => {
        let alive = true;
        const probe = async () => {
          try {
            const result = await hostRemote.health();
            if (alive && result?.status === 'ok') { setStatus('ready'); return; }
          } catch { /* The session exchange can race on the first panel mount. */ }
          try {
            const result = await hostRemote.bootstrap();
            if (alive) setStatus(result?.workspaceReady === false ? 'error' : 'ready');
          } catch {
            if (alive) setStatus('error');
          }
        };
        void probe();
        return () => { alive = false; };
      }, []);
      return h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : status === 'loading' ? '读取 Host' : 'Host 待接入');
    }

    /**
     * DSH's document title is selected at build time, so the plugin cannot
     * replace it through a slot. Keep the browser chrome product-owned while
     * preserving the current session title. This observes only the public
     * title element and is disposed with the plugin context.
     */
    function productDocument() {
      if (typeof document === 'undefined') return null;
      // DSH Web mounts global panels in a same-origin srcdoc frame. Browser
      // chrome belongs to the top-level document, so brand that document when
      // the embedding boundary permits it and otherwise stay frame-local.
      try {
        const parentDocument = window.parent && window.parent !== window ? window.parent.document : null;
        return parentDocument || document;
      } catch { return document; }
    }

    function adoptProductDocumentTitle() {
      const ownerDocument = productDocument();
      if (!ownerDocument) return () => {};
      const project = () => {
        const current = String(ownerDocument.title || '').trim();
        const base = current.split(' — ')[0].trim();
        const isDshBuildTitle = base.startsWith('DSH') || base === 'DeepSeek Harness';
        const next = base === 'AgentKit Studio'
          ? 'AgentKit Studio'
          : base && !isDshBuildTitle
            ? `${base} — AgentKit Studio`
            : 'AgentKit Studio';
        // Writing even an unchanged title queues another MutationObserver
        // callback and can keep the browser on the plugin boot screen forever.
        if (ownerDocument.title !== next) ownerDocument.title = next;
      };
      project();
      const title = ownerDocument.querySelector('title');
      if (!title || typeof MutationObserver === 'undefined') return () => {};
      const observer = new MutationObserver(project);
      observer.observe(title, { childList: true, characterData: true, subtree: true });
      return () => observer.disconnect();
    }

    // Keep the embedded document aligned with the Studio brand. The public
    // webserver index injection in index.mjs handles the top-level document;
    // this path is the fallback for hosts that only expose the panel realm.
    function adoptProductDocumentBrand() {
      const ownerDocument = productDocument();
      if (!ownerDocument) return () => {};
      const mark = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#f7ffff" stroke="#0aa6a6" stroke-width="2"/><path d="M32 6 7 54h11l5-10h18l5 10h11L32 6Zm0 18 5 10H27l5-10Z" fill="#0aa6a6"/></svg>');
      const href = `data:image/svg+xml,${mark}`;
      const existing = Array.from(ownerDocument.querySelectorAll('link[rel~="icon"]'));
      const links = existing.length ? existing : [ownerDocument.createElement('link')];
      const previous = links.map(link => ({ link, rel: link.rel, type: link.type, href: link.href }));
      links.forEach(link => { link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = href; if (!link.isConnected) ownerDocument.head.append(link); });
      return () => previous.forEach(({ link, rel, type, href: previousHref }) => { link.rel = rel; link.type = type; link.href = previousHref; });
    }

    // DSH's panel frame can be narrower than a desktop Studio window (browser
    // zoom, split view, or an embedded WebView). Keep the product surface usable
    // at that width without duplicating a second CSS build: compact grids and
    // action rows collapse through this scoped stylesheet, while data tables
    // retain horizontal scrolling for their full column set.
    function installResponsiveStyles() {
      const ownerDocument = productDocument();
      if (!ownerDocument || ownerDocument.querySelector('style[data-agentkit-studio-responsive]')) return () => {};
      const style = ownerDocument.createElement('style');
      style.dataset.agentkitStudioResponsive = 'true';
      style.textContent = `
        .agentkit-settings-launcher {
          flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
          height: 42px; padding: 0 10px 0 8px; margin: 0; box-sizing: border-box;
          border: 0; border-radius: var(--dsw-radius-md, 12px); background: transparent;
          color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 14px;
        }
        .agentkit-settings-launcher:hover { background: var(--dsw-alias-interactive-bg-hover); }
        .agentkit-settings-launcher:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4b73e8); outline-offset: 2px; }
        .agentkit-settings-launcher[data-wide="false"] { flex: none; width: 36px; height: 36px; padding: 0; gap: 0; justify-content: center; }
        [data-agentkit-studio="product-application"] [data-studio-tabs] { overflow-x: auto; scrollbar-width: thin; }
        [data-agentkit-studio="product-application"] [data-studio-tabs] > button { flex: 0 0 auto; white-space: nowrap; }
        [data-agentkit-studio="product-application"] [data-studio-heading],
        [data-agentkit-studio="product-application"] [data-studio-content-intro] { flex-wrap: wrap; align-items: flex-start; }
        [data-studio-model-settings] { container-type: inline-size; }
        [data-studio-model-settings] input, [data-studio-model-settings] select { min-width: 0; box-sizing: border-box; }
        @container (max-width: 540px) {
          [data-studio-model-settings] [style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
        }
        @media (max-width: 960px) {
          [data-agentkit-studio="product-application"] > main { padding: 18px 16px 28px !important; }
          [data-agentkit-studio="product-application"] [style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
          [data-agentkit-studio="product-application"] [data-studio-heading],
          [data-agentkit-studio="product-application"] [data-studio-content-intro] { align-items: flex-start; }
          [data-agentkit-studio="product-application"] [data-studio-header] { gap: 14px !important; }
          [data-agentkit-studio="product-application"] [data-studio-pager] { flex-wrap: wrap !important; }
        }
        @media (max-width: 760px) {
          [data-agentkit-studio="product-application"] > main { padding: 16px 12px 28px !important; }
          [data-agentkit-studio="product-application"] [data-studio-header] { flex-wrap: wrap !important; gap: 12px !important; margin-bottom: 16px !important; }
          [data-agentkit-studio="product-application"] [data-studio-header] > div:last-child { width: 100%; justify-content: flex-start; }
          [data-agentkit-studio="product-application"] [style*="display: flex"] { flex-wrap: wrap !important; }
          [data-agentkit-studio="product-application"] [data-studio-pager] { align-items: flex-start !important; }
          [data-agentkit-studio="product-application"] [data-studio-pager] > div { width: 100%; justify-content: flex-start !important; flex-wrap: wrap !important; }
          [data-agentkit-studio="product-application"] [data-studio-pager] select { max-width: 100%; }
          [data-agentkit-studio="product-application"] [data-studio-dialog] { width: calc(100vw - 20px) !important; max-height: calc(100vh - 20px) !important; padding: 14px !important; }
          [data-agentkit-studio="product-application"] table { font-size: 11px !important; }
        }
      `;
      ownerDocument.head.append(style);
      return () => style.remove();
    }

    function StudioShell({ scheduleRemote, page = 'overview', onNavigate }) {
      const activeNav = PANELS.find(item => item.page === page) || PANELS[0];
      return h('div', {
        'data-agentkit-studio': 'product-application',
        style: { height: '100%', minHeight: 0, minWidth: 0, overflow: 'auto', background: page === 'resource-hub' ? BRAND.surface : BRAND.canvas, color: BRAND.ink, fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
      },
      h('main', { 'data-studio-shell-main': 'true', style: { minWidth: 0, minHeight: '100%', boxSizing: 'border-box', padding: '24px 28px 32px' } },
        h('header', { 'data-studio-header': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '24px' } },
          h('div', null,
            h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'AgentKit Studio'),
            h('h1', { style: { color: BRAND.ink, margin: '6px 0 5px', fontSize: '25px', letterSpacing: '-0.035em' } }, activeNav.label),
            h('p', { style: { color: BRAND.inkMuted, margin: 0, fontSize: '13px' } }, activeNav.note)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } }, h(Pill, { tone: 'neutral' }, 'Local'), h(HostStatusPill))),
        page === 'overview' ? h(OverviewPage, { onNavigate }) : page === 'agents' ? h(AgentWorkspace, { onNavigate }) : page === 'resource-hub' ? h(ResourceWorkspace) : page === 'operations' ? h(OperationsWorkspace, { scheduleRemote }) : h(DomainPage, { page })));
    }

    function StudioPanelIcon({ size, active, glyph, panelId }) {
      const paths = {
        'studio-overview': h('path', { d: 'M5 11 12 5l7 6v7h-5v-5h-4v5H5v-7Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinejoin: 'round' }),
        'studio-agents': h('path', { d: 'm12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm5.5 12.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }),
        'studio-resources': h('path', { d: 'm12 3 8 8-8 8-8-8 8-8Zm0 5 3 3-3 3-3-3 3-3Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round' }),
        'studio-operations': h('path', { d: 'M5 19 19 5m0 0h-7m7 0v7', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      };
      return h('span', {
        'aria-hidden': 'true',
        'data-studio-panel-id': panelId || undefined,
        style: { display: 'inline-grid', placeItems: 'center', width: String(size) + 'px', height: String(size) + 'px', borderRadius: '5px', color: active ? BRAND.accentStrong : 'currentColor', background: active ? BRAND.accentSoft : 'transparent', fontSize: size >= 18 ? '16px' : '14px', fontWeight: 700 },
      }, h('svg', { width: Math.max(14, Number(size || 18) - 1), height: Math.max(14, Number(size || 18) - 1), viewBox: '0 0 24 24', fill: 'none' }, paths[panelId] || h('path', { d: 'M5 12h14', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' })));
    }

    function SettingsRow({ label, value, detail, tone = 'neutral' }) {
      return h('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '18px', padding: '14px 0', borderBottom: '1px solid ' + BRAND.border },
      },
      h('div', null,
        h('div', { style: { color: BRAND.ink, fontSize: '13px', fontWeight: 700 } }, label),
        h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '4px', lineHeight: 1.45 } }, detail)),
      h(Pill, { tone }, value));
    }

    const MODEL_CREDENTIAL_NAMES = ['AGENTKIT_MODEL_API_KEY', 'OPENAI_API_KEY'];
    const DEFAULT_KSYUN_BASE_URL = 'http://kspmas.ksyun.com/v1';
    const DEFAULT_KSYUN_MODEL = 'deepseek-v4.1-flash';
    const DSH_MODEL_SETTINGS_NS = 'llm-pi-ai';
    const DSH_DEFAULT_MODEL_SETTINGS_NS = 'agent-default-model';
    const DSH_MODEL_ROUTE = 'agentkit-studio';
    const DSH_MODEL_CREDENTIAL = 'AGENTKIT_MODEL_API_KEY';

    /**
     * Publish Studio model profiles through the public DSH model contract.
     * Studio owns global defaults and cloud credentials; DSH chat only
     * sees providers registered through its own settings/credentials Remotes.
     * Keeping this bridge on the public Remote surface avoids a second model
     * catalog or a browser-owned chat implementation.
     */
    function modelProfileId(profile, index = 0) {
      const provider = String(profile?.provider || 'ksyun').trim() || 'ksyun';
      const model = String(profile?.modelName || '').trim() || `model-${index + 1}`;
      return String(profile?.id || `${provider}:${model}`).trim().replace(/[^a-zA-Z0-9._:-]+/g, '-');
    }

    function modelCredentialName(profile, index = 0) {
      return String(profile?.credentialName || `AGENTKIT_MODEL_API_KEY_${modelProfileId(profile, index).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`).trim();
    }

    function createDshModelBridge(ctx) {
      const describe = async () => {
        const response = await ctx.remote.settings.describe();
        if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置不可用');
        return response.value;
      };
      const applyProfiles = async ({ profiles, keys = {} }) => {
        const document = await describe();
        const namespace = (document.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS);
        const valid = profiles.filter(profile => profile?.enabled !== false && String(profile?.modelName || '').trim())
          .sort((left, right) => Number(right.default === true) - Number(left.default === true));
        if (!valid.length) throw new Error('至少保留一个模型配置');
        const catalogs = await Promise.all(valid.map(profile => hostRemote.modelCatalog(modelProfileId(profile)).catch(() => null)));
        const operations = valid.map((profile, index) => {
          const route = `agentkit-studio-${modelProfileId(profile, index).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
          const modelName = String(profile.modelName).trim();
          const provider = String(profile.provider || 'ksyun').trim() || 'ksyun';
          const baseUrl = String(profile.baseUrl || '').trim() || (provider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : '');
          if (!baseUrl) throw new Error(`模型 ${modelName} 需要填写 API 地址`);
          const credentialName = modelCredentialName(profile, index);
          return { route, modelName, provider, baseUrl, credentialName, operation: { op: 'set', path: ['providers', route], value: {
            displayName: `${provider} · ${modelName}`, api: 'openai-completions', apiKeyEnv: credentialName,
            baseURL: baseUrl,
            // Kspmas model metadata is multimodal, but custom DSH routes fall
            // back to text-only unless the capability is declared explicitly.
            // Keep the input contract on each profile so read_image and native
            // image messages are admitted consistently with the upstream model.
            models: (catalogs[index]?.items?.length ? catalogs[index].items : [{ id: modelName, name: modelName, input: profile.input || ['text'] }])
              .map(model => ({ id: model.id, name: model.name || model.id, contextWindow: 262144, maxTokens: 32768, input: model.input || ['text'] })),
          } } };
        });
        const response = await ctx.remote.settings.mutate(DSH_MODEL_SETTINGS_NS, [
          ...Object.keys(namespace?.value?.providers || {}).filter(route => route.startsWith('agentkit-studio-') && !operations.some(item => item.route === route)).map(route => ({ op: 'unset', path: ['providers', route] })),
          ...operations.map(item => item.operation),
        ], namespace?.revision);
        if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置保存失败');
        const defaultNamespace = (await describe()).namespaces?.find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
        if (!defaultNamespace) throw new Error('DSH 默认模型设置不可用，无法让新会话使用该模型');
        const first = operations[0];
        const defaultResponse = await ctx.remote.settings.mutate(DSH_DEFAULT_MODEL_SETTINGS_NS, [
          { op: 'set', path: ['provider'], value: first.route }, { op: 'set', path: ['model'], value: first.modelName },
        ], defaultNamespace.revision);
        if (!defaultResponse?.ok) throw new Error(defaultResponse?.error?.message || 'DSH 默认模型保存失败');
        for (const item of operations) {
          const key = String(keys[item.credentialName] || '').trim();
          if (!key) continue;
          const stored = await ctx.remote.credentials.set(item.credentialName, key);
          if (!stored?.ok) throw new Error(stored?.error?.message || `模型 ${item.modelName} 凭证保存失败`);
        }
        return { provider: first.provider, route: first.route, model: first.modelName, profiles: operations.map(({ operation, ...item }) => item) };
      };
      return {
        describe,
        applyProfiles,
        apply: async ({ provider, baseUrl, modelName, apiKey }) => applyProfiles({
          profiles: [{ provider, baseUrl, modelName, credentialName: DSH_MODEL_CREDENTIAL }],
          keys: { [DSH_MODEL_CREDENTIAL]: apiKey },
        }),
        credentialStatus: async name => {
          const response = await ctx.remote.credentials.describe([name || DSH_MODEL_CREDENTIAL]);
          if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型凭证不可用');
          return response.value?.[name || DSH_MODEL_CREDENTIAL] || { configured: false };
        },
      };
    }

    function ModelSettingsSection({ dshModel }) {
      const [form, setForm] = useState({
        profiles: [{ id: 'default', provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: DEFAULT_KSYUN_MODEL, credentialName: DSH_MODEL_CREDENTIAL, apiKey: '', enabled: true, default: true }],
        cloudAccessKey: '', cloudSecretKey: '', cloudAccountId: '', cloudRegion: '', cloudServerUrl: '', cloudBucket: '',
      });
      const [modelStatus, setModelStatus] = useState({});
      const [cloudStatus, setCloudStatus] = useState({ configured: false, source: 'missing' });
      const [dshStatus, setDshStatus] = useState({ configured: false, model: '', credentialConfigured: false });
      const [status, setStatus] = useState('loading');
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [saving, setSaving] = useState(false);

      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const [settings, dshDocument] = await Promise.all([hostRemote.settings(), dshModel.describe()]);
          const legacy = { id: 'default', provider: settings?.modelProvider || 'ksyun', modelName: settings?.modelName || DEFAULT_KSYUN_MODEL, baseUrl: settings?.modelBaseUrl || (settings?.modelProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : ''), credentialName: DSH_MODEL_CREDENTIAL, enabled: true };
          const loaded = (Array.isArray(settings?.modelProfiles) && settings.modelProfiles.length ? settings.modelProfiles : [legacy]);
          const hasDefault = loaded.some(profile => profile.default === true);
          const profiles = loaded.map((profile, index) => ({ ...legacy, ...profile, id: modelProfileId(profile, index), credentialName: modelCredentialName(profile, index), default: hasDefault ? profile.default === true : index === 0, apiKey: '' }));
          const credentialStatuses = await Promise.all(profiles.map(async profile => [profile.credentialName, await dshModel.credentialStatus(profile.credentialName).catch(() => ({ configured: false }))]));
          const statusMap = Object.fromEntries(credentialStatuses);
          setModelStatus(statusMap);
          setCloudStatus({ configured: Boolean(settings?.cloudAccountConfigured), source: settings?.configurationSources?.cloudAccessKey || 'missing' });
          const dshProfile = (dshDocument?.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS)?.value?.providers;
          const firstDsh = dshProfile ? Object.values(dshProfile)[0] : null;
          setDshStatus({ configured: Boolean(firstDsh?.models?.length), model: firstDsh?.models?.[0]?.id || '', credentialConfigured: Boolean(statusMap[profiles[0].credentialName]?.configured) });
          setForm(current => ({ ...current, profiles, cloudAccountId: settings?.cloudAccountId || '', cloudRegion: settings?.cloudRegion || '', cloudServerUrl: settings?.cloudServerUrl || '', cloudBucket: settings?.cloudBucket || '' }));
          setStatus('ready');
        } catch (reason) { setStatus('error'); setError(reason?.message || 'Host 尚未连接'); }
      };
      useEffect(() => { load(); }, []);
      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const setProfile = (index, key, value) => setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => cursor === index ? { ...profile, [key]: value } : profile) }));
      const addProfile = () => setForm(current => ({ ...current, profiles: [...current.profiles, { id: `profile-${Date.now()}`, provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: '', credentialName: `AGENTKIT_MODEL_API_KEY_${Date.now().toString(36).toUpperCase()}`, apiKey: '', enabled: true, default: false }] }));
      const setDefaultProfile = index => setForm(current => ({ ...current, profiles: current.profiles.map((profile, cursor) => ({ ...profile, default: cursor === index })) }));
      const removeProfile = index => setForm(current => {
        if (current.profiles.length <= 1) return current;
        const removedDefault = current.profiles[index]?.default === true;
        const profiles = current.profiles.filter((_, cursor) => cursor !== index);
        return { ...current, profiles: removedDefault ? profiles.map((profile, cursor) => ({ ...profile, default: cursor === 0 })) : profiles };
      });
      const sourceLabel = source => ({ global: '全局 ~/.agentkit', workspace: '当前工作区', environment: '环境变量', 'workspace-alias': '当前工作区别名', 'global-alias': '全局 ~/.agentkit（兼容别名）', session: '本次 Host 会话', missing: '未配置' }[source] || source || '未配置');
      const save = async event => {
        event.preventDefault(); if (saving || status !== 'ready') return;
        setSaving(true); setMessage(''); setError('');
        try {
          const rawProfiles = form.profiles.map((profile, index) => ({ id: modelProfileId(profile, index), provider: profile.provider.trim() || 'ksyun', modelName: profile.modelName.trim(), baseUrl: profile.baseUrl.trim() || (profile.provider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : ''), credentialName: modelCredentialName(profile, index), enabled: profile.enabled !== false, default: profile.default === true, codexApi: profile.codexApi || 'responses', input: profile.input || ['text'] }));
          const defaultIndex = rawProfiles.findIndex(profile => profile.default);
          const profiles = rawProfiles.map((profile, index) => ({ ...profile, default: defaultIndex < 0 ? index === 0 : index === defaultIndex }));
          if (profiles.some(profile => !profile.modelName)) throw new Error('每个模型配置都需要填写模型名称');
          const keys = Object.fromEntries(form.profiles.map((profile, index) => [modelCredentialName(profile, index), String(profile.apiKey || '').trim()]).filter(([, value]) => value));
          const first = profiles.find(profile => profile.default === true) || profiles[0];
          const payload = { modelProvider: first.provider, modelBaseUrl: first.baseUrl, modelName: first.modelName, modelProfiles: profiles, modelProfileKeys: keys, cloudAccountId: form.cloudAccountId.trim(), cloudRegion: form.cloudRegion.trim(), cloudServerUrl: form.cloudServerUrl.trim(), cloudBucket: form.cloudBucket.trim() };
          if (form.cloudAccessKey?.trim()) payload.cloudAccessKey = form.cloudAccessKey.trim();
          if (form.cloudSecretKey?.trim()) payload.cloudSecretKey = form.cloudSecretKey.trim();
          await hostRemote.updateSettings(payload);
          await hostRemote.syncModelCredential();
          // Upstream metadata is authoritative. Unknown models stay text-only
          // unless the user explicitly enables image input in the profile.
          for (const profile of profiles) {
            try {
              const catalog = await hostRemote.modelCatalog(profile.id);
              const model = catalog.items.find(item => item.id === profile.modelName);
              if (model) profile.input = model.input;
            } catch { /* Some providers have no discovery API; preserve user choice. */ }
          }
          await hostRemote.updateSettings({ modelProfiles: profiles });
          await dshModel.applyProfiles({ profiles, keys });
          setForm(current => ({ ...current, profiles: current.profiles.map(profile => ({ ...profile, apiKey: '' })), cloudAccessKey: '', cloudSecretKey: '' }));
          window.dispatchEvent(new CustomEvent('agentkit-studio:model-credential-changed'));
          setMessage('已保存多个模型配置；标记为“默认”的模型用于新会话，Agent 可在创建或编辑时多选模型绑定。');
          await load();
        } catch (reason) { setError(reason?.message || '保存模型与凭证失败'); } finally { setSaving(false); }
      };
      const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { type, value: form[key] || '', placeholder, autoComplete: type === 'password' ? 'new-password' : 'off', onChange: event => setField(key, event.target.value), style: inputStyle() }));
      return h('div', { 'data-studio-model-settings': true, style: { color: BRAND.ink, minWidth: 0, padding: '4px 2px 18px', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' } },
        status === 'error' ? h('div', { role: 'alert', style: { marginBottom: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        h('form', { onSubmit: save, style: { display: 'grid', gap: '14px', maxWidth: '1100px' } },
          h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } }, h('div', null, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '模型与提供商'), h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '这里管理可复用的多个提供商和模型；每条配置独立保存凭证，并明确指定一个聊天默认模型。Agent 创建页仍可从这些模型中多选绑定。')), h(Pill, { tone: dshStatus.configured ? 'accent' : 'signal' }, dshStatus.configured ? 'DSH 已识别' : '待同步')),
            h('div', { style: { display: 'grid', gap: '10px' } }, form.profiles.map((profile, index) => h('article', { key: profile.id || index, style: { border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '12px', background: BRAND.canvas } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } }, h('strong', { style: { fontSize: '12px', color: BRAND.ink } }, `模型 ${index + 1}`), profile.default ? h(Pill, { tone: 'accent' }, '默认') : null), h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', onClick: () => setDefaultProfile(index), disabled: profile.default, style: { ...buttonStyle(), padding: '4px 8px', fontSize: '10px' } }, profile.default ? '当前默认' : '设为默认'), h('button', { type: 'button', onClick: () => removeProfile(index), disabled: form.profiles.length <= 1, style: { ...buttonStyle(), padding: '4px 8px', fontSize: '10px' } }, '移除'))),
              h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(150px, .8fr) minmax(180px, 1.2fr)', gap: '9px' } }, h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '提供商', h('select', { value: profile.provider === 'ksyun' || profile.provider === 'openai' ? profile.provider : 'custom', onChange: event => { setProfile(index, 'provider', event.target.value); setProfile(index, 'baseUrl', event.target.value === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : event.target.value === 'openai' ? 'https://api.openai.com/v1' : ''); }, style: inputStyle() }, h('option', { value: 'ksyun' }, '金山云模型服务'), h('option', { value: 'openai' }, 'OpenAI'), h('option', { value: 'custom' }, '自定义提供商'))), h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '模型名称', h('input', { value: profile.modelName, placeholder: DEFAULT_KSYUN_MODEL, onChange: event => setProfile(index, 'modelName', event.target.value), style: inputStyle() }))),
              profile.provider === 'ksyun' ? h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '10px' } }, '金山云模型服务使用默认地址，无需填写 API 地址。') : h('label', { style: { display: 'block', marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'API 地址', h('input', { value: profile.baseUrl, placeholder: '例如：https://api.example.com/v1', onChange: event => setProfile(index, 'baseUrl', event.target.value), style: inputStyle() })),
              h('label', { style: { display: 'block', marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Codex 模型接口', h('select', { value: profile.codexApi || 'responses', onChange: event => setProfile(index, 'codexApi', event.target.value), style: inputStyle() }, h('option', { value: 'responses' }, 'Responses · 直接连接'), h('option', { value: 'chat-completions' }, 'Chat Completions · 本地协议代理')), h('span', { style: { fontWeight: 400 } }, '仅影响 Codex；服务不支持 Responses 时选择本地代理。')),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '12px' } }, h('input', { type: 'checkbox', checked: profile.input?.includes('image') || false, onChange: event => setProfile(index, 'input', event.target.checked ? ['text', 'image'] : ['text']) }), '支持图片输入（保存时优先读取模型目录）'),
              h('label', { style: { display: 'block', marginTop: '8px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'API Key（留空表示不修改）', h('input', { type: 'password', value: profile.apiKey, placeholder: modelStatus[profile.credentialName]?.configured ? '已配置，留空保持不变' : '由本机 Host 安全保存', autoComplete: 'new-password', onChange: event => setProfile(index, 'apiKey', event.target.value), style: inputStyle() }), h('div', { style: { display: 'flex', gap: '10px', marginTop: '4px', color: BRAND.inkMuted, fontSize: '10px', flexWrap: 'wrap' } }, h('span', null, '来源：', sourceLabel(modelStatus[profile.credentialName]?.source)), profile.provider === 'ksyun' ? h('a', { href: 'https://ksp.console.ksyun.com/#/apiKey', target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong, textDecoration: 'underline' } }, '获取 Key') : null))
            ))),
            h('button', { type: 'button', onClick: addProfile, style: { ...buttonStyle(), marginTop: '10px' } }, '＋ 添加提供商或模型')),
          h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } }, h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } }, h('div', null, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '云端凭证'), h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '用于构建、部署和资源访问')), h(Pill, { tone: cloudStatus.configured ? 'accent' : 'signal' }, cloudStatus.configured ? '已配置' : '未配置')), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px' } }, field('Access Key', 'cloudAccessKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Access Key', 'password'), field('Secret Key', 'cloudSecretKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Secret Key', 'password')), h('details', { style: { marginTop: '10px', color: BRAND.inkMuted, fontSize: '11px' } }, h('summary', { style: { cursor: 'pointer', color: BRAND.ink, fontWeight: 700 } }, '高级云端设置'), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px', marginTop: '8px' } }, field('Account ID', 'cloudAccountId', '可选'), field('区域', 'cloudRegion', '例如：cn-beijing-6'), field('控制面地址', 'cloudServerUrl', '例如：https://agentengine.example.com'), field('对象存储桶', 'cloudBucket', '可选'))), h('div', { style: { marginTop: '9px', color: BRAND.inkMuted, fontSize: '10px' } }, '当前来源：', sourceLabel(cloudStatus.source))),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', flexWrap: 'wrap' } }, message ? h('span', { role: 'status', style: { color: BRAND.accentStrong, fontSize: '11px', marginRight: 'auto' } }, message) : null, error ? h('span', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px', marginRight: 'auto' } }, error) : null, h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取'), h('button', { type: 'submit', disabled: saving || status !== 'ready', style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: saving || status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, borderColor: 'transparent' } }, saving ? '保存中…' : '保存配置'))));
    }
