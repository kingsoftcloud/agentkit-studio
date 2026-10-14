import { operationalCollection, operationalDate, operationalId, operationalLabel } from '../state/operational-data.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createObservabilityPage({ ui, hostRemote, window = globalThis.window, document = globalThis.document }) {
  const { React, EmptyState, Metric, OperationalBars, OperationalPageHeading, OperationalPager, OperationalTable, OperationalToolbar, Pill, ResourceDialog, StudioPageTabs, buttonStyle, inputStyle, operationalStatus, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h, useEffect, useState } = React;
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
  return { ObservabilityPage };
}
