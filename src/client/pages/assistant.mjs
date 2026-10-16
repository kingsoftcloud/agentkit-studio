/** Assistant client: closing this view only releases reads, never cloud work. */
export function createAssistantPage({ ui, hostRemote, actions, window }) {
  const { React: { createElement: h, useState, useEffect, useRef }, BRAND, buttonStyle, inputStyle, Pill } = ui;
  const read = key => { try { return JSON.parse(window.localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => window.localStorage.setItem(key, JSON.stringify(value));
  const pendingKey = id => `agentkit.assistant.pending.${id}`;
  const labels = { idle: '可以开始对话', running: '云端执行中', completed: '已完成', cancelled: '已停止', failed: '执行未完成' };
  return function AssistantPage() {
    const [catalog, setCatalog] = useState([]), [agentId, setAgentId] = useState(() => read('agentkit.assistant.agent') || '');
    const [tab, setTab] = useState('chat'), [view, setView] = useState(null), [error, setError] = useState('');
    const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    const [pending, setPending] = useState(null), [memories, setMemories] = useState([]), [tasks, setTasks] = useState([]);
    const [memoryText, setMemoryText] = useState(''), [editing, setEditing] = useState('');
    const [scheduleTitle, setScheduleTitle] = useState(''), [schedulePrompt, setSchedulePrompt] = useState(''), [scheduleSeconds, setScheduleSeconds] = useState('3600');
    const [older, setOlder] = useState([]), [olderCursor, setOlderCursor] = useState(null), [olderHasMore, setOlderHasMore] = useState(null);
    const epoch = useRef(0), submitting = useRef(false);
    useEffect(() => {
      let alive = true;
      hostRemote.assistantCatalog().then(result => {
        if (!alive) return;
        setCatalog(result.items || []);
        if (result.warnings?.length) setError(result.warnings.join('；'));
      }).catch(reason => { if (alive) setError(reason.message); });
      return () => { alive = false; };
    }, []);
    useEffect(() => {
      const version = ++epoch.current;
      let stopped = false, timer;
      setView(null); setError(''); setNotice(''); setPending(read(pendingKey(agentId))); setMemories([]); setTasks([]);
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
          if (tab === 'memory') {
            const result = await hostRemote.assistantExecute(agentId, 'memory-list');
            if (!stopped && version === epoch.current) setMemories(result.items || []);
          }
          if (tab === 'schedule') {
            const result = await hostRemote.assistantExecute(agentId, 'schedule-list');
            if (!stopped && version === epoch.current) setTasks(result.items || []);
          }
        } catch (reason) { if (!stopped && version === epoch.current) setError(reason.message); }
        finally { if (!stopped) timer = window.setTimeout(refresh, 5000); }
      };
      void refresh();
      return () => { stopped = true; epoch.current++; window.clearTimeout(timer); };
    }, [agentId, catalog, tab]);
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
      if (submitting.current) return;
      const request = read(pendingKey(agentId)) || pending || { text: draft.trim(), requestId: window.crypto.randomUUID(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (!request.text) return;
      try { save(pendingKey(agentId), request); } catch { setError('无法保存提交标识，请检查本机存储后重试。'); return; }
      setPending(request);
      await execute('submit', request, result => {
        if (!result.accepted || result.requestId !== request.requestId) { setError('提交结果未确认，请刷新后核对。'); return; }
        window.localStorage.removeItem(pendingKey(agentId)); setPending(null); setDraft('');
        setNotice('云端已接收并保存。现在可以关闭 Studio，稍后回来查看结果。');
        setView(previous => ({ ...previous, status: 'running' }));
      });
    };
    const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || disabled, style: buttonStyle() }, label);
    const box = { border: `1px solid ${BRAND.border}`, borderRadius: '12px', padding: '16px', background: BRAND.surface };
    const messages = [...new Map([...older, ...(view?.messages || [])].map(item => [item.id, item])).values()].sort((a, b) => a.seq - b.seq);
    const chosen = catalog.find(item => item.metadata.id === agentId);
    return h('section', { 'data-studio-assistant': true, style: { maxWidth: '980px', display: 'grid', gap: '16px' } },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
        h('label', null, '云端助理 ', h('select', { 'aria-label': '云端助理', style: inputStyle(), value: chosen ? agentId : '', disabled: busy,
          onChange: event => { const id = event.target.value; save('agentkit.assistant.agent', id); setAgentId(id); } },
          h('option', { value: '' }, '选择专属 DSH 云端 Agent'), ...catalog.map(item => h('option', { key: item.metadata.id, value: item.metadata.id }, item.metadata.name)))),
        h(Pill, { tone: view?.status === 'running' ? 'accent' : 'neutral' }, labels[view?.status] || '等待连接')),
      !catalog.length ? h('p', null, '请先在运行中心部署一个 DSH Native Agent，并绑定记忆库。部署后会出现在这里。') : null,
      h('div', { role: 'tablist', 'aria-label': '助理功能', style: { display: 'flex', gap: '8px' } },
        ...[['chat', '对话'], ['memory', '记忆'], ['schedule', '云端定时任务']].map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, disabled: busy,
          onClick: () => setTab(id), style: { ...buttonStyle(), background: tab === id ? BRAND.accentSoft : BRAND.surface } }, label))),
      error ? h('p', { role: 'alert', style: { color: BRAND.danger } }, error) : null,
      notice ? h('p', { role: 'status' }, notice) : null,
      chosen && tab === 'chat' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', { style: { color: BRAND.inkMuted } }, '任务在云端 DSH 中执行。关闭窗口不会停止任务；停止按钮会明确取消当前运行。'),
        h('div', { 'aria-label': '助理会话', style: { ...box, minHeight: '160px' } },
          ...messages.map(message => h('article', { key: message.id, style: { marginBottom: '16px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
            h('strong', null, message.source === 'schedule' ? '定时任务' : message.role === 'user' ? '你' : '助理'), h('div', null, message.text))),
          view && !view.messages?.length ? h('p', null, '从一条消息开始。可以告诉助理你的偏好，并明确说“请记住”。') : null,
          (olderHasMore ?? view?.hasMore) ? button('加载更早记录', () => void execute('snapshot', { beforeSeq: olderCursor ?? view.beforeSeq }, result => { setOlder(rows => [...result.messages, ...rows]); setOlderCursor(result.beforeSeq); setOlderHasMore(result.hasMore); })) : null),
        pending ? h('p', { role: 'status' }, '上一条消息的提交结果待确认。重试会沿用同一个请求标识，避免重复执行。') : null,
        h('textarea', { 'aria-label': '发给助理', value: draft, maxLength: 32000, disabled: busy || Boolean(pending), rows: 4, style: inputStyle(),
          onChange: event => setDraft(event.target.value), placeholder: '请帮我……' }),
        h('div', { style: { display: 'flex', gap: '8px' } }, button(pending ? '核对并重试上一条' : '发送', () => void submit(), !view || (!pending && !draft.trim())),
          button('停止当前任务', async () => { if (await actions.confirm({ title: '停止云端任务', detail: '停止助理当前正在执行的任务？', confirmLabel: '停止' })) void execute('cancel', {}, () => setNotice('已请求停止，请等待云端状态更新。')); }, view?.status !== 'running'))) : null,
      chosen && tab === 'memory' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, '助理通过绑定的记忆库积累偏好与经验，并在后续对话中召回。新记忆需要后台提取，提交成功后可能稍晚出现。'),
        ...memories.map(item => h('div', { key: item.id, style: box }, h('p', { style: { whiteSpace: 'pre-wrap' } }, item.text),
          button('纠正', () => { setEditing(item.id); setMemoryText(item.text); }), ' ',
          button('删除记忆', async () => { if (await actions.confirm({ title: '删除这条记忆', detail: '删除长期记忆后，原会话记录仍保留。', confirmLabel: '删除', danger: true })) void execute('memory-delete', { id: item.id }, () => { setMemories(rows => rows.filter(row => row.id !== item.id)); setNotice('记忆已删除。'); }); }))),
        h('textarea', { 'aria-label': '记忆内容', value: memoryText, onChange: event => setMemoryText(event.target.value), rows: 3, maxLength: 4000, style: inputStyle(), placeholder: '希望助理长期记住的偏好或事实' }),
        button(editing ? '保存纠正' : '记住这条信息', () => void execute(editing ? 'memory-update' : 'memory-save', { id: editing, text: memoryText }, () => { setMemoryText(''); setEditing(''); setNotice('已提交记忆更新，列表会自动刷新。'); }), !view?.memoryEnabled || !memoryText.trim())) : null,
      chosen && tab === 'schedule' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, '由云端 DSH 官方定时任务插件触发，结果回到此会话。第一版支持一次性提醒；无需保持 Studio 打开。'),
        ...tasks.map(task => h('div', { key: task.id, style: box }, h('strong', null, task.title), h('p', null, `${task.scheduledAt} · ${task.status === 'active' ? '等待触发' : '已投递'}`),
          button('删除任务', async () => { if (await actions.confirm({ title: '删除定时任务', detail: '停止后续触发，并删除此任务的投递记录。', confirmLabel: '删除', danger: true })) void execute('schedule-delete', { id: task.id }, () => setTasks(rows => rows.filter(row => row.id !== task.id))); }))),
        h('input', { 'aria-label': '任务名称', placeholder: '任务名称', value: scheduleTitle, maxLength: 120, style: inputStyle(), onChange: event => setScheduleTitle(event.target.value) }),
        h('textarea', { 'aria-label': '任务内容', placeholder: '到时间后让助理执行什么', value: schedulePrompt, maxLength: 4000, rows: 3, style: inputStyle(), onChange: event => setSchedulePrompt(event.target.value) }),
        h('label', null, '多少秒后执行 ', h('input', { 'aria-label': '延迟秒数', type: 'number', min: 1, value: scheduleSeconds, style: inputStyle(), onChange: event => setScheduleSeconds(event.target.value) })),
        button('创建云端定时任务', () => void execute('schedule-create', { spec: { title: scheduleTitle, prompt: schedulePrompt, after_seconds: Number(scheduleSeconds) } }, () => { setScheduleTitle(''); setSchedulePrompt(''); setNotice('任务已保存到云端 DSH。'); }), !view?.scheduleEnabled || !scheduleTitle.trim() || !schedulePrompt.trim() || !Number.isSafeInteger(Number(scheduleSeconds)) || Number(scheduleSeconds) < 1)) : null);
  };
}
