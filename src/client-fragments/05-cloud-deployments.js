    const DEPLOYMENT_LABELS = { PREPARED: '待提交', UPLOADING: '上传运行包', UPLOAD_UNKNOWN: '上传结果待核对', UPLOADED: '已上传', CREATING: '创建中', CREATE_UNKNOWN: '创建结果待核对', PROVISIONING: '准备实例', CONFIGURING: '配置访问令牌', TOKEN_PENDING: '等待配置生效', STARTING: '启动中', UPDATING: '切换版本 · 等待入口确认', UPDATE_UNKNOWN: '更新结果待核对', READY: '就绪', AVAILABLE_UPDATING: '入口可用 · 平台更新中', ACTION_REQUIRED: '需要处理', FAILED: '失败', DELETING: '删除中', DELETE_UNKNOWN: '删除结果待核对', DELETED: '已删除' };
    const DEPLOYMENT_POLL_STATES = new Set(['UPDATING', 'UPDATE_UNKNOWN', 'PROVISIONING', 'CONFIGURING', 'TOKEN_PENDING', 'STARTING', 'AVAILABLE_UPDATING', 'DELETING', 'DELETE_UNKNOWN']);
    const DEPLOYMENT_ATTENTION_STATES = new Set(['CREATE_UNKNOWN', 'UPLOAD_UNKNOWN', 'UPDATE_UNKNOWN', 'DELETE_UNKNOWN', 'ACTION_REQUIRED', 'FAILED', 'TOKEN_PENDING']);
    function deliveryDate(value) {
      const date = new Date(value);
      return value && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    }
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
          h('button', { type: 'button', disabled: busy, onClick: deploy, style: { ...buttonStyle(), background: BRAND.primaryFill, color: '#fff' } }, preview.deploymentId ? preview.rollbackVersionId ? '确认回滚当前实例' : '确认升级当前实例' : '确认创建云端实例'),
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
            ['READY', 'AVAILABLE_UPDATING'].includes(record.state) ? h('button', { type: 'button', disabled: busy, onClick: () => window.__AGENTKIT_STUDIO_BIND_AGENT__?.(record.cloudAgentId), style: buttonStyle() }, '开始对话') : null,
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
