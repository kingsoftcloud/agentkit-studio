/** Assistant client: closing this view only releases reads, never cloud work. */
import { assistantCancelAvailable, assistantRetryAvailable, assistantTranscript, createAssistantSession } from '../state/assistant-session.mjs';
import { createAssistantApprovals } from '../components/assistant-approvals.mjs';
import { createAssistantNativeComposer } from '../components/assistant-native-composer.mjs';
import { readAssistantAttachment } from '../state/assistant-attachments.mjs';
export function createAssistantPage({ ui, hostRemote, actions, window, nativeModules }) {
  const { React: { createElement: h, useState, useEffect, useRef }, BRAND, buttonStyle, inputStyle, ComputerConnection, AssistantTranscript, AssistantBrowser, Button, FileTypeIcon, StateDot } = ui;
  const NativeComposer = nativeModules ? createAssistantNativeComposer({ ui, hostRemote, nativeModules, window }) : null;
  const Action = Button || 'button';
  const AssistantApprovals = createAssistantApprovals({ ui, window });
  const read = key => { try { return JSON.parse(window.localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => window.localStorage.setItem(key, JSON.stringify(value));
  return function AssistantPage({ onNavigate }) {
    const [catalog, setCatalog] = useState([]), [agentId, setAgentId] = useState(() => read('agentkit.assistant.agent') || '');
    const [error, setError] = useState('');
    const sessionRef = useRef(null);
    if (!sessionRef.current) sessionRef.current = createAssistantSession({
      execute: (id, operation, input, signal) => hostRemote.assistantExecute(id, operation, input, signal),
      storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: key => window.localStorage.removeItem(key) },
      createRequestId: () => window.crypto.randomUUID(),
      readAttachment: (file, options) => readAssistantAttachment(file, { ...options, FileReader: window.FileReader }), setTimer: (work, delay) => window.setTimeout(work, delay), clearTimer: id => window.clearTimeout(id),
    });
    const session = sessionRef.current;
    const [sessionState, setSessionState] = useState(() => session.getState());
    // Effects connect the selected agent after render. Never pair an old transcript
    // (including its attachment IDs) with the newly selected cloud agent.
    const sessionMatches = sessionState.agentId === agentId;
    const { draft, attachments, attachmentError, busy, pending, pendingInvalid, notice, olderHasMore, loadingOlder, cancelPhase } = sessionMatches ? sessionState
      : { draft: '', attachments: [], attachmentError: '', busy: true, pending: null, pendingInvalid: false, notice: '', olderHasMore: null, loadingOlder: false, cancelPhase: null };
    const { messages, view } = sessionMatches ? assistantTranscript(sessionState) : { messages: [], view: null };
    const nativeComposerAvailable = Boolean(NativeComposer && view?.capabilities?.composer?.nativeComposer === true);
    const useNativeComposer = Boolean(nativeComposerAvailable && !pending && !pendingInvalid && !attachments.length && !draft.trim());
    const composer = useRef(null), filePicker = useRef(null), history = useRef(null), followLatest = useRef(true);
    useEffect(() => session.subscribe(setSessionState), [session]);
    const [catalogReady, setCatalogReady] = useState(false);
    const [setup, setSetup] = useState(null), [setupOptions, setSetupOptions] = useState(null);
    const [setupMemory, setSetupMemory] = useState(''), [setupBusy, setSetupBusy] = useState(false);
    const [upgrade, setUpgrade] = useState(null), [upgrading, setUpgrading] = useState(false);
    useEffect(() => {
      let alive = true;
      hostRemote.assistantCatalog().then(result => {
        if (!alive) return;
        const items = result.items || [];
        setCatalog(items);
        const saved = read('agentkit.assistant.agent');
        const next = items.some(item => item.metadata.id === saved) ? saved : items.length === 1 ? items[0].metadata.id : '';
        setAgentId(next);
        if (next) { try { save('agentkit.assistant.agent', next); } catch { /* Reading remains available without local persistence. */ } }
        if (result.warnings?.length) setError(result.warnings.join('；'));
      }).catch(reason => { if (alive) setError(reason.message); }).finally(() => { if (alive) setCatalogReady(true); });
      return () => { alive = false; };
    }, []);
    useEffect(() => {
      if (!catalogReady || catalog.length) return;
      let stopped = false, timer, optionsLoaded = false, settled = false;
      const refresh = async () => {
        try {
          const current = await hostRemote.assistantSetupStatus();
          if (stopped) return;
          setSetup(current);
          if (current.ready) {
            if (catalog.length) { settled = true; return; }
            const result = await hostRemote.assistantCatalog();
            if (stopped) return;
            setCatalog(result.items || []);
            if ((result.items || []).some(item => item.metadata.id === current.cloudAgentId)) {
              save('agentkit.assistant.agent', current.cloudAgentId); setAgentId(current.cloudAgentId);
            }
          } else if (['NOT_STARTED', 'DELETED'].includes(current.state)) {
            if (catalog.length) { settled = true; return; }
            if (!optionsLoaded) {
              const available = await hostRemote.assistantSetupOptions();
              if (!stopped) { setSetupOptions(available); setSetupMemory(previous => previous || (available.memories.length === 1 ? available.memories[0].id : '')); optionsLoaded = true; }
            }
          }
          if (!stopped) setError('');
        } catch (reason) { if (!stopped) setError(reason.message); }
        finally { if (!stopped && !settled) timer = window.setTimeout(refresh, 5000); }
      };
      void refresh();
      return () => { stopped = true; window.clearTimeout(timer); };
    }, [catalogReady, catalog.length]);
    const connectedAgentId = catalog.some(item => item.metadata.id === agentId) ? agentId : '';
    // A ready assistant may still run an older cloud image. Offer the in-place
    // rollout update (history, workspace files and memory are preserved) only
    // when the catalog exposes a different eligible release.
    useEffect(() => {
      if (!connectedAgentId) { setUpgrade(null); return; }
      let alive = true;
      void (async () => {
        try {
          const current = await hostRemote.assistantSetupStatus();
          if (!alive || !current?.ready) { if (alive) setUpgrade(null); return; }
          const available = await hostRemote.assistantSetupOptions();
          if (!alive) return;
          setUpgrade({ currentReleaseId: current.releaseId || null, availableReleaseId: available.releaseId, optionsId: available.optionsId });
        } catch { if (alive) setUpgrade(null); }
      })();
      return () => { alive = false; };
    }, [connectedAgentId]);
    const upgradeNow = async () => {
      if (!upgrade || upgrading) return;
      const confirmed = await actions.confirm({ title: '升级云端助理', detail: '将切换到新的云端运行版本并重建冻结包；会话历史、工作区文件和记忆会保留，升级期间暂不能对话。', confirmLabel: '升级' });
      if (!confirmed) return;
      setUpgrading(true); setError('');
      try {
        const result = await hostRemote.assistantSetupUpgrade({ confirmed: true, optionsId: upgrade.optionsId });
        setUpgrade(previous => previous ? { ...previous, currentReleaseId: result?.releaseId || previous.availableReleaseId } : previous);
        setNotice('云端助理正在升级，完成后自动生效。');
        void session.refresh();
      } catch (reason) { setError(reason.message); }
      finally { setUpgrading(false); }
    };
    useEffect(() => {
      followLatest.current = true;
      session.connect(connectedAgentId);
      return () => session.disconnect();
    }, [connectedAgentId, session]);
    useEffect(() => {
      const reconnect = () => { if (window.document?.visibilityState !== 'hidden') void session.refresh(); };
      window.addEventListener('online', reconnect);
      window.addEventListener('focus', reconnect);
      window.document?.addEventListener('visibilitychange', reconnect);
      return () => {
        window.removeEventListener('online', reconnect);
        window.removeEventListener('focus', reconnect);
        window.document?.removeEventListener('visibilitychange', reconnect);
      };
    }, [session]);
    useEffect(() => {
      const changed = event => { if (!event.detail || catalog.some(item => item.metadata.id === event.detail)) setAgentId(event.detail || ''); };
      const deleted = event => { setCatalog(items => items.filter(item => item.metadata.id !== event.detail)); if (event.detail === agentId) { setAgentId(''); } };
      window.addEventListener('agentkit-studio:assistant-changed', changed);
      window.addEventListener('agentkit-studio:assistant-deleted', deleted);
      return () => { window.removeEventListener('agentkit-studio:assistant-changed', changed); window.removeEventListener('agentkit-studio:assistant-deleted', deleted); };
    }, [catalog, agentId]);
    useEffect(() => {
      const changed = event => { if (event.detail?.agentId === agentId) session.updateIdentity(event.detail.identity, event.detail.agentId); };
      window.addEventListener('agentkit-studio:assistant-identity-changed', changed);
      return () => window.removeEventListener('agentkit-studio:assistant-identity-changed', changed);
    }, [agentId, session]);
    useEffect(() => {
      if (followLatest.current && history.current) history.current.scrollTop = history.current.scrollHeight;
    }, [view?.asOfSeq, messages.length, pending?.requestId]);
    const submit = () => { followLatest.current = true; return session.submit(); };
    const button = (label, onClick, disabled = false) => h(Action, { type: 'button', onClick, disabled: busy || disabled, ...(Button ? { variant: 'outline', size: 'sm' } : { style: buttonStyle() }) }, label);
    const box = { border: `1px solid ${BRAND.border}`, borderRadius: '12px', padding: '16px', background: BRAND.surface };
    const chosen = catalog.find(item => item.metadata.id === agentId);
    const assistantName = view?.identity?.assistantName || chosen?.metadata.name || '个人助理';
    const running = view?.status === 'running';
    const canCancel = assistantCancelAvailable(view);
    const canUpload = view?.capabilities?.input?.attachments === true;
    const attachmentsReady = attachments.every(row => row.status === 'ready');
    const historyUnavailable = view?.historyState === 'migration-required' || view?.status === 'migration-required';
    const hasConversation = Boolean(pending || view?.queued?.length || messages.some(message => message.requestId !== 'assistant-welcome-v1')
      || view?.events?.some(event => ['assistant/message', 'tool/call', 'tool/result', 'deliverables/presented', 'goal/change', 'approval/asked'].includes(event.type)));
    const stopping = cancelPhase === 'stopping' || cancelPhase === 'requesting';
    const statusLabel = stopping ? '正在等待云端确认停止…' : running ? '正在处理…' : view?.status === 'queued' ? '已排队，等待处理…' : '';
    const conversationError = (sessionMatches && (sessionState.error || sessionState.readError)) || error || view?.failure?.message || (view?.status === 'failed' ? '助理本次任务未完成，请重试。' : '');
    const openSettings = () => window.dispatchEvent(new window.CustomEvent('agentkit-studio:open-settings'));
    if (catalogReady && !catalog.length && !chosen) {
      const setupError = error || setup?.failure?.message || (setup?.failure ? setup.message : '');
      const preparing = !setupError && setup && !['NOT_STARTED', 'ACTION_REQUIRED', 'FAILED', 'CREATE_UNKNOWN', 'UPLOAD_UNKNOWN', 'DELETED'].includes(setup.state);
      const start = async () => {
        if (setupBusy || !setupOptions) return;
        setSetupBusy(true); setError('');
        try { setSetup(await hostRemote.assistantSetupStart({ confirmed: true, optionsId: setupOptions.optionsId, memoryId: setupMemory })); }
        catch (reason) { setError(reason.message); }
        finally { setSetupBusy(false); }
      };
      return h('section', { 'data-studio-assistant': true, 'data-studio-assistant-setup': true, style: { position: 'relative', height: '100%', boxSizing: 'border-box', overflow: 'auto', display: 'grid', placeItems: 'center', background: BRAND.surface, padding: '96px 32px 32px' } },
        h('style', null, '@keyframes assistant-setup-spin { to { transform: rotate(360deg); } } @media (prefers-reduced-motion: reduce) { [data-studio-assistant-spinner] { animation: none !important; } }'),
        h('header', { style: { position: 'absolute', top: '16px', left: '24px', right: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('span', { style: { fontSize: '16px', fontWeight: 600 } }, '个人助理'), h(ComputerConnection, { assistantName: '个人助理' })),
        h('div', { style: { maxWidth: '440px', width: '100%', textAlign: 'center' } },
          preparing || setupBusy ? h('div', { 'data-studio-assistant-spinner': true, 'aria-hidden': true, style: { width: '32px', height: '32px', border: `3px solid ${BRAND.border}`, borderTopColor: BRAND.primaryFill, borderRadius: '50%', margin: '0 auto 24px', animation: 'assistant-setup-spin 1s linear infinite' } }) : null,
          h('h1', { style: { fontSize: '26px', fontWeight: 500, margin: '0 0 14px' } }, setupError ? '助理连接暂不可用' : preparing || setupBusy ? '你的助理正在准备中' : '7×24 的个人助理'),
          h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.8, margin: '0 0 24px' } }, preparing || setupBusy ? '正在准备，请稍候。' : '交代任务、安排提醒，记住你的偏好。'),
          preparing ? h('p', { role: 'status', style: { fontSize: '14px' } }, setup.message) : null,
          setupError ? h('p', { role: 'alert', style: { color: BRAND.danger, lineHeight: 1.7 } }, setupError) : null,
          ['NOT_STARTED', 'DELETED'].includes(setup?.state) && setupOptions ? h('div', null,
            setupOptions.memories.length > 1 ? h('label', { style: { display: 'block', textAlign: 'left', fontSize: '13px', marginBottom: '16px' } }, '把记忆保存在',
              h('select', { 'aria-label': '助理记忆库', value: setupMemory, onChange: event => setSetupMemory(event.target.value), style: { ...inputStyle(), width: '100%', marginTop: '8px' } },
                h('option', { value: '' }, '选择记忆库'), ...setupOptions.memories.map(item => h('option', { key: item.id, value: item.id }, item.name)))) : null,
            h('button', { type: 'button', onClick: () => void start(), disabled: setupBusy || !setupMemory, style: { ...buttonStyle(), padding: '12px 24px', borderRadius: '12px', background: BRAND.primaryFill, color: BRAND.primaryText } }, '开通个人助理'),
            h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.7, marginTop: '18px' } }, setupOptions.billingNotice),
            setupOptions.permissionNotice ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.7 } }, setupOptions.permissionNotice) : null,
            h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, `使用 ${setupOptions.model.name} · ${setupOptions.memories.find(item => item.id === setupMemory)?.name || '选择一个记忆库'}`)) : null,
          setupError ? h('div', { style: { display: 'flex', gap: '12px', justifyContent: 'center' } },
            button('检查云端设置', openSettings), button('查看运行中心', () => onNavigate?.('operations'))) : null));
    }
    return h(AssistantBrowser || ui.React.Fragment, AssistantBrowser ? { key: connectedAgentId || agentId, agentId: connectedAgentId || agentId } : null, h('section', { 'data-studio-assistant': true, style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: BRAND.surface } },
      h('style', null, `[data-studio-assistant] .studio-assistant-composer:focus-within { outline: 1px solid ${BRAND.border}; outline-offset: 2px; } [data-studio-assistant] textarea[aria-label="发给助理"]::placeholder { color: ${BRAND.inkMuted}; opacity: 1; }`),
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', gap: '12px' } },
        h('div', null, h('h1', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, assistantName),
          statusLabel ? h('span', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, statusLabel) : null),
        h(ComputerConnection, { assistantName, deploymentName: chosen?.metadata.name })),
      upgrade && upgrade.currentReleaseId && upgrade.availableReleaseId !== upgrade.currentReleaseId
        ? h('div', { role: 'status', 'data-studio-assistant-upgrade': true, style: { margin: '0 24px 8px', padding: '10px 14px', border: `1px solid ${BRAND.border}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', color: BRAND.inkMuted, lineHeight: 1.7 } }, upgrading ? '正在升级云端助理，会话与工作区文件会保留…' : '云端助理有新的运行版本可用，升级后可获得更强的联网与工具能力；会话、工作区文件和记忆都会保留。'),
          upgrading ? null : button('升级云端助理', () => void upgradeNow()))
        : null,
      h('div', { ref: history, 'aria-label': '助理会话', onScroll: event => { const node = event.currentTarget; followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; },
        style: { flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: '20px 24px' } },
        h('div', { style: { maxWidth: '760px', margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column', gap: '24px', justifyContent: hasConversation || historyUnavailable ? 'flex-start' : 'center' } },
          (olderHasMore ?? view?.hasMore) ? h('div', { style: { textAlign: 'center' } }, button(loadingOlder ? '正在加载…' : '加载更早记录', () => { followLatest.current = false; void session.loadOlder(); }, loadingOlder)) : null,
          !hasConversation && !historyUnavailable ? h('div', { style: { textAlign: 'center', paddingBottom: '40px' } },
            h('h2', { style: { fontSize: '26px', fontWeight: 500, letterSpacing: '-0.04em', margin: '0 0 12px' } }, chosen && !view ? '正在恢复云端会话…' : '有什么想一起完成的？'),
            !chosen ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '14px', lineHeight: 1.8 } }, catalogReady ? '先连接你的助理。' : '正在连接…') : null,
            catalogReady && !chosen ? button('在系统设置中连接助理', openSettings) : null) : null,
          h(AssistantTranscript, { messages, view, pending, assistantName, agentId }))),
      h('div', { style: { padding: '8px 24px 20px', flexShrink: 0 } }, h('div', { style: { maxWidth: '760px', margin: '0 auto' } },
        h(AssistantApprovals, { view, agentId, busy, decision: sessionMatches ? sessionState.approvalDecision : null, onDecide: (request, decision) => session.decideApproval(request, decision) }),
        conversationError ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '13px', display: 'flex', gap: '12px', alignItems: 'center' } },
          h('span', null, conversationError),
          sessionMatches && sessionState.errorKind === 'attachment-expired' ? button('重新选择附件', () => { if (session.replaceExpiredAttachments()) filePicker.current?.click(); }) : null,
          historyUnavailable ? button('检查云端设置', openSettings) : sessionMatches && (sessionState.readError || pendingInvalid) ? button('重新连接', () => void session.refresh()) : null,
          !pending && assistantRetryAvailable(view) ? button('重试任务', () => { followLatest.current = true; void session.retry(); }) : null) : null,
        running && !canCancel ? h('p', { role: 'status', style: { fontSize: '12px', color: BRAND.inkMuted } }, '更新云端助理后可停止当前任务。') : null,
        pending ? h('p', { role: 'status', style: { fontSize: '12px', color: BRAND.inkMuted } }, pending.observed ? '消息已收到，保存待确认。' : '上一条消息的保存结果待确认。') : null,
        nativeComposerAvailable ? h(NativeComposer, { key: agentId, agentId, hiddenComposer: !useNativeComposer, onAccepted: () => session.refresh() }) : null,
        useNativeComposer ? h('div', null,
          running ? button(!canCancel ? '停止（需更新云端）' : stopping ? '正在停止…' : '停止当前任务', () => void session.cancel(() => actions.confirm({ title: '停止当前任务', detail: '停止助理正在处理的任务？停止请求受理后，仍需等待云端确认。', confirmLabel: '停止' })), stopping || !canCancel) : null) : h('form', { className: 'studio-assistant-composer',
          onDragOver: event => { if (canUpload && Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); },
          onDrop: event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); session.addAttachments(Array.from(event.dataTransfer.files)); } },
          onSubmit: event => { event.preventDefault(); void submit(); }, style: { ...box, padding: '12px 14px', borderRadius: '20px' } },
          h('input', { ref: filePicker, type: 'file', multiple: true, 'aria-label': '上传附件', disabled: !canUpload || busy || Boolean(pending) || historyUnavailable, style: { display: 'none' },
            onChange: event => { session.addAttachments(Array.from(event.target.files || [])); event.target.value = ''; } }),
          attachments.length ? h('ul', { 'aria-label': '待发送附件', style: { listStyle: 'none', padding: 0, margin: '0 0 8px', display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            ...attachments.map(row => h('li', { key: row.id, style: { border: `1px solid ${BRAND.border}`, borderRadius: '12px', padding: '8px 10px', minWidth: 0, maxWidth: '100%', display: 'flex', alignItems: 'center', gap: '8px' } },
              FileTypeIcon ? h(FileTypeIcon, { path: row.name, size: 28 }) : null,
              h('div', { style: { minWidth: 0 } }, h('div', { style: { fontSize: '13px', overflowWrap: 'anywhere' } }, row.name),
                h('div', { role: 'status', style: { fontSize: '11px', color: ['failed', 'cancelled', 'expired'].includes(row.status) ? BRAND.danger : BRAND.inkMuted } },
                  StateDot ? h(StateDot, { state: row.status === 'ready' ? 'done' : ['reading', 'uploading'].includes(row.status) ? 'ongoing' : 'error' }) : null,
                  ' ', row.status === 'ready' ? '已上传，等待发送' : row.status === 'reading' ? `正在读取 ${row.progress || 0}%` : row.status === 'uploading' ? '正在上传，等待云端回执…' : row.error || '上传未完成'),
                ['reading', 'uploading'].includes(row.status) ? h('progress', { 'aria-label': `附件进度：${row.name}`, ...(row.status === 'reading' ? { value: row.progress || 0, max: 100 } : {}), style: { maxWidth: '160px', width: '100%' } }) : null),
              ['failed', 'cancelled'].includes(row.status) ? button('重试上传', () => void session.retryUpload(row.id), Boolean(pending)) : null,
              ['reading', 'uploading'].includes(row.status) ? button('取消上传', () => session.cancelUpload(row.id), Boolean(pending)) : null,
              h(Action, { type: 'button', 'aria-label': `移除附件：${row.name}`, disabled: busy || Boolean(pending), onClick: () => session.removeAttachment(row.id), ...(Button ? { size: 'sm', variant: 'ghost' } : { style: buttonStyle() }) }, '移除')))) : null,
          attachmentError ? h('p', { role: 'alert', style: { margin: '4px 0 8px', color: BRAND.danger, fontSize: '12px' } }, attachmentError) : null,
          h('textarea', { ref: composer, 'aria-label': '发给助理', value: draft, title: 'Shift + Enter 换行', maxLength: 32000, disabled: busy || Boolean(pending), rows: 3,
            style: { ...inputStyle(), border: 0, outline: 'none', height: 'auto', minHeight: '72px', padding: '4px 2px', background: 'transparent', boxShadow: 'none', width: '100%', resize: 'none', boxSizing: 'border-box', lineHeight: 1.6 },
            onChange: event => session.setDraft(event.target.value),
            onPaste: event => { if (event.clipboardData?.files?.length) { if (!event.clipboardData.getData('text/plain')) event.preventDefault(); session.addAttachments(Array.from(event.clipboardData.files)); } }, placeholder: '有什么想让我帮你做的？',
            onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!busy && view && !historyUnavailable) void submit(); } } }),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              canUpload ? button('添加附件', () => filePicker.current?.click(), Boolean(pending) || historyUnavailable) : null),
            h('div', { style: { display: 'flex', gap: '8px' } }, running ? button(!canCancel ? '停止（需更新云端）' : stopping ? '正在停止…' : '停止', () => void session.cancel(() => actions.confirm({ title: '停止当前任务', detail: '停止助理正在处理的任务？停止请求受理后，仍需等待云端确认。', confirmLabel: '停止' })), stopping || !canCancel) : null,
              h(Action, { type: 'submit', disabled: busy || !view || historyUnavailable || pendingInvalid || (!pending && (!attachmentsReady || !draft.trim() && !attachments.length)), ...(Button ? { variant: 'primary' } : { style: { ...buttonStyle(), borderRadius: '12px', background: BRAND.primaryFill, color: BRAND.primaryText } }) }, pending ? pending.observed ? '确认提交' : '重试上一条' : '发送')))),
        notice ? h('p', { role: 'status', style: { margin: '8px 0 0', fontSize: '11px', color: BRAND.inkMuted, textAlign: 'center' } }, notice) : null))));
  };
}
