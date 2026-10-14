import { localDateTimeValue, scheduleLabel, scheduleNeedsRefresh } from '../state/automation-data.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createAutomationPage({
  ui: { React: { useEffect, useState, createElement: h, useRef, Fragment }, EmptyState, OperationalPageHeading, OperationalPager, Pill, ResourceDialog, ScheduleDeliveryPicker, ScheduleDeliveryResult, StudioPageTabs, buttonStyle, inputStyle, BRAND = DEFAULT_BRAND },
  hostRemote, actions, window = globalThis.window, document = globalThis.document
}) {
  function useAutomationOccurrences(task, refreshKey) {
    const key = task ? `${task.target?.agentId}/${task.taskId}` : '';
    const [result, setResult] = useState({ key: '', status: 'idle', items: [], error: '' });
    useEffect(() => {
      if (!key) return undefined;
      let active = true;
      setResult({ key, status: 'loading', items: [], error: '' });
      hostRemote.scheduleOccurrences(task.taskId, task.target?.agentId).then(value => {
        if (active) setResult({ key, status: 'ready', items: Array.isArray(value?.items) ? value.items : [], error: '' });
      }).catch(reason => {
        if (active) setResult({ key, status: 'error', items: [], error: reason?.message || '请求未完成' });
      });
      return () => { active = false; };
    }, [key, refreshKey]);
    return result.key === key ? result : { key, status: key ? 'loading' : 'idle', items: [], error: '' };
  }

  function AutomationPage({ scheduleRemote }) {
    const [scope, setScope] = useState('local');
    const loadVersion = useRef(0);
    const refreshing = useRef(0);
    const [status, setStatus] = useState('loading');
    const [tasks, setTasks] = useState([]);
    const [nativeTasks, setNativeTasks] = useState([]);
    const [agents, setAgents] = useState([]);
    const [error, setError] = useState('');
    const [readError, setReadError] = useState('');
    const [message, setMessage] = useState('');
    const [editorOpen, setEditorOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [busyTask, setBusyTask] = useState('');
    const [historyTask, setHistoryTask] = useState('');
    const [editingTask, setEditingTask] = useState(null);
    const [detailTask, setDetailTask] = useState(null);
    const [latestOccurrences, setLatestOccurrences] = useState({});
    const [occurrenceErrors, setOccurrenceErrors] = useState({});
    const [availability, setAvailability] = useState(null);
    const [section, setSection] = useState('tasks');
    const [viewMode, setViewMode] = useState('board');
    const [query, setQuery] = useState('');
    const [agentFilter, setAgentFilter] = useState('');
    const [historyRows, setHistoryRows] = useState([]);
    const [historyStatus, setHistoryStatus] = useState('idle');
    const [historyFailures, setHistoryFailures] = useState(0);
    const [taskPage, setTaskPage] = useState(0);
    const [form, setForm] = useState({ deliveryMode: 'record', deliveryTarget: null, agentId: '', displayName: '', prompt: '', kind: 'interval', everySeconds: '3600', expression: '0 9 * * 1-5', at: '' });
    const taskPageSize = 12;
    const historyView = useAutomationOccurrences(tasks.find(task => task.taskId === historyTask), tasks);
    const detailView = useAutomationOccurrences(detailTask, tasks);
    const history = historyView.items, detailOccurrences = detailView.items;

    const agentId = item => item?.metadata?.id || item?.id || '';
    const agentName = item => item?.metadata?.name || item?.name || agentId(item);
    const createAgents = scope === 'cloud' ? agents.filter(item => availability?.readyAgentIds?.includes(agentId(item))) : agents;
    const catalogUnavailable = scope === 'cloud' && agents.length > 0 && availability?.catalogReadable === false;
    const load = async ({ quiet = false } = {}) => {
      if (quiet && refreshing.current) return;
      const version = ++loadVersion.current;
      refreshing.current = version;
      if (!quiet) { setStatus('loading'); setError(''); setReadError(''); }
      try {
        const [scheduleResult, agentResult] = await Promise.all([hostRemote.schedules(undefined, scope), hostRemote.agents({ source: scope, pageSize: 100 })]);
        if (version !== loadVersion.current) return;
        const nextAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
        setAgents(nextAgents);
        const nextTasks = Array.isArray(scheduleResult?.items) ? scheduleResult.items : [];
        setTasks(nextTasks);
        setDetailTask(current => current ? nextTasks.find(item => item.taskId === current.taskId) || null : null);
        // The operations board groups tasks by the latest occurrence. The
        // Host schedule list stays light, so hydrate a bounded index for the
        // board and detail view without making one failed row fail the page.
        const refreshTasks = nextTasks.slice(0, 100).filter(task => {
          const previous = tasks.find(item => item.taskId === task.taskId);
          return !quiet || !previous || occurrenceErrors[task.taskId] || previous.updatedAt !== task.updatedAt
            || previous.nextRunAt !== task.nextRunAt || scheduleNeedsRefresh(previous, latestOccurrences[task.taskId]);
        });
        const occurrencePairs = await Promise.all(refreshTasks.map(async task => {
          try {
            const result = await hostRemote.scheduleOccurrences(task.taskId, task?.target?.agentId);
            const items = Array.isArray(result?.items) ? result.items : [];
            const latest = items.slice().sort((a, b) => new Date(b?.completedAt || b?.startedAt || b?.scheduledFor || 0) - new Date(a?.completedAt || a?.startedAt || a?.scheduledFor || 0))[0];
            return [task.taskId, latest || null, false];
          } catch { return [task.taskId, null, true]; }
        }));
        if (version !== loadVersion.current) return;
        setLatestOccurrences(previous => Object.fromEntries(nextTasks.map(task => {
          const read = occurrencePairs.find(([id]) => id === task.taskId);
          return [task.taskId, read && !read[2] ? read[1] : previous[task.taskId]];
        })));
        setOccurrenceErrors(previous => Object.fromEntries(nextTasks.map(task => {
          const read = occurrencePairs.find(([id]) => id === task.taskId);
          return [task.taskId, read ? read[2] : previous[task.taskId]];
        })));
        try {
          const records = scope === 'cloud' ? [] : Array.isArray(scheduleResult?.nativeItems) ? scheduleResult.nativeItems : scheduleRemote?.catalog ? await scheduleRemote.catalog() : [];
          setNativeTasks(Array.isArray(records) ? records : []);
        } catch {
          setNativeTasks([]);
        }
        if (version !== loadVersion.current) return;
        setReadError((scheduleResult?.warnings || []).join('；'));
        setAvailability(scheduleResult?.availability || null);
        setStatus('ready');
        const readyAgents = scope === 'cloud' ? nextAgents.filter(item => scheduleResult?.availability?.readyAgentIds?.includes(agentId(item))) : nextAgents;
        if (!quiet) setForm(previous => ({ ...previous, agentId: readyAgents.some(item => agentId(item) === previous.agentId) ? previous.agentId : agentId(readyAgents[0]) }));
      } catch (reason) {
        if (version !== loadVersion.current) return;
        if (!quiet) setStatus('error');
        setReadError(quiet ? '自动化刷新失败，当前显示上次读取的状态。请刷新重试。' : reason?.message || '自动化目录读取失败');
      } finally {
        if (refreshing.current === version) refreshing.current = 0;
      }
    };
    useEffect(() => { setTasks([]); setNativeTasks([]); setAgents([]); setEditorOpen(false); setDetailTask(null); setHistoryTask(''); setHistoryRows([]); setHistoryFailures(0); setOccurrenceErrors({}); setLatestOccurrences({}); setAgentFilter(''); setForm(previous => ({ ...previous, agentId: '' })); void load(); return () => { loadVersion.current++; }; }, [scope]);
    useEffect(() => { setTaskPage(0); }, [query, agentFilter, viewMode]);
    useEffect(() => {
      if (section !== 'history' || status !== 'ready') return undefined;
      let cancelled = false;
      setHistoryStatus('loading');
      setHistoryFailures(0);
      Promise.all(tasks.slice(0, 50).map(async task => {
        try {
          const result = await hostRemote.scheduleOccurrences(task.taskId, task?.target?.agentId);
          return { items: (Array.isArray(result?.items) ? result.items : []).map(item => ({ ...item, taskName: task.displayName || task.taskId, taskId: task.taskId })), failed: false };
        } catch { return { items: [], failed: true }; }
      })).then(rows => {
        if (cancelled) return;
        setHistoryRows(rows.flatMap(row => row.items).sort((a, b) => new Date(b.completedAt || b.scheduledFor || 0) - new Date(a.completedAt || a.scheduledFor || 0)));
        setHistoryFailures(rows.filter(row => row.failed).length);
        setHistoryStatus(rows.length && rows.every(row => row.failed) ? 'error' : 'ready');
      }).catch(() => { if (!cancelled) setHistoryStatus('error'); });
      return () => { cancelled = true; };
    }, [section, status, tasks]);

    const save = async () => {
      if (!form.agentId || !form.displayName.trim() || !form.prompt.trim()) {
        setError('请选择 Agent，并填写任务名称和提示词。'); return;
      }
      const schedule = { kind: form.kind, timezone: 'Asia/Shanghai' };
      if (form.kind === 'interval') schedule.everySeconds = Math.max(60, Number(form.everySeconds) || 3600);
      if (form.kind === 'cron') schedule.expression = form.expression.trim();
      if (form.kind === 'once') {
        const at = new Date(form.at);
        if (!form.at || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { setError('请选择未来的执行时间。'); return; }
        schedule.at = at.toISOString();
      }
      if (scope === 'cloud' && form.deliveryMode === 'channel' && !form.deliveryTarget) { setError('请选择收件会话。'); return; }
      setSaving(true); setError(''); setMessage('');
      try {
        const payload = { displayName: form.displayName.trim(), prompt: form.prompt.trim(), schedule, enabled: editingTask ? editingTask.enabled !== false : true, continuity: editingTask?.continuity || 'new_session', ...(editingTask ? { expectedRevision: editingTask.revision } : {}) };
        if (scope === 'cloud') {
          const selected = form.deliveryMode === 'channel' ? form.deliveryTarget : null;
          const before = editingTask?.deliveryTarget;
          if (!editingTask || selected?.channelConfigId !== before?.channelConfigId || selected?.bindingId !== before?.bindingId) payload.deliveryTarget = selected;
        }
        if (editingTask) {
          await hostRemote.updateSchedule(form.agentId, editingTask.taskId, payload);
          setMessage('自动化已更新。');
        } else {
          await hostRemote.createSchedule(form.agentId, payload);
          setMessage(scope === 'cloud' ? '云端自动化已创建，关闭应用后仍按计划执行。' : '本地自动化已创建，请保持应用运行。');
        }
        setEditorOpen(false);
        setEditingTask(null);
        setForm(previous => ({ ...previous, displayName: '', prompt: '' }));
        await load();
      } catch (reason) { setError(reason?.message || '自动化创建失败'); }
      finally { setSaving(false); }
    };
    const startEdit = task => {
      const schedule = task?.schedule || {};
      const kind = schedule.kind === 'cron' || schedule.kind === 'once' ? schedule.kind : 'interval';
      setEditingTask(task);
      setForm({
        deliveryMode: task.deliveryTarget ? 'channel' : 'record',
        deliveryTarget: task.deliveryTarget || null,
        agentId: task?.target?.agentId || '',
        displayName: task?.displayName || '',
        prompt: task?.command?.payload?.content || '',
        kind,
        everySeconds: String(schedule.everySeconds || schedule.every_seconds || 3600),
        expression: String(schedule.expression || '0 9 * * 1-5'),
        at: schedule.at ? localDateTimeValue(schedule.at) : '',
      });
      setEditorOpen(true); setError(''); setMessage('');
    };
    const toggle = async task => {
      const targetAgent = task?.target?.agentId;
      if (!targetAgent || !task?.taskId) return;
      setBusyTask(task.taskId); setError(''); setMessage('');
      try {
        await hostRemote.updateSchedule(targetAgent, task.taskId, {
          displayName: task.displayName || task.taskId,
          prompt: task?.command?.payload?.content || '',
          schedule: task.schedule,
          enabled: task.enabled === false, expectedRevision: task.revision,
          continuity: task.continuity || 'new_session',
        });
        setMessage(task.enabled === false ? '自动化已启用。' : '自动化已暂停。');
        await load();
      } catch (reason) { setError(reason?.message || '更新自动化状态失败'); }
      finally { setBusyTask(''); }
    };
    const runNow = async task => {
      const targetAgent = task?.target?.agentId;
      if (!targetAgent || !task?.taskId) return;
      setBusyTask(task.taskId); setError(''); setMessage('');
      try {
        await hostRemote.runSchedule(targetAgent, task.taskId);
        setMessage(`已提交立即运行：${task.displayName || task.taskId}`);
        await load();
      } catch (reason) { setError(reason?.message || '立即运行失败'); }
      finally { setBusyTask(''); }
    };
    const remove = async task => {
      const targetAgent = task?.target?.agentId;
      if (!targetAgent || !task?.taskId) return;
      if (typeof window !== 'undefined' && !(await (actions.confirm({ title: '删除自动化', detail: `删除自动化“${task.displayName || task.taskId}”？此操作不可撤销。${scope === 'cloud' ? '只停止后续触发，已触发的执行和结果投递会继续。' : ''}`, confirmLabel: '删除', danger: true })))) return;
      setBusyTask(task.taskId); setError('');
      try { await hostRemote.deleteSchedule(targetAgent, task.taskId); setMessage('自动化已删除。'); if (detailTask?.taskId === task.taskId) setDetailTask(null); await load(); }
      catch (reason) { setError(reason?.message || '自动化删除失败'); }
      finally { setBusyTask(''); }
    };
    const showHistory = task => {
      setHistoryTask(current => current === task.taskId ? '' : task.taskId);
    };
    const openDetail = task => {
      setDetailTask(task);
    };
    const visibleTasks = tasks.filter(task => {
      const name = String(task?.displayName || task?.taskId || '').toLowerCase();
      const prompt = String(task?.command?.payload?.content || '').toLowerCase();
      const agent = String(task?.target?.agentId || '').toLowerCase();
      const needle = query.trim().toLowerCase();
      return (!needle || name.includes(needle) || prompt.includes(needle) || agent.includes(needle))
        && (!agentFilter || agent === agentFilter.toLowerCase());
    });
    const latestOccurrence = task => latestOccurrences[task.taskId] || task?.latestOccurrence || task?.lastOccurrence || null;
    const taskStatus = task => {
      if (occurrenceErrors[task.taskId]) return 'attention';
      const latest = latestOccurrence(task);
      const state = String(latest?.state || latest?.status || '').toLowerCase();
      if (['claimed', 'accepted', 'running', 'admitting'].includes(state)) return 'running';
      if (['failed', 'unknown'].includes(latest?.deliveryState) || ['failed', 'error', 'cancelled', 'rejected'].includes(state)) return 'attention';
      if (task.enabled === false || (task.schedule?.kind === 'once' && ['succeeded', 'completed'].includes(state))) return 'paused';
      return 'scheduled';
    };
    useEffect(() => {
      if (status !== 'ready' || !tasks.length) return undefined;
      const timer = window.setInterval(() => {
        if (!document.hidden && tasks.some(task => occurrenceErrors[task.taskId] || scheduleNeedsRefresh(task, latestOccurrence(task)))) void load({ quiet: true });
      }, 5000);
      return () => window.clearInterval(timer);
    }, [status, tasks, latestOccurrences, occurrenceErrors]);
    const occurrencePlaceholder = view => view.status === 'error'
      ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px', marginTop: '8px' } },
        `执行记录读取失败：${view.error}。请刷新重试。`)
      : h('span', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', marginTop: '8px' } }, view.status === 'loading' ? '正在读取执行记录…' : '暂无执行记录。');
    const taskGroups = [
      { id: 'scheduled', label: '待执行' },
      { id: 'running', label: '执行中' },
      { id: 'attention', label: '需关注' },
      { id: 'paused', label: '已暂停 / 已结束' },
    ];
    const openTemplate = kind => {
      const templates = {
        daily: { displayName: '每日工作摘要', prompt: '整理今天工作区中的变更并给出摘要', kind: 'cron', expression: '0 10 * * 1-5' },
        interval: { displayName: '定期服务巡检', prompt: '检查服务状态，发现异常时给出原因和处理建议', kind: 'interval', everySeconds: '1800' },
        weekly: { displayName: '每周总结', prompt: '总结本周工作区中的重要进展、风险和待办', kind: 'cron', expression: '0 17 * * 5' },
      };
      setEditingTask(null);
      setForm(previous => ({ ...previous, deliveryMode: 'record', deliveryTarget: null, ...templates[kind], agentId: createAgents.some(item => agentId(item) === previous.agentId) ? previous.agentId : agentId(createAgents[0]) }));
      setEditorOpen(true); setError(''); setMessage('');
    };
    const taskCard = task => {
      const target = agents.find(item => agentId(item) === task?.target?.agentId);
      const active = historyTask === task.taskId;
      const latest = latestOccurrence(task);
      return h('section', { key: task.taskId, style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '15px 16px', background: BRAND.surface, minWidth: 0 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' } },
          h('div', { style: { minWidth: 0 } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, task.displayName || task.taskId), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${target ? agentName(target) : task?.target?.agentId || '目标 Agent'} · ${scheduleLabel(task)}`)),
          h(Pill, { tone: taskStatus(task) === 'attention' ? 'signal' : task.enabled ? 'accent' : 'signal' }, occurrenceErrors[task.taskId] ? '状态待确认' : taskStatus(task) === 'running' ? '执行中' : taskStatus(task) === 'attention' ? '需关注' : task.enabled ? '已启用' : '已暂停')),
        h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: '12px 0 0', whiteSpace: 'pre-wrap', minHeight: '36px' } }, task?.command?.payload?.content || '—'),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', flexWrap: 'wrap' } }, h('span', null, task.enabled && task.nextRunAt ? `下次执行：${new Date(task.nextRunAt).toLocaleString()}` : latest ? `最近执行：${new Date(latest.completedAt || latest.startedAt || latest.scheduledFor || Date.now()).toLocaleString()}` : '未安排下一次执行'), h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, h('button', { type: 'button', onClick: () => void openDetail(task), style: { ...buttonStyle(), background: BRAND.surface } }, '详情'), h('button', { type: 'button', onClick: () => void showHistory(task), style: { ...buttonStyle(), background: BRAND.surface } }, active ? '收起记录' : '执行记录'), h('button', { type: 'button', onClick: () => startEdit(task), style: { ...buttonStyle(), background: BRAND.surface } }, '编辑'), h('button', { type: 'button', onClick: () => void toggle(task), disabled: busyTask === task.taskId, style: { ...buttonStyle(), background: BRAND.surface } }, task.enabled === false ? '启用' : '暂停'), h('button', { type: 'button', onClick: () => void runNow(task), disabled: busyTask === task.taskId || task.enabled === false, style: { ...buttonStyle(), background: BRAND.primaryFill, color: BRAND.primaryText } }, busyTask === task.taskId ? '提交中…' : '立即运行'), h('button', { type: 'button', onClick: () => void remove(task), disabled: busyTask === task.taskId, style: { ...buttonStyle(), background: BRAND.surface, color: BRAND.danger } }, '删除'))),
        active ? h('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border } }, history.length ? history.slice(0, 8).map(item => h('div', { key: item.occurrenceId, style: { display: 'flex', justifyContent: 'space-between', gap: '12px', color: BRAND.inkMuted, fontSize: '11px', padding: '4px 0' } }, h('div', null, h('span', null, item.state || 'unknown'), h(ScheduleDeliveryResult, { item })), h('span', null, item.completedAt ? new Date(item.completedAt).toLocaleString() : item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : '—'))) : occurrencePlaceholder(historyView)) : null);
    };
    const pagedTasks = visibleTasks.slice(taskPage * taskPageSize, (taskPage + 1) * taskPageSize);
    const detailTarget = detailTask ? agents.find(item => agentId(item) === detailTask?.target?.agentId) : null;
    const detailPanel = detailTask ? h(ResourceDialog, { title: detailTask.displayName || detailTask.taskId, detail: `${detailTarget ? agentName(detailTarget) : detailTask?.target?.agentId || '目标 Agent'} · ${scheduleLabel(detailTask)}`, wide: true, onClose: () => setDetailTask(null) },
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '12px' } },
        h('div', { style: { color: BRAND.accentStrong, fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', marginRight: 'auto' } }, 'Automation detail'),
        h(Pill, { tone: taskStatus(detailTask) === 'attention' ? 'signal' : taskStatus(detailTask) === 'running' ? 'accent' : 'neutral' }, taskStatus(detailTask) === 'running' ? '执行中' : taskStatus(detailTask) === 'attention' ? '需关注' : detailTask.enabled === false ? '已暂停' : '已启用')),
      occurrenceErrors[detailTask.taskId] ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px', marginTop: '8px' } }, '最近执行状态读取失败，请刷新重试。') : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginTop: '14px' } },
        [['任务 ID', detailTask.taskId], ['执行计划', scheduleLabel(detailTask)], ['会话方式', detailTask.continuity === 'continue_session' ? '继续已有会话' : '每次新建会话'], ['下次执行', detailTask.enabled && detailTask.nextRunAt ? new Date(detailTask.nextRunAt).toLocaleString() : '—']].map(([label, value]) => h('div', { key: label, style: { padding: '10px 11px', borderRadius: '10px', background: BRAND.canvas } }, h('div', { style: { color: BRAND.inkMuted, fontSize: '10px' } }, label), h('div', { style: { color: BRAND.ink, fontSize: '12px', marginTop: '4px', wordBreak: 'break-word' } }, value || '—')))),
      h('div', { style: { marginTop: '12px', color: BRAND.ink, fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, detailTask?.command?.payload?.content || '—'),
      h('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap', marginTop: '13px' } }, h('button', { type: 'button', onClick: () => startEdit(detailTask), style: buttonStyle() }, '编辑'), h('button', { type: 'button', onClick: () => void toggle(detailTask), disabled: busyTask === detailTask.taskId, style: buttonStyle() }, detailTask.enabled === false ? '启用' : '暂停'), h('button', { type: 'button', onClick: () => void runNow(detailTask), disabled: busyTask === detailTask.taskId || detailTask.enabled === false, style: { ...buttonStyle(), color: BRAND.primaryText, background: BRAND.primaryFill, borderColor: 'transparent' } }, busyTask === detailTask.taskId ? '提交中…' : '立即运行'), h('button', { type: 'button', onClick: () => void remove(detailTask), disabled: busyTask === detailTask.taskId, style: { ...buttonStyle(), color: BRAND.danger } }, '删除')),
      h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, '最近执行'), detailOccurrences.length ? h('div', { style: { display: 'grid', gap: '6px', marginTop: '8px' } }, detailOccurrences.slice(0, 10).map(item => h('div', { key: item.occurrenceId || `${item.state}-${item.scheduledFor}`, style: { display: 'grid', gridTemplateColumns: '90px minmax(0,1fr) 170px', gap: '10px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h(Pill, { tone: ['succeeded', 'completed'].includes(String(item.state).toLowerCase()) ? 'accent' : ['failed', 'error', 'cancelled'].includes(String(item.state).toLowerCase()) ? 'signal' : 'neutral' }, item.state || 'unknown'), h('div', null, h('span', null, item.detail || item.errorCode || item.occurrenceId || '—'), h(ScheduleDeliveryResult, { item })), h('span', null, item.completedAt ? new Date(item.completedAt).toLocaleString() : item.startedAt ? new Date(item.startedAt).toLocaleString() : item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : '—')))) : occurrencePlaceholder(detailView))) : null;

    return h('div', null,
      h(OperationalPageHeading, { title: '自动化', detail: scope === 'cloud' ? '云端按计划执行，关闭应用后仍然有效。每次执行使用触发时部署的版本。' : '本地按计划执行，需要保持此设备和应用运行。', action: h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, h(Pill, { tone: availability?.triggerActive ? 'accent' : 'neutral' }, availability?.triggerActive ? '调度运行中' : '调度待就绪'), h('button', { type: 'button', onClick: () => { setEditingTask(null); setForm(previous => ({ ...previous, deliveryMode: 'record', deliveryTarget: null, agentId: createAgents.some(item => agentId(item) === previous.agentId) ? previous.agentId : agentId(createAgents[0]) })); setEditorOpen(true); setMessage(''); }, disabled: status !== 'ready' || !createAgents.length, style: buttonStyle() }, '新建自动化'), h('button', { type: 'button', onClick: () => void load(), style: { ...buttonStyle(), background: BRAND.surface } }, '刷新')) }),
      h(StudioPageTabs, { value: scope, onChange: setScope, items: [{ id: 'local', label: '本地' }, { id: 'cloud', label: '云端部署' }], ariaLabel: '自动化执行位置' }),
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取自动化', detail: '读取计划、可用 Agent 和调度器状态。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '自动化不可用', detail: readError, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
      status === 'ready' ? h(Fragment, null,
        editorOpen ? h(ResourceDialog, { title: editingTask ? '编辑自动化' : '新建自动化', detail: scope === 'cloud' ? '选择已部署的 Agent 和触发规则，由云端调度执行。' : '选择本地 Agent 和触发规则。', onClose: () => { if (!saving) setEditorOpen(false); } }, h('form', { onSubmit: event => { event.preventDefault(); void save(); }, style: { display: 'grid', gap: '14px' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px' } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '绑定 Agent', h('select', { value: form.agentId, disabled: Boolean(editingTask), onChange: event => setForm(previous => ({ ...previous, agentId: event.target.value, deliveryMode: 'record', deliveryTarget: null })), style: inputStyle() }, (editingTask ? agents : createAgents).map(item => h('option', { key: agentId(item), value: agentId(item) }, `${agentName(item)} · ${agentId(item)}`)))),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '任务名称', h('input', { value: form.displayName, onChange: event => setForm(previous => ({ ...previous, displayName: event.target.value })), placeholder: '例如：每日工作摘要', style: inputStyle() }))),
          h('label', { style: { display: 'block', marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '到期时发送给 Agent 的提示词', h('textarea', { value: form.prompt, onChange: event => setForm(previous => ({ ...previous, prompt: event.target.value })), rows: 3, placeholder: '例如：整理今天工作区中的变更并给出摘要', style: { ...inputStyle(), resize: 'vertical' } })),
          h('div', { style: { display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: '12px', marginTop: '12px', alignItems: 'end' } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '触发方式', h('select', { value: form.kind, onChange: event => setForm(previous => ({ ...previous, kind: event.target.value })), style: inputStyle() }, h('option', { value: 'interval' }, '固定间隔'), h('option', { value: 'cron' }, 'Cron'), h('option', { value: 'once' }, '执行一次'))),
            form.kind === 'interval' ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '间隔秒数（最少 60）', h('input', { type: 'number', min: 60, value: form.everySeconds, onChange: event => setForm(previous => ({ ...previous, everySeconds: event.target.value })), style: inputStyle() })) : null,
            form.kind === 'cron' ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '五段 Cron（Asia/Shanghai）', h('input', { value: form.expression, onChange: event => setForm(previous => ({ ...previous, expression: event.target.value })), style: inputStyle() })) : null,
            form.kind === 'once' ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '执行时间', h('input', { type: 'datetime-local', value: form.at, onChange: event => setForm(previous => ({ ...previous, at: event.target.value })), style: inputStyle() })) : null),
          scope === 'cloud' ? h(ScheduleDeliveryPicker, { agentId: form.agentId, mode: form.deliveryMode, target: form.deliveryTarget, supported: availability?.deliveryReadyAgentIds?.includes(form.agentId), onChange: (deliveryMode, deliveryTarget) => setForm(previous => ({ ...previous, deliveryMode, deliveryTarget })) }) : null,
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' } }, h('button', { type: 'button', onClick: () => setEditorOpen(false), disabled: saving, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: saving || !agents.length, style: { ...buttonStyle(), color: saving || !agents.length ? BRAND.inkMuted : BRAND.primaryText, background: saving || !agents.length ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !agents.length ? BRAND.border : 'transparent' } }, saving ? '保存中…' : editingTask ? '保存修改' : '创建'))),
        ) : null,
        h('section', { style: { display: 'grid', gap: '12px', marginBottom: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '14px 16px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
            h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { type: 'button', onClick: () => setSection('tasks'), style: { ...buttonStyle(), background: section === 'tasks' ? BRAND.accentSoft : BRAND.surface } }, `全部任务 ${tasks.length}`), h('button', { type: 'button', onClick: () => setSection('history'), style: { ...buttonStyle(), background: section === 'history' ? BRAND.accentSoft : BRAND.surface } }, '执行记录')),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, h('input', { value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索任务或提示词', 'aria-label': '搜索自动化', style: { ...inputStyle(), width: '180px' } }), h('select', { value: agentFilter, onChange: event => setAgentFilter(event.target.value), 'aria-label': '按 Agent 筛选', style: { ...inputStyle(), width: '170px' } }, h('option', { value: '' }, '全部 Agent'), agents.map(item => h('option', { key: agentId(item), value: agentId(item) }, agentName(item)))), section === 'tasks' ? h('button', { type: 'button', onClick: () => setViewMode(viewMode === 'board' ? 'list' : 'board'), style: { ...buttonStyle(), background: BRAND.surface } }, viewMode === 'board' ? '列表视图' : '看板视图') : null)),
          section === 'tasks' ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, '从常用任务开始：'), h('button', { type: 'button', onClick: () => openTemplate('daily'), disabled: !createAgents.length, style: { ...buttonStyle(), background: BRAND.surface } }, '每日简报 · 工作日 10:00'), h('button', { type: 'button', onClick: () => openTemplate('interval'), disabled: !createAgents.length, style: { ...buttonStyle(), background: BRAND.surface } }, '定期巡检 · 每 30 分钟'), h('button', { type: 'button', onClick: () => openTemplate('weekly'), disabled: !createAgents.length, style: { ...buttonStyle(), background: BRAND.surface } }, '每周总结 · 周五 17:00')) : null),

        scope === 'local' ? h('details', { style: { display: 'grid', gap: '10px', marginBottom: '14px', border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface } },
          h('summary', { style: { cursor: 'pointer', padding: '11px 14px', color: BRAND.ink, fontWeight: 750, fontSize: '12px' } }, `DSH 原生会话自动化 ${nativeTasks.length} · 展开查看`),
          h('div', { style: { display: 'grid', gap: '10px', padding: '0 14px 14px' } },
            h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '由对话中的 schedule_create 创建；与 Host Agent 自动化分开存储。'),
            nativeTasks.length ? nativeTasks.map(task => h('div', { key: `${task.sessionId}-${task.id}`, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px 120px', gap: '12px', alignItems: 'center', border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px' } },
              h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, task.title || '未命名任务'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.prompt || '—')),
              h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, scheduleLabel({ schedule: task })),
              h(Pill, { tone: task.status === 'active' ? 'accent' : 'neutral' }, task.status === 'active' ? '已启用' : '已结束'))) :
              h('div', { style: { border: '1px dashed ' + BRAND.border, borderRadius: '10px', padding: '13px 14px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } },
                h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '12px', marginBottom: '4px' } }, '当前会话还没有 DSH 原生自动化'),
                h('span', null, '在新会话中直接说“每天 9 点提醒我整理工作摘要”，DSH 会调用 schedule_create；创建后刷新本页即可看到任务。')))) : null,
        detailPanel,
        section === 'history' && historyFailures ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px', marginBottom: '12px' } }, `${historyFailures} 个任务的执行记录读取失败，当前记录可能不完整。请刷新重试。`) : null,
        section === 'history' ? (historyStatus === 'error' ? h(EmptyState, { icon: '!', title: '执行记录暂时无法读取', detail: '请刷新重试。' }) : historyStatus === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取执行记录', detail: '读取当前执行位置的任务历史。' }) : !historyRows.length ? h(EmptyState, { icon: '◷', title: '暂无执行记录', detail: visibleTasks.length ? '任务尚未执行，或调整筛选条件。' : '调整搜索或 Agent 筛选条件。' }) : h('div', { style: { display: 'grid', gap: '8px' } }, historyRows.filter(item => visibleTasks.some(task => task.taskId === item.taskId)).slice(0, 100).map(item => h('div', { key: item.occurrenceId || `${item.taskId}-${item.scheduledFor}`, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px 170px', gap: '12px', alignItems: 'center', border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px', background: BRAND.surface, color: BRAND.inkMuted, fontSize: '11px' } }, h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, item.taskName), h('div', { style: { marginTop: '3px' } }, item.occurrenceId || '—'), h(ScheduleDeliveryResult, { item })), h(Pill, { tone: item.state === 'completed' || item.state === 'succeeded' ? 'accent' : item.state === 'failed' ? 'signal' : 'neutral' }, item.state || 'unknown'), h('span', null, item.completedAt ? new Date(item.completedAt).toLocaleString() : item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : '—'))))) : (!visibleTasks.length ? h(EmptyState, { icon: '◷', title: catalogUnavailable ? '云端任务暂时无法读取' : tasks.length ? '没有匹配的自动化' : '还没有自动化', detail: catalogUnavailable ? '请根据下方提示恢复云端服务后刷新。' : tasks.length ? '调整搜索或 Agent 筛选条件。' : agents.length ? scope === 'cloud' ? '计划使用触发时的云端部署版本；调度就绪后可创建。' : '可以在这里创建计划。计划绑定到 Agent，执行时使用其当前 Revision；也可以先用上面的常用任务模板。' : scope === 'cloud' ? '先将本地 Agent 部署到云端，再创建云端计划。' : '先创建一个 Agent，自动化才有可执行目标。' }) : viewMode === 'list' ? h('div', { style: { display: 'grid', gap: '10px' } }, pagedTasks.map(taskCard)) : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' } }, taskGroups.map(group => {
          const items = visibleTasks.filter(task => taskStatus(task) === group.id);
          const pageItems = pagedTasks.filter(task => taskStatus(task) === group.id);
          return h('section', { key: group.id, style: { display: 'grid', alignContent: 'start', gap: '10px', minWidth: 0 } }, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 2px', color: BRAND.inkMuted, fontSize: '12px', fontWeight: 750 } }, h('span', null, group.label), h('span', null, String(items.length))), pageItems.length ? pageItems.map(taskCard) : h('div', { style: { border: '1px dashed ' + BRAND.border, borderRadius: '12px', padding: '18px', color: BRAND.inkMuted, fontSize: '12px', textAlign: 'center' } }, group.id === 'scheduled' ? '新建任务，安排下一次执行' : '暂无任务'));
        }))),
        section === 'tasks' && visibleTasks.length ? h(OperationalPager, { page: taskPage, pageSize: taskPageSize, total: visibleTasks.length, onChange: setTaskPage }) : null,
        message ? h('div', { role: 'status', style: { marginTop: '12px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
        readError ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, readError) : null,
        error ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
      ) : null);
  }
  return { useAutomationOccurrences, AutomationPage };
}
