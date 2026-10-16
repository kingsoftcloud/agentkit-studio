/** Assistant client: closing this view only releases reads, never cloud work. */
export function createAssistantPage({ ui, hostRemote, actions, window }) {
  const { React: { createElement: h, useState, useEffect, useRef }, BRAND, buttonStyle, inputStyle, Modal, IconSettingsOutlineMedium } = ui;
  const read = key => { try { return JSON.parse(window.localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => window.localStorage.setItem(key, JSON.stringify(value));
  const pendingKey = id => `agentkit.assistant.pending.${id}`;
  return function AssistantPage({ onNavigate }) {
    const [catalog, setCatalog] = useState([]), [agentId, setAgentId] = useState(() => read('agentkit.assistant.agent') || '');
    const [panel, setPanel] = useState(null), [view, setView] = useState(null), [error, setError] = useState('');
    const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    const [pending, setPending] = useState(null), [memories, setMemories] = useState([]), [tasks, setTasks] = useState([]);
    const [memoryText, setMemoryText] = useState(''), [editing, setEditing] = useState('');
    const [scheduleTitle, setScheduleTitle] = useState(''), [schedulePrompt, setSchedulePrompt] = useState(''), [scheduleSeconds, setScheduleSeconds] = useState('3600');
    const [older, setOlder] = useState([]), [olderCursor, setOlderCursor] = useState(null), [olderHasMore, setOlderHasMore] = useState(null);
    const epoch = useRef(0), submitting = useRef(false), composer = useRef(null), history = useRef(null), followLatest = useRef(true);
    const [catalogReady, setCatalogReady] = useState(false);
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
      const version = ++epoch.current;
      let stopped = false, timer;
      setView(null); setNotice(''); setPending(read(pendingKey(agentId))); setMemories([]); setTasks([]);
      setMemoryText(''); setEditing(''); setBusy(false); setOlder([]); setOlderCursor(null); setOlderHasMore(null);
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
    // Secondary settings must not reset the conversation or its durable receipt.
    useEffect(() => {
      if (!agentId || !['memory', 'schedule'].includes(panel)) return;
      let stopped = false, timer;
      const refresh = async () => {
        try {
          const result = await hostRemote.assistantExecute(agentId, `${panel}-list`);
          if (!stopped) (panel === 'memory' ? setMemories : setTasks)(result.items || []);
        } catch (reason) { if (!stopped) setError(reason.message); }
        finally { if (!stopped) timer = window.setTimeout(refresh, 5000); }
      };
      void refresh();
      return () => { stopped = true; window.clearTimeout(timer); };
    }, [agentId, panel]);
    useEffect(() => { if (!panel) composer.current?.focus(); }, [panel, agentId]);
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
    const messages = [...new Map([...older, ...(view?.messages || [])].map(item => [item.id, item])).values()].sort((a, b) => a.seq - b.seq);
    const chosen = catalog.find(item => item.metadata.id === agentId);
    const running = view?.status === 'running';
    const choose = id => {
      try { save('agentkit.assistant.agent', id); } catch { setError('无法保存默认助理，重新打开时可能需要再次选择。'); }
      setAgentId(id); setPanel(null); followLatest.current = true;
    };
    return h('section', { 'data-studio-assistant': true, style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: BRAND.surface } },
      h('style', null, `[data-studio-assistant] .studio-assistant-composer:focus-within { outline: 1px solid ${BRAND.border}; outline-offset: 2px; } [data-studio-assistant] textarea[aria-label="发给助理"]::placeholder { color: ${BRAND.inkMuted}; opacity: 1; }`),
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', gap: '12px' } },
        h('div', null, h('h1', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, '个人助理'),
          running ? h('span', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, '正在处理…') : null),
        h('button', { type: 'button', 'aria-label': '助理设置', title: '助理设置', 'aria-haspopup': 'dialog', onClick: () => setPanel('settings'), style: { ...buttonStyle(), borderColor: 'transparent', background: 'transparent', padding: '7px' } }, h(IconSettingsOutlineMedium, { size: 20 }))),
      h('div', { ref: history, 'aria-label': '助理会话', onScroll: event => { const node = event.currentTarget; followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; },
        style: { flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: '20px 24px' } },
        h('div', { style: { maxWidth: '760px', margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column', gap: '24px', justifyContent: messages.length ? 'flex-start' : 'center' } },
          (olderHasMore ?? view?.hasMore) ? h('div', { style: { textAlign: 'center' } }, button('加载更早记录', () => void execute('snapshot', { beforeSeq: olderCursor ?? view.beforeSeq }, result => { followLatest.current = false; setOlder(rows => [...result.messages, ...rows]); setOlderCursor(result.beforeSeq); setOlderHasMore(result.hasMore); }))) : null,
          !messages.length ? h('div', { style: { textAlign: 'center', paddingBottom: '40px' } },
            h('h2', { style: { fontSize: '26px', fontWeight: 500, letterSpacing: '-0.04em', margin: '0 0 12px' } }, '有什么想一起完成的？'),
            h('p', { style: { color: BRAND.inkMuted, fontSize: '14px', lineHeight: 1.8 } }, chosen ? '交代一件事，或告诉我你希望记住的偏好。' : catalogReady ? '先连接你的助理，之后我们就在这里继续。' : '正在连接你的助理…'),
            catalogReady && !chosen ? button('连接助理', () => setPanel('settings')) : null) : null,
          ...messages.map(message => h('article', { key: message.id, 'aria-label': message.source === 'schedule' ? '提醒' : message.role === 'user' ? '你' : '助理', style: { alignSelf: message.role === 'user' && message.source !== 'schedule' ? 'flex-end' : 'stretch',
            maxWidth: message.role === 'user' ? '86%' : '100%', borderRadius: '16px', padding: message.role === 'user' ? '12px 16px' : '0',
            background: message.role === 'user' ? BRAND.accentSoft : 'transparent', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8, fontSize: '15px' } },
            message.source === 'schedule' ? h('div', { style: { fontSize: '12px', color: BRAND.inkMuted } }, '提醒') : null, message.text)),
          pending && !messages.some(message => message.requestId === pending.requestId) ? h('article', { style: { alignSelf: 'flex-end', maxWidth: '86%', ...box, background: BRAND.accentSoft, whiteSpace: 'pre-wrap' } }, pending.text) : null)),
      h('div', { style: { padding: '8px 24px 20px', flexShrink: 0 } }, h('div', { style: { maxWidth: '760px', margin: '0 auto' } },
        error && !panel ? h('p', { role: 'alert', style: { color: BRAND.danger, fontSize: '13px' } }, error) : null,
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
        h('p', { role: 'status', style: { margin: '8px 0 0', minHeight: '16px', fontSize: '11px', color: BRAND.inkMuted, textAlign: 'center' } }, notice || (chosen ? '离开也没关系，回来可以接着聊。' : '')))),
      h(Modal, { open: Boolean(panel), onClose: () => setPanel(null), title: panel === 'memory' ? '助理记忆' : panel === 'schedule' ? '计划任务' : '助理设置',
        footer: panel && panel !== 'settings' ? button('返回设置', () => setPanel('settings')) : undefined },
        error ? h('p', { role: 'alert', style: { color: BRAND.danger } }, error) : null,
        notice ? h('p', { role: 'status' }, notice) : null,
        panel === 'settings' ? h('div', { style: { display: 'grid', gap: '18px' } },
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, button('查看与管理记忆', () => setPanel('memory'), !view?.memoryEnabled), button('查看计划任务', () => setPanel('schedule'), !view?.scheduleEnabled)),
          h('p', { style: { margin: 0, color: BRAND.inkMuted } }, '告诉助理“请记住”可以积累偏好；需要时，你可以在这里纠正或删除记忆。'),
          h('label', null, '连接的助理', h('select', { 'aria-label': '云端助理', style: { ...inputStyle(), display: 'block', marginTop: '8px' }, value: chosen ? agentId : '', disabled: busy, onChange: event => choose(event.target.value) },
            h('option', { value: '' }, '选择助理'), ...catalog.map(item => h('option', { key: item.metadata.id, value: item.metadata.id }, item.metadata.name)))),
          !catalog.length ? h('div', null, h('p', null, '还没有可连接的云端助理。先创建一个，之后打开这里就能直接对话。'), button('前往运行中心', () => { setPanel(null); onNavigate?.('operations'); })) : null) : null,
      chosen && panel === 'memory' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, '这里保存你希望长期记住的偏好和信息。新内容整理好后会出现在列表中。'),
        ...memories.map(item => h('div', { key: item.id, style: box }, h('p', { style: { whiteSpace: 'pre-wrap' } }, item.text),
          button('纠正', () => { setEditing(item.id); setMemoryText(item.text); }), ' ',
          button('删除记忆', async () => { if (await actions.confirm({ title: '删除这条记忆', detail: '删除长期记忆后，原会话记录仍保留。', confirmLabel: '删除', danger: true })) void execute('memory-delete', { id: item.id }, () => { setMemories(rows => rows.filter(row => row.id !== item.id)); setNotice('记忆已删除。'); }); }))),
        h('textarea', { 'aria-label': '记忆内容', value: memoryText, onChange: event => setMemoryText(event.target.value), rows: 3, maxLength: 4000, style: inputStyle(), placeholder: '希望助理长期记住的偏好或事实' }),
        button(editing ? '保存纠正' : '记住这条信息', () => void execute(editing ? 'memory-update' : 'memory-save', { id: editing, text: memoryText }, () => { setMemoryText(''); setEditing(''); setNotice('已提交记忆更新，列表会自动刷新。'); }), !view?.memoryEnabled || !memoryText.trim())) : null,
      chosen && panel === 'schedule' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, '到时间后继续处理，结果会回到这段对话。关闭 Studio 也能触发。'),
        ...tasks.map(task => h('div', { key: task.id, style: box }, h('strong', null, task.title), h('p', { style: { whiteSpace: 'pre-wrap' } }, task.prompt), h('p', null, `${task.scheduledAt} · ${task.status === 'active' ? '等待触发' : '已投递'}`),
          button('删除任务', async () => { if (await actions.confirm({ title: '删除定时任务', detail: '停止后续触发，并删除此任务的投递记录。', confirmLabel: '删除', danger: true })) void execute('schedule-delete', { id: task.id }, () => setTasks(rows => rows.filter(row => row.id !== task.id))); }))),
        h('input', { 'aria-label': '任务名称', placeholder: '任务名称', value: scheduleTitle, maxLength: 120, style: inputStyle(), onChange: event => setScheduleTitle(event.target.value) }),
        h('textarea', { 'aria-label': '任务内容', placeholder: '到时间后让助理执行什么', value: schedulePrompt, maxLength: 4000, rows: 3, style: inputStyle(), onChange: event => setSchedulePrompt(event.target.value) }),
        h('label', null, '多少秒后执行 ', h('input', { 'aria-label': '延迟秒数', type: 'number', min: 1, value: scheduleSeconds, style: inputStyle(), onChange: event => setScheduleSeconds(event.target.value) })),
        button('安排任务', () => void execute('schedule-create', { spec: { title: scheduleTitle, prompt: schedulePrompt, after_seconds: Number(scheduleSeconds) } }, () => { setScheduleTitle(''); setSchedulePrompt(''); setNotice('安排好了，到时间后会在这里继续。'); }), !view?.scheduleEnabled || !scheduleTitle.trim() || !schedulePrompt.trim() || !Number.isSafeInteger(Number(scheduleSeconds)) || Number(scheduleSeconds) < 1)) : null));
  };
}
