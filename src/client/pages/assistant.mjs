/** Assistant client: closing this view only releases reads, never cloud work. */
export function createAssistantPage({ ui, hostRemote, actions, window }) {
  const { React: { createElement: h, useState, useEffect, useRef }, BRAND, buttonStyle, inputStyle, ComputerConnection, MarkdownText } = ui;
  const read = key => { try { return JSON.parse(window.localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => window.localStorage.setItem(key, JSON.stringify(value));
  const pendingKey = id => `agentkit.assistant.pending.${id}`;
  return function AssistantPage({ onNavigate }) {
    const [catalog, setCatalog] = useState([]), [agentId, setAgentId] = useState(() => read('agentkit.assistant.agent') || '');
    const [view, setView] = useState(null), [error, setError] = useState('');
    const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    const [pending, setPending] = useState(null);
    const [older, setOlder] = useState([]), [olderCursor, setOlderCursor] = useState(null), [olderHasMore, setOlderHasMore] = useState(null);
    const epoch = useRef(0), submitting = useRef(false), composer = useRef(null), history = useRef(null), followLatest = useRef(true);
    const [catalogReady, setCatalogReady] = useState(false);
    const [setup, setSetup] = useState(null), [setupOptions, setSetupOptions] = useState(null);
    const [setupMemory, setSetupMemory] = useState(''), [setupBusy, setSetupBusy] = useState(false);
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
    useEffect(() => {
      const version = ++epoch.current;
      let stopped = false, timer;
      setView(null); setNotice(''); setPending(read(pendingKey(agentId)));
      setBusy(false); setOlder([]); setOlderCursor(null); setOlderHasMore(null);
      if (!agentId || !catalog.some(item => item.metadata.id === agentId)) return;
      const refresh = async () => {
        try {
          const snapshot = await hostRemote.assistantExecute(agentId, 'snapshot');
          if (stopped || version !== epoch.current) return;
          setView(snapshot); setError('');
          const unknown = read(pendingKey(agentId));
          if (unknown && snapshot.messages.some(message => message.requestId === unknown.requestId)) {
            window.localStorage.removeItem(pendingKey(agentId)); setPending(null);
          }
        } catch (reason) { if (!stopped && version === epoch.current) setError(reason.message); }
        finally { if (!stopped) timer = window.setTimeout(refresh, 5000); }
      };
      void refresh();
      return () => { stopped = true; epoch.current++; window.clearTimeout(timer); };
    }, [agentId, catalog]);
    useEffect(() => {
      const changed = event => { if (!event.detail || catalog.some(item => item.metadata.id === event.detail)) setAgentId(event.detail || ''); };
      const deleted = event => { setCatalog(items => items.filter(item => item.metadata.id !== event.detail)); if (event.detail === agentId) { setAgentId(''); setDraft(''); setView(null); setPending(null); } };
      window.addEventListener('agentkit-studio:assistant-changed', changed);
      window.addEventListener('agentkit-studio:assistant-deleted', deleted);
      return () => { window.removeEventListener('agentkit-studio:assistant-changed', changed); window.removeEventListener('agentkit-studio:assistant-deleted', deleted); };
    }, [catalog, agentId]);
    useEffect(() => {
      const changed = event => { if (event.detail?.agentId === agentId) setView(previous => ({ ...previous, identity: event.detail.identity })); };
      window.addEventListener('agentkit-studio:assistant-identity-changed', changed);
      return () => window.removeEventListener('agentkit-studio:assistant-identity-changed', changed);
    }, [agentId]);
    useEffect(() => {
      if (followLatest.current && history.current) history.current.scrollTop = history.current.scrollHeight;
    }, [view?.messages?.length, pending?.requestId]);
    const execute = async (operation, input, onSuccess) => {
      const version = epoch.current;
      if (submitting.current) return;
      submitting.current = true; setBusy(true); setError('');
      try {
        const result = await hostRemote.assistantExecute(agentId, operation, input);
        if (version !== epoch.current) return;
        onSuccess?.(result);
      } catch (reason) { if (version === epoch.current) setError(reason.message); }
      finally { submitting.current = false; if (version === epoch.current) setBusy(false); }
    };
    const submit = async () => {
      if (submitting.current || !view) return;
      const request = read(pendingKey(agentId)) || pending || { text: draft.trim(), requestId: window.crypto.randomUUID(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (!request.text) return;
      try { save(pendingKey(agentId), request); } catch { setError('无法保存提交标识，请检查本机存储后重试。'); return; }
      setPending(request); followLatest.current = true;
      await execute('submit', request, result => {
        if (!result.accepted || result.requestId !== request.requestId) { setError('提交结果未确认，请刷新后核对。'); return; }
        window.localStorage.removeItem(pendingKey(agentId)); setPending(null); setDraft('');
        setNotice('已收到。你可以随时离开，结果会留在这里。');
        setView(previous => ({ ...previous, status: 'running', messages: previous.messages.some(item => item.requestId === request.requestId) ? previous.messages : [...previous.messages,
          { id: `pending:${request.requestId}`, requestId: request.requestId, seq: (previous.messages.at(-1)?.seq ?? 0) + 1, role: 'user', text: request.text }] }));
      });
    };
    const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || disabled, style: buttonStyle() }, label);
    const box = { border: `1px solid ${BRAND.border}`, borderRadius: '12px', padding: '16px', background: BRAND.surface };
    const messages = [...new Map([...older, ...(view?.messages || [])].map(item => [item.id, item])).values()]
      .filter(item => item.requestId !== 'assistant-welcome-v1').sort((a, b) => a.seq - b.seq);
    const chosen = catalog.find(item => item.metadata.id === agentId);
    const assistantName = view?.identity?.assistantName || chosen?.metadata.name || '个人助理';
    const running = view?.status === 'running';
    const openSettings = () => window.dispatchEvent(new window.CustomEvent('agentkit-studio:open-settings'));
    const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
    if (catalogReady && !catalog.length && !chosen) {
      const preparing = setup && !['NOT_STARTED', 'ACTION_REQUIRED', 'FAILED', 'CREATE_UNKNOWN', 'UPLOAD_UNKNOWN', 'DELETED'].includes(setup.state);
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
          h('h1', { style: { fontSize: '26px', fontWeight: 500, margin: '0 0 14px' } }, preparing || setupBusy ? '你的助理正在准备中' : '7×24 的个人助理'),
          h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.8, margin: '0 0 24px' } }, preparing || setupBusy ? '准备好后，我们就在这里聊。你也可以先离开，回来会继续显示进度。' : '交代任务、安排提醒，慢慢记住你的偏好。关闭 Studio 后，助理仍能在云端继续工作。'),
          preparing ? h('p', { role: 'status', style: { fontSize: '14px' } }, setup.message) : null,
          setup?.failure ? h('p', { role: 'alert', style: { color: BRAND.danger, lineHeight: 1.7 } }, setup.message) : null,
          error ? h('p', { role: 'alert', style: { color: BRAND.danger, lineHeight: 1.7 } }, error) : null,
          ['NOT_STARTED', 'DELETED'].includes(setup?.state) && setupOptions ? h('div', null,
            setupOptions.memories.length > 1 ? h('label', { style: { display: 'block', textAlign: 'left', fontSize: '13px', marginBottom: '16px' } }, '把记忆保存在',
              h('select', { 'aria-label': '助理记忆库', value: setupMemory, onChange: event => setSetupMemory(event.target.value), style: { ...inputStyle(), width: '100%', marginTop: '8px' } },
                h('option', { value: '' }, '选择记忆库'), ...setupOptions.memories.map(item => h('option', { key: item.id, value: item.id }, item.name)))) : null,
            h('button', { type: 'button', onClick: () => void start(), disabled: setupBusy || !setupMemory, style: { ...buttonStyle(), padding: '12px 24px', borderRadius: '12px', background: BRAND.primaryFill, color: BRAND.primaryText } }, '开通个人助理'),
            h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.7, marginTop: '18px' } }, setupOptions.billingNotice),
            h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, `使用 ${setupOptions.model.name} · ${setupOptions.memories.find(item => item.id === setupMemory)?.name || '选择一个记忆库'}`)) : null,
          !preparing && (error || setup?.failure) ? button('查看运行中心', () => onNavigate?.('operations')) : null));
    }
    return h('section', { 'data-studio-assistant': true, style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: BRAND.surface } },
      h('style', null, `[data-studio-assistant] .studio-assistant-composer:focus-within { outline: 1px solid ${BRAND.border}; outline-offset: 2px; } [data-studio-assistant] textarea[aria-label="发给助理"]::placeholder { color: ${BRAND.inkMuted}; opacity: 1; }`),
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', gap: '12px' } },
        h('div', null, h('h1', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, assistantName),
          running ? h('span', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, '正在处理…') : null),
        h(ComputerConnection, { assistantName, deploymentName: chosen?.metadata.name })),
      h('div', { ref: history, 'aria-label': '助理会话', onScroll: event => { const node = event.currentTarget; followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; },
        style: { flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: '20px 24px' } },
        h('div', { style: { maxWidth: '760px', margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column', gap: '24px', justifyContent: messages.length ? 'flex-start' : 'center' } },
          (olderHasMore ?? view?.hasMore) ? h('div', { style: { textAlign: 'center' } }, button('加载更早记录', () => void execute('snapshot', { beforeSeq: olderCursor ?? view.beforeSeq }, result => { followLatest.current = false; setOlder(rows => [...result.messages, ...rows]); setOlderCursor(result.beforeSeq); setOlderHasMore(result.hasMore); }))) : null,
          !messages.length ? h('div', { style: { textAlign: 'center', paddingBottom: '40px' } },
            h('h2', { style: { fontSize: '26px', fontWeight: 500, letterSpacing: '-0.04em', margin: '0 0 12px' } }, '有什么想一起完成的？'),
            h('p', { style: { color: BRAND.inkMuted, fontSize: '14px', lineHeight: 1.8 } }, chosen ? '交代一件事，或告诉我你希望记住的偏好。' : catalogReady ? '先连接你的助理，之后我们就在这里继续。' : '正在连接你的助理…'),
            catalogReady && !chosen ? button('在系统设置中连接助理', openSettings) : null) : null,
          ...messages.map(message => h('article', { key: message.id, 'aria-label': message.source === 'schedule' ? '提醒' : message.role === 'user' ? '你' : '助理', style: { alignSelf: message.role === 'user' && message.source !== 'schedule' ? 'flex-end' : 'stretch',
            maxWidth: message.role === 'user' ? '86%' : '100%', borderRadius: '16px', padding: message.role === 'user' ? '12px 16px' : '0',
            background: message.role === 'user' ? BRAND.accentSoft : 'transparent', whiteSpace: message.role === 'user' ? 'pre-wrap' : 'normal', overflowWrap: 'anywhere', lineHeight: 1.8, fontSize: '15px' } },
            message.source === 'schedule' ? h('div', { style: { fontSize: '12px', color: BRAND.inkMuted } }, '提醒') : null, message.role === 'assistant' ? h(MarkdownText, { text: message.text, labels: markdownLabels }) : message.text)),
          pending && !messages.some(message => message.requestId === pending.requestId) ? h('article', { style: { alignSelf: 'flex-end', maxWidth: '86%', ...box, background: BRAND.accentSoft, whiteSpace: 'pre-wrap' } }, pending.text) : null)),
      h('div', { style: { padding: '8px 24px 20px', flexShrink: 0 } }, h('div', { style: { maxWidth: '760px', margin: '0 auto' } },
        error ? h('p', { role: 'alert', style: { color: BRAND.danger, fontSize: '13px' } }, error) : null,
        pending ? h('p', { role: 'status', style: { fontSize: '12px', color: BRAND.inkMuted } }, '还在确认上一条消息，重试不会重复执行。') : null,
        h('form', { className: 'studio-assistant-composer', onSubmit: event => { event.preventDefault(); void submit(); }, style: { ...box, padding: '12px 14px', borderRadius: '20px' } },
          h('textarea', { ref: composer, 'aria-label': '发给助理', value: draft, maxLength: 32000, disabled: busy || Boolean(pending), rows: 3,
            style: { ...inputStyle(), border: 0, outline: 'none', height: 'auto', minHeight: '72px', padding: '4px 2px', background: 'transparent', boxShadow: 'none', width: '100%', resize: 'none', boxSizing: 'border-box', lineHeight: 1.6 },
            onChange: event => setDraft(event.target.value), placeholder: '有什么想让我帮你做的？',
            onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!busy && view) void submit(); } } }),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' } },
            h('span', { style: { fontSize: '11px', color: BRAND.inkMuted } }, chosen ? 'Shift + Enter 换行' : '连接后即可发送，草稿会保留'),
            h('div', { style: { display: 'flex', gap: '8px' } }, running ? button('停止', async () => { if (await actions.confirm({ title: '停止当前任务', detail: '停止助理正在处理的任务？', confirmLabel: '停止' })) void execute('cancel', {}, () => setNotice('已请求停止。')); }) : null,
              h('button', { type: 'submit', disabled: busy || !view || (!pending && !draft.trim()), style: { ...buttonStyle(), borderRadius: '12px', background: BRAND.primaryFill, color: BRAND.primaryText } }, pending ? '重试上一条' : '发送')))),
        h('p', { role: 'status', style: { margin: '8px 0 0', minHeight: '16px', fontSize: '11px', color: BRAND.inkMuted, textAlign: 'center' } }, notice || (chosen ? '离开也没关系，回来可以接着聊。' : '')))));
  };
}
