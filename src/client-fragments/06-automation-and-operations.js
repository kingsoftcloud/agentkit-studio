    function ResourceWorkspace() {
      const [tab, setTab] = useState(() => {
        try {
          const value = window.localStorage.getItem('agentkit-studio:resource-tab');
          if (value) window.localStorage.removeItem('agentkit-studio:resource-tab');
          return value || 'models';
        } catch { return 'models'; }
      });
      return h('div', null,
        h(StudioSubnav, { value: tab, onChange: setTab, items: [{ id: 'models', label: '模型与工具' }, { id: 'marketplace', label: '插件市场' }, { id: 'runtime-resources', label: '运行资源' }] }),
        tab === 'models' ? h(ResourcesPage) : tab === 'marketplace' ? h(MarketplacePage) : h(RuntimeResourcesPage));
    }

    function localDateTimeValue(value) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      const pad = value => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function scheduleLabel(task) {
      const schedule = task?.schedule || {};
      if (schedule.kind === 'cron') return `Cron · ${schedule.expression || '—'}`;
      if (schedule.kind === 'interval' || schedule.kind === 'every') {
        const seconds = Number(schedule.everySeconds || schedule.every_seconds || 0);
        if (seconds >= 86400 && seconds % 86400 === 0) return `每 ${seconds / 86400} 天`;
        if (seconds >= 3600 && seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
        if (seconds >= 60 && seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
        return `每 ${seconds || '—'} 秒`;
      }
      if (schedule.kind === 'after') return `延迟 ${schedule.afterSeconds || schedule.after_seconds || '—'} 秒`;
      if (schedule.kind === 'daily') return `每天 ${schedule.time || '—'}`;
      if (schedule.kind === 'weekly') return `每周 ${schedule.time || '—'}`;
      if (schedule.kind === 'at') return schedule.scheduledAt ? `一次 · ${new Date(schedule.scheduledAt).toLocaleString()}` : '一次性任务';
      return schedule.at ? `一次 · ${new Date(schedule.at).toLocaleString()}` : '一次性任务';
    }

    function scheduleNeedsRefresh(task, latest) {
      if (['claimed', 'accepted', 'running', 'admitting'].includes(latest?.state)
        || ['waiting_result', 'pending', 'queued', 'sending', 'retrying'].includes(latest?.deliveryState)) return true;
      return task.enabled !== false && Boolean(task.nextRunAt) && new Date(task.nextRunAt).getTime() <= Date.now();
    }

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
        if (typeof window !== 'undefined' && !(await (window.__AGENTKIT_CONFIRM__ ? window.__AGENTKIT_CONFIRM__({ title: '删除自动化', detail: `删除自动化“${task.displayName || task.taskId}”？此操作不可撤销。${scope === 'cloud' ? '只停止后续触发，已触发的执行和结果投递会继续。' : ''}`, confirmLabel: '删除', danger: true }) : Promise.resolve(window.confirm(`删除自动化“${task.displayName || task.taskId}”？`))))) return;
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
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', flexWrap: 'wrap' } }, h('span', null, task.enabled && task.nextRunAt ? `下次执行：${new Date(task.nextRunAt).toLocaleString()}` : latest ? `最近执行：${new Date(latest.completedAt || latest.startedAt || latest.scheduledFor || Date.now()).toLocaleString()}` : '未安排下一次执行'), h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, h('button', { type: 'button', onClick: () => void openDetail(task), style: { ...buttonStyle(), background: BRAND.surface } }, '详情'), h('button', { type: 'button', onClick: () => void showHistory(task), style: { ...buttonStyle(), background: BRAND.surface } }, active ? '收起记录' : '执行记录'), h('button', { type: 'button', onClick: () => startEdit(task), style: { ...buttonStyle(), background: BRAND.surface } }, '编辑'), h('button', { type: 'button', onClick: () => void toggle(task), disabled: busyTask === task.taskId, style: { ...buttonStyle(), background: BRAND.surface } }, task.enabled === false ? '启用' : '暂停'), h('button', { type: 'button', onClick: () => void runNow(task), disabled: busyTask === task.taskId || task.enabled === false, style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)' } }, busyTask === task.taskId ? '提交中…' : '立即运行'), h('button', { type: 'button', onClick: () => void remove(task), disabled: busyTask === task.taskId, style: { ...buttonStyle(), background: BRAND.surface, color: BRAND.danger } }, '删除'))),
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
        h('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap', marginTop: '13px' } }, h('button', { type: 'button', onClick: () => startEdit(detailTask), style: buttonStyle() }, '编辑'), h('button', { type: 'button', onClick: () => void toggle(detailTask), disabled: busyTask === detailTask.taskId, style: buttonStyle() }, detailTask.enabled === false ? '启用' : '暂停'), h('button', { type: 'button', onClick: () => void runNow(detailTask), disabled: busyTask === detailTask.taskId || detailTask.enabled === false, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: BRAND.primaryFill, borderColor: 'transparent' } }, busyTask === detailTask.taskId ? '提交中…' : '立即运行'), h('button', { type: 'button', onClick: () => void remove(detailTask), disabled: busyTask === detailTask.taskId, style: { ...buttonStyle(), color: BRAND.danger } }, '删除')),
        h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, '最近执行'), detailOccurrences.length ? h('div', { style: { display: 'grid', gap: '6px', marginTop: '8px' } }, detailOccurrences.slice(0, 10).map(item => h('div', { key: item.occurrenceId || `${item.state}-${item.scheduledFor}`, style: { display: 'grid', gridTemplateColumns: '90px minmax(0,1fr) 170px', gap: '10px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h(Pill, { tone: ['succeeded', 'completed'].includes(String(item.state).toLowerCase()) ? 'accent' : ['failed', 'error', 'cancelled'].includes(String(item.state).toLowerCase()) ? 'signal' : 'neutral' }, item.state || 'unknown'), h('div', null, h('span', null, item.detail || item.errorCode || item.occurrenceId || '—'), h(ScheduleDeliveryResult, { item })), h('span', null, item.completedAt ? new Date(item.completedAt).toLocaleString() : item.startedAt ? new Date(item.startedAt).toLocaleString() : item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : '—')))) : occurrencePlaceholder(detailView))) : null;

      return h('div', null,
        h(OperationalPageHeading, { title: '自动化', detail: scope === 'cloud' ? '云端按计划执行，关闭应用后仍然有效。每次执行使用触发时部署的版本。' : '本地按计划执行，需要保持此设备和应用运行。', action: h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, h(Pill, { tone: availability?.triggerActive ? 'accent' : 'neutral' }, availability?.triggerActive ? '调度运行中' : '调度待就绪'), h('button', { type: 'button', onClick: () => { setEditingTask(null); setForm(previous => ({ ...previous, deliveryMode: 'record', deliveryTarget: null, agentId: createAgents.some(item => agentId(item) === previous.agentId) ? previous.agentId : agentId(createAgents[0]) })); setEditorOpen(true); setMessage(''); }, disabled: status !== 'ready' || !createAgents.length, style: buttonStyle() }, '新建自动化'), h('button', { type: 'button', onClick: () => void load(), style: { ...buttonStyle(), background: BRAND.surface } }, '刷新')) }),
        h(StudioPageTabs, { value: scope, onChange: setScope, items: [{ id: 'local', label: '本地' }, { id: 'cloud', label: '云端部署' }], ariaLabel: '自动化执行位置' }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取自动化', detail: '读取计划、可用 Agent 和调度器状态。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '自动化不可用', detail: readError, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
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
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' } }, h('button', { type: 'button', onClick: () => setEditorOpen(false), disabled: saving, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: saving || !agents.length, style: { ...buttonStyle(), color: saving || !agents.length ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !agents.length ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !agents.length ? BRAND.border : 'transparent' } }, saving ? '保存中…' : editingTask ? '保存修改' : '创建'))),
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

    function OperationsWorkspace({ scheduleRemote }) {
      const [tab, setTab] = useState('delivery');
      return h('div', null,
        h(StudioSubnav, { value: tab, onChange: setTab, items: [{ id: 'delivery', label: '构建与部署' }, { id: 'automation', label: '自动化' }, { id: 'evaluation', label: '评测' }, { id: 'observability', label: '观测' }, { id: 'channels', label: 'Channels' }] }),
        tab === 'delivery' ? h(DeliveryPage) : tab === 'automation' ? h(AutomationPage, { scheduleRemote }) : h(OperationalPage, { page: tab }));
    }

    function operationalCollection(payload, keys = ['items']) {
      if (Array.isArray(payload)) return payload;
      for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
      const nested = payload?.data || payload?.Data;
      if (Array.isArray(nested)) return nested;
      if (nested && typeof nested === 'object') {
        for (const key of keys) if (Array.isArray(nested[key])) return nested[key];
      }
      return [];
    }

    function operationalId(item, fallback = '') {
      return String(item?.metadata?.id || item?.id || item?.Id || item?.caseId || item?.traceId || item?.TraceId || item?.runId || item?.RunId || fallback);
    }

    function operationalLabel(item, fallback = '—') {
      return String(item?.metadata?.name || item?.name || item?.Name || item?.title || item?.Title || item?.displayName || item?.DisplayName || fallback);
    }

    function operationalDate(value) {
      if (!value) return '—';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function operationalStatus(value) {
      const status = String(value || 'unknown').toUpperCase();
      const tone = ['SUCCEEDED', 'SUCCESS', 'PASSED', 'COMPLETED', 'READY', 'CONNECTED', 'ENABLED', 'ONLINE'].includes(status) ? 'accent' : ['FAILED', 'ERROR', 'CANCELLED', 'REJECTED', 'OFFLINE'].includes(status) ? 'signal' : 'neutral';
      return h(Pill, { tone }, status.toLowerCase());
    }

    function OperationalTable({ columns, rows, empty = '暂无数据', onRowClick }) {
      const header = h('thead', null,
        h('tr', { style: { position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', color: BRAND.inkMuted, background: BRAND.canvas } },
          columns.map(column => h('th', { key: column.id, style: { padding: '11px 12px', fontWeight: 750, whiteSpace: 'nowrap', borderBottom: '1px solid ' + BRAND.border } }, column.label))));
      const body = rows.length
        ? rows.map((row, index) => h('tr', { key: operationalId(row, String(index)), onClick: onRowClick ? () => onRowClick(row) : undefined, style: { cursor: onRowClick ? 'pointer' : 'default', borderBottom: '1px solid ' + BRAND.border } }, columns.map(column => h('td', { key: column.id, style: { padding: '11px 12px', color: BRAND.ink, verticalAlign: 'top', maxWidth: column.maxWidth || undefined } }, column.cell ? column.cell(row) : String(row?.[column.id] ?? '—')))))
        : h('tr', null, h('td', { colSpan: columns.length, style: { padding: '28px 14px', color: BRAND.inkMuted, textAlign: 'center' } }, empty));
      return h('div', { style: { overflow: 'auto', maxHeight: 'min(58vh, 560px)', border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface } },
        h('table', { style: { width: '100%', minWidth: Math.max(680, columns.length * 140) + 'px', borderCollapse: 'collapse', fontSize: '12px' } }, header, h('tbody', null, body)));
    }

    function OperationalPager({ page, pageSize, total, onChange }) {
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      return h('div', { 'data-studio-pager': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px', padding: '4px 0', color: BRAND.inkMuted, fontSize: '11px' } },
        h('span', null, total ? `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} / ${total}` : '0 条'),
        h('div', { style: { display: 'flex', gap: '6px', flexShrink: 0 } },
          h('button', { type: 'button', 'aria-label': '运行中心上一页', disabled: page <= 0, onClick: () => onChange(Math.max(0, page - 1)), style: pagerButtonStyle(page <= 0) }, '上一页'),
          h('button', { type: 'button', 'aria-label': '运行中心下一页', disabled: page >= pageCount - 1, onClick: () => onChange(Math.min(pageCount - 1, page + 1)), style: pagerButtonStyle(page >= pageCount - 1) }, '下一页')));
    }

    function OperationalToolbar({ children, onRefresh, busy }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, children),
        h('button', { type: 'button', onClick: onRefresh, disabled: busy, style: { ...buttonStyle(), background: BRAND.surface } }, busy ? '读取中…' : '刷新'));
    }

    function OperationalBars({ buckets = [] }) {
      const values = Array.isArray(buckets) ? buckets.slice(-24) : [];
      if (!values.length) return null;
      const peak = Math.max(1, ...values.map(item => Number(item?.runs || item?.count || 0)));
      return h(OperationalPanel, { title: '运行趋势', detail: 'Host Trace Store 返回的时间桶；没有上报时不绘制估算数据。' },
        h('div', { style: { display: 'flex', alignItems: 'end', gap: '4px', height: '92px', padding: '12px 14px 14px', overflowX: 'auto' } },
          values.map((item, index) => {
            const runs = Number(item?.runs || item?.count || 0);
            const completed = Number(item?.completed || item?.succeeded || 0);
            const height = Math.max(4, Math.round((runs / peak) * 58));
            return h('div', { key: `${item?.startedAt || item?.at || index}`, title: `${operationalDate(item?.startedAt || item?.at)} · ${runs} 次运行 · ${completed} 次完成`, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'end', gap: '4px', minWidth: '18px', height: '66px' } },
              h('span', { style: { width: '12px', height: `${height}px`, borderRadius: '4px 4px 2px 2px', background: completed === runs ? BRAND.primaryFill : BRAND.accentSoft, border: '1px solid ' + BRAND.primaryFill } }),
              index === 0 || index === values.length - 1 ? h('small', { style: { color: BRAND.inkMuted, fontSize: '9px', whiteSpace: 'nowrap' } }, operationalDate(item?.startedAt || item?.at).slice(0, 5)) : null);
          })));
    }

    function EvaluationPage() {
      const [status, setStatus] = useState('loading');
      const [error, setError] = useState('');
      const [targets, setTargets] = useState([]);
      const [evalsets, setEvalsets] = useState([]);
      const [runs, setRuns] = useState([]);
      const [tab, setTab] = useState('runs');
      const [filter, setFilter] = useState('');
      const [page, setPage] = useState(0);
      const [evalsetPage, setEvalsetPage] = useState(0);
      const [targetPage, setTargetPage] = useState(0);
      const [selected, setSelected] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      const [detailTab, setDetailTab] = useState('summary');
      const [createOpen, setCreateOpen] = useState(false);
      const [evalsetFile, setEvalsetFile] = useState('');
      const [target, setTarget] = useState('');
      const [targetKind, setTargetKind] = useState('studio_build');
      const [timeoutSeconds, setTimeoutSeconds] = useState('120');
      const [failFast, setFailFast] = useState(false);
      const [evaluators, setEvaluators] = useState(['response_contract@v1', 'runtime_budget@v1', 'tool_trajectory@v1']);
      const [creating, setCreating] = useState(false);
      const [message, setMessage] = useState('');
      const [evalsetUploading, setEvalsetUploading] = useState(false);
      const [runFilter, setRunFilter] = useState('all');
      const pageSize = 12;

      const load = async () => {
        setStatus('loading'); setError('');
        const result = await Promise.allSettled([
          hostRemote.evaluationTargets(),
          hostRemote.evaluationSets(),
          hostRemote.evaluationRuns('limit=200'),
        ]);
        const firstError = result.find(item => item.status === 'rejected');
        if (firstError && result.every(item => item.status === 'rejected')) {
          setStatus('error'); setError(firstError.reason?.message || '评测 Host 不可用'); return;
        }
        const targetPayload = result[0].status === 'fulfilled' ? result[0].value : {};
        const evalPayload = result[1].status === 'fulfilled' ? result[1].value : {};
        const runPayload = result[2].status === 'fulfilled' ? result[2].value : {};
        setTargets(operationalCollection(targetPayload, ['items', 'builds', 'targets']));
        setEvalsets(operationalCollection(evalPayload, ['items', 'evalsets', 'evaluationSets']));
        setRuns(operationalCollection(runPayload, ['items', 'runs', 'evaluationRuns']));
        setPage(0); setEvalsetPage(0); setTargetPage(0);
        setStatus('ready');
        if (firstError) setError('部分评测目录暂不可用，已展示可读取的数据。');
      };
      useEffect(() => { void load(); }, []);
      useEffect(() => {
        if (status !== 'ready' || !runs.some(run => ['RUNNING', 'PENDING', 'QUEUED', 'ADMITTING'].includes(String(run?.status || '').toUpperCase()))) return undefined;
        const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 4000);
        return () => window.clearInterval(timer);
      }, [status, runs]);
      const filteredRuns = runs.filter(run => {
        const haystack = [operationalId(run), operationalLabel(run?.evalset), operationalLabel(run?.target), run?.status, run?.createdAt].join(' ').toLowerCase();
        const state = String(run?.status || '').toUpperCase();
        const stateMatch = runFilter === 'active' ? ['RUNNING', 'PENDING', 'QUEUED', 'ADMITTING'].includes(state) : runFilter === 'passed' ? ['PASSED', 'SUCCEEDED', 'COMPLETED'].includes(state) : runFilter === 'attention' ? ['FAILED', 'ERROR', 'INTERRUPTED', 'UNAVAILABLE'].includes(state) : true;
        return stateMatch && (!filter.trim() || haystack.includes(filter.trim().toLowerCase()));
      });
      const rows = filteredRuns.slice(page * pageSize, (page + 1) * pageSize);
      const visibleEvalsets = evalsets.slice(evalsetPage * pageSize, (evalsetPage + 1) * pageSize);
      const visibleTargets = targets.slice(targetPage * pageSize, (targetPage + 1) * pageSize);
      const openRun = async run => {
        const id = operationalId(run);
        setSelected(run); setDetailTab('summary'); setDetailLoading(true);
        try { setSelected(await hostRemote.evaluationRun(id)); } catch { try { setSelected(await hostRemote.evaluation(id)); } catch { /* keep list row */ } }
        finally { setDetailLoading(false); }
      };
      const startCreate = async event => {
        event.preventDefault();
        if (!evalsetFile.trim() || !target.trim() || creating) return;
        setCreating(true); setMessage('');
        try {
          if (!evaluators.length) throw new Error('至少选择一个评估器');
          await hostRemote.createEvaluation({
            evalsetFile: evalsetFile.trim(),
            target: { kind: targetKind, locator: target.trim() },
            config: {
              timeoutSeconds: Math.max(1, Number(timeoutSeconds) || 120),
              failFast,
              dataPolicy: 'local_only',
              evaluators,
            },
          }, `studio-evaluation-${Date.now()}`);
          setCreateOpen(false); setMessage('评测已提交，正在读取运行记录。'); await load();
        } catch (reason) { setError(reason?.message || '评测创建失败'); }
        finally { setCreating(false); }
      };
      const importEvalset = async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || evalsetUploading) return;
        setEvalsetUploading(true); setError('');
        try {
          const payload = await hostRemote.importEvaluationFile((() => { const body = new FormData(); body.append('file', file); return body; })());
          const path = payload?.evalsetId || payload?.id || payload?.path || payload?.file?.path || payload?.locator;
          if (!path) throw new Error('Host 未返回 EvalSet 标识');
          setEvalsetFile(path); setMessage(`已导入 EvalSet：${path}`); void load();
        } catch (reason) { setError(reason?.message || 'EvalSet 文件导入失败'); }
        finally { setEvalsetUploading(false); }
      };
      const summary = [
        ['运行记录', runs.length, '真实 Host evaluation-runs'],
        ['评测集', evalsets.length, '已导入的 EvalSet'],
        ['可用目标', targets.length, 'Build / A2A / 本地目标'],
        ['进行中', runs.filter(item => ['RUNNING', 'PENDING', 'QUEUED', 'ADMITTING'].includes(String(item?.status || '').toUpperCase())).length, '后台执行'],
      ];
      const runColumns = [
        { id: 'name', label: '评测任务', cell: row => h('div', null, h('strong', null, operationalLabel(row?.evalset, operationalId(row))), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, operationalId(row))) },
        { id: 'target', label: '目标', cell: row => operationalLabel(row?.target, row?.target?.kind || '—') },
        { id: 'status', label: '状态', cell: row => operationalStatus(row?.status) },
        { id: 'progress', label: '结果', cell: row => row?.summary ? `${row.summary.passedCases ?? 0} / ${row.summary.totalCases ?? 0} 通过` : row?.progress ? `${row.progress.current ?? 0} / ${row.progress.total ?? 0}` : '等待开始' },
        { id: 'duration', label: '耗时', cell: row => row?.durationMs == null ? '—' : `${row.durationMs} ms` },
        { id: 'createdAt', label: '创建时间', cell: row => operationalDate(row?.createdAt) },
      ];
      const evaluatorOptions = [
        ['response_contract@v1', '响应契约'],
        ['runtime_budget@v1', '运行预算'],
        ['tool_trajectory@v1', '工具轨迹'],
        ['reference_match@v1', '参考答案匹配'],
      ];
      const targetKindLabel = targetKind === 'a2a' ? 'Agent 地址' : targetKind === 'local_source' ? 'Agent 源码目录' : 'Build';
      const selectedRunSummary = selected?.summary || selected?.report?.summary || {};
      const selectedDetail = selected ? h(ResourceDialog, { title: `评测详情 · ${operationalId(selected)}`, detail: `${operationalDate(selected.createdAt)} · ${String(selected.status || 'unknown').toLowerCase()}`, wide: true, onClose: () => setSelected(null) },
        h('div', { style: { padding: '2px 0', maxHeight: 'min(64vh, 620px)', overflow: 'auto' } },
          detailLoading ? h('p', { style: { color: BRAND.inkMuted } }, '正在读取运行详情…') : h(React.Fragment, null,
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } }, operationalStatus(selected.status), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, operationalDate(selected.createdAt))),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' } },
              [['总用例', selectedRunSummary.totalCases ?? selected?.cases?.length ?? '—'], ['通过', selectedRunSummary.passedCases ?? '—'], ['失败', selectedRunSummary.failedCases ?? '—'], ['耗时', selected?.durationMs == null ? '—' : `${selected.durationMs} ms`]].map(([label, value]) => h('div', { key: label, style: { padding: '10px 11px', borderRadius: '9px', background: BRAND.canvas, border: '1px solid ' + BRAND.border } }, h('div', { style: { color: BRAND.inkMuted, fontSize: '10px' } }, label), h('strong', { style: { display: 'block', color: BRAND.ink, marginTop: '4px', fontSize: '15px' } }, String(value))))),
            h(StudioPageTabs, { value: detailTab, onChange: setDetailTab, items: [{ id: 'summary', label: '摘要' }, { id: 'cases', label: `用例 ${selected?.cases?.length || 0}` }, { id: 'assertions', label: `断言 ${selected?.assertions?.length || 0}` }, { id: 'trace', label: '执行轨迹' }], ariaLabel: '评测运行详情视图' }),
            detailTab === 'summary' ? h('pre', { style: { margin: '12px 0 0', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.55 } }, JSON.stringify(selected.report || selected.error || selected, null, 2)) : null,
            detailTab === 'cases' ? h(OperationalTable, { columns: [{ id: 'name', label: '用例', cell: row => h('strong', null, operationalLabel(row, operationalId(row))) }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.status || row?.result) }, { id: 'duration', label: '耗时', cell: row => row?.durationMs == null ? '—' : `${row.durationMs} ms` }, { id: 'error', label: '错误', cell: row => row?.error || row?.message || '—' }], rows: operationalCollection(selected.cases || selected.caseResults || selected.results), empty: '运行详情未返回用例结果。' }) : null,
            detailTab === 'assertions' ? h(OperationalTable, { columns: [{ id: 'name', label: '断言', cell: row => h('strong', null, operationalLabel(row, row?.path || '—')) }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.status || (row?.passed ? 'passed' : 'failed')) }, { id: 'message', label: '说明', cell: row => row?.message || row?.detail || '—' }], rows: operationalCollection(selected.assertions || selected.evaluatorResults), empty: '运行详情未返回断言结果。' }) : null,
            detailTab === 'trace' ? h('pre', { style: { margin: '12px 0 0', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.55 } }, JSON.stringify(selected.trace || selected.trajectory || selected.events || [], null, 2)) : null))) : null;

      return h('div', null,
        h(OperationalPageHeading, { title: '评测', detail: '评测集、目标、运行记录和详情都来自 Host；页面负责筛选、分页和结果投影。', action: h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : '读取中'), h('button', { type: 'button', onClick: () => setCreateOpen(value => !value), style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, '新建评测')) }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取评测数据', detail: '读取评测目标、评测集和运行记录。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '评测暂不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '14px' } }, summary.map(item => h(Metric, { key: item[0], label: item[0], value: String(item[1]), detail: item[2] }))),
          createOpen ? h(ResourceDialog, { title: '新建评测', detail: '选择 EvalSet、目标和评估器，提交后由 Host 在后台执行。', onClose: () => { if (!creating) setCreateOpen(false); } }, h('form', { onSubmit: startCreate, style: { display: 'grid', gap: '14px' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(180px, .8fr)', gap: '12px' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'EvalSet 文件', h('input', { value: evalsetFile, onChange: event => setEvalsetFile(event.target.value), placeholder: '.agentkit/evaluations/example.yaml', style: inputStyle(), required: true }), h('input', { type: 'file', accept: '.yaml,.yml,.json', onChange: importEvalset, disabled: evalsetUploading, style: { ...inputStyle(), marginTop: '6px', padding: '6px' } }), evalsetUploading ? h('span', { style: { color: BRAND.inkMuted, fontSize: '10px' } }, '正在导入…') : null),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '评测目标类型', h('select', { value: targetKind, onChange: event => { setTargetKind(event.target.value); setTarget(''); }, style: inputStyle() }, h('option', { value: 'studio_build' }, 'Studio Build'), h('option', { value: 'a2a', disabled: true }, 'A2A Agent（尚未接入）'), h('option', { value: 'local_source', disabled: true }, '本地源码（尚未接入）')))),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 180px 180px', gap: '12px', alignItems: 'end' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, targetKindLabel, targetKind === 'studio_build'
                ? h('select', { value: target, onChange: event => setTarget(event.target.value), style: inputStyle(), required: true }, h('option', { value: '' }, '选择可用 Build'), targets.map(item => h('option', { key: operationalId(item), value: operationalId(item) }, `${operationalLabel(item, operationalId(item))} · ${operationalId(item)}`)))
                : h('input', { value: target, onChange: event => setTarget(event.target.value), placeholder: targetKind === 'a2a' ? 'https://agent.example.test/a2a' : '.', style: inputStyle(), required: true })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '超时（秒）', h('input', { type: 'number', min: 1, max: 3600, value: timeoutSeconds, onChange: event => setTimeoutSeconds(event.target.value), style: inputStyle(), required: true })),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '36px', color: BRAND.ink, fontSize: '12px', fontWeight: 700 } }, h('input', { type: 'checkbox', checked: failFast, onChange: event => setFailFast(event.target.checked) }), h('span', null, '失败时停止'))),
            h('fieldset', { style: { border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px', margin: 0 } },
              h('legend', { style: { padding: '0 5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '评估器（至少选择一个）'),
              h('div', { style: { display: 'flex', gap: '10px 18px', flexWrap: 'wrap' } }, evaluatorOptions.map(([id, label]) => h('label', { key: id, style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: BRAND.ink, fontSize: '12px' } }, h('input', { type: 'checkbox', checked: evaluators.includes(id), onChange: event => setEvaluators(current => event.target.checked ? [...new Set([...current, id])] : current.filter(item => item !== id)) }), label)))),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: () => setCreateOpen(false), disabled: creating, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: creating || !evaluators.length, style: { ...buttonStyle(), background: BRAND.primaryFill, color: 'var(--dsw-static-neutral-00, #fff)', borderColor: 'transparent' } }, creating ? '提交中…' : '开始评测')))) : null,
          h(StudioPageTabs, { value: tab, onChange: next => { setTab(next); setPage(0); if (next === 'sets') setEvalsetPage(0); if (next === 'targets') setTargetPage(0); }, items: [{ id: 'runs', label: '运行记录' }, { id: 'sets', label: `评测集 ${evalsets.length}` }, { id: 'targets', label: `评测目标 ${targets.length}` }], ariaLabel: '评测视图' }),
          tab === 'runs' ? h(React.Fragment, null,
            h(OperationalToolbar, { onRefresh: () => void load(), busy: status === 'loading' }, h('input', { value: filter, onChange: event => { setFilter(event.target.value); setPage(0); }, placeholder: '搜索任务、目标或状态', 'aria-label': '搜索评测运行', style: { ...inputStyle(), maxWidth: '280px' } }), h('select', { value: runFilter, onChange: event => { setRunFilter(event.target.value); setPage(0); }, 'aria-label': '评测状态筛选', style: { ...inputStyle(), width: '120px' } }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'active' }, '进行中'), h('option', { value: 'passed' }, '已通过'), h('option', { value: 'attention' }, '需关注')), h(Pill, { tone: 'neutral' }, `${filteredRuns.length} 条运行`)),
            h(OperationalTable, { columns: runColumns, rows, empty: '还没有评测运行，点击“新建评测”提交一个真实任务。', onRowClick: openRun }),
            h(OperationalPager, { page, pageSize, total: filteredRuns.length, onChange: setPage }),
            message ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null) : null,
          tab === 'sets' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'name', label: '评测集', cell: row => h('strong', null, operationalLabel(row)) }, { id: 'source', label: '来源', cell: row => row?.sourceFormat || row?.source || 'Host' }, { id: 'cases', label: '用例数', cell: row => row?.caseCount ?? row?.cases?.length ?? '—' }, { id: 'updatedAt', label: '更新时间', cell: row => operationalDate(row?.updatedAt || row?.createdAt) }], rows: visibleEvalsets, empty: '暂无已导入评测集。' }), h(OperationalPager, { page: evalsetPage, pageSize, total: evalsets.length, onChange: setEvalsetPage })) : null,
          tab === 'targets' ? h(React.Fragment, null, h(OperationalTable, { columns: [{ id: 'name', label: '目标', cell: row => h('strong', null, operationalLabel(row, operationalId(row))) }, { id: 'kind', label: '类型', cell: row => row?.kind || row?.runtime || row?.type || 'Build' }, { id: 'agentId', label: 'Agent', cell: row => row?.agentId || row?.agent?.id || '—' }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.status || 'ready') }], rows: visibleTargets, empty: '暂无可评测目标，请先完成 Agent Build。' }), h(OperationalPager, { page: targetPage, pageSize, total: targets.length, onChange: setTargetPage })) : null,
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, marginTop: '10px', fontSize: '12px' } }, error) : null,
          selectedDetail) : null);
    }

    function ObservabilityPage() {
      const [status, setStatus] = useState('loading');
      const [error, setError] = useState('');
      const [overview, setOverview] = useState(null);
      const [traces, setTraces] = useState([]);
      const [agents, setAgents] = useState([]);
      const [range, setRange] = useState('24h');
      const [query, setQuery] = useState('');
      const [agentFilter, setAgentFilter] = useState('all');
      const [statusFilter, setStatusFilter] = useState('all');
      const [page, setPage] = useState(0);
      const [selected, setSelected] = useState(null);
      const [selectedSpan, setSelectedSpan] = useState(null);
      const [detailTab, setDetailTab] = useState('spans');
      const [raw, setRaw] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      const pageSize = 12;

      const load = async () => {
        setStatus('loading');
        setError('');
        const qs = new URLSearchParams({ range, limit: '200' });
        if (query.trim()) qs.set('query', query.trim());
        const result = await Promise.allSettled([
          hostRemote.tracesOverview(`range=${encodeURIComponent(range)}`),
          hostRemote.traces(qs.toString()),
          hostRemote.agents(),
        ]);
        if (result.slice(0, 2).every(item => item.status === 'rejected')) {
          setStatus('error');
          setError(result[0].reason?.message || '观测 Host 不可用');
          return;
        }
        setOverview(result[0].status === 'fulfilled' ? result[0].value : null);
        setTraces(result[1].status === 'fulfilled' ? operationalCollection(result[1].value, ['items', 'traces']) : []);
        setAgents(result[2].status === 'fulfilled' ? operationalCollection(result[2].value, ['items', 'agents']) : []);
        setStatus('ready');
        if (result.some(item => item.status === 'rejected')) setError('部分观测数据暂不可用。');
      };

      useEffect(() => { void load(); }, [range]);
      useEffect(() => {
        if (status !== 'ready' || !traces.some(trace => ['RUNNING', 'PENDING', 'QUEUED'].includes(String(trace?.status || '').toUpperCase()))) return undefined;
        const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
        return () => window.clearInterval(timer);
      }, [status, traces]);

      const filtered = traces.filter(trace => {
        const haystack = [operationalId(trace), trace?.runId, trace?.sessionId, trace?.agentId, trace?.status, trace?.name, trace?.agentName]
          .join(' ')
          .toLowerCase();
        const state = String(trace?.status || '').toUpperCase();
        const statusMatch = statusFilter === 'all' || (statusFilter === 'active' ? ['RUNNING', 'PENDING', 'QUEUED'].includes(state) : statusFilter === 'failed' ? ['FAILED', 'ERROR', 'INTERRUPTED'].includes(state) : ['SUCCEEDED', 'COMPLETED', 'SUCCESS'].includes(state));
        const traceAgentId = String(trace?.agentId || trace?.AgentId || '');
        return statusMatch && (agentFilter === 'all' || traceAgentId === agentFilter) && (!query.trim() || haystack.includes(query.trim().toLowerCase()));
      });
      const rows = filtered.slice(page * pageSize, (page + 1) * pageSize);

      const openTrace = async trace => {
        const id = operationalId(trace);
        setSelected(trace);
        setSelectedSpan(null);
        setRaw(null);
        setDetailTab('spans');
        setDetailLoading(true);
        try {
          const detail = await hostRemote.trace(id);
          setSelected(detail);
          setSelectedSpan(detail?.spans?.[0] || null);
        } catch (reason) {
          setError(reason?.message || 'Trace 详情读取失败');
        } finally {
          setDetailLoading(false);
        }
      };

      const loadRaw = async () => {
        if (!selected) return;
        try {
          setRaw(await hostRemote.traceOtlp(operationalId(selected)));
        } catch (reason) {
          setError(reason?.message || 'OTLP 读取失败');
        }
      };
      const exportSession = async () => {
        const sessionId = selected?.sessionId || selected?.SessionId;
        if (!sessionId) { setError('当前 Trace 没有 Session ID，无法导出会话日志。'); return; }
        try {
          const payload = await hostRemote.exportSessionLog(sessionId);
          const blob = new Blob([payload?.content ?? (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))], { type: payload?.contentType || 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a'); link.href = url; link.download = payload?.filename || `${sessionId}-session.json`; link.click(); URL.revokeObjectURL(url);
        } catch (reason) { setError(reason?.message || '会话日志导出失败'); }
      };

      const summary = [
        ['运行次数', overview?.total ?? overview?.totalRuns ?? traces.length, range === '7d' ? '近 7 天' : '近 24 小时'],
        ['完成率', overview?.successRate == null ? '—' : `${Math.round(Number(overview.successRate) * 100)}%`, '已完成运行'],
        ['平均耗时', overview?.avgDurationMs == null ? '—' : `${Math.round(Number(overview.avgDurationMs))} ms`, 'Runtime 上报'],
        ['Token 用量', overview?.totalTokens ?? overview?.tokens ?? '—', '输入与输出合计'],
      ];

      const requestMetrics = (selected?.events || []).filter(event => event.event_type === 'model.request').map(event => event.payload);
      const requestDetail = h('div', { style: { display: 'grid', gap: '10px', maxHeight: '36vh', overflow: 'auto' } },
        h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', margin: 0 } }, '字符数反映请求体大小，不等于 Token 用量；这里只保存统计，不保存提示词正文。'),
        requestMetrics.length ? requestMetrics.map((item, index) => h('div', { key: item.requestId || index, style: { padding: '12px', border: '1px solid ' + BRAND.border, borderRadius: '10px' } },
          h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, `请求 ${index + 1} · ${item.model || '—'}`),
          h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '8px', lineHeight: 1.8 } },
            `总计 ${Number(item.requestChars || 0).toLocaleString()} 字符 · ${Number(item.requestBytes || 0).toLocaleString()} 字节`,
            h('br'), `工具定义 ${Number(item.toolsChars || 0).toLocaleString()} 字符（${item.toolCount ?? '—'} 个工具）`,
            h('br'), `系统提示词 ${Number(item.instructionsChars || 0).toLocaleString()} 字符 · 对话内容 ${Number(item.conversationChars || 0).toLocaleString()} 字符`)))
          : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '此记录没有请求体统计。当前仅新运行的 Codex Chat Completions 代理提供该统计；不代表请求大小为零。'));
      const detailContent = detailTab === 'requests' ? requestDetail : detailTab === 'raw'
        ? h(React.Fragment, null,
            h('button', { type: 'button', onClick: loadRaw, style: buttonStyle() }, '读取 OTLP'),
            raw
              ? h('pre', { style: { maxHeight: '32vh', overflow: 'auto', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(raw, null, 2))
              : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '点击读取原始 OTLP。'))
        : detailTab === 'events'
          ? h('pre', { style: { maxHeight: '32vh', overflow: 'auto', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(selectedSpan?.events || selected?.events || selected?.event || [], null, 2))
          : detailTab === 'attributes'
            ? h('pre', { style: { maxHeight: '32vh', overflow: 'auto', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(selectedSpan?.attributes || {}, null, 2))
            : detailTab === 'resource'
              ? h('pre', { style: { maxHeight: '32vh', overflow: 'auto', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify({ executionLocation: selected?.executionLocation || 'local', provenance: selected?.provenance, resource: selected?.resource || selected?.scope || {} }, null, 2))
              : detailTab === 'trajectory'
                ? h('pre', { style: { maxHeight: '32vh', overflow: 'auto', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(selected?.trajectory || selected?.toolCalls || selected?.spans || [], null, 2))
                : h('div', { style: { display: 'grid', gap: '8px', maxHeight: '32vh', overflow: 'auto' } },
                    (selected?.spans || []).map((span, index) => h(
                      'button',
                      {
                        key: operationalId(span, String(index)),
                        type: 'button',
                        onClick: () => setSelectedSpan(span),
                        style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '9px 10px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '10px', textAlign: 'left', color: BRAND.ink, background: selectedSpan === span ? BRAND.accentSoft : BRAND.surface, cursor: 'pointer' },
                      },
                      h('div', null,
                        h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, span?.name || span?.spanName || 'Span'),
                        h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, `${span?.spanId || span?.id || '—'} · ${span?.durationMs ?? '—'} ms`)),
                      operationalStatus(span?.status || 'completed'),
                    )));

      const traceDetail = selected
        ? h(ResourceDialog, { title: `Trace 详情 · ${operationalId(selected)}`, detail: `${operationalDate(selected.startedAt || selected.createdAt)} · ${String(selected.status || 'unknown').toLowerCase()}`, wide: true, onClose: () => setSelected(null) },
            h('div', { style: { display: 'grid', gap: '10px' } },
              h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h('button', { type: 'button', onClick: exportSession, style: { ...buttonStyle(), background: BRAND.surface } }, '导出 Session')),
              detailLoading
                ? h('p', { style: { color: BRAND.inkMuted } }, '正在读取 Span…')
                : h(React.Fragment, null,
                    h(StudioPageTabs, { value: detailTab, onChange: setDetailTab, items: [{ id: 'spans', label: `Spans ${selected?.spans?.length || 0}` }, { id: 'attributes', label: '属性' }, { id: 'events', label: '事件' }, { id: 'resource', label: '资源' }, { id: 'trajectory', label: '轨迹' }, { id: 'requests', label: `模型请求${requestMetrics.length ? ' ' + requestMetrics.length : ''}` }, { id: 'raw', label: '原始 OTLP' }], ariaLabel: 'Trace 详情视图' }),
                    detailContent)))
        : null;

      const columns = [
        { id: 'trace', label: 'Trace', cell: row => h('div', null, h('strong', null, row?.name || operationalId(row)), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, operationalId(row))) },
        { id: 'location', label: '执行位置', cell: row => row.executionLocation === 'cloud' ? '云端 · 本机留存凭据' : '本地' },
        { id: 'agent', label: 'Agent / Run', cell: row => `${row?.agentId || '—'} · ${row?.runId || '—'}` },
        { id: 'status', label: '状态', cell: row => operationalStatus(row?.status) },
        { id: 'duration', label: '耗时', cell: row => row?.durationMs == null ? '—' : `${row.durationMs} ms` },
        { id: 'tokens', label: 'Tokens', cell: row => row?.totalTokens ?? row?.usage?.totalTokens ?? '—' },
        { id: 'startedAt', label: '开始时间', cell: row => operationalDate(row?.startedAt || row?.startTime || row?.createdAt) },
      ];

      return h('div', null,
        h(OperationalPageHeading, { title: '观测', detail: '按时间、Agent、Run 和 Session 查看 Trace，打开详情查看 Span、事件、用量和原始 OTLP。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Trace Store 已连接' : '读取中') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取观测数据', detail: '读取聚合指标和 Trace 列表。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '观测暂不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '14px' } }, summary.map(item => h(Metric, { key: item[0], label: item[0], value: String(item[1]), detail: item[2] }))),
          overview?.buckets ? h(OperationalBars, { buckets: overview.buckets }) : null,
          overview?.cloud ? h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginBottom: '12px' } }, `云端统计 · 会话 ${overview.cloud.sessionCount ?? '—'} · Tokens ${overview.cloud.tokenCount ?? '—'} · 错误 ${overview.cloud.errorCount ?? '—'}`) : null,
          h(OperationalToolbar, { onRefresh: () => void load(), busy: status === 'loading' },
            h('input', { value: query, onChange: event => { setQuery(event.target.value); setPage(0); }, placeholder: '搜索 Trace、Run、Session 或 Agent', style: { ...inputStyle(), maxWidth: '300px' } }),
            h('select', { value: range, onChange: event => { setRange(event.target.value); setPage(0); }, style: { ...inputStyle(), width: '110px' } }, h('option', { value: '24h' }, '24 小时'), h('option', { value: '7d' }, '7 天')),
            h('select', { value: agentFilter, onChange: event => { setAgentFilter(event.target.value); setPage(0); }, 'aria-label': '按 Agent 筛选', style: { ...inputStyle(), width: '170px' } }, h('option', { value: 'all' }, '全部 Agent'), agents.map(item => h('option', { key: operationalId(item), value: operationalId(item) }, operationalLabel(item, operationalId(item))))),
            h('select', { value: statusFilter, onChange: event => { setStatusFilter(event.target.value); setPage(0); }, 'aria-label': '观测状态筛选', style: { ...inputStyle(), width: '110px' } }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'active' }, '进行中'), h('option', { value: 'success' }, '已完成'), h('option', { value: 'failed' }, '失败')),
            h(Pill, { tone: 'neutral' }, `${filtered.length} 条 Trace`)),
          h(OperationalTable, { columns, rows, empty: '还没有 Trace。完成一次真实 Agent 运行后，Trace 会出现在这里。', onRowClick: openTrace }),
          h(OperationalPager, { page, pageSize, total: filtered.length, onChange: setPage }),
          error ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.signal, fontSize: '12px' } }, error) : null,
          traceDetail)
        : null);
    }
