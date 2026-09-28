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
      const [channelForm, setChannelForm] = useState({ AgentId: '', ConnectorWorkspaceId: '', Channel: 'wps-xiezuo', ChannelAccountId: '', DmPolicy: 'pairing', GroupPolicy: 'allowlist', RequireMention: true, SessionScope: 'per-peer', Enabled: true, ConfigJson: '{}' });
      const [channelSaving, setChannelSaving] = useState(false);
      const [channelPage, setChannelPage] = useState(0);
      const [pairingPage, setPairingPage] = useState(0);
      const [bindingPage, setBindingPage] = useState(0);
      const [messagePage, setMessagePage] = useState(0);
      const [activeTakeovers, setActiveTakeovers] = useState({});
      const [selectedConversationId, setSelectedConversationId] = useState('');
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
        if (firstError) setError('Channel Connector 未安装或部分数据源不可用；已展示能够读取的连接状态。');
      };
      useEffect(() => { void load(); }, []);
      const saveConnection = async event => {
        event.preventDefault(); setSaving(true); setError('');
        try { const value = await hostRemote.updateChannelConnection({ serverUrl: config.serverUrl.trim(), accountId: config.accountId.trim(), workspaceId: config.workspaceId.trim(), ...(config.apiToken ? { apiToken: config.apiToken } : {}) }); setConnection(value); setConfig(previous => ({ ...previous, apiToken: '' })); }
        catch (reason) { setError(reason?.message || '保存 Channel 连接失败'); }
        finally { setSaving(false); }
      };
      const pairingAction = async (id, action) => { setActionBusy(id); try { await hostRemote.channelAction(action, { Id: id }); await load(); } catch (reason) { setError(reason?.message || `${action} 失败`); } finally { setActionBusy(''); } };
      const openChannelEditor = channel => {
        setChannelEditor(channel ? operationalId(channel) : 'new');
        setChannelForm(channel ? { AgentId: channel?.AgentId || channel?.agentId || '', ConnectorWorkspaceId: channel?.ConnectorWorkspaceId || channel?.connectorWorkspaceId || '', Channel: channel?.Channel || channel?.channel || 'wps-xiezuo', ChannelAccountId: channel?.ChannelAccountId || channel?.channelAccountId || '', DmPolicy: channel?.DmPolicy || channel?.dmPolicy || 'pairing', GroupPolicy: channel?.GroupPolicy || channel?.groupPolicy || 'allowlist', RequireMention: channel?.RequireMention ?? channel?.requireMention ?? true, SessionScope: channel?.SessionScope || channel?.sessionScope || 'per-peer', Enabled: channel?.Enabled ?? channel?.enabled ?? true, ConfigJson: channel?.ConfigJson || channel?.configJson || '{}' } : { AgentId: '', ConnectorWorkspaceId: '', Channel: 'wps-xiezuo', ChannelAccountId: '', DmPolicy: 'pairing', GroupPolicy: 'allowlist', RequireMention: true, SessionScope: 'per-peer', Enabled: true, ConfigJson: '{}' });
      };
      const saveChannel = async event => {
        event.preventDefault();
        if (!channelForm.AgentId.trim() || !channelForm.ChannelAccountId.trim() || channelSaving) return;
        setChannelSaving(true); setError('');
        try {
          const action = channelEditor && channelEditor !== 'new' ? 'UpdateChannel' : 'CreateChannel';
          const payload = { ...channelForm, AgentId: channelForm.AgentId.trim(), ChannelAccountId: channelForm.ChannelAccountId.trim(), ...(channelEditor && channelEditor !== 'new' ? { Id: channelEditor } : {}) };
          await hostRemote.channelAction(action, payload);
          setChannelEditor(null); await load();
        } catch (reason) { setError(reason?.message || '渠道保存失败'); }
        finally { setChannelSaving(false); }
      };
      const deleteChannel = async channel => {
        const id = operationalId(channel);
        if (!id || !window.confirm(`删除渠道“${channelLabel(channel)}”？`)) return;
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
        if (!id || !window.confirm('解除这个渠道会话绑定？')) return;
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
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '工作区 ID', h('input', { value: config.workspaceId, onChange: event => setConfig({ ...config, workspaceId: event.target.value }), style: inputStyle() })),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '服务凭证', h('input', { type: 'password', value: config.apiToken, onChange: event => setConfig({ ...config, apiToken: event.target.value }), placeholder: connection?.hasApiToken ? '已保存，留空保留' : '可选', style: inputStyle() })),
            h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, saving ? '保存中…' : '保存连接'))),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取 Channel 数据', detail: '读取连接状态、渠道、配对和消息。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: 'Channels 暂不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '14px' } }, summary.map(item => h(Metric, { key: item[0], label: item[0], value: String(item[1]), detail: item[2] }))),
          h(OperationalToolbar, { onRefresh: () => void load(), busy: status === 'loading' }, h(Pill, { tone: 'neutral' }, 'Channel Connector API'), tab === 'channels' ? h('button', { type: 'button', onClick: () => openChannelEditor(null), style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, '新增渠道') : null),
          channelEditor ? h(ResourceDialog, { title: channelEditor === 'new' ? '新增渠道' : '编辑渠道', detail: '配置渠道连接和会话策略；保存后由 Channel API 管理凭证、配对和消息。', wide: true, onClose: () => { if (!channelSaving) setChannelEditor(null); } }, h('form', { onSubmit: saveChannel, style: { display: 'grid', gap: '10px' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '9px' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Agent ID', h('input', { value: channelForm.AgentId, onChange: event => setChannelForm({ ...channelForm, AgentId: event.target.value }), style: inputStyle(), required: true })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '渠道类型', h('select', { value: channelForm.Channel, onChange: event => setChannelForm({ ...channelForm, Channel: event.target.value }), style: inputStyle() }, h('option', { value: 'wps-xiezuo' }, 'WPS 协作'), h('option', { value: 'feishu' }, '飞书'), h('option', { value: 'wecom' }, '企业微信'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '渠道账号 ID', h('input', { value: channelForm.ChannelAccountId, onChange: event => setChannelForm({ ...channelForm, ChannelAccountId: event.target.value }), style: inputStyle(), required: true }))),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '9px' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '私聊策略', h('select', { value: channelForm.DmPolicy, onChange: event => setChannelForm({ ...channelForm, DmPolicy: event.target.value }), style: inputStyle() }, h('option', { value: 'pairing' }, '需配对'), h('option', { value: 'open' }, '开放'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '群聊策略', h('select', { value: channelForm.GroupPolicy, onChange: event => setChannelForm({ ...channelForm, GroupPolicy: event.target.value }), style: inputStyle() }, h('option', { value: 'allowlist' }, '白名单'), h('option', { value: 'open' }, '开放'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '会话范围', h('select', { value: channelForm.SessionScope, onChange: event => setChannelForm({ ...channelForm, SessionScope: event.target.value }), style: inputStyle() }, h('option', { value: 'per-peer' }, '按用户'), h('option', { value: 'per-group' }, '按群聊'))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '7px', paddingTop: '22px' } }, h('input', { type: 'checkbox', checked: channelForm.Enabled, onChange: event => setChannelForm({ ...channelForm, Enabled: event.target.checked }) }), '启用渠道')),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: () => setChannelEditor(null), disabled: channelSaving, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: channelSaving, style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, channelSaving ? '保存中…' : '保存渠道')))) : null,
          channelQr ? h(ResourceDialog, { title: `连接渠道 · ${channelLabel(channelQr.channel)}`, detail: '连接地址由 Connector 返回；Studio 不生成或保存二维码内容。', onClose: () => setChannelQr(null) },
            channelQr.loading ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, '正在读取连接地址…') : channelQr.error ? h('p', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px', margin: 0 } }, channelQr.error) : channelQr.url ? h('div', { style: { display: 'grid', gap: '8px' } }, h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, channelQr.label || '请打开下面的连接地址完成渠道授权。'), h('a', { href: channelQr.url, target: '_blank', rel: 'noreferrer', style: { color: BRAND.accentStrong, fontSize: '12px', wordBreak: 'break-all' } }, channelQr.url)) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, 'Host 未返回连接地址。')) : null,
          h(StudioPageTabs, { value: tab, onChange: next => { setTab(next); if (next === 'channels') setChannelPage(0); if (next === 'pairings') setPairingPage(0); if (next === 'bindings') setBindingPage(0); if (next === 'messages') setMessagePage(0); }, items: [{ id: 'channels', label: `渠道 ${channels.length}` }, { id: 'pairings', label: `配对请求 ${pairings.length}` }, { id: 'bindings', label: `会话绑定 ${bindings.length}` }, { id: 'messages', label: `消息记录 ${messages.length}` }], ariaLabel: 'Channels 管理视图' }),
          tab === 'channels' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'channel', label: '渠道', cell: row => h('div', null, h('strong', null, `${channelLabel(row)} · ${row?.ChannelAccountId || row?.channelAccountId || '—'}`), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, operationalId(row))) }, { id: 'agent', label: '绑定 Agent', cell: row => row?.AgentId || row?.agentId || '未绑定' }, { id: 'policy', label: '策略', cell: row => `${row?.DmPolicy || row?.dmPolicy || '—'} / ${row?.GroupPolicy || row?.groupPolicy || '—'}` }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.Enabled ?? row?.enabled ? 'enabled' : 'disabled') }, { id: 'action', label: '操作', cell: row => h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ['feishu', 'wecom'].includes(String(row?.Channel || row?.channel).toLowerCase()) ? h('button', { type: 'button', onClick: event => { event.stopPropagation(); void openChannelQr(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '扫码连接') : null, h('button', { type: 'button', onClick: event => { event.stopPropagation(); openChannelEditor(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '编辑'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void deleteChannel(row); }, style: { ...buttonStyle(), padding: '5px 8px', color: BRAND.danger, background: BRAND.surface } }, '删除')) }], rows: visibleChannels, empty: '还没有渠道配置，请先保存连接并创建渠道。' }), h(OperationalPager, { page: channelPage, pageSize: channelPageSize, total: channels.length, onChange: setChannelPage })) : null,
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

    function StudioShell({ scheduleRemote, page = 'overview', onNavigate }) {
      const activeNav = PANELS.find(item => item.page === page) || PANELS[0];
      return h('div', {
        'data-agentkit-studio': 'application-shell',
        style: { minHeight: '100%', background: BRAND.canvas, color: BRAND.ink, fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
      },
      h('main', { style: { minWidth: 0, padding: '24px 28px 30px', overflow: 'auto' } },
        h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '24px' } },
          h('div', null,
            h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'AgentKit Studio'),
            h('h1', { style: { color: BRAND.ink, margin: '6px 0 5px', fontSize: '25px', letterSpacing: '-0.035em' } }, activeNav.label),
            h('p', { style: { color: BRAND.inkMuted, margin: 0, fontSize: '13px' } }, activeNav.note)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } }, h(Pill, { tone: 'neutral' }, 'Local'), h(HostStatusPill)))),
        page === 'overview' ? h(OverviewPage, { onNavigate }) : page === 'agents' ? h(AgentWorkspace, { onNavigate }) : page === 'resource-hub' ? h(ResourceWorkspace) : page === 'operations' ? h(OperationsWorkspace, { scheduleRemote }) : h(DomainPage, { page }));
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
     * Bridge Studio's product form to the DSH model contract. KsADK remains
     * the source for Studio defaults and cloud credentials, but DSH chat only
     * sees providers registered through its own settings/credentials Remotes.
     * Keeping this bridge on the public Remote surface avoids a second model
     * catalog or a browser-owned chat implementation.
     */
    function createDshModelBridge(ctx) {
      const describe = async () => {
        const response = await ctx.remote.settings.describe();
        if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置不可用');
        return response.value;
      };
      return {
        describe,
        apply: async ({ provider, baseUrl, modelName, apiKey }) => {
          const document = await describe();
          const namespace = (document.namespaces || []).find(item => item.ns === DSH_MODEL_SETTINGS_NS);
          const existing = namespace?.user?.providers?.[DSH_MODEL_ROUTE]
            || namespace?.value?.providers?.[DSH_MODEL_ROUTE]
            || {};
          const normalizedProvider = String(provider || 'ksyun').trim() || 'ksyun';
          const normalizedModel = String(modelName || '').trim();
          const normalizedBaseUrl = String(baseUrl || '').trim()
            || (normalizedProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : '');
          if (!normalizedModel || !normalizedBaseUrl) {
            throw new Error('请填写模型名称；自定义提供商才需要填写 API 地址');
          }
          const profile = {
            ...existing,
            displayName: 'AgentKit Studio',
            api: 'openai-completions',
            apiKeyEnv: DSH_MODEL_CREDENTIAL,
            baseURL: normalizedBaseUrl,
            models: [{
              id: normalizedModel,
              name: normalizedModel,
              contextWindow: 262144,
              maxTokens: 32768,
            }],
          };
          const normalizedKey = String(apiKey || '').trim();
          const response = await ctx.remote.settings.mutate(
            DSH_MODEL_SETTINGS_NS,
            [{ op: 'set', path: ['providers', DSH_MODEL_ROUTE], value: profile }],
            namespace?.revision,
          );
          if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型配置保存失败');
          const defaultNamespace = (await describe()).namespaces?.find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
          if (!defaultNamespace) throw new Error('DSH 默认模型设置不可用，无法让新会话使用该模型');
          const defaultResponse = await ctx.remote.settings.mutate(
            DSH_DEFAULT_MODEL_SETTINGS_NS,
            [
              { op: 'set', path: ['provider'], value: DSH_MODEL_ROUTE },
              { op: 'set', path: ['model'], value: normalizedModel },
            ],
            defaultNamespace.revision,
          );
          if (!defaultResponse?.ok) throw new Error(defaultResponse?.error?.message || 'DSH 默认模型保存失败');
          if (normalizedKey) {
            const stored = await ctx.remote.credentials.set(DSH_MODEL_CREDENTIAL, normalizedKey);
            if (!stored?.ok) throw new Error(stored?.error?.message || 'DSH 模型凭证保存失败');
          }
          return { provider, route: DSH_MODEL_ROUTE, model: normalizedModel };
        },
        credentialStatus: async () => {
          const response = await ctx.remote.credentials.describe([DSH_MODEL_CREDENTIAL]);
          if (!response?.ok) throw new Error(response?.error?.message || 'DSH 模型凭证不可用');
          return response.value?.[DSH_MODEL_CREDENTIAL] || { configured: false };
        },
      };
    }

    function ModelSettingsSection({ dshModel }) {
      const [form, setForm] = useState({
        provider: 'ksyun', baseUrl: DEFAULT_KSYUN_BASE_URL, modelName: DEFAULT_KSYUN_MODEL, apiKey: '',
        cloudAccessKey: '', cloudSecretKey: '', cloudAccountId: '', cloudRegion: '',
        cloudServerUrl: '', cloudBucket: '',
      });
      const [modelStatus, setModelStatus] = useState({ configured: false, source: 'missing' });
      const [cloudStatus, setCloudStatus] = useState({ configured: false, source: 'missing' });
      const [dshStatus, setDshStatus] = useState({ configured: false, model: '', credentialConfigured: false });
      const [status, setStatus] = useState('loading');
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [saving, setSaving] = useState(false);

      const load = async () => {
        setStatus('loading');
        setError('');
        try {
          const [settings, primaryStatus, aliasStatus, dshDocument, dshCredential] = await Promise.all([
            hostRemote.settings(),
            hostRemote.credential(MODEL_CREDENTIAL_NAMES[0]),
            hostRemote.credential(MODEL_CREDENTIAL_NAMES[1]),
            dshModel.describe(),
            dshModel.credentialStatus(),
          ]);
          const selectedModelStatus = primaryStatus?.configured ? primaryStatus : aliasStatus;
          setModelStatus(selectedModelStatus || { configured: false, source: 'missing' });
          setCloudStatus({
            configured: Boolean(settings?.cloudAccountConfigured),
            source: settings?.configurationSources?.cloudAccessKey || 'missing',
          });
          const dshProfile = (dshDocument?.namespaces || [])
            .find(item => item.ns === DSH_MODEL_SETTINGS_NS)?.value?.providers?.[DSH_MODEL_ROUTE];
          const configuredModel = dshProfile?.models?.[0]?.id || '';
          const configuredBaseUrl = dshProfile?.baseURL || '';
          const configuredCredential = dshProfile?.apiKeyEnv || '';
          const studioProvider = settings?.modelProvider || 'ksyun';
          const studioModel = settings?.modelName || DEFAULT_KSYUN_MODEL;
          const configuredStudioBaseUrl = settings?.modelBaseUrl || '';
          const studioBaseUrl = studioProvider === 'ksyun'
            ? (configuredStudioBaseUrl || DEFAULT_KSYUN_BASE_URL)
            : (configuredStudioBaseUrl === DEFAULT_KSYUN_BASE_URL ? '' : configuredStudioBaseUrl);
          if (studioModel && studioBaseUrl
            && (configuredModel !== studioModel || configuredBaseUrl !== studioBaseUrl || configuredCredential !== DSH_MODEL_CREDENTIAL)) {
            // Keep the DSH model directory convergent with the Studio/Host
            // defaults even when the user edits ~/.agentkit outside this page.
            // No secret is copied here; a key is synchronized only on an
            // explicit Save with a newly entered value.
            try {
              await dshModel.apply({ provider: studioProvider, baseUrl: studioBaseUrl, modelName: studioModel, apiKey: '' });
              setDshStatus({ configured: true, model: studioModel, credentialConfigured: Boolean(dshCredential?.configured || selectedModelStatus?.configured) });
            } catch (reason) {
              setDshStatus({ configured: Boolean(configuredModel), model: configuredModel, credentialConfigured: Boolean(dshCredential?.configured || selectedModelStatus?.configured) });
              setError(reason?.message || 'DSH 模型目录同步失败');
            }
          } else {
            setDshStatus({ configured: Boolean(configuredModel), model: configuredModel, credentialConfigured: Boolean(dshCredential?.configured || selectedModelStatus?.configured) });
          }
          setForm(current => ({
            ...current,
            provider: studioProvider,
            baseUrl: settings?.modelBaseUrl || (studioProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : ''),
            modelName: settings?.modelName || DEFAULT_KSYUN_MODEL,
            cloudAccountId: settings?.cloudAccountId || '',
            cloudRegion: settings?.cloudRegion || '',
            cloudServerUrl: settings?.cloudServerUrl || '',
            cloudBucket: settings?.cloudBucket || '',
          }));
          setStatus('ready');
        } catch (reason) {
          setStatus('error');
          setError(reason?.message || 'Host 尚未连接');
        }
      };

      useEffect(() => { load(); }, []);

      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const sourceLabel = source => ({
        global: '全局 ~/.agentkit',
        workspace: '当前工作区',
        environment: '环境变量',
        'workspace-alias': '当前工作区别名',
        'global-alias': '全局 ~/.agentkit（兼容别名）',
        session: '本次 Host 会话',
        missing: '未配置',
      }[source] || source || '未配置');

      const save = async event => {
        event.preventDefault();
        if (saving || status !== 'ready') return;
        setSaving(true);
        setMessage('');
        setError('');
        try {
          const modelProvider = form.provider.trim() || 'ksyun';
          const modelBaseUrl = form.baseUrl.trim() || (modelProvider === 'ksyun' ? DEFAULT_KSYUN_BASE_URL : '');
          const settingsPayload = {
            modelProvider,
            modelBaseUrl,
            modelName: form.modelName.trim() || DEFAULT_KSYUN_MODEL,
            cloudAccountId: form.cloudAccountId.trim(),
            cloudRegion: form.cloudRegion.trim(),
            cloudServerUrl: form.cloudServerUrl.trim(),
            cloudBucket: form.cloudBucket.trim(),
          };
          if (form.cloudAccessKey.trim()) settingsPayload.cloudAccessKey = form.cloudAccessKey.trim();
          if (form.cloudSecretKey.trim()) settingsPayload.cloudSecretKey = form.cloudSecretKey.trim();
          await hostRemote.updateSettings(settingsPayload);
          if (form.apiKey.trim()) {
            await hostRemote.putCredential('AGENTKIT_MODEL_API_KEY', form.apiKey.trim());
          }
          await dshModel.apply({
            provider: modelProvider,
            baseUrl: modelBaseUrl,
            modelName: form.modelName.trim() || DEFAULT_KSYUN_MODEL,
            apiKey: form.apiKey.trim(),
          });
          setForm(current => ({ ...current, apiKey: '', cloudAccessKey: '', cloudSecretKey: '' }));
          setMessage('已保存到本机 Host，并同步到 DSH 聊天模型目录；新会话可直接选择该模型。');
          await load();
        } catch (reason) {
          setError(reason?.message || '保存模型与凭证失败');
        } finally {
          setSaving(false);
        }
      };

      const field = (label, key, placeholder, type = 'text') => h('label', {
        style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 },
      }, label, h('input', {
        type, value: form[key], placeholder, autoComplete: type === 'password' ? 'new-password' : 'off',
        onChange: event => setField(key, event.target.value), style: inputStyle(),
      }));

      const isKsyun = form.provider === 'ksyun';
      const changeProvider = event => {
        const provider = event.target.value;
        setForm(current => ({
          ...current,
          provider,
          baseUrl: provider === 'ksyun'
            ? (current.baseUrl || DEFAULT_KSYUN_BASE_URL)
            : (current.baseUrl === DEFAULT_KSYUN_BASE_URL ? '' : current.baseUrl),
        }));
      };
      return h('div', { style: { color: BRAND.ink, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' } },
        status === 'error' ? h('div', { role: 'alert', style: { marginBottom: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        h('form', { onSubmit: save, style: { display: 'grid', gap: '14px', maxWidth: '900px' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '14px', alignItems: 'start' } },
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
                h('div', null,
                  h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '默认模型'),
                  h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '新会话和未绑定专属模型的 Agent 使用')),
                h(Pill, { tone: dshStatus.configured && dshStatus.credentialConfigured ? 'accent' : 'signal' }, dshStatus.configured ? 'DSH 已识别' : '待同步')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: '9px' } },
                h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '提供商', h('select', { value: form.provider, onChange: changeProvider, style: inputStyle() },
                  h('option', { value: 'ksyun' }, '金山云模型服务'),
                  h('option', { value: 'openai-compatible' }, 'OpenAI 兼容接口'),
                  h('option', { value: 'custom' }, '自定义提供商'))),
                field('模型名称', 'modelName', DEFAULT_KSYUN_MODEL)),
              isKsyun ? h('div', { style: { marginTop: '8px', color: BRAND.inkMuted, fontSize: '10px' } }, '金山云模型服务使用默认地址，无需填写 API 地址。') : field('API 地址', 'baseUrl', '例如：https://api.example.com/v1'),
              h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px', alignItems: 'end', marginTop: '8px' } },
                field('API Key（留空表示不修改）', 'apiKey', modelStatus.configured ? '已配置，留空保持不变' : '由本机 Host 安全保存', 'password'),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', color: BRAND.inkMuted, fontSize: '10px', flexWrap: 'wrap' } },
                  h('span', null, '来源：', sourceLabel(modelStatus.source)),
                  isKsyun
                    ? h('a', { href: 'https://ksp.console.ksyun.com/#/apiKey', target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong, textDecoration: 'underline' } }, '获取 Key')
                    : h('span', { style: { color: BRAND.inkMuted } }, '请填写该提供商的 API Key'))),
            ),
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
                h('div', null,
                  h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '14px' } }, '云端凭证'),
                  h('p', { style: { margin: '3px 0 0', color: BRAND.inkMuted, fontSize: '11px' } }, '用于构建、部署和资源访问')),
                h(Pill, { tone: cloudStatus.configured ? 'accent' : 'signal' }, cloudStatus.configured ? '已配置' : '未配置')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px' } },
                field('Access Key', 'cloudAccessKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Access Key', 'password'),
                field('Secret Key', 'cloudSecretKey', cloudStatus.configured ? '已配置，留空保持不变' : '云端 Secret Key', 'password')),
              h('details', { style: { marginTop: '10px', color: BRAND.inkMuted, fontSize: '11px' } },
                h('summary', { style: { cursor: 'pointer', color: BRAND.ink, fontWeight: 700 } }, '高级云端设置'),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px', marginTop: '8px' } },
                  field('Account ID', 'cloudAccountId', '可选'),
                  field('区域', 'cloudRegion', '例如：cn-beijing-6'),
                  field('控制面地址', 'cloudServerUrl', '例如：https://agentengine.example.com'),
                  field('对象存储桶', 'cloudBucket', '可选'))),
              h('div', { style: { marginTop: '9px', color: BRAND.inkMuted, fontSize: '10px' } }, '当前来源：', sourceLabel(cloudStatus.source))),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', flexWrap: 'wrap' } },
            message ? h('span', { role: 'status', style: { color: BRAND.accentStrong, fontSize: '11px', marginRight: 'auto' } }, message) : null,
            error ? h('span', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px', marginRight: 'auto' } }, error) : null,
            h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取'),
            h('button', { type: 'submit', disabled: saving || status !== 'ready', style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: saving || status !== 'ready' ? 'var(--dsw-alias-label-tertiary, #aab7c4)' : BRAND.primaryFill, borderColor: 'transparent' } }, saving ? '保存中…' : '保存配置'))));
    }

