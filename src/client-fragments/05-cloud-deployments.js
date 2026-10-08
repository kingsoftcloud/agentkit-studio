    const DEPLOYMENT_LABELS = { PREPARED: '待提交', UPLOADING: '上传运行包', UPLOAD_UNKNOWN: '上传结果待核对', UPLOADED: '已上传', CREATING: '创建中', CREATE_UNKNOWN: '创建结果待核对', PROVISIONING: '准备实例', CONFIGURING: '配置访问令牌', TOKEN_PENDING: '等待配置生效', STARTING: '启动中', UPDATING: '切换版本 · 等待入口确认', UPDATE_UNKNOWN: '更新结果待核对', READY: '就绪', AVAILABLE_UPDATING: '入口可用 · 平台更新中', ACTION_REQUIRED: '需要处理', FAILED: '失败', DELETING: '删除中', DELETE_UNKNOWN: '删除结果待核对', DELETED: '已删除' };
    const DEPLOYMENT_POLL_STATES = new Set(['UPDATING', 'UPDATE_UNKNOWN', 'PROVISIONING', 'CONFIGURING', 'TOKEN_PENDING', 'STARTING', 'AVAILABLE_UPDATING', 'DELETING', 'DELETE_UNKNOWN']);
    function CloudDeploymentPanel({ agentId, builds, selectedBuild, onBuildChange }) {
      const [preview, setPreview] = useState(null);
      const [requestKey, setRequestKey] = useState('');
      const [records, setRecords] = useState([]);
      const [cpu, setCpu] = useState(2);
      const [ratio, setRatio] = useState(4);
      const [storageGiB, setStorageGiB] = useState(20);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [deleting, setDeleting] = useState('');
      const [log, setLog] = useState(null);
      const [rollback, setRollback] = useState({});
      const resources = { cpu, memoryGiB: cpu * ratio, storageGiB };
      const updateRecord = record => setRecords(previous => [record, ...previous.filter(item => item.id !== record.id)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
      useEffect(() => { setPreview(null); setRequestKey(''); setError(''); }, [agentId, selectedBuild, cpu, ratio, storageGiB]);
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
            if (!stopped) setRecords(next);
          } catch (reason) { if (!stopped) setError(reason?.message || '部署记录读取失败'); }
          finally { running = false; }
        };
        void poll(); const timer = setInterval(poll, 5000);
        return () => { stopped = true; clearInterval(timer); };
      }, []);
      const inspect = async () => {
        if (!agentId || !selectedBuild || busy) return;
        setBusy(true); setError(''); setPreview(null); setNotice('正在检查冻结版本、资源凭证和部署位置…');
        try {
          const result = await hostRemote.prepareDeployment({ agentId, buildId: selectedBuild, resources });
          setPreview(result); setRequestKey(`studio-deploy-${crypto.randomUUID()}`); setNotice('');
        } catch (reason) { setError(reason?.message || '部署检查失败'); setNotice(''); }
        finally { setBusy(false); }
      };
      const inspectUpdate = async (record, rollbackVersionId) => {
        setBusy(true); setError(''); setPreview(null); setNotice('正在核对目标冻结版本…');
        try {
          const result = await hostRemote.prepareDeploymentUpdate({ deploymentId: record.id,
            ...(rollbackVersionId ? { rollbackVersionId } : { buildId: selectedBuild }) });
          setPreview(result); setRequestKey(`studio-update-${crypto.randomUUID()}`); setNotice('');
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
      return h('section', { style: section, 'aria-label': '云端部署' },
        h('h3', { style: { margin: '0 0 6px', fontSize: '16px', color: BRAND.ink } }, '部署到云端'),
        h('p', { style: { margin: '0 0 16px', fontSize: '12px', color: BRAND.inkMuted } }, '使用已冻结的版本和绑定资源。部署位置跟随设置中的云端环境。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) 100px 120px auto', gap: '12px', alignItems: 'end' } },
          h('label', { style: label }, '构建版本', h('select', { 'aria-label': '云端构建版本', value: selectedBuild, disabled: busy, onChange: event => onBuildChange(event.target.value), style: inputStyle() }, h('option', { value: '' }, '选择 Build'), builds.map(item => h('option', { key: item.id, value: item.id }, `Revision ${item.revision} · ${item.id.slice(-8)}`)))),
          h('label', { style: label }, 'CPU', h('select', { value: cpu, disabled: busy, onChange: event => setCpu(Number(event.target.value)), style: inputStyle() }, [1, 2, 4, 8, 16].map(value => h('option', { key: value, value }, `${value} 核`)))),
          h('label', { style: label }, '内存', h('select', { value: ratio, disabled: busy, onChange: event => setRatio(Number(event.target.value)), style: inputStyle() }, [4, 8].map(value => h('option', { key: value, value }, `${cpu * value} GB`)))),
          h('label', { style: label }, '对话存储', h('select', { value: storageGiB, disabled: busy, onChange: event => setStorageGiB(Number(event.target.value)), style: inputStyle() }, [20, 50, 100, 200, 500, 0].map(value => h('option', { key: value, value }, value ? `持久化 ${value} GiB` : '临时存储')))),
          h('button', { type: 'button', disabled: busy || !selectedBuild, onClick: inspect, style: buttonStyle() }, busy ? '处理中…' : '检查部署')),
        preview ? h('div', { style: { marginTop: '16px', padding: '16px', borderRadius: '10px', background: BRAND.canvas } },
          h('strong', { style: { color: BRAND.ink } }, `${preview.agentName} · Revision ${preview.revision}`),
          h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, `${preview.environment === 'pre-online' ? '预发环境' : preview.environment} · ${preview.region} · ${preview.resources.cpu} 核 / ${preview.resources.memoryGiB} GB · 1 个实例`),
          h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, `运行时 ${preview.runtime} · 镜像 ${preview.image.version} · ${preview.resourceCounts.models} 个模型 / ${preview.resourceCounts.mcps} 个 MCP / ${preview.resourceCounts.skills} 个 Skill / ${preview.resourceCounts.remote} 个云端资源`),
          h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, preview.identity.kind === 'subaccount' ? `操作人：${preview.identity.userName}` : '操作人：主账号'),
          h('ul', { style: { fontSize: '12px', lineHeight: 1.7, color: BRAND.inkMuted, paddingLeft: '18px' } }, preview.warnings.map((warning, index) => h('li', { key: index }, warning))),
          h('button', { type: 'button', disabled: busy, onClick: deploy, style: { ...buttonStyle(), background: BRAND.primaryFill, color: '#fff' } }, preview.deploymentId ? preview.rollbackVersionId ? '确认回滚当前实例' : '确认升级当前实例' : '确认创建云端实例'),
          h('button', { type: 'button', disabled: busy, onClick: () => setPreview(null), style: { ...buttonStyle(), marginLeft: '8px' } }, '取消')) : null,
        notice ? h('p', { role: 'status', style: { fontSize: '12px', color: BRAND.inkMuted } }, notice) : null,
        error ? h('p', { role: 'alert', style: { fontSize: '12px', color: BRAND.danger } }, error) : null,
        h('h4', { style: { margin: '24px 0 8px', color: BRAND.ink } }, '部署记录'),
        !records.length ? h('p', { style: label }, '还没有云端部署。') : records.map(record => h('div', { key: record.id, style: { borderTop: '1px solid ' + BRAND.border, padding: '14px 0' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' } },
            h('strong', { style: { fontSize: '13px', color: BRAND.ink } }, `${record.agentName} · Revision ${record.revision}`), h(Pill, { tone: record.state === 'READY' ? 'accent' : 'signal' }, DEPLOYMENT_LABELS[record.state] || record.state)),
          h('p', { style: { fontSize: '11px', color: BRAND.inkMuted } }, `${record.environment} · ${record.region} · ${record.cloudAgentId || record.name} · ${record.resources?.storageGiB ? '持久化 ' + record.resources.storageGiB + ' GiB' : '临时存储'}`),
          record.rollout ? h('p', { style: { fontSize: '12px', color: BRAND.inkMuted } }, `${record.rollout.kind === 'rollback' ? '回滚' : '升级'}到 Revision ${record.rollout.revision} · ${record.rollout.status === 'SUCCEEDED' ? '入口版本已确认' : record.rollout.status === 'FAILED' ? '未提交成功' : '等待目标版本生效'}`) : null,
          record.failure ? h('p', { style: { fontSize: '12px', color: BRAND.danger } }, `${record.failure.code} · ${record.failure.message}`) : null,
          record.state !== 'DELETED' ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { type: 'button', disabled: busy, onClick: () => action(record, record.cloudAgentId ? 'refresh' : 'reconcile'), style: buttonStyle() }, record.cloudAgentId ? '刷新状态' : '核对创建结果'),
            ['READY', 'AVAILABLE_UPDATING'].includes(record.state) ? h('button', { type: 'button', disabled: busy, onClick: () => window.__AGENTKIT_STUDIO_BIND_AGENT__?.(record.cloudAgentId), style: buttonStyle() }, '开始对话') : null,
            record.state === 'READY' && record.agentId === agentId ? h('button', { type: 'button', disabled: busy || !selectedBuild, onClick: () => inspectUpdate(record), style: buttonStyle() }, '升级到所选构建') : null,
            record.state === 'READY' && (record.versions || []).some(version => version.id !== record.versionId) ? h('div', { style: { display: 'flex', gap: '6px' } },
              h('select', { 'aria-label': '回滚版本 ' + record.agentName, value: rollback[record.id] || '', disabled: busy, style: inputStyle(), onChange: event => setRollback(previous => ({ ...previous, [record.id]: event.target.value })) },
                h('option', { value: '' }, '选择历史版本'), record.versions.filter(version => version.id !== record.versionId).map(version => h('option', { key: version.id, value: version.id }, `Revision ${version.revision} · ${version.imageVersion} · ${version.completedAt}`))),
              h('button', { type: 'button', disabled: busy || !rollback[record.id], onClick: () => inspectUpdate(record, rollback[record.id]), style: buttonStyle() }, '检查回滚')) : null,
            record.cloudAgentId ? h('button', { type: 'button', disabled: busy, onClick: () => action(record, 'logs'), style: buttonStyle() }, '日志') : null,
            record.state === 'TOKEN_PENDING' && record.cloudStatus === 'RUNNING' && record.tokenBound === false ? h('button', { type: 'button', disabled: busy, onClick: () => action(record, 'repairAccess'), style: buttonStyle() }, '修复访问配置') : null,
            record.cloudAgentId ? h('button', { type: 'button', disabled: busy, onClick: () => deleting === record.id ? action(record, 'remove') : setDeleting(record.id), style: { ...buttonStyle(), color: BRAND.danger } }, deleting === record.id ? '确认删除云端实例' : '删除') : null,
            deleting === record.id ? h('button', { type: 'button', onClick: () => setDeleting(''), style: buttonStyle() }, '取消') : null) : null)),
        log ? h('div', { style: { marginTop: '12px' } }, h('strong', null, `${log.name} · 运行日志`), h('button', { type: 'button', onClick: () => setLog(null), style: buttonStyle() }, '关闭'), h('pre', { style: { padding: '12px', background: BRAND.canvas, maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '11px' } }, log.lines.join('\n') || '暂无日志')) : null);
    }
