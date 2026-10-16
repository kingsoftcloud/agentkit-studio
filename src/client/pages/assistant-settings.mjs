/** Assistant configuration lives in DSH's native Settings navigation. */
export function createAssistantSettings({ ui, hostRemote, actions, window }) {
  const { React: { createElement: h, useState, useEffect, useRef }, BRAND, buttonStyle, inputStyle, StudioSubnav, Modal } = ui;
  const key = 'agentkit.assistant.agent';
  const read = () => { try { return JSON.parse(window.localStorage.getItem(key)) || ''; } catch { return ''; } };
  return function AssistantSettingsSection({ close = () => {} }) {
    const [catalog, setCatalog] = useState([]), [agentId, setAgentId] = useState(read);
    const [panel, setPanel] = useState('connection'), [view, setView] = useState(null), [error, setError] = useState('');
    const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [closing, setClosing] = useState(false);
    const [memories, setMemories] = useState([]), [tasks, setTasks] = useState([]);
    const [memoryText, setMemoryText] = useState(''), [editing, setEditing] = useState('');
    const [scheduleTitle, setScheduleTitle] = useState(''), [schedulePrompt, setSchedulePrompt] = useState(''), [scheduleSeconds, setScheduleSeconds] = useState('3600');
    const epoch = useRef(0), submitting = useRef(false), confirmation = useRef(null);
    const [question, setQuestion] = useState(null);
    const confirm = options => new Promise(resolve => {
      const settle = value => { confirmation.current = null; setQuestion(null); resolve(value); };
      confirmation.current = settle; setQuestion({ ...options, settle });
    });
    useEffect(() => () => { confirmation.current?.(false); }, []);
    useEffect(() => {
      let active = true;
      hostRemote.assistantCatalog().then(result => {
        if (!active) return;
        const items = result.items || []; setCatalog(items);
        const saved = read(), next = items.some(item => item.metadata.id === saved) ? saved : items.length === 1 ? items[0].metadata.id : '';
        setAgentId(next);
      }).catch(reason => { if (active) setError(reason.message); });
      return () => { active = false; epoch.current++; };
    }, []);
    const chosen = catalog.find(item => item.metadata.id === agentId);
    useEffect(() => {
      const version = ++epoch.current; let stopped = false, timer;
      setView(null); setMemories([]); setTasks([]); setError('');
      if (!chosen) return;
      const refresh = async () => {
        try {
          const snapshot = await hostRemote.assistantExecute(agentId, 'snapshot');
          if (stopped || version !== epoch.current) return;
          setView(snapshot);
          if (panel === 'memory' && snapshot.memoryEnabled || panel === 'schedule' && snapshot.scheduleEnabled) {
            const result = await hostRemote.assistantExecute(agentId, `${panel}-list`);
            if (!stopped && version === epoch.current) (panel === 'memory' ? setMemories : setTasks)(result.items || []);
          }
        } catch (reason) { if (!stopped && version === epoch.current) setError(reason.message); }
        finally { if (!stopped) timer = window.setTimeout(refresh, 5000); }
      };
      void refresh();
      return () => { stopped = true; epoch.current++; window.clearTimeout(timer); };
    }, [agentId, panel, Boolean(chosen)]);
    const choose = id => {
      try { window.localStorage.setItem(key, JSON.stringify(id)); }
      catch { setError('无法保存默认助理，请检查本机存储。'); return; }
      setNotice(''); setAgentId(id);
      window.dispatchEvent(new window.CustomEvent('agentkit-studio:assistant-changed', { detail: id }));
    };
    const closeAssistant = async () => {
      if (closing || !chosen?.deployment) return;
      const confirmed = await confirm({ title: '关闭并删除个人助理',
        detail: `将删除「${chosen.metadata.name}」的专属云端部署、会话和记忆，停止计划任务。记忆无法恢复；共享知识库和记忆库实例会保留。`,
        confirmLabel: '关闭并删除', danger: true });
      if (!confirmed) return;
      setClosing(true); setError('');
      try {
        const result = await hostRemote.closeAssistant({ agentId, confirmAgentId: agentId, deploymentId: chosen.deployment.id, versionId: chosen.deployment.versionId });
        if (!result.deleted) { setNotice('专属会话和记忆已清理，云端部署正在删除。再次点击可核对关闭结果。'); return; }
        window.localStorage.removeItem(key);
        window.localStorage.removeItem(`agentkit.assistant.pending.${agentId}`);
        setCatalog(items => items.filter(item => item.metadata.id !== agentId)); setAgentId(''); setView(null);
        window.dispatchEvent(new window.CustomEvent('agentkit-studio:assistant-changed', { detail: '' }));
        setNotice('个人助理已关闭，专属会话和记忆已删除。重新启用需要创建新的云端助理。');
      } catch (reason) { setError(reason.message || '关闭结果尚未确认，请保留当前部署并重试核对。'); }
      finally { setClosing(false); }
    };
    const execute = async (operation, input, onSuccess) => {
      if (submitting.current) return;
      const version = epoch.current; submitting.current = true; setBusy(true); setError('');
      try { const result = await hostRemote.assistantExecute(agentId, operation, input); if (version === epoch.current) onSuccess?.(result); }
      catch (reason) { if (version === epoch.current) setError(reason.message); }
      finally { submitting.current = false; if (version === epoch.current) setBusy(false); }
    };
    const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || closing || disabled, style: buttonStyle() }, label);
    const box = { border: `1px solid ${BRAND.border}`, borderRadius: '10px', padding: '14px', background: BRAND.surface };
    return h('div', { 'data-studio-assistant-settings': true, style: { color: BRAND.ink, maxWidth: '720px' } },
      h('div', { className: 'agentkit-form-heading' }, h('div', null, h('h3', null, '个人助理'), h('p', null, '管理助理连接、记忆和计划任务。'))),
      h(StudioSubnav, { value: panel, onChange: setPanel, items: [{ id: 'connection', label: '连接' }, { id: 'memory', label: '记忆' }, { id: 'schedule', label: '计划任务' }] }),
      error ? h('p', { role: 'alert', style: { color: BRAND.danger } }, error) : null,
      notice ? h('p', { role: 'status', style: { color: BRAND.inkMuted } }, notice) : null,
      panel === 'connection' ? h('section', { 'data-studio-settings-group': true },
        h('label', { style: { display: 'grid', gridTemplateColumns: '1fr minmax(180px, 1fr)', alignItems: 'center', gap: '20px', padding: '18px 0' } },
          h('span', null, '云端助理', h('span', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '12px', marginTop: '6px' } }, '本地 Studio 连接的专属 DSH Native 部署')),
          h('select', { 'aria-label': '云端助理', style: inputStyle(), value: chosen ? agentId : '', disabled: busy, onChange: event => choose(event.target.value) },
            h('option', { value: '' }, '选择助理'), ...catalog.map(item => h('option', { key: item.metadata.id, value: item.metadata.id }, item.metadata.name)))),
        !catalog.length ? h('p', null, '还没有可连接的云端助理。', ' ', button('前往运行中心', () => { close(); window.dispatchEvent(new window.CustomEvent('agentkit-studio:navigate', { detail: 'operations' })); })) : null,
        h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.8 } }, '云端任务与历史保存在部署中。关闭本地 Studio 后，云端任务仍可继续；本机工具需要在本机会话中使用。'),
        chosen ? h('div', { style: { borderTop: '1px solid ' + BRAND.border, marginTop: '24px', paddingTop: '20px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px' } },
            h('div', null, h('strong', { style: { fontSize: '13px' } }, '关闭个人助理'), h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.7, margin: '6px 0' } }, '删除专属云端部署、会话和记忆，无法恢复。')),
            h('button', { type: 'button', disabled: closing || busy || !view?.canClose, onClick: closeAssistant, style: { ...buttonStyle(), color: BRAND.danger, flexShrink: 0 } }, closing ? '正在关闭…' : '关闭并删除')),
          !view?.canClose ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '当前镜像尚未提供专属数据删除能力，请先更新云端助理。') : null) : null) : null,
      chosen && panel === 'memory' && !view?.memoryEnabled ? h('p', { role: 'status' }, '为助理绑定记忆库后，可在这里查看和管理记忆。') : null,
      chosen && panel === 'schedule' && !view?.scheduleEnabled ? h('p', { role: 'status' }, '云端部署启用官方定时任务插件后，可在这里安排任务。') : null,
      chosen && panel === 'memory' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, '这里保存你希望长期记住的偏好和信息。新内容整理好后会出现在列表中。'),
        ...memories.map(item => h('div', { key: item.id, style: box }, h('p', { style: { whiteSpace: 'pre-wrap' } }, item.text),
          button('纠正', () => { setEditing(item.id); setMemoryText(item.text); }), ' ',
          button('删除记忆', async () => { if (await confirm({ title: '删除这条记忆', detail: '删除长期记忆后，原会话记录仍保留。', confirmLabel: '删除', danger: true })) void execute('memory-delete', { id: item.id }, () => { setMemories(rows => rows.filter(row => row.id !== item.id)); setNotice('记忆已删除。'); }); }))),
        h('textarea', { 'aria-label': '记忆内容', value: memoryText, onChange: event => setMemoryText(event.target.value), rows: 3, maxLength: 4000, style: inputStyle(), placeholder: '希望助理长期记住的偏好或事实' }),
        button(editing ? '保存纠正' : '记住这条信息', () => void execute(editing ? 'memory-update' : 'memory-save', { id: editing, text: memoryText }, () => { setMemoryText(''); setEditing(''); setNotice('已提交记忆更新，列表会自动刷新。'); }), !view?.memoryEnabled || !memoryText.trim())) : null,
      chosen && panel === 'schedule' ? h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, '到时间后继续处理，结果会回到这段对话。关闭 Studio 也能触发。'),
        ...tasks.map(task => h('div', { key: task.id, style: box }, h('strong', null, task.title), h('p', { style: { whiteSpace: 'pre-wrap' } }, task.prompt), h('p', null, `${task.scheduledAt} · ${task.status === 'active' ? '等待触发' : '已投递'}`),
          button('删除任务', async () => { if (await confirm({ title: '删除定时任务', detail: '停止后续触发，并删除此任务的投递记录。', confirmLabel: '删除', danger: true })) void execute('schedule-delete', { id: task.id }, () => setTasks(rows => rows.filter(row => row.id !== task.id))); }))),
        h('input', { 'aria-label': '任务名称', placeholder: '任务名称', value: scheduleTitle, maxLength: 120, style: inputStyle(), onChange: event => setScheduleTitle(event.target.value) }),
        h('textarea', { 'aria-label': '任务内容', placeholder: '到时间后让助理执行什么', value: schedulePrompt, maxLength: 4000, rows: 3, style: inputStyle(), onChange: event => setSchedulePrompt(event.target.value) }),
        h('label', null, '多少秒后执行 ', h('input', { 'aria-label': '延迟秒数', type: 'number', min: 1, value: scheduleSeconds, style: inputStyle(), onChange: event => setScheduleSeconds(event.target.value) })),
        button('安排任务', () => void execute('schedule-create', { spec: { title: scheduleTitle, prompt: schedulePrompt, after_seconds: Number(scheduleSeconds) } }, () => { setScheduleTitle(''); setSchedulePrompt(''); setNotice('安排好了，到时间后会在这里继续。'); }), !view?.scheduleEnabled || !scheduleTitle.trim() || !schedulePrompt.trim() || !Number.isSafeInteger(Number(scheduleSeconds)) || Number(scheduleSeconds) < 1)) : null,
      h(Modal, { open: Boolean(question), title: question?.title || '确认操作', onClose: () => question?.settle(false), footer: question ? h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { type: 'button', style: buttonStyle(), onClick: () => question.settle(false) }, '取消'),
        h('button', { type: 'button', style: { ...buttonStyle(), color: question.danger ? BRAND.danger : BRAND.ink }, onClick: () => question.settle(true) }, question.confirmLabel || '确认')) : null },
        h('p', { style: { lineHeight: 1.8 } }, question?.detail)));
  };
}
