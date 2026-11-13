import { createFormKit } from '../components/form-kit.mjs';
import { DEPLOYMENT_ATTENTION_STATES, DEPLOYMENT_LABELS, DEPLOYMENT_POLL_STATES, deliveryDate } from '../state/deployment.mjs';
import { BRAND as DEFAULT_BRAND, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';
import { consumeOperationsFocus } from '../operations-focus.mjs';

/**
 * Deployments always run on the platform's default persistent volume.
 *
 * The Server contract (agentengine.container-storage/v1) only accepts 20–500 GiB
 * on a daily plan, and the mounted home is the Agent's persistence root: state,
 * ~/.codex and the workspace all live there. Offering the choice only changed
 * the daily bill while a 临时存储 pick silently dropped conversation history, so
 * the page always asks for the 20 GiB floor and just states what it gets.
 */
export const DEPLOYMENT_STORAGE = Object.freeze({ storageGiB: 20, mountPath: '/home/node' });
const STORAGE_HELP = `固定 ${DEPLOYMENT_STORAGE.storageGiB} GiB 持久化云盘，挂载在运行容器的 ${DEPLOYMENT_STORAGE.mountPath}。Agent 状态、会话历史和工作区都在这个目录下，实例重建后仍然保留；按天计费，删除实例前请先备份需要留下的历史。`;
const storageSummary = resources => resources?.storageGiB ? `${resources.storageGiB} GiB · ${DEPLOYMENT_STORAGE.mountPath}` : '临时存储（重建后不保留历史）';

const deploymentCanUpdate = record => ['READY', 'STARTING', 'ACTION_REQUIRED'].includes(record?.state);
const SPEC_GROUPS = [
  ['通用 · CPU / 内存 1:2', [1, 2, 4, 8, 16].map(value => [`${value}:2`, `${value} 核 · ${value * 2} GB`])],
  ['更多内存', [4, 8].flatMap(memoryRatio => [1, 2, 4, 8, 16].map(value => [`${value}:${memoryRatio}`, `${value} 核 · ${value * memoryRatio} GB`]))],
];

export function createDeliveryPages({
  ui: { React: { createElement: h, useEffect, useRef, useState, Fragment }, Menu, MenuItemButton, Pill, StudioPageTabs, SectionHeading, EmptyState, BRAND = DEFAULT_BRAND, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS },
  hostRemote, actions, window = globalThis.window, document = globalThis.document, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval
}) {
  const { Section: FormSection, Row: FormRow, Select, Input, Button, Note: FormNote, Collapsible, Summary, Switch } = createFormKit({ React: { createElement: h } });
  const Row = ({ help, title, ...props }, ...children) => FormRow({ ...props, title: help ? h('span', { title: help }, title) : title, className: 'af-row studio-srow' }, ...children);
  const Note = (props, ...children) => FormNote({ title: children.every(child => typeof child === 'string') ? children.join('') : undefined, ...props }, ...children);
  const Section = ({ number, done, current, panel = true, help, ...props }, ...children) => FormSection({ ...props,
    title: number ? h(Fragment, null, h('span', { className: 'ad-step-number', 'data-done': done || undefined, 'data-current': current || undefined, 'aria-hidden': 'true' }, done ? '✓' : number), h('span', { title: help }, props.title)) : h('span', { title: help }, props.title),
    'data-delivery-step': number }, panel ? h('div', { className: 'ad-panel studio-panel' }, ...children) : children);
  const MenuAction = ({ onClick, ...props }, ...children) => h(MenuItemButton, { ...props, onSelect: onClick }, ...children);
  const MoreMenu = ({ id, open, onToggle, onClose }, ...children) => h(Menu, { open, onClose, align: 'end', portal: true, compact: true, listClassName: 'studio-menu',
    anchor: Button({ size: 'sm', variant: 'ghost', 'aria-label': `更多操作 ${id}`, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: onToggle }, '⋯') }, ...children);

  function CloudDeploymentPanel({ agentId, selectedBuild, onBusyChange, hasCurrentBuild = Boolean(selectedBuild) }) {
    const [preview, setPreview] = useState(null);
    const [requestKey, setRequestKey] = useState('');
    const [records, setRecords] = useState([]);
    const [spec, setSpec] = useState('2:2');
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
    const [recordMenu, setRecordMenu] = useState('');
    // Polling every 5s must not re-render the page when nothing changed; React
    // state updates keep the list stable across refreshes of an idle deployment.
    const recordsSignature = useRef('');
    const existing = records.filter(record => record.agentId === agentId && record.cloudAgentId && record.state !== 'DELETED').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const deploymentTarget = target === 'auto' ? existing[0]?.id || 'new' : target;
    const targetRecord = existing.find(record => record.id === deploymentTarget);
    const [cpu, ratio] = spec.split(':').map(Number);
    const resources = { cpu, memoryGiB: cpu * ratio, storageGiB: DEPLOYMENT_STORAGE.storageGiB };
    // Storage is fixed now, so it no longer takes part in the "inputs changed,
    // drop the stale check" signature.
    const inputKey = JSON.stringify([agentId, selectedBuild, spec, deploymentTarget, useRecommendedImage]);
    const latestInput = useRef(inputKey);
    latestInput.current = inputKey;
    const scopedRecords = records.filter(record => scope === 'all' || record.agentId === agentId);
    const visibleRecords = scopedRecords.filter(record => showDeleted || record.state !== 'DELETED').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const pageCount = Math.max(1, Math.ceil(visibleRecords.length / 5));
    const currentPage = Math.min(page, pageCount);
    const otherAttention = records.filter(record => record.agentId !== agentId && DEPLOYMENT_ATTENTION_STATES.has(record.state)).length;
    const updateRecord = record => setRecords(previous => [record, ...previous.filter(item => item.id !== record.id)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    useEffect(() => { setPreview(null); setRequestKey(''); setError(''); }, [agentId, selectedBuild, cpu, ratio, deploymentTarget, useRecommendedImage]);
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
          if (!stopped) {
            const signature = JSON.stringify(next);
            if (signature !== recordsSignature.current) { recordsSignature.current = signature; setRecords(next); }
            setRecordsLoaded(true);
          }
        } catch (reason) { if (!stopped) setError(reason?.message || '部署记录读取失败'); }
        finally { running = false; }
      };
      void poll(); const timer = setInterval(() => { if (!document.hidden) void poll(); }, 5000);
      return () => { stopped = true; clearInterval(timer); };
    }, []);
    const inspect = async () => {
      if (!agentId || !selectedBuild || busy) return;
      if (deploymentTarget !== 'new') { if (deploymentCanUpdate(targetRecord)) await inspectUpdate(targetRecord); return; }
      setBusy(true); setError(''); setPreview(null); setNotice('正在检查冻结版本、资源凭证和部署位置…');
      try {
        const result = await hostRemote.prepareDeployment({ agentId, buildId: selectedBuild, deploymentType: 'ManagedRuntime', resources });
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
          deploymentType: 'ManagedRuntime', bundleUploadId: preview.bundleUploadId, releaseId: preview.releaseId, previewId: preview.previewId, resources: preview.resources }, requestKey);
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
    const previewTitle = preview ? `${preview.deploymentId ? preview.rollbackVersionId ? '确认回滚' : '确认升级' : '检查通过'} · ${preview.agentName} · 版本 ${preview.revision}` : '';
    const previewRows = preview ? [
      ['部署位置', `${preview.environment === 'pre-online' ? '预发环境' : preview.environment} · ${preview.region}`],
      ['实例规格', `${preview.resources.cpu} 核 / ${preview.resources.memoryGiB} GB · 1 个实例`],
      ['对话存储', storageSummary(preview.resources)],
      ['运行时', `${preview.runtime} · 当前镜像 ${targetRecord?.imageVersion || '—'}`],
      // The immutable image tag and digest are the deployment identity an
      // operator checks before an upgrade rolls a frozen version.
      ['目标运行镜像', `${preview.image.version || '—'}${preview.image.digest ? ` · ${preview.image.digest}` : ''}`],
      ['已绑定资源', `${preview.resourceCounts.models} 个模型 · ${preview.resourceCounts.mcps} 个 MCP · ${preview.resourceCounts.skills} 个 Skill · ${preview.resourceCounts.remote} 个云端资源`],
      ['操作人', preview.identity.kind === 'subaccount' ? preview.identity.userName : '主账号'],
    ] : [];
    return h(Fragment, null,
      Section({ id: 'sec-deploy', 'data-delivery-section': 'deploy', number: 2, done: existing.length > 0 && hasCurrentBuild, current: Boolean(selectedBuild) && hasCurrentBuild && !existing.length,
          title: '部署', className: !selectedBuild ? 'ad-step-dimmed' : undefined, meta: !selectedBuild ? '构建成功后可以部署' : undefined, help: '更新已有实例会保留实例 ID、规格和存储；创建新实例时按下面的规格新建。' },
        Row({ title: '部署到', desc: targetRecord ? `更新「${targetRecord.agentName}」的当前实例` : '创建新的云端实例' },
          Select({ 'aria-label': '部署目标', value: deploymentTarget, disabled: busy, onChange: event => setTarget(event.target.value) },
            existing.map(record => h('option', { key: record.id, value: record.id }, `更新 ${record.agentName} · 版本 ${record.revision} · ${record.cloudAgentId}`)),
            h('option', { value: 'new' }, '创建新的云端实例'))),
        targetRecord
          ? Row({ title: '运行镜像', desc: `当前 ${targetRecord.imageVersion || '—'}` },
            Switch({ 'aria-label': '使用推荐运行镜像', label: '使用当前推荐的运行镜像', checked: useRecommendedImage, disabled: busy, onChange: event => setUseRecommendedImage(event.target.checked) }))
          : Row({ title: '实例规格', desc: '默认 2 核 4 GB，可按需调整' },
            Select({ 'aria-label': '实例规格', value: spec, disabled: busy, onChange: event => setSpec(event.target.value) },
              SPEC_GROUPS.map(([label, options]) => h('optgroup', { key: label, label }, options.map(([value, text]) => h('option', { key: value, value }, text)))))),
        targetRecord ? Row({ title: '实例规格' }, h('span', { className: 'ad-value' }, `${targetRecord.resources?.cpu || '—'} 核 / ${targetRecord.resources?.memoryGiB || '—'} GB`)) : null,
        !targetRecord ? Row({ title: '运行镜像' }, h('span', { className: 'ad-value' }, preview?.image?.version || '检查部署后显示')) : null,
        Row({ title: '对话存储', help: STORAGE_HELP, desc: '不再提供选择，实例重建后仍保留会话历史' },
          h('span', { className: 'ad-value' }, `${DEPLOYMENT_STORAGE.storageGiB} GiB 持久化云盘`,
            h('span', { className: 'ad-value-sub' }, `挂载 ${DEPLOYMENT_STORAGE.mountPath} · 按天计费`))),
        h('div', { className: 'studio-cfoot' },
          Button({ variant: selectedBuild && hasCurrentBuild && !existing.length && !preview ? 'primary' : 'outline', disabled: busy || !recordsLoaded || !selectedBuild || (deploymentTarget !== 'new' && (!deploymentCanUpdate(targetRecord) || (!useRecommendedImage && selectedBuild === targetRecord.buildId))), onClick: inspect },
            busy ? '处理中…' : targetRecord ? '检查更新' : '检查部署')),
        notice ? Note({ role: 'status' }, notice) : null,
        error ? Note({ role: 'alert', tone: 'danger' }, error) : null),
      preview ? h('section', { className: 'ad-preview', 'aria-label': '部署检查结果' },
        h('div', { className: 'ad-preview-head' }, h('strong', null, previewTitle)),
        h('ul', { className: 'ad-checks' }, ['冻结版本', '资源凭证', '部署位置与配额'].map(label => h('li', { key: label }, h('span', { className: 'studio-st', 'data-tone': 'ok' }, label)))),
        Summary({ rows: previewRows }),
        preview.warnings.length ? h('ul', { className: 'ad-warnings' }, preview.warnings.map((warning, index) => h('li', { key: index, title: warning }, warning))) : null,
        h('div', { className: 'studio-cfoot' },
          Button({ variant: 'ghost', disabled: busy, onClick: () => setPreview(null) }, '取消'),
          Button({ variant: hasCurrentBuild && !existing.length ? 'primary' : 'outline', disabled: busy, onClick: deploy }, preview.deploymentId ? preview.rollbackVersionId ? '确认回滚当前实例' : '确认升级当前实例' : '确认创建云端实例'))) : null,
      Section({ id: 'sec-records', 'data-delivery-section': 'records', number: 3, current: existing.length > 0 && hasCurrentBuild, panel: false, title: '云端实例', meta: `${visibleRecords.length} 条`, help: '部署进度每 5 秒自动刷新，页面切到后台时暂停轮询。',
          action: h('div', { className: 'ad-record-header-actions' }, Switch({ 'aria-label': '显示已删除的部署记录', label: `显示已删除（${scopedRecords.filter(record => record.state === 'DELETED').length}）`, checked: showDeleted, onChange: event => setShowDeleted(event.target.checked) }), h('div', { className: 'ad-record-scope' }, h(StudioPageTabs, { ariaLabel: '部署记录范围', value: scope, onChange: setScope, items: [{ id: 'current', label: '当前 Agent' }, { id: 'all', label: '全部' }] }))) },
        scope === 'current' && otherAttention
          ? Note({ role: 'status' }, `其他 Agent 有 ${otherAttention} 条部署需要处理。`, Button({ size: 'sm', onClick: () => setScope('all') }, '查看全部'))
          : null,
        !visibleRecords.length
          ? Note(null, scopedRecords.length ? '暂无进行中的部署，可显示已删除记录查看历史。' : scope === 'current' ? '当前 Agent 尚未部署，检查通过后即可创建云端实例。' : '还没有云端部署。')
          : h('div', { className: 'ad-table-scroll' }, h('table', { className: 'studio-tbl ad-records-table' },
            h('thead', null, h('tr', null, ['实例', '版本', '状态', '部署位置与规格', '操作'].map(label => h('th', { key: label }, label)))),
            h('tbody', null, visibleRecords.slice((currentPage - 1) * 5, currentPage * 5).map(record => h(Fragment, { key: record.id },
            h('tr', null,
              h('td', null, h('strong', { className: 'ad-record-title' }, record.agentName)),
              h('td', null, `版本 ${record.revision}`),
              h('td', null, h('span', { className: 'studio-st', 'data-tone': record.state === 'READY' ? 'ok' : record.failure ? 'err' : record.state === 'DELETED' ? 'neutral' : 'run' }, DEPLOYMENT_LABELS[record.state] || record.state)),
              h('td', null, h('span', { className: 'ad-record-meta' }, `${record.environment === 'pre-online' ? '预发环境' : record.environment} · ${record.region} · ${record.resources?.cpu || '—'} 核 / ${record.resources?.memoryGiB || '—'} GB · 镜像 ${record.imageVersion || '—'} · ${deliveryDate(record.createdAt)}`)),
              h('td', null, h('div', { className: 'ad-record-actions' },
                record.state !== 'DELETED' ? h(Fragment, null,
                  Button({ size: 'sm', variant: 'ghost', disabled: busy, onClick: () => action(record, record.cloudAgentId ? 'refresh' : 'reconcile') }, record.cloudAgentId ? '刷新状态' : '核对创建结果'),
                  ['READY', 'AVAILABLE_UPDATING'].includes(record.state) ? Button({ size: 'sm', variant: 'ghost', disabled: busy, onClick: () => actions.bindAgent?.(record.cloudAgentId) }, '开始对话') : null) : null,
                MoreMenu({ id: record.id, open: recordMenu === record.id, onToggle: () => setRecordMenu(recordMenu === record.id ? '' : record.id), onClose: () => setRecordMenu('') },
                  MenuAction({ 'aria-expanded': Boolean(details[record.id]), onClick: () => setDetails(previous => ({ ...previous, [record.id]: !previous[record.id] })) }, details[record.id] ? '收起详情' : '详情'),
                  record.state !== 'DELETED' ? h(Fragment, null,
                deploymentCanUpdate(record) && record.agentId === agentId ? MenuAction({ disabled: busy || !selectedBuild || (!useRecommendedImage && selectedBuild === record.buildId), onClick: () => inspectUpdate(record) }, record.state === 'READY' ? '升级到所选版本' : '用所选版本修复') : null,
                record.state === 'READY' && (record.versions || []).some(version => version.id !== record.versionId)
                  ? h(Fragment, null,
                    Select({ size: 'sm', className: 'ad-rollback-picker', 'aria-label': '回滚版本 ' + record.agentName, value: rollback[record.id] || '', disabled: busy, onChange: event => setRollback(previous => ({ ...previous, [record.id]: event.target.value })) },
                      h('option', { value: '' }, '选择历史版本'), record.versions.filter(version => version.id !== record.versionId).map(version => h('option', { key: version.id, value: version.id }, `Revision ${version.revision} · ${version.imageVersion} · ${version.completedAt}`))),
                    MenuAction({ disabled: busy || !rollback[record.id], onClick: () => inspectUpdate(record, rollback[record.id]) }, '检查回滚'))
                  : null,
                record.cloudAgentId ? MenuAction({ disabled: busy, onClick: () => action(record, 'logs') }, '日志') : null,
                record.state === 'TOKEN_PENDING' && record.cloudStatus === 'RUNNING' && record.tokenBound === false ? MenuAction({ disabled: busy, onClick: () => action(record, 'repairAccess') }, '修复访问配置') : null,
                details[record.id] && record.cloudAgentId ? MenuAction({ disabled: busy, onClick: () => deleting === record.id ? action(record, 'remove') : setDeleting(record.id) }, deleting === record.id ? '确认删除云端实例' : '删除') : null,
                deleting === record.id ? MenuAction({ onClick: () => setDeleting('') }, '取消') : null) : null)))),
            record.rollout || record.failure || details[record.id] ? h('tr', { className: 'ad-record-detail' }, h('td', { colSpan: 5 },
            record.rollout ? Note(null, `${record.rollout.kind === 'rollback' ? '回滚' : '升级'}到 Revision ${record.rollout.revision} · ${record.rollout.status === 'SUCCEEDED' ? '入口版本已确认' : record.rollout.status === 'FAILED' ? '未提交成功' : '等待目标版本生效'}`) : null,
            record.failure ? Note({ tone: 'danger' }, `${record.failure.code} · ${record.failure.message}`) : null,
            details[record.id] ? h('dl', { className: 'ad-detail' },
              h('dt', null, '云端 Agent'), h('dd', null, record.cloudAgentId || record.name || '等待创建结果'),
              h('dt', null, '运行时'), h('dd', null, RUNTIME_LABELS[record.runtime] || record.runtime),
              h('dt', null, '运行镜像'), h('dd', null, `${record.imageVersion || '—'}${record.imageDigest ? ` · ${record.imageDigest}` : ''}`),
              h('dt', null, '构建版本'), h('dd', null, record.buildId),
              h('dt', null, '对话存储'), h('dd', null, storageSummary(record.resources))) : null)) : null))))),
        pageCount > 1 ? h('div', { className: 'ad-pager' },
          h('span', null, `${visibleRecords.length} 条 · ${currentPage} / ${pageCount}`),
          h('div', { className: 'ad-pager-actions' },
            Button({ size: 'sm', disabled: currentPage <= 1, onClick: () => setPage(currentPage - 1) }, '上一页'),
            Button({ size: 'sm', disabled: currentPage >= pageCount, onClick: () => setPage(currentPage + 1) }, '下一页'))) : null,
        log ? h('div', { className: 'ad-list', style: { marginTop: '12px' } },
          h('div', { className: 'ad-record-head', style: { padding: '12px 16px' } }, h('strong', { className: 'ad-record-title' }, `${log.name} · 运行日志`), Button({ size: 'sm', onClick: () => setLog(null) }, '关闭')),
          h('pre', { className: 'ad-log' }, log.lines.join('\n') || '暂无日志')) : null));
  }

  function DeliveryPage({ focus } = {}) {
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
    const pageElement = useRef(null);
    const [loadedFocus, setLoadedFocus] = useState(null);
    const [buildMenu, setBuildMenu] = useState('');

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
        setLoadedFocus(focus);
        setStatus('ready');
      } catch (reason) {
        if (request !== agentRequest.current) return;
        setStatus('error');
        setError(reason?.message || '构建与部署状态不可用');
      }
    };
    useEffect(() => { void load(focus?.agentId); return () => { agentRequest.current++; }; }, [focus]);
    useEffect(() => {
      if (!focus || loadedFocus !== focus || status !== 'ready') return;
      consumeOperationsFocus(window, focus);
      if (selectedAgent !== focus.agentId) return;
      const section = pageElement.current?.querySelector(`[data-delivery-section="${focus.section}"]`);
      section?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      section?.classList.add('studio-focus-highlight');
      const timer = setTimeout(() => section?.classList.remove('studio-focus-highlight'), 1500);
      return () => { clearTimeout(timer); section?.classList.remove('studio-focus-highlight'); };
    }, [focus, loadedFocus, status, selectedAgent]);

    const currentAgent = agents.find(item => (item?.metadata?.id || item?.id) === selectedAgent);
    const builds = [...(Array.isArray(currentAgent?.builds) ? currentAgent.builds : [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const readyBuilds = builds.filter(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
    const hasCurrentBuild = readyBuilds.some(item => Number(item.revision || 1) === Number(currentAgent?.metadata?.revision || 1));
    const hasLiveDeployment = deployments.some(item => item.agentId === selectedAgent && !['DELETED', 'FAILED', 'CANCELLED'].includes(item.state || item.status));
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
    const buildRows = builds.length
      ? builds.slice(0, historyLimit).map(item => {
        const succeeded = String(item.status || '').toUpperCase() === 'SUCCEEDED';
        return h('tr', { key: item.id, 'data-selected': selectedBuild === item.id ? 'true' : undefined },
          h('td', null, h('label', { className: 'ad-radio' },
            h('input', { type: 'radio', name: 'delivery-build', 'aria-label': `选择版本 ${item.revision} ${item.id.slice(-8)}`, checked: selectedBuild === item.id, disabled: deliveryBusy || agentLoading || !succeeded, onChange: () => setSelectedBuild(item.id) }),
            `版本 ${item.revision || '—'}`)),
          h('td', { title: item.id }, `${deliveryDate(item.createdAt)} · ${item.id.slice(-8)}`),
          h('td', null, h('span', { className: 'studio-st', 'data-tone': succeeded ? 'ok' : String(item.status).toUpperCase() === 'FAILED' ? 'err' : 'neutral' }, succeeded ? '构建成功' : item.status || 'UNKNOWN')),
          h('td', null, h('div', { className: 'ad-table-cell-actions' },
            canRunBuild && succeeded ? Button({ size: 'sm', variant: 'ghost', onClick: () => actions.bindAgent?.({ agentId: selectedAgent, buildId: item.id }) }, '在新会话运行') : null,
            directServerMode && succeeded ? MoreMenu({ id: item.id, open: buildMenu === item.id, onToggle: () => setBuildMenu(buildMenu === item.id ? '' : item.id), onClose: () => setBuildMenu('') },
              MenuAction({ onClick: () => downloadBuild(item.id) }, '下载定义 ZIP'),
              canRunBuild ? MenuAction({ disabled: saving, onClick: () => exportPortableBuild(item.id) }, '导出运行包') : null) : null)));
      })
      : h('tr', null, h('td', { colSpan: 4 }, Note(null, '当前 Agent 还没有 Build。')));
    return h('div', { 'data-studio-delivery': 'true', ref: pageElement },
      status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取交付状态', detail: '读取 Agent、Build、Deployment 和 Operation。' }) : null,
      status === 'error' ? h(EmptyState, { icon: '!', title: '交付状态不可用', detail: error, action: Button({ onClick: () => load() }, '重新读取') }) : null,
      status === 'ready' ? h(Fragment, null,
        h('div', { className: 'ad-subject studio-row' },
          h('span', { className: 'studio-tile', 'aria-hidden': 'true' }, '✦'),
          h('div', { className: 'studio-row-main' },
            h('div', { className: 'studio-row-title' }, currentAgent?.metadata?.name || currentAgent?.name || selectedAgent || '暂无本地 Agent', h('code', { className: 'studio-row-id' }, selectedAgent)),
            currentAgent ? h('div', { className: 'studio-row-meta' }, `${RUNTIME_LABELS[currentAgent.spec?.runtime?.type] || currentAgent.spec?.runtime?.type || 'Agent'} · 当前配置 r${currentAgent.metadata?.revision || '—'}`) : null),
          Select({ className: 'ad-agent-picker', 'aria-label': '目标 Agent', value: selectedAgent, onChange: chooseAgent, disabled: deliveryBusy },
            agents.length ? agents.map(item => { const id = item?.metadata?.id || item?.id; return h('option', { key: id, value: id }, item?.metadata?.name || item?.name || id); }) : h('option', { value: '' }, '暂无本地 Agent'))),
        Section({ id: 'sec-build', 'data-delivery-section': 'build', number: 1, done: hasCurrentBuild, current: !hasCurrentBuild, title: '构建', meta: builds.length ? `${builds.length} 个构建` : '尚未构建', help: '构建保存当前提示词、模型和资源绑定；部署使用这个冻结版本。' },
          Row({ title: hasCurrentBuild ? `当前配置 r${currentAgent?.metadata?.revision || 1} 已构建` : readyBuilds.length ? `配置已更新到 r${currentAgent?.metadata?.revision || 1}` : '尚未构建' },
            Button({ variant: hasCurrentBuild ? 'outline' : 'primary', className: 'ad-build-primary', onClick: createBuild, disabled: deliveryBusy || agentLoading || !selectedAgent }, saving ? '构建中…' : hasCurrentBuild ? '重新构建' : '构建当前版本')),
          Row({ title: '冻结版本', desc: agentLoading ? '正在读取版本…' : readyBuilds.length ? '只列出构建成功的版本' : '尚无成功的构建' },
            Select({ 'aria-label': '构建版本', value: selectedBuild, disabled: deliveryBusy || agentLoading || !readyBuilds.length, onChange: event => setSelectedBuild(event.target.value) },
              h('option', { value: '' }, agentLoading ? '正在读取版本…' : readyBuilds.length ? '选择成功的版本' : '尚无构建版本'),
              readyBuilds.map((item, index) => h('option', { key: item.id, value: item.id }, `版本 ${item.revision} · ${deliveryDate(item.createdAt)}${index === 0 ? ' · 最新构建' : ''}`)))),
          builds.length ? Collapsible({ summary: `构建历史 · ${builds.length} 个版本` },
            h('div', { style: { overflowX: 'auto' } },
              h('table', { className: 'studio-tbl ad-table' },
                h('thead', null, h('tr', null, ['版本', '构建时间', '状态', '操作'].map(label => h('th', { key: label }, label)))),
                h('tbody', null, buildRows))),
            builds.length > historyLimit ? Button({ size: 'sm', style: { marginTop: '12px' }, onClick: () => setHistoryLimit(historyLimit + 5) }, '显示更多版本') : null) : null),
        directServerMode
          ? h(CloudDeploymentPanel, { key: selectedAgent, agentId: selectedAgent, selectedBuild: agentLoading ? '' : selectedBuild, hasCurrentBuild, onBusyChange: setDeploymentBusy })
          : h(Fragment, null, Section({ id: 'sec-deploy', 'data-delivery-section': 'deploy', number: 2, done: hasLiveDeployment && hasCurrentBuild, current: hasCurrentBuild && !hasLiveDeployment, title: '部署', className: !selectedBuild ? 'ad-step-dimmed' : undefined, meta: !selectedBuild ? '构建成功后可以部署' : undefined, help: '当前 Host 没有连接 AgentEngine Server，云端发布不可用；已构建的版本仍可导出运行包或在独立 Host 中运行。' },
            Row({ title: 'Build' }, Select({ value: selectedBuild, onChange: event => setSelectedBuild(event.target.value), disabled: directServerMode }, h('option', { value: '' }, readyBuilds.length ? '请选择 Build' : '暂无成功 Build'), readyBuilds.map(item => h('option', { key: item.id, value: item.id }, `${item.id} · Revision ${item.revision || '—'}`)))),
            Row({ title: '区域' }, Input({ value: region, onChange: event => setRegion(event.target.value), disabled: directServerMode })),
            Row({ title: '环境' }, Input({ value: environment, onChange: event => setEnvironment(event.target.value), disabled: directServerMode })),
            h('div', { className: 'studio-cfoot' }, Button({ variant: hasCurrentBuild && !hasLiveDeployment ? 'primary' : 'outline', onClick: createDeployment, disabled: directServerMode || saving || !selectedBuild }, saving ? '提交中…' : '提交部署'))),
          Section({ id: 'sec-records', 'data-delivery-section': 'records', number: 3, current: hasLiveDeployment && hasCurrentBuild, title: '云端实例', panel: false },
            deployments.length
              ? h('table', { className: 'studio-tbl ad-local-records' },
                h('thead', null, h('tr', null, h('th', null, '实例'), h('th', null, '状态'))),
                h('tbody', null, deployments.slice(0, 8).map(item => h('tr', { key: item.id },
                  h('td', null, item.id || '—'), h('td', null, h('span', { className: 'studio-st', 'data-tone': item.status === 'READY' ? 'ok' : 'neutral' }, item.status || 'UNKNOWN'))))))
              : Note(null, '暂无部署记录。'),
            Collapsible({ summary: `操作记录（${visibleOperations.length}）` },
              visibleOperations.length
                ? h('div', { className: 'ad-list' }, visibleOperations.slice(0, 8).map(item => h('div', { key: item.id, className: 'ad-record' },
                  h('div', { className: 'ad-record-head' },
                    h('span', { className: 'ad-record-meta', style: { margin: 0 } }, `${item.kind || item.type || 'operation'} · ${item.status || 'UNKNOWN'}`),
                    (directServerMode ? ['QUEUED'] : ['RUNNING', 'PENDING', 'ADMITTING', 'DEPLOYING']).includes(String(item.status || '').toUpperCase())
                      ? Button({ size: 'sm', onClick: () => cancel(item.id) }, '取消') : null))))
                : Note(null, '暂无操作记录。')))),
        message ? Note({ role: 'status' }, message) : null,
        error ? Note({ role: 'alert', tone: 'danger' }, error) : null,
      ) : null);
  }

  return { CloudDeploymentPanel, DeliveryPage };
}
