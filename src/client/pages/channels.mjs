import { operationalCollection, operationalDate, operationalId } from '../state/operational-data.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createChannelsPage({ ui, hostRemote, actions, window = globalThis.window, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  const { React, EmptyState, Metric, OperationalPageHeading, OperationalPager, OperationalTable, OperationalToolbar, Pill, ResourceDialog, StudioPageTabs, buttonStyle, inputStyle, operationalStatus, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h, useEffect, useState } = React;
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
      if (!id || !(await (actions.confirm({ title: '删除渠道', detail: `删除渠道“${channelLabel(channel)}”？此操作不可撤销。`, confirmLabel: '删除', danger: true })))) return;
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
      if (!id || !(await (actions.confirm({ title: '解除会话绑定', detail: '解除这个渠道会话绑定？', confirmLabel: '解除', danger: true })))) return;
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
          h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.primaryFill, color: BRAND.primaryText, borderColor: 'transparent' } }, saving ? '保存中…' : '保存连接'))),
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
        h(OperationalToolbar, { onRefresh: () => void load(), busy: status === 'loading' }, h(Pill, { tone: 'neutral' }, 'Channel Connector API'), tab === 'channels' ? h('button', { type: 'button', onClick: () => openChannelEditor(null), style: { ...buttonStyle(), background: BRAND.primaryFill, color: BRAND.primaryText, borderColor: 'transparent' } }, '新增渠道') : null),
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
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: () => setChannelEditor(null), disabled: channelSaving, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: channelSaving, style: { ...buttonStyle(), background: BRAND.primaryFill, color: BRAND.primaryText, borderColor: 'transparent' } }, channelSaving ? '保存中…' : '保存渠道')))) : null,
        channelQr ? h(ResourceDialog, { title: `连接渠道 · ${channelLabel(channelQr.channel)}`, detail: '连接地址由 Connector 返回；Studio 不生成或保存二维码内容。', onClose: () => setChannelQr(null) },
          channelQr.loading ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, '正在读取连接地址…') : channelQr.error ? h('p', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px', margin: 0 } }, channelQr.error) : channelQr.url ? h('div', { style: { display: 'grid', gap: '8px' } }, h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, channelQr.label || '请打开下面的连接地址完成渠道授权。'), h('a', { href: channelQr.url, target: '_blank', rel: 'noreferrer', style: { color: BRAND.accentStrong, fontSize: '12px', wordBreak: 'break-all' } }, channelQr.url)) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, 'Host 未返回连接地址。')) : null,
        h(StudioPageTabs, { value: tab, onChange: next => { setTab(next); if (next === 'channels') setChannelPage(0); if (next === 'pairings') setPairingPage(0); if (next === 'bindings') setBindingPage(0); if (next === 'messages') setMessagePage(0); }, items: [{ id: 'channels', label: `渠道 ${channels.length}` }, { id: 'pairings', label: `配对请求 ${pairings.length}` }, { id: 'bindings', label: `会话绑定 ${bindings.length}` }, { id: 'messages', label: `消息记录 ${messages.length}` }], ariaLabel: 'Channels 管理视图' }),
        tab === 'channels' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'channel', label: '渠道', cell: row => h('div', null, h('strong', null, `${channelLabel(row)} · ${row?.ChannelAccountId || row?.channelAccountId || '—'}`), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, operationalId(row))) }, { id: 'agent', label: '绑定 Agent', cell: row => h('div', null, [...(connection?.localAgents || []), ...(connection?.cloudAgents || [])].find(item => item.id === (row?.AgentId || row?.agentId))?.name || row?.AgentId || row?.agentId || '未绑定', (row?.ConnectorWorkspaceId || row?.connectorWorkspaceId) ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '本地设备执行') : h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '云端执行')) }, { id: 'policy', label: '策略', cell: row => `${row?.DmPolicy || row?.dmPolicy || '—'} / ${row?.GroupPolicy || row?.groupPolicy || '—'}` }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.Enabled ?? row?.enabled ? 'enabled' : 'disabled') }, { id: 'action', label: '操作', cell: row => h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ['feishu', 'wecom'].includes(String(row?.Channel || row?.channel).toLowerCase()) ? h('button', { type: 'button', onClick: event => { event.stopPropagation(); void openChannelQr(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '扫码连接') : null, h('button', { type: 'button', onClick: event => { event.stopPropagation(); openChannelEditor(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '编辑'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void deleteChannel(row); }, style: { ...buttonStyle(), padding: '5px 8px', color: BRAND.danger, background: BRAND.surface } }, '删除')) }], rows: visibleChannels, empty: '还没有渠道配置，请先保存连接并创建渠道。' }), h(OperationalPager, { page: channelPage, pageSize: channelPageSize, total: channels.length, onChange: setChannelPage })) : null,
        tab === 'pairings' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'sender', label: '申请人', cell: row => h('strong', null, row?.SenderName || row?.senderName || row?.SenderId || '—') }, { id: 'channel', label: '渠道', cell: row => `${channelLabel(row)} · ${row?.ChannelAccountId || '—'}` }, { id: 'chat', label: '会话', cell: row => row?.ChatType || row?.chatType || row?.PeerId || '—' }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.Status || row?.status) }, { id: 'action', label: '操作', cell: row => String(row?.Status || row?.status).toLowerCase() === 'pending' ? h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void pairingAction(operationalId(row), 'ApprovePairing'); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '通过'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void pairingAction(operationalId(row), 'RejectPairing'); }, style: { ...buttonStyle(), padding: '5px 8px', background: BRAND.surface } }, '拒绝')) : '—' }], rows: visiblePairings, empty: '没有待处理的配对请求。' }), h(OperationalPager, { page: pairingPage, pageSize: channelSecondaryPageSize, total: pairings.length, onChange: setPairingPage })) : null,
        tab === 'bindings' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'channel', label: '渠道', cell: row => `${channelLabel(row)} · ${row?.ChannelAccountId || '—'}` }, { id: 'agent', label: 'Agent', cell: row => row?.AgentId || row?.agentId || '—' }, { id: 'peer', label: '对端', cell: row => row?.PeerId || row?.peerId || '—' }, { id: 'session', label: 'Session', cell: row => h('div', null, h('span', null, row?.SessionId || row?.sessionId || '未关联'), activeTakeovers[operationalId(row)] ? h(Pill, { tone: 'signal' }, '已接管') : null) }, { id: 'createdAt', label: '更新时间', cell: row => operationalDate(row?.UpdatedAt || row?.updatedAt || row?.CreatedAt) }, { id: 'action', label: '操作', cell: row => h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } }, h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void updateBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '编辑会话'), activeTakeovers[operationalId(row)] ? h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void releaseBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '释放接管') : h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void takeoverBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px' } }, '接管'), h('button', { type: 'button', disabled: actionBusy === operationalId(row), onClick: event => { event.stopPropagation(); void deleteBinding(row); }, style: { ...buttonStyle(), padding: '5px 8px', color: BRAND.danger, background: BRAND.surface } }, '解除绑定')) }], rows: visibleBindings, empty: '没有会话绑定；用户完成渠道配对后会出现在这里。' }), h(OperationalPager, { page: bindingPage, pageSize: channelSecondaryPageSize, total: bindings.length, onChange: setBindingPage })) : null,
        tab === 'messages' ? h(React.Fragment, null, messageWorkspace, h(OperationalPager, { page: messagePage, pageSize: channelSecondaryPageSize, total: conversations.length, onChange: next => { setMessagePage(next); setSelectedConversationId(''); } })) : null,
        error ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.signal, fontSize: '12px' } }, error) : null) : null);
  }
  return { ChannelsPage };
}
