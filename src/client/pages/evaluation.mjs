import { operationalCollection, operationalDate, operationalId, operationalLabel } from '../state/operational-data.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createEvaluationPage({
  ui: { React: { createElement: h, useEffect, useState, Fragment }, EmptyState, Metric, OperationalPageHeading, OperationalPager, OperationalTable, OperationalToolbar, Pill, ResourceDialog, StudioPageTabs, buttonStyle, inputStyle, operationalStatus, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, document = globalThis.document
}) {
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
        detailLoading ? h('p', { style: { color: BRAND.inkMuted } }, '正在读取运行详情…') : h(Fragment, null,
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } }, operationalStatus(selected.status), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, operationalDate(selected.createdAt))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' } },
            [['总用例', selectedRunSummary.totalCases ?? selected?.cases?.length ?? '—'], ['通过', selectedRunSummary.passedCases ?? '—'], ['失败', selectedRunSummary.failedCases ?? '—'], ['耗时', selected?.durationMs == null ? '—' : `${selected.durationMs} ms`]].map(([label, value]) => h('div', { key: label, style: { padding: '10px 11px', borderRadius: '9px', background: BRAND.canvas, border: '1px solid ' + BRAND.border } }, h('div', { style: { color: BRAND.inkMuted, fontSize: '10px' } }, label), h('strong', { style: { display: 'block', color: BRAND.ink, marginTop: '4px', fontSize: '15px' } }, String(value))))),
          h(StudioPageTabs, { value: detailTab, onChange: setDetailTab, items: [{ id: 'summary', label: '摘要' }, { id: 'cases', label: `用例 ${selected?.cases?.length || 0}` }, { id: 'assertions', label: `断言 ${selected?.assertions?.length || 0}` }, { id: 'trace', label: '执行轨迹' }], ariaLabel: '评测运行详情视图' }),
          detailTab === 'summary' ? h('pre', { style: { margin: '12px 0 0', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.55 } }, JSON.stringify(selected.report || selected.error || selected, null, 2)) : null,
          detailTab === 'cases' ? h(OperationalTable, { columns: [{ id: 'name', label: '用例', cell: row => h('strong', null, operationalLabel(row, operationalId(row))) }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.status || row?.result) }, { id: 'duration', label: '耗时', cell: row => row?.durationMs == null ? '—' : `${row.durationMs} ms` }, { id: 'error', label: '错误', cell: row => row?.error || row?.message || '—' }], rows: operationalCollection(selected.cases || selected.caseResults || selected.results), empty: '运行详情未返回用例结果。' }) : null,
          detailTab === 'assertions' ? h(OperationalTable, { columns: [{ id: 'name', label: '断言', cell: row => h('strong', null, operationalLabel(row, row?.path || '—')) }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.status || (row?.passed ? 'passed' : 'failed')) }, { id: 'message', label: '说明', cell: row => row?.message || row?.detail || '—' }], rows: operationalCollection(selected.assertions || selected.evaluatorResults), empty: '运行详情未返回断言结果。' }) : null,
          detailTab === 'trace' ? h('pre', { style: { margin: '12px 0 0', whiteSpace: 'pre-wrap', color: BRAND.ink, fontSize: '11px', lineHeight: 1.55 } }, JSON.stringify(selected.trace || selected.trajectory || selected.events || [], null, 2)) : null))) : null;

    return h('div', null,
      h(OperationalPageHeading, { title: '评测', detail: '评测集、目标、运行记录和详情都来自 Host；页面负责筛选、分页和结果投影。', action: h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : '读取中'), h('button', { type: 'button', onClick: () => setCreateOpen(value => !value), style: { ...buttonStyle(), background: BRAND.primaryFill, color: BRAND.primaryText, borderColor: 'transparent' } }, '新建评测')) }),
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取评测数据', detail: '读取评测目标、评测集和运行记录。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '评测暂不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
      status === 'ready' ? h(Fragment, null,
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
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: () => setCreateOpen(false), disabled: creating, style: { ...buttonStyle(), background: BRAND.surface } }, '取消'), h('button', { type: 'submit', disabled: creating || !evaluators.length, style: { ...buttonStyle(), background: BRAND.primaryFill, color: BRAND.primaryText, borderColor: 'transparent' } }, creating ? '提交中…' : '开始评测')))) : null,
        h(StudioPageTabs, { value: tab, onChange: next => { setTab(next); setPage(0); if (next === 'sets') setEvalsetPage(0); if (next === 'targets') setTargetPage(0); }, items: [{ id: 'runs', label: '运行记录' }, { id: 'sets', label: `评测集 ${evalsets.length}` }, { id: 'targets', label: `评测目标 ${targets.length}` }], ariaLabel: '评测视图' }),
        tab === 'runs' ? h(Fragment, null,
          h(OperationalToolbar, { onRefresh: () => void load(), busy: status === 'loading' }, h('input', { value: filter, onChange: event => { setFilter(event.target.value); setPage(0); }, placeholder: '搜索任务、目标或状态', 'aria-label': '搜索评测运行', style: { ...inputStyle(), maxWidth: '280px' } }), h('select', { value: runFilter, onChange: event => { setRunFilter(event.target.value); setPage(0); }, 'aria-label': '评测状态筛选', style: { ...inputStyle(), width: '120px' } }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'active' }, '进行中'), h('option', { value: 'passed' }, '已通过'), h('option', { value: 'attention' }, '需关注')), h(Pill, { tone: 'neutral' }, `${filteredRuns.length} 条运行`)),
          h(OperationalTable, { columns: runColumns, rows, empty: '还没有评测运行，点击“新建评测”提交一个真实任务。', onRowClick: openRun }),
          h(OperationalPager, { page, pageSize, total: filteredRuns.length, onChange: setPage }),
          message ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null) : null,
        tab === 'sets' ? h(Fragment, null, h(OperationalTable, { columns: [{ id: 'name', label: '评测集', cell: row => h('strong', null, operationalLabel(row)) }, { id: 'source', label: '来源', cell: row => row?.sourceFormat || row?.source || 'Host' }, { id: 'cases', label: '用例数', cell: row => row?.caseCount ?? row?.cases?.length ?? '—' }, { id: 'updatedAt', label: '更新时间', cell: row => operationalDate(row?.updatedAt || row?.createdAt) }], rows: visibleEvalsets, empty: '暂无已导入评测集。' }), h(OperationalPager, { page: evalsetPage, pageSize, total: evalsets.length, onChange: setEvalsetPage })) : null,
        tab === 'targets' ? h(Fragment, null, h(OperationalTable, { columns: [{ id: 'name', label: '目标', cell: row => h('strong', null, operationalLabel(row, operationalId(row))) }, { id: 'kind', label: '类型', cell: row => row?.kind || row?.runtime || row?.type || 'Build' }, { id: 'agentId', label: 'Agent', cell: row => row?.agentId || row?.agent?.id || '—' }, { id: 'status', label: '状态', cell: row => operationalStatus(row?.status || 'ready') }], rows: visibleTargets, empty: '暂无可评测目标，请先完成 Agent Build。' }), h(OperationalPager, { page: targetPage, pageSize, total: targets.length, onChange: setTargetPage })) : null,
        error ? h('div', { role: 'alert', style: { color: BRAND.danger, marginTop: '10px', fontSize: '12px' } }, error) : null,
        selectedDetail) : null);
  }
  return EvaluationPage;
}
