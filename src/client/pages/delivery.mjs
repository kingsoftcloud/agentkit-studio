import { DEPLOYMENT_ATTENTION_STATES, DEPLOYMENT_LABELS, DEPLOYMENT_POLL_STATES, deliveryDate } from '../state/deployment.mjs';
import { BRAND as DEFAULT_BRAND, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';

export function createDeliveryPages({ ui, hostRemote, actions, window = globalThis.window, document = globalThis.document, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  const { React, Pill, StudioPageTabs, buttonStyle, inputStyle, EmptyState, SectionHeading, BRAND = DEFAULT_BRAND, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS } = ui;
  const { createElement: h, useEffect, useRef, useState } = React;
  function DeliveryStep({ number, title, detail, action }) {
    return h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      h('span', { 'aria-hidden': true, style: { display: 'grid', placeItems: 'center', width: '26px', height: '26px', borderRadius: '50%', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, number),
      h('div', { style: { flex: 1, minWidth: '180px' } }, h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '15px' } }, title), detail ? h('p', { style: { margin: '4px 0 0', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.5 } }, detail) : null), action);
  }

  function CloudDeploymentPanel({ agentId, selectedBuild, onBusyChange }) {
    const [preview, setPreview] = useState(null);
    const [requestKey, setRequestKey] = useState('');
    const [records, setRecords] = useState([]);
    const [spec, setSpec] = useState('2:2');
    const [storageGiB, setStorageGiB] = useState(20);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [deleting, setDeleting] = useState('');
    const [log, setLog] = useState(null);
    const [rollback, setRollback] = useState({});
    const [scope, setScope] = useState('current');
    const [showDeleted, setShowDeleted] = useState(false);
    const [page, setPage] = useState(1);
    const [details, setDetails] = useState({});
    const [target, setTarget] = useState('auto');
    const [useRecommendedImage, setUseRecommendedImage] = useState(true);
    const [recordsLoaded, setRecordsLoaded] = useState(false);
    const existing = records.filter(record => record.agentId === agentId && record.cloudAgentId && record.state !== 'DELETED').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const deploymentTarget = target === 'auto' ? existing[0]?.id || 'new' : target;
    const targetRecord = existing.find(record => record.id === deploymentTarget);
    const [cpu, ratio] = spec.split(':').map(Number);
    const resources = { cpu, memoryGiB: cpu * ratio, storageGiB };
    const inputKey = JSON.stringify([agentId, selectedBuild, spec, storageGiB, deploymentTarget, useRecommendedImage]);
    const latestInput = useRef(inputKey);
    latestInput.current = inputKey;
    const scopedRecords = records.filter(record => scope === 'all' || record.agentId === agentId);
    const visibleRecords = scopedRecords.filter(record => showDeleted || record.state !== 'DELETED').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const pageCount = Math.max(1, Math.ceil(visibleRecords.length / 5));
    const currentPage = Math.min(page, pageCount);
    const otherAttention = records.filter(record => record.agentId !== agentId && DEPLOYMENT_ATTENTION_STATES.has(record.state)).length;
    const updateRecord = record => setRecords(previous => [record, ...previous.filter(item => item.id !== record.id)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    useEffect(() => { setPreview(null); setRequestKey(''); setError(''); }, [agentId, selectedBuild, cpu, ratio, storageGiB, deploymentTarget, useRecommendedImage]);
    useEffect(() => { setPage(1); }, [scope, showDeleted, agentId]);
    useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
    useEffect(() => {
      let stopped = false, running = false;
      const poll = async () => {
        if (running) return;
        running = true;
        try {
          const result = await hostRemote.deployments();
          const rows = result.items || [];
          const next = await Promise.all(rows.map(async item => {
            if (!DEPLOYMENT_POLL_STATES.has(item.state)) return item;
            try { return await hostRemote.refreshDeployment(item.id); } catch { return item; }
          }));
          if (!stopped) { setRecords(next); setRecordsLoaded(true); }
        } catch (reason) { if (!stopped) setError(reason?.message || '部署记录读取失败'); }
        finally { running = false; }
      };
      void poll(); const timer = setInterval(poll, 5000);
      return () => { stopped = true; clearInterval(timer); };
    }, []);
    const inspect = async () => {
      if (!agentId || !selectedBuild || busy) return;
      if (deploymentTarget !== 'new') { if (targetRecord?.state === 'READY') await inspectUpdate(targetRecord); return; }
      setBusy(true); setError(''); setPreview(null); setNotice('正在检查冻结版本、资源凭证和部署位置…');
      try {
        const result = await hostRemote.prepareDeployment({ agentId, buildId: selectedBuild, resources });
        if (latestInput.current === inputKey) { setPreview(result); setRequestKey(`studio-deploy-${crypto.randomUUID()}`); }
        setNotice('');
      } catch (reason) { setError(reason?.message || '部署检查失败'); setNotice(''); }
      finally { setBusy(false); }
    };
    const inspectUpdate = async (record, rollbackVersionId) => {
      setBusy(true); setError(''); setPreview(null); setNotice('正在核对目标冻结版本…');
      try {
        const result = await hostRemote.prepareDeploymentUpdate({ deploymentId: record.id,
          ...(rollbackVersionId ? { rollbackVersionId } : { buildId: selectedBuild, useRecommendedImage }) });
        if (latestInput.current === inputKey) { setPreview(result); setRequestKey(`studio-update-${crypto.randomUUID()}`); } setNotice('');
      } catch (reason) { setError(reason?.message || '版本检查失败'); setNotice(''); }
      finally { setBusy(false); }
    };
    const deploy = async () => {
      if (!preview || busy) return;
      setBusy(true); setError('');
      try {
        const record = preview.deploymentId ? await hostRemote.applyDeploymentUpdate({ ...preview, idempotencyKey: requestKey })
          : await hostRemote.createDeployment(preview.buildId, { agentId: preview.agentId, bundleId: preview.bundleId,
          releaseId: preview.releaseId, previewId: preview.previewId, resources: preview.resources }, requestKey);
        updateRecord(record); setPreview(null); setNotice('部署已提交，进度会自动更新。');
      } catch (reason) { setError(reason?.message || '提交结果未确认，请保留当前页面并核对部署记录'); }
      finally { setBusy(false); }
    };
    const action = async (record, type) => {
      setBusy(true); setError('');
      try {
        if (type === 'logs') setLog({ name: record.agentName, ...(await hostRemote.deploymentLogs(record.id)) });
        else {
          const result = await (type === 'remove' ? hostRemote.removeDeployment : type === 'repairAccess' ? hostRemote.repairDeploymentAccess : type === 'reconcile' ? hostRemote.reconcileDeployment : hostRemote.refreshDeployment)(record.id);
          updateRecord(result); if (type === 'remove') setDeleting('');
        }
      } catch (reason) { setError(reason?.message || '部署操作失败'); }
      finally { setBusy(false); }
    };
    const section = { marginTop: '14px', padding: '18px', border: '1px solid ' + BRAND.border, borderRadius: '14px', background: BRAND.surface };
    const label = { display: 'grid', gap: '6px', fontSize: '12px', color: BRAND.inkMuted };
    return h(React.Fragment, null,
      h('section', { style: section, 'aria-label': '云端部署' },
      h(DeliveryStep, { number: '3', title: '检查并部署', detail: '选择更新已有实例或创建新实例，使用上方选中的冻结版本。' }),
      h('label', { style: { ...label, marginBottom: '14px' } }, '部署目标', h('select', { 'aria-label': '部署目标', value: deploymentTarget, disabled: busy, onChange: event => setTarget(event.target.value), style: inputStyle() },
        existing.map(record => h('option', { key: record.id, value: record.id }, `更新 ${record.agentName} · 版本 ${record.revision} · ${record.cloudAgentId}`)), h('option', { value: 'new' }, '创建新的云端实例'))),
      targetRecord ? h(React.Fragment, null,
        h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, '更新保留实例 ID、规格和存储。检查后确认冻结版本与镜像，新版本需开启新会话。'),
        h('label', { style: { ...label, display: 'flex', alignItems: 'center', marginBottom: '12px' } }, h('input', { type: 'checkbox', 'aria-label': '使用推荐运行镜像', checked: useRecommendedImage, disabled: busy, onChange: event => setUseRecommendedImage(event.target.checked) }), '使用当前推荐的运行镜像', h('span', null, `当前 ${targetRecord.imageVersion || '—'}`))) : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', alignItems: 'end' } },
        !targetRecord ? h(React.Fragment, null,
        h('label', { style: label }, '实例规格', h('select', { 'aria-label': '实例规格', value: spec, disabled: busy, onChange: event => setSpec(event.target.value), style: inputStyle() },
          h('optgroup', { label: '通用 · CPU / 内存 1:2' }, [1, 2, 4, 8, 16].map(value => h('option', { key: value, value: `${value}:2` }, `${value} 核 · ${value * 2} GB`))),
          h('optgroup', { label: '更多内存' }, [4, 8].flatMap(memoryRatio => [1, 2, 4, 8, 16].map(value => h('option', { key: `${value}:${memoryRatio}`, value: `${value}:${memoryRatio}` }, `${value} 核 · ${value * memoryRatio} GB`))))),
          h('span', { style: { fontSize: '11px' } }, '默认 2 核 4 GB，可按需调整')),
        h('label', { style: label }, '对话存储', h('select', { 'aria-label': '对话存储', value: storageGiB, disabled: busy, onChange: event => setStorageGiB(Number(event.target.value)), style: inputStyle() }, [20, 50, 100, 200, 500, 0].map(value => h('option', { key: value, value }, value ? `持久化 ${value} GiB` : '临时存储'))),
          h('span', { style: { fontSize: '11px' } }, storageGiB ? '实例重建后保留会话历史' : '实例重建后不保留会话历史'))) : null,
        h('div', { style: { alignSelf: 'center' } }, h('button', { type: 'button', disabled: busy || !recordsLoaded || !selectedBuild || (deploymentTarget !== 'new' && (!targetRecord || targetRecord.state !== 'READY' || (!useRecommendedImage && selectedBuild === targetRecord.buildId))), onClick: inspect, style: buttonStyle() }, busy ? '处理中…' : targetRecord ? '检查更新' : '检查部署'))),
      !selectedBuild ? h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, '请先构建或选择一个成功的版本。') : null,
      preview ? h('div', { style: { marginTop: '16px', padding: '16px', borderRadius: '10px', background: BRAND.canvas } },
        h('strong', { style: { color: BRAND.ink } }, `${preview.deploymentId ? preview.rollbackVersionId ? '确认回滚' : '确认升级' : '检查通过'} · ${preview.agentName} · 版本 ${preview.revision}`),
        h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, `${preview.environment === 'pre-online' ? '预发环境' : preview.environment} · ${preview.region} · ${preview.resources.cpu} 核 / ${preview.resources.memoryGiB} GB · 1 个实例`),
        h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, `运行时 ${preview.runtime} · 镜像 ${preview.image.version} · ${preview.resourceCounts.models} 个模型 / ${preview.resourceCounts.mcps} 个 MCP / ${preview.resourceCounts.skills} 个 Skill / ${preview.resourceCounts.remote} 个云端资源`),
        h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, preview.identity.kind === 'subaccount' ? `操作人：${preview.identity.userName}` : '操作人：主账号'),
        h('ul', { style: { fontSize: '12px', lineHeight: 1.7, color: BRAND.inkMuted, paddingLeft: '18px' } }, preview.warnings.map((warning, index) => h('li', { key: index }, warning))),
        h('button', { type: 'button', disabled: busy, onClick: deploy, style: { ...buttonStyle(), background: BRAND.primaryFill, color: BRAND.primaryText } }, preview.deploymentId ? preview.rollbackVersionId ? '确认回滚当前实例' : '确认升级当前实例' : '确认创建云端实例'),
        h('button', { type: 'button', disabled: busy, onClick: () => setPreview(null), style: { ...buttonStyle(), marginLeft: '8px' } }, '取消')) : null,
      notice ? h('p', { role: 'status', style: { fontSize: '12px', color: BRAND.inkMuted } }, notice) : null,
      error ? h('p', { role: 'alert', style: { fontSize: '12px', color: BRAND.danger } }, error) : null),
      h('section', { style: section, 'aria-label': '部署记录' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '12px' } },
        h('h3', { style: { margin: 0, fontSize: '15px', color: BRAND.ink } }, '部署记录'),
        h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: BRAND.inkMuted } }, h('input', { type: 'checkbox', checked: showDeleted, onChange: event => setShowDeleted(event.target.checked) }), `显示已删除（${scopedRecords.filter(record => record.state === 'DELETED').length}）`)),
      h(StudioPageTabs, { ariaLabel: '部署记录范围', value: scope, onChange: setScope, items: [{ id: 'current', label: '当前 Agent' }, { id: 'all', label: '全部 Agent' }] }),
      scope === 'current' && otherAttention ? h('p', { role: 'status', style: { fontSize: '12px', color: BRAND.inkMuted } }, `其他 Agent 有 ${otherAttention} 条部署需要处理。`, h('button', { type: 'button', onClick: () => setScope('all'), style: { ...buttonStyle(), marginLeft: '8px' } }, '查看全部')) : null,
      !visibleRecords.length ? h('p', { style: { padding: '16px 0', fontSize: '13px', color: BRAND.inkMuted } }, scopedRecords.length ? '暂无进行中的部署，可显示已删除记录查看历史。' : scope === 'current' ? '当前 Agent 尚未部署，检查通过后即可创建云端实例。' : '还没有云端部署。') : visibleRecords.slice((currentPage - 1) * 5, currentPage * 5).map(record => h('div', { key: record.id, style: { borderTop: '1px solid ' + BRAND.border, padding: '16px 0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' } },
          h('strong', { style: { fontSize: '13px', color: BRAND.ink } }, `${record.agentName} · 版本 ${record.revision}`), h(Pill, { tone: record.state === 'READY' ? 'accent' : record.state === 'DELETED' ? 'neutral' : 'signal' }, DEPLOYMENT_LABELS[record.state] || record.state)),
        h('p', { style: { fontSize: '12px', color: BRAND.inkMuted, lineHeight: 1.6 } }, `${record.environment === 'pre-online' ? '预发环境' : record.environment} · ${record.region} · ${record.resources?.cpu || '—'} 核 / ${record.resources?.memoryGiB || '—'} GB · ${deliveryDate(record.createdAt)}`),
        record.rollout ? h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, `${record.rollout.kind === 'rollback' ? '回滚' : '升级'}到 Revision ${record.rollout.revision} · ${record.rollout.status === 'SUCCEEDED' ? '入口版本已确认' : record.rollout.status === 'FAILED' ? '未提交成功' : '等待目标版本生效'}`) : null,
        record.failure ? h('p', { style: { fontSize: '12px', color: BRAND.danger } }, `${record.failure.code} · ${record.failure.message}`) : null,
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h('button', { type: 'button', 'aria-expanded': Boolean(details[record.id]), onClick: () => setDetails(previous => ({ ...previous, [record.id]: !previous[record.id] })), style: buttonStyle() }, details[record.id] ? '收起详情' : '详情'),
        record.state !== 'DELETED' ? h(React.Fragment, null,
          h('button', { type: 'button', disabled: busy, onClick: () => action(record, record.cloudAgentId ? 'refresh' : 'reconcile'), style: buttonStyle() }, record.cloudAgentId ? '刷新状态' : '核对创建结果'),
          ['READY', 'AVAILABLE_UPDATING'].includes(record.state) ? h('button', { type: 'button', disabled: busy, onClick: () => actions.bindAgent?.(record.cloudAgentId), style: buttonStyle() }, '开始对话') : null,
          record.state === 'READY' && record.agentId === agentId ? h('button', { type: 'button', disabled: busy || !selectedBuild || (!useRecommendedImage && selectedBuild === record.buildId), onClick: () => inspectUpdate(record), style: buttonStyle() }, '升级到所选版本') : null,
          record.state === 'READY' && (record.versions || []).some(version => version.id !== record.versionId) ? h('div', { style: { display: 'flex', gap: '6px' } },
            h('select', { 'aria-label': '回滚版本 ' + record.agentName, value: rollback[record.id] || '', disabled: busy, style: inputStyle(), onChange: event => setRollback(previous => ({ ...previous, [record.id]: event.target.value })) },
              h('option', { value: '' }, '选择历史版本'), record.versions.filter(version => version.id !== record.versionId).map(version => h('option', { key: version.id, value: version.id }, `Revision ${version.revision} · ${version.imageVersion} · ${version.completedAt}`))),
            h('button', { type: 'button', disabled: busy || !rollback[record.id], onClick: () => inspectUpdate(record, rollback[record.id]), style: buttonStyle() }, '检查回滚')) : null,
          record.cloudAgentId ? h('button', { type: 'button', disabled: busy, onClick: () => action(record, 'logs'), style: buttonStyle() }, '日志') : null,
          record.state === 'TOKEN_PENDING' && record.cloudStatus === 'RUNNING' && record.tokenBound === false ? h('button', { type: 'button', disabled: busy, onClick: () => action(record, 'repairAccess'), style: buttonStyle() }, '修复访问配置') : null,
          details[record.id] && record.cloudAgentId ? h('button', { type: 'button', disabled: busy, onClick: () => deleting === record.id ? action(record, 'remove') : setDeleting(record.id), style: { ...buttonStyle(), color: BRAND.danger } }, deleting === record.id ? '确认删除云端实例' : '删除') : null,
          deleting === record.id ? h('button', { type: 'button', onClick: () => setDeleting(''), style: buttonStyle() }, '取消') : null) : null),
        details[record.id] ? h('dl', { style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '8px 16px', padding: '14px', background: BRAND.canvas, borderRadius: '10px', fontSize: '12px', color: BRAND.inkMuted, overflowWrap: 'anywhere' } },
          h('dt', null, '云端 Agent'), h('dd', { style: { margin: 0 } }, record.cloudAgentId || record.name || '等待创建结果'),
          h('dt', null, '运行时'), h('dd', { style: { margin: 0 } }, RUNTIME_LABELS[record.runtime] || record.runtime),
          h('dt', null, '构建版本'), h('dd', { style: { margin: 0 } }, record.buildId),
          h('dt', null, '对话存储'), h('dd', { style: { margin: 0 } }, record.resources?.storageGiB ? `持久化 ${record.resources.storageGiB} GiB` : '临时存储')) : null)),
      pageCount > 1 ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '12px', marginTop: '12px', fontSize: '12px', color: BRAND.inkMuted } },
        h('span', null, `${visibleRecords.length} 条 · ${currentPage} / ${pageCount}`), h('button', { type: 'button', disabled: currentPage <= 1, onClick: () => setPage(currentPage - 1), style: buttonStyle() }, '上一页'), h('button', { type: 'button', disabled: currentPage >= pageCount, onClick: () => setPage(currentPage + 1), style: buttonStyle() }, '下一页')) : null,
      log ? h('div', { style: { marginTop: '12px' } }, h('strong', null, `${log.name} · 运行日志`), h('button', { type: 'button', onClick: () => setLog(null), style: buttonStyle() }, '关闭'), h('pre', { style: { padding: '12px', background: BRAND.canvas, maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '11px' } }, log.lines.join('\n') || '暂无日志')) : null));
  }

  function DeliveryPage() {
    const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
    const [agents, setAgents] = useState([]);
    const [deployments, setDeployments] = useState([]);
    const [operations, setOperations] = useState([]);
    const [selectedAgent, setSelectedAgent] = useState('');
    const [selectedBuild, setSelectedBuild] = useState('');
    const [region, setRegion] = useState('cn-beijing-6');
    const [environment, setEnvironment] = useState('production');
    const [status, setStatus] = useState('loading');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [historyLimit, setHistoryLimit] = useState(5);
    const [agentLoading, setAgentLoading] = useState(false);
    const [deploymentBusy, setDeploymentBusy] = useState(false);
    const agentRequest = useRef(0);

    const load = async (preferredAgent = selectedAgent) => {
      const request = ++agentRequest.current;
      setStatus('loading');
      setError('');
      try {
        const [agentResult, deploymentResult, operationResult] = await Promise.all([
          hostRemote.agents({ source: 'local', pageSize: 100 }), hostRemote.deployments(), hostRemote.operations(),
        ]);
        const nextAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
        if (request !== agentRequest.current) return;
        const nextAgent = preferredAgent && nextAgents.some(item => (item?.metadata?.id || item?.id) === preferredAgent)
          ? preferredAgent : (nextAgents[0]?.metadata?.id || nextAgents[0]?.id || '');
        setAgents(nextAgents);
        setSelectedAgent(nextAgent);
        setDeployments(Array.isArray(deploymentResult?.items) ? deploymentResult.items : []);
        setOperations(Array.isArray(operationResult?.items) ? operationResult.items : []);
        // The collection endpoint intentionally keeps list rows small and
        // does not include the revision/build history. Load the selected
        // agent detail before rendering Delivery; otherwise an agent with a
        // successful build is incorrectly shown as “0 个” and deployment
        // cannot be selected. This also gives the UI the same source of
        // truth as the build mutation route.
        const current = nextAgents.find(item => (item?.metadata?.id || item?.id) === nextAgent);
        const detail = nextAgent ? await hostRemote.agent(nextAgent) : null;
        if (request !== agentRequest.current) return;
        const builds = Array.isArray(detail?.builds) ? detail.builds : (Array.isArray(current?.builds) ? current.builds : []);
        if (nextAgent && detail) {
          setAgents(nextAgents.map(item => (item?.metadata?.id || item?.id) === nextAgent ? { ...item, ...detail } : item));
        }
        const readyBuild = [...builds].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
        setSelectedBuild(String(readyBuild?.id || ''));
        setStatus('ready');
      } catch (reason) {
        if (request !== agentRequest.current) return;
        setStatus('error');
        setError(reason?.message || '构建与部署状态不可用');
      }
    };
    useEffect(() => { void load(); return () => { agentRequest.current++; }; }, []);

    const currentAgent = agents.find(item => (item?.metadata?.id || item?.id) === selectedAgent);
    const builds = [...(Array.isArray(currentAgent?.builds) ? currentAgent.builds : [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const readyBuilds = builds.filter(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
    const deliveryBusy = saving || deploymentBusy;
    const visibleOperations = operations.filter(item => !item.resourceId || item.resourceId === selectedAgent);
    const canRunBuild = currentAgent?.metadata?.local === true;
    const idempotency = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const waitForOperation = async operationId => {
      if (!operationId) return null;
      const deadline = Date.now() + 10000;
      let latest = null;
      while (Date.now() < deadline) {
        const result = await hostRemote.operations();
        latest = (result?.items || []).find(item => item?.id === operationId) || latest;
        const state = String(latest?.status || '').toLowerCase();
        if (['succeeded', 'failed', 'cancelled'].includes(state)) return latest;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return latest;
    };
    const chooseAgent = event => {
      const request = ++agentRequest.current;
      const id = event.target.value;
      setSelectedAgent(id);
      setSelectedBuild('');
      setHistoryLimit(5); setError(''); setMessage(''); setAgentLoading(true);
      const nextAgent = agents.find(item => (item?.metadata?.id || item?.id) === id);
      const knownBuilds = Array.isArray(nextAgent?.builds) ? nextAgent.builds : [];
      const knownReady = [...knownBuilds].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
      if (knownReady) setSelectedBuild(String(knownReady.id || ''));
      // Agent list rows do not carry build history. Hydrate the newly
      // selected row so switching targets does not regress to an empty
      // deployment selector.
      void hostRemote.agent(id).then(detail => {
        if (request !== agentRequest.current) return;
        const detailBuilds = Array.isArray(detail?.builds) ? detail.builds : [];
        setAgents(previous => previous.map(item => (item?.metadata?.id || item?.id) === id ? { ...item, ...detail } : item));
        const ready = [...detailBuilds].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
        setSelectedBuild(String(ready?.id || ''));
      }).catch(reason => { if (request === agentRequest.current) setError(reason?.message || '版本读取失败，请重试'); })
        .finally(() => { if (request === agentRequest.current) setAgentLoading(false); });
    };
    const createBuild = async () => {
      if (!selectedAgent || saving) return;
      setSaving(true); setError(''); setMessage('');
      try {
        const detail = await hostRemote.agent(selectedAgent);
        const revision = Number(detail?.metadata?.revision || detail?.draft?.metadata?.revision || currentAgent?.metadata?.revision || 1);
        const result = await hostRemote.createBuild(selectedAgent, revision, idempotency('studio-build'));
        const operation = await waitForOperation(result?.operationId);
        if (String(operation?.status || '').toLowerCase() === 'failed') throw new Error(operation?.result?.message || 'Build 执行失败');
        if (String(operation?.status || '').toLowerCase() === 'cancelled') throw new Error('构建已取消');
        const buildId = operation?.result?.buildId || result?.buildId || result?.id || '';
        setMessage(buildId ? '构建完成，已选中新版本，可以检查部署。' : '构建已提交，正在等待 Host 完成');
        await load(selectedAgent);
      } catch (reason) { setError(reason?.message || 'Build 提交失败'); }
      finally { setSaving(false); }
    };
    const createDeployment = async () => {
      if (directServerMode || !selectedBuild || saving) return;
      setSaving(true); setError(''); setMessage('');
      try {
        const result = await hostRemote.createDeployment(selectedBuild, {
          target: { region: region.trim(), environment: environment.trim() },
          binding: {},
          release_policy: { strategy: 'rolling', approval: 'none' },
        }, idempotency('studio-deploy'));
        const operation = await waitForOperation(result?.operationId);
        if (String(operation?.status || '').toLowerCase() === 'failed') throw new Error(operation?.result?.message || '部署执行失败');
        setMessage(`部署已提交：${operation?.id || result?.operationId || result?.id || '等待异步完成'}`);
        await load(selectedAgent);
      } catch (reason) { setError(reason?.message || '部署提交失败'); }
      finally { setSaving(false); }
    };
    const cancel = async operationId => {
      try { await hostRemote.cancelOperation(operationId); await load(selectedAgent); }
      catch (reason) { setError(reason?.message || '取消操作失败'); }
    };
    const downloadBuild = async buildId => {
      setError('');
      try {
        const result = await hostRemote.downloadBuild(selectedAgent, buildId);
        // Use DSH's same-origin Fetch carrier, as its native session export
        // does. Embedded browser download managers may drop blob: URLs.
        const url = 'api/agentkit.build.download?' + new URLSearchParams({ agentId: selectedAgent, buildId });
        const link = document.createElement('a');
        link.href = url; link.download = result.filename;
        document.body.appendChild(link); link.click(); link.remove();
        setMessage(`已请求下载 ${result.filename}（${result.bytes} 字节），请查看浏览器或系统的下载提示。`);
      } catch (reason) { setError(reason?.message || '构建产物下载失败'); }
    };
    const exportPortableBuild = async buildId => {
      if (saving) return;
      setSaving(true); setError(''); setMessage('正在收集模型、MCP 配置与 Skill 文件…');
      try {
        const result = await hostRemote.exportPortableBuild(selectedAgent, buildId);
        const link = document.createElement('a');
        link.href = 'api/agentkit.build.download?' + new URLSearchParams({ agentId: selectedAgent, buildId, bundleId: result.bundleId });
        link.download = result.bundleId + '.zip';
        document.body.appendChild(link); link.click(); link.remove();
        const names = [...new Set((result.requirements || []).map(item => item.name))];
        setMessage(`已请求下载运行包：${result.modelCount} 个模型、${result.mcpCount} 个 MCP、${result.skillCount} 个 Skill。目标 Host 需配置：${names.join('、') || '无资源凭证'}。运行包不包含 Codex 登录与个人插件。`);
      } catch (reason) { setMessage(''); setError(reason?.message || '运行包导出失败'); }
      finally { setSaving(false); }
    };
    const buildRows = builds.length ? builds.slice(0, historyLimit).map(item => h('tr', { key: item.id, style: { borderBottom: '1px solid ' + BRAND.border } },
      h('td', { style: { padding: '10px 12px', color: BRAND.ink } }, h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap' } }, h('input', { type: 'radio', name: 'delivery-build', 'aria-label': `选择版本 ${item.revision} ${item.id.slice(-8)}`, checked: selectedBuild === item.id, disabled: deliveryBusy || agentLoading || String(item.status || '').toUpperCase() !== 'SUCCEEDED', onChange: () => setSelectedBuild(item.id) }), `版本 ${item.revision || '—'}`)),
      h('td', { style: { padding: '10px 12px', color: BRAND.inkMuted }, title: item.id }, `${deliveryDate(item.createdAt)} · ${item.id.slice(-8)}`),
      h('td', { style: { padding: '10px 12px' } }, h(Pill, { tone: String(item.status || '').toUpperCase() === 'SUCCEEDED' ? 'accent' : 'signal' }, String(item.status || '').toUpperCase() === 'SUCCEEDED' ? '构建成功' : item.status || 'UNKNOWN')),
      h('td', { style: { padding: '10px 12px', display: 'flex', gap: '6px' } }, canRunBuild && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', onClick: () => actions.bindAgent?.({ agentId: selectedAgent, buildId: item.id }), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '在新会话运行') : null, directServerMode && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', onClick: () => downloadBuild(item.id), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '下载定义 ZIP') : null, canRunBuild && directServerMode && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', disabled: saving, onClick: () => exportPortableBuild(item.id), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '导出运行包') : null))) : h('tr', null, h('td', { colSpan: 4, style: { padding: '18px 12px', color: BRAND.inkMuted } }, '当前 Agent 还没有 Build。'));
    return h('div', { style: { maxWidth: '1120px', margin: '0 auto' } },
      h(SectionHeading, { title: '构建与部署', detail: '选择 Agent 和版本，检查配置后发布到云端。' }),
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取交付状态', detail: '读取 Agent、Build、Deployment 和 Operation。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '交付状态不可用', detail: error, action: h('button', { type: 'button', onClick: () => load(), style: buttonStyle() }, '重新读取') }) : null,
      status === 'ready' ? h(React.Fragment, null,
        h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '18px', background: BRAND.surface } },
          h(DeliveryStep, { number: '1', title: '选择 Agent', detail: '仅展示本地创建的 Agent。' }),
          h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
            h('select', { 'aria-label': '目标 Agent', value: selectedAgent, onChange: chooseAgent, disabled: deliveryBusy, style: { ...inputStyle(), flex: '1 1 240px' } }, agents.length ? agents.map(item => { const id = item?.metadata?.id || item?.id; return h('option', { key: id, value: id }, item?.metadata?.name || item?.name || id); }) : h('option', { value: '' }, '暂无本地 Agent')),
            currentAgent ? h('span', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, `${RUNTIME_LABELS[currentAgent.spec?.runtime?.type] || 'Agent'} · 当前版本 ${currentAgent.metadata?.revision || '—'}`) : null)),
        h('section', { style: { marginTop: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '18px', background: BRAND.surface } },
          h(DeliveryStep, { number: '2', title: '选择构建版本', detail: '构建保存当前提示词、模型和资源绑定，部署后使用这个冻结版本。' }),
          h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
            h('label', { style: { flex: '1 1 240px' } }, h('select', { 'aria-label': '构建版本', value: selectedBuild, disabled: deliveryBusy || agentLoading || !readyBuilds.length, onChange: event => setSelectedBuild(event.target.value), style: inputStyle() }, h('option', { value: '' }, agentLoading ? '正在读取版本…' : readyBuilds.length ? '选择成功的版本' : '尚无构建版本'), readyBuilds.map((item, index) => h('option', { key: item.id, value: item.id }, `版本 ${item.revision} · ${deliveryDate(item.createdAt)}${index === 0 ? ' · 最新构建' : ''}`)))),
            h('button', { type: 'button', onClick: createBuild, disabled: deliveryBusy || agentLoading || !selectedAgent, style: buttonStyle() }, saving ? '构建中…' : '构建当前版本')),
          h('details', { style: { marginTop: '16px' } },
            h('summary', { style: { color: BRAND.inkMuted, fontSize: '12px', cursor: 'pointer' } }, `构建历史（${builds.length}）`),
            h('div', { style: { overflowX: 'auto', marginTop: '12px' } }, h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } }, h('thead', null, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas } }, ['版本', '构建时间', '状态', '操作'].map(label => h('th', { key: label, style: { padding: '10px 12px', fontWeight: 650 } }, label)))), h('tbody', null, buildRows))),
            builds.length > historyLimit ? h('button', { type: 'button', onClick: () => setHistoryLimit(historyLimit + 5), style: { ...buttonStyle(), marginTop: '12px' } }, '显示更多版本') : null)),
        directServerMode ? h(CloudDeploymentPanel, { key: selectedAgent, agentId: selectedAgent, selectedBuild: agentLoading ? '' : selectedBuild, onBusyChange: setDeploymentBusy }) : h('section', { style: { marginTop: '14px', display: 'grid', gap: '12px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
          h('div', { style: { color: BRAND.ink, fontWeight: 800, fontSize: '14px' } }, '部署已成功的 Build'),
          directServerMode ? h('div', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55, padding: '10px 12px', borderRadius: '9px', background: BRAND.canvas } }, '可导出运行包，在独立 Studio Host 中导入运行。包内包含导出时的模型、MCP 配置与 Skill 文件；目标环境需注入凭证，并能访问知识库、记忆库等远程服务。云端发布尚未接入。') : null,
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1fr 1fr auto', gap: '9px', alignItems: 'end' } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Build', h('select', { value: selectedBuild, onChange: event => setSelectedBuild(event.target.value), disabled: directServerMode, style: inputStyle() }, h('option', { value: '' }, readyBuilds.length ? '请选择 Build' : '暂无成功 Build'), readyBuilds.map(item => h('option', { key: item.id, value: item.id }, `${item.id} · Revision ${item.revision || '—'}`)))),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '区域', h('input', { value: region, onChange: event => setRegion(event.target.value), disabled: directServerMode, style: inputStyle() })),
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '环境', h('input', { value: environment, onChange: event => setEnvironment(event.target.value), disabled: directServerMode, style: inputStyle() })),
            h('button', { type: 'button', onClick: createDeployment, disabled: directServerMode || saving || !selectedBuild, style: { ...buttonStyle(), color: directServerMode || saving || !selectedBuild ? BRAND.inkMuted : BRAND.primaryText, background: directServerMode || saving || !selectedBuild ? BRAND.accentSoft : BRAND.primaryFill, borderColor: directServerMode || saving || !selectedBuild ? BRAND.border : 'transparent' } }, directServerMode ? '云端发布未接入' : '提交部署'))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginTop: '14px' } },
          !directServerMode ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '部署记录'), deployments.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, deployments.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, item.id || '—'), h(Pill, { tone: item.status === 'READY' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无部署记录。')) : null,
          h('details', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('summary', { style: { cursor: 'pointer', color: BRAND.inkMuted, fontSize: '12px' } }, '操作记录'), visibleOperations.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, visibleOperations.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `${item.kind || item.type || 'operation'} · ${item.status || 'UNKNOWN'}`), (directServerMode ? ['QUEUED'] : ['RUNNING', 'PENDING', 'ADMITTING', 'DEPLOYING']).includes(String(item.status || '').toUpperCase()) ? h('button', { type: 'button', onClick: () => cancel(item.id), style: { ...buttonStyle(), padding: '4px 7px', fontSize: '10px' } }, '取消') : null))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无操作记录。'))),
        message ? h('div', { role: 'status', style: { marginTop: '12px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
        error ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
      ) : null);
  }
  return { DeliveryStep, CloudDeploymentPanel, DeliveryPage };
}
