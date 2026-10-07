    function resourceStatusPresentation(resource, kind) {
      const status = String(resource.status || '').toLowerCase();
      if (resource.disabled) return { label: '不可用', detail: '资源已停用。', tone: 'signal' };
      if (kind === 'skill' && resource.source === 'local-import' && status === 'ready') return { label: '本地已导入', detail: 'Skill 文件已导入本机；实际执行还取决于模型调用和脚本依赖。', tone: 'accent' };
      if ((kind === 'skill' || kind === 'skill-space') && status === 'available') return { label: '云端目录可见', detail: '云端 Skill Space 可在目录中读取；绑定后由 Host 下载加载，不代表所有 Skill 已执行验证。', tone: 'neutral' };
      if (kind === 'mcp') {
        if (resource.health?.errorCode || status === 'error') return { label: '探测失败', detail: resource.health?.errorCode || '请重新探测查看连接结果。', tone: 'signal' };
        if (status === 'ready' && (resource.health?.checkedAt || resource.health?.status === 'ready')) return { label: '探测通过', detail: '最近一次连接和工具列表读取成功；不代表每个工具已实际调用验证。', tone: 'accent' };
        if (resource.source === 'local') return { label: '已配置，未探测', detail: '已保存本机连接配置，请重新探测确认连通性。', tone: 'neutral' };
        if (status === 'running') return { label: '云端运行中', detail: '服务端运行状态；本机连通性尚未探测。', tone: 'neutral' };
      }
      return { label: ({ available: '目录可见', configured: '已配置', 'credential-missing': '缺少凭证', ready: '就绪', running: '运行中', error: '异常' })[status] || resource.status || '状态未知', detail: '目录状态不代表 Agent 绑定后的实际执行结果。', tone: 'neutral' };
    }

    function ResourcesPage() {
      const [resourceKind, setResourceKind] = useState('model');
      const [resources, setResources] = useState([]);
      const [platformCatalog, setPlatformCatalog] = useState(null);
      const [page, setPage] = useState(0);
      const [pageSize, setPageSize] = useState(20);
      const [cursorStack, setCursorStack] = useState([null]);
      const [nextCursor, setNextCursor] = useState(null);
      const [total, setTotal] = useState(0);
      const [query, setQuery] = useState('');
      const [submittedQuery, setSubmittedQuery] = useState('');
      const [status, setStatus] = useState('loading');
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
      const [mcpEditing, setMcpEditing] = useState(null);
      const [mcpPreview, setMcpPreview] = useState(null);
      const [skillDialogOpen, setSkillDialogOpen] = useState(false);
      const [skillPreview, setSkillPreview] = useState(null);
      const [skillPreviewFile, setSkillPreviewFile] = useState(null);
      const [modelDialogOpen, setModelDialogOpen] = useState(false);
      const [resourcePreview, setResourcePreview] = useState(null);
      const [deleting, setDeleting] = useState(false);
      const platformKinds = ['knowledge-base', 'memory-instance', 'skill-space'];
      const isPlatform = platformKinds.includes(resourceKind);
      const requestSeq = useRef(0);
      const resourceKinds = [
        ['model', '模型'], ['mcp', 'MCP'], ['skill', 'Skill'],
        ['knowledge-base', '知识库'], ['memory-instance', '记忆库'], ['skill-space', 'Skill Center'],
      ];
      const label = resourceKinds.find(item => item[0] === resourceKind)?.[1] || '资源';

      const load = async (kind = resourceKind, cursor = null, resetPaging = true, preserveMessage = false) => {
        const seq = ++requestSeq.current;
        setStatus('loading'); setError(''); if (!preserveMessage) setMessage('');
        if (resetPaging) { setPage(0); setCursorStack([null]); setNextCursor(null); }
        try {
          const result = platformKinds.includes(kind)
            ? await hostRemote.platformResources(kind)
            : await hostRemote.resources({ kind, limit: pageSize, cursor, query: submittedQuery.trim() });
          if (seq !== requestSeq.current) return;
          if (platformKinds.includes(kind)) {
            setPlatformCatalog(result || { items: [] }); setResources([]); setNextCursor(null); setTotal(Number(result?.total) || (result?.items || []).length || 0);
          } else {
            setResources(Array.isArray(result?.items) ? result.items : []);
            setNextCursor(result?.nextCursor || null);
            setTotal(Number(result?.total) || 0);
            setPlatformCatalog(null);
            if (result?.warnings?.length) setError(result.warnings.map(item => item.message).join(' '));
          }
          setStatus('ready');
        } catch (reason) {
          if (seq === requestSeq.current) { setStatus('error'); setError(reason?.message || '资源目录不可用'); }
        }
      };
      useEffect(() => {
        const timer = setTimeout(() => setSubmittedQuery(query), 250);
        return () => clearTimeout(timer);
      }, [query]);
      useEffect(() => { void load(resourceKind, null, true); }, [resourceKind, pageSize, submittedQuery]);
      const reloadCatalog = (preserveMessage = false) => load(resourceKind, null, true, preserveMessage === true);
      const openMcpCreate = () => { setMcpEditing(null); setMcpDialogOpen(true); };
      const openMcpEdit = resource => { setMcpEditing(resource); setMcpDialogOpen(true); };
      const closeMcpDialog = () => { setMcpDialogOpen(false); setMcpEditing(null); };
      const probeMcp = async resource => {
        setMessage(''); setError('');
        try {
          const result = await hostRemote.probeMcpResource(resource.resourceId);
          setMessage(`${resource.displayName || resource.name} 已探测，发现 ${result?.health?.toolCount || result?.toolCount || 0} 个 Tool。`);
          await reloadCatalog(true);
        } catch (reason) { await reloadCatalog(true); setError(reason?.message || 'MCP 探测失败'); }
      };
      const previewInstalledSkill = async resource => {
        try {
          const files = await hostRemote.previewInstalledSkill(resource.resourceId);
          setSkillPreview({ title: resource.displayName || resource.name || resource.resourceId, files, resource });
          setSkillPreviewFile(null);
        } catch (reason) { setError(reason?.message || 'Skill 文件读取失败'); }
      };
      const loadSkillFile = async path => {
        if (!skillPreview?.resource) return;
        try { setSkillPreviewFile(await hostRemote.previewInstalledSkill(skillPreview.resource.resourceId, path)); }
        catch (reason) { setError(reason?.message || 'Skill 文件读取失败'); }
      };
      const remove = async resource => {
        if (deleting) return;
        const name = resource.displayName || resource.name || resource.resourceId;
        const cloud = resource.source === 'agentengine-server';
        const title = cloud ? '删除云端 MCP' : '移除本地 MCP 配置';
        const detail = cloud ? `确定删除云端 MCP“${name}”吗？这会删除云端资源并清理关联运行实例，所有引用它的 Agent 可能无法继续调用。已有 Agent Revision 不会自动解除绑定。` : `确定移除“${name}”的本地连接配置吗？远端 MCP 服务会保留，引用此配置的 Agent 可能无法继续调用；已有 Revision 不会自动解除绑定。`;
        if (typeof window !== 'undefined' && !(await (window.__AGENTKIT_CONFIRM__ ? window.__AGENTKIT_CONFIRM__({ title, detail, confirmLabel: cloud ? '删除云端 MCP' : '移除配置', danger: true }) : Promise.resolve(window.confirm(detail))))) return;
        setDeleting(true); setError(''); setMessage('');
        try {
          await hostRemote.deleteResource(resource.resourceId, cloud ? 'cloud' : 'local');
          setMessage(`${name} ${cloud ? '已从云端删除' : '的本地连接配置已移除'}。请在 Agent 编辑页更新相关绑定。`);
          await reloadCatalog(true);
        } catch (reason) { setError(reason?.message || '资源删除失败'); }
        finally { setDeleting(false); }
      };
      const previousPage = async () => {
        if (page <= 0 || status === 'loading') return;
        const previous = page - 1;
        setPage(previous);
        await load(resourceKind, cursorStack[previous] || null, false);
      };
      const nextPage = async () => {
        if (!nextCursor || status === 'loading') return;
        const next = page + 1;
        setCursorStack(current => [...current.slice(0, next), nextCursor]);
        setPage(next);
        await load(resourceKind, nextCursor, false);
      };
      const pageCount = total ? Math.max(1, Math.ceil(total / pageSize)) : (nextCursor ? page + 2 : page + 1);
      const sourceLabel = item => ({ local: '本地配置', 'local-import': '本地导入', 'agentengine-server': '云端' })[item.source] || item.source || item.provider || item.origin || '—';
      const kindDetail = item => resourceKind === 'skill' && item.source === 'agentengine-server' ? 'Skill Space' : item.contract?.model || item.contract?.entrypoint || item.contract?.transport || item.region || item.version || '—';
      const rows = isPlatform ? (platformCatalog?.items || []) : resources;
      const tableRows = rows.map(resource => {
            const id = resource.resourceId || resource.id || resource.name;
            const name = resource.displayName || resource.name || id;
            const localMcp = resourceKind === 'mcp' && resource.source === 'local';
            const canDelete = localMcp || (resourceKind === 'mcp' && resource.source === 'agentengine-server');
            const displayStatus = resourceStatusPresentation(resource, resourceKind);
            return h('tr', { key: id, style: { borderBottom: '1px solid ' + BRAND.border } },
              h('td', { style: { padding: '12px 13px', color: BRAND.ink } }, h('strong', null, name), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } }, id)),
              h('td', { style: { padding: '12px 13px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, sourceLabel(resource)),
              h('td', { style: { padding: '12px 13px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, kindDetail(resource)),
              h('td', { title: displayStatus.detail, style: { padding: '12px 13px' } }, h(Pill, { tone: displayStatus.tone }, displayStatus.label), resource.health?.errorCode ? h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '4px' } }, resource.health.errorCode) : null),
              h('td', { style: { padding: '12px 13px', whiteSpace: 'nowrap' } },
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', { type: 'button', onClick: () => setResourcePreview(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看'),
                  localMcp ? h('button', { type: 'button', onClick: () => openMcpEdit(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '编辑凭证') : null,
                  resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => void probeMcp(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '重新探测') : null,
                  resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => setMcpPreview(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看工具') : null,
                  resourceKind === 'skill' && resource.source === 'local-import' ? h('button', { type: 'button', onClick: () => void previewInstalledSkill(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看文件') : null,
                  canDelete ? h('button', { type: 'button', disabled: deleting, onClick: () => void remove(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px', color: BRAND.danger } }, localMcp ? '移除配置' : '删除云端 MCP') : null,
                )));
      });
      const table = rows.length ? h('div', { style: { maxHeight: 'min(58vh, 620px)', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: '760px', fontSize: '12px' } },
          h('thead', { style: { position: 'sticky', top: 0, zIndex: 1 } }, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas } }, ['名称', '来源', '版本 / 类型', '状态', '操作'].map(column => h('th', { key: column, style: { padding: '11px 13px', borderBottom: '1px solid ' + BRAND.border, fontWeight: 750, whiteSpace: 'nowrap' } }, column)))),
          h('tbody', null, tableRows))) : null;
      const platformTable = platformCatalog ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '10px' } }, h('div', null, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, label), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '4px' } }, platformCatalog.connectionRef ? '云端目录资源只在这里做发现、查看和刷新；每类默认只允许绑定一个资源。绑定动作在 Agent 创建或编辑页完成。' : '当前没有可用云端凭证，先到设置页配置后再读取目录。')), h(Pill, { tone: platformCatalog.connectionRef ? 'accent' : 'signal' }, platformCatalog.connectionRef ? '目录已连接' : '待连接')),
        platformCatalog.items?.length ? table : h(EmptyState, { icon: '◈', title: `暂无${label}`, detail: platformCatalog.connectionRef ? '云端目录没有返回可用资源。' : '连接云端后刷新此目录。' })) : null;
      return h('div', null,
        h(ContentIntro, { detail: '资源库只负责资源目录生命周期：发现、导入、探测、查看、删除和状态刷新。新增或变更 Agent 绑定关系请在 Agent 创建页或编辑页完成。模型、Tool、MCP、Skill 可绑定多个；知识库、记忆库和 Skill Center 每类默认绑定一个。', action: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
          resourceKind === 'model' ? h('button', { type: 'button', onClick: () => setModelDialogOpen(true), style: buttonStyle() }, '添加模型') : null,
          resourceKind === 'mcp' ? h('button', { type: 'button', onClick: openMcpCreate, style: buttonStyle() }, '添加 MCP') : null,
          resourceKind === 'skill' ? h('button', { type: 'button', onClick: () => setSkillDialogOpen(true), style: buttonStyle() }, '扫描本地 Skill') : null,
          h('button', { type: 'button', onClick: () => void reloadCatalog(), style: buttonStyle() }, '刷新'),
          h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : 'Host 待接入')) }),
        h(StudioPageTabs, { ariaLabel: '资源类型', value: resourceKind, onChange: setResourceKind, items: resourceKinds.map(([id, value]) => ({ id, label: value })) }),
        ['skill', 'skill-space', 'mcp'].includes(resourceKind) ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, resourceKind === 'mcp' ? '探测通过表示连接和工具列表读取成功；工具是否能完成任务，需要在绑定的 Agent 中实际调用验证。移除配置只影响本机，删除云端 MCP 会清理云端资源。' : '本地已导入：文件已保存到本机。云端目录可见：绑定后由 Host 下载加载 Skill Space。两种状态都不代表脚本依赖或 Agent 实际执行已验证。') : null,
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取资源目录', detail: '读取 Host 的资源清单和云端平台目录。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '资源目录不可用', detail: error, action: h('button', { type: 'button', onClick: () => void reloadCatalog(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          !isPlatform ? h('section', { style: { display: 'grid', gap: '10px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
              h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: `搜索${label}`, 'aria-label': '搜索资源', style: { ...inputStyle(), marginTop: 0, maxWidth: '460px', flex: '1 1 280px' } }),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `${total || resources.length} 项 · 第 ${page + 1}/${pageCount} 页`), h('select', { value: String(pageSize), onChange: event => setPageSize(Number(event.target.value)), 'aria-label': '每页显示数量', style: { ...inputStyle(), width: '112px', marginTop: 0, padding: '0 7px' } }, h('option', { value: '10' }, '每页 10 条'), h('option', { value: '20' }, '每页 20 条'), h('option', { value: '50' }, '每页 50 条')))),
            table || h(EmptyState, { icon: '◈', title: `暂无${label}`, detail: '可以从右上角添加、发现或刷新资源。' }),
        h('div', { 'data-studio-pager': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: BRAND.inkMuted, fontSize: '11px', paddingTop: '4px' } }, h('span', null, `当前页 ${resources.length} 项`), h('div', { style: { display: 'flex', gap: '6px', flexShrink: 0 } }, h('button', { type: 'button', 'aria-label': '资源上一页', disabled: page <= 0 || status === 'loading', onClick: () => void previousPage(), style: pagerButtonStyle(page <= 0 || status === 'loading') }, '上一页'), h('button', { type: 'button', 'aria-label': '资源下一页', disabled: !nextCursor || status === 'loading', onClick: () => void nextPage(), style: pagerButtonStyle(!nextCursor || status === 'loading') }, '下一页')))
          ) : platformTable,
          message ? h('div', { role: 'status', style: { marginTop: '10px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
          error ? h('div', { role: 'alert', style: { marginTop: '10px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        ) : null,
        modelDialogOpen ? h(ModelResourceDialog, { onClose: () => setModelDialogOpen(false), onCreated: reloadCatalog }) : null,
        mcpDialogOpen ? h(McpResourceDialog, { resource: mcpEditing, onClose: closeMcpDialog, onCreated: reloadCatalog }) : null,
        mcpPreview ? h(McpToolsDialog, { resource: mcpPreview, onClose: () => setMcpPreview(null) }) : null,
        skillDialogOpen ? h(SkillDiscoveryDialog, { onClose: () => setSkillDialogOpen(false), onImported: reloadCatalog }) : null,
        skillPreview ? h(SkillPreviewDialog, { title: skillPreview.title, preview: skillPreview.files, file: skillPreviewFile, onClose: () => { setSkillPreview(null); setSkillPreviewFile(null); }, onSelect: loadSkillFile }) : null,
        resourcePreview ? h(ResourceDialog, { title: resourcePreview.displayName || resourcePreview.name || resourcePreview.resourceId, detail: '只读查看 Host 资源声明。Agent 绑定关系不会在资源库页面修改。', onClose: () => setResourcePreview(null) }, h('pre', { style: { margin: 0, maxHeight: '520px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: BRAND.ink, background: BRAND.canvas, border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '12px', fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(resourcePreview, null, 2))) : null);
    }

    function CodexPluginCapabilities({ pluginId }) {
      const [state, setState] = useState({ loading: true });
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        let current = true;
        setState({ loading: true });
        Promise.resolve().then(() => hostRemote.inspectCodexPlugin(pluginId)).then(value => {
          if (current) setState({ value });
        }, error => { if (current) setState({ error: error?.message || '能力与连接状态读取失败' }); });
        return () => { current = false; };
      }, [pluginId, revision]);
      const labels = { callable: '可调用', disabled: '已禁用', 'not-callable': '尚不可调用', 'not-loaded': '未连接或未加载', unknown: '状态未确认' };
      return h('section', { style: { borderTop: '1px solid ' + BRAND.border, paddingTop: '16px', marginTop: '16px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h3', { style: { margin: 0, fontSize: '15px', color: BRAND.ink } }, '能力与连接状态'), h('button', { type: 'button', disabled: state.loading, onClick: () => setRevision(value => value + 1), style: buttonStyle() }, '刷新连接状态')),
        state.loading ? h('p', { role: 'status' }, '正在读取插件能力和连接状态…') : null,
        state.error ? h('p', { role: 'alert', style: { color: BRAND.danger } }, state.error) : null,
        state.value ? h('div', { style: { fontSize: '12px', lineHeight: 1.7, color: BRAND.inkMuted } },
          state.value.runtimeError ? h('p', { role: 'status' }, state.value.runtimeError) : null,
          state.value.apps.map(app => h('div', { key: app.id, style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', padding: '12px 0' } }, h('strong', { style: { color: BRAND.ink } }, app.name), h(Pill, { tone: app.state === 'callable' ? 'accent' : 'signal' }, labels[app.state] || labels.unknown), app.installUrl ? h('a', { href: app.installUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: BRAND.accentStrong } }, '打开授权 / 管理连接') : null)),
          state.value.apps.length ? h('p', null, '授权完成后点击刷新连接状态。可调用表示 Codex 当前允许模型使用该连接器，实际效果仍以会话工具记录为准。') : null,
          state.value.skills.length ? h('p', null, 'Skill：', state.value.skills.map(item => item.name + (item.enabled ? '' : '（未启用）')).join('、')) : null,
          state.value.mcpServers.length ? h('p', null, '声明的 MCP：', state.value.mcpServers.join('、'), '。连接和工具执行结果请在 Codex Agent 会话中检查。') : null,
          !state.value.apps.length && !state.value.skills.length && !state.value.mcpServers.length ? h('p', null, '插件未声明连接器、Skill 或 MCP；其他能力由对应宿主加载。') : null,
        ) : null);
    }

    function MarketplacePage() {
      const [status, setStatus] = useState('loading');
      const [items, setItems] = useState([]);
      const [errors, setErrors] = useState([]);
      const [busyKey, setBusyKey] = useState('');
      const [message, setMessage] = useState('');
      const [authApps, setAuthApps] = useState([]);
      const [inspectionRevision, setInspectionRevision] = useState(0);
      const [installOpen, setInstallOpen] = useState(false);
      const [installSource, setInstallSource] = useState('');
      const load = async ({ preserveMessage = false } = {}) => {
        setStatus('loading');
        if (!preserveMessage) setMessage('');
        const results = await Promise.allSettled([hostRemote.dshPlugins(), hostRemote.codexPlugins()]);
        const next = [];
        const nextErrors = [];
        for (const [index, result] of results.entries()) {
          const ecosystem = index === 0 ? 'dsh' : 'codex';
          if (result.status === 'fulfilled') {
            for (const item of (result.value?.items || [])) next.push({ ...item, ecosystem });
            if (result.value?.error?.message) nextErrors.push(`${ecosystem}：${result.value.error.message}`);
          } else nextErrors.push(`${ecosystem}：${result.reason?.message || '插件宿主不可用'}`);
        }
        setItems(next);
        setSelected(current => current ? next.find(item => item.ecosystem === current.ecosystem && item.pluginId === current.pluginId) || null : null);
        setErrors(nextErrors);
        setStatus('ready');
        return next;
      };
      const mutate = async (item, operation) => {
        const pluginId = String(item.pluginId || item.id || '').trim();
        if (!pluginId || busyKey) return false;
        const key = `${item.ecosystem}:${pluginId}`;
        setBusyKey(key); setMessage(''); setErrors([]); setAuthApps([]);
        try {
          let result;
          if (item.ecosystem === 'dsh') {
            if (operation === 'install') {
              const source = item.installSpec || item.source?.package || item.distributionName || pluginId;
              result = await hostRemote.installDshPlugin(source);
            } else if (operation === 'enable') result = await hostRemote.enableDshPlugin(pluginId);
            else if (operation === 'disable') result = await hostRemote.disableDshPlugin(pluginId);
            else if (operation === 'update') result = await hostRemote.updateDshPlugin(pluginId);
            else if (operation === 'uninstall') result = await hostRemote.uninstallDshPlugin(pluginId);
          } else if (operation === 'install') {
            result = await hostRemote.installCodexPlugin(pluginId, item.marketplaceName || item.marketplace);
          } else if (operation === 'uninstall') {
            result = await hostRemote.uninstallCodexPlugin(pluginId);
          }
          const refreshed = await load({ preserveMessage: true });
          if (item.ecosystem === 'codex' && operation === 'install') {
            setSelected(refreshed.find(row => row.ecosystem === 'codex' && row.pluginId === pluginId) || null);
            setAuthApps(result?.appsNeedingAuth || []);
          }
          setInspectionRevision(value => value + 1);
          setMessage(`${item.displayName || pluginId}：${operation === 'install' ? '已安装' : operation === 'uninstall' ? '已卸载' : operation === 'enable' ? '已启用' : operation === 'disable' ? '已停用' : '已更新'}。${result?.note || ''}${result?.warnings?.length ? ' 加载提示：' + result.warnings.join('；') : ''}`);
          return true;
        } catch (reason) {
          setErrors([reason?.message || '插件操作失败']);
          return false;
        } finally { setBusyKey(''); }
      };
      useEffect(() => { void load(); }, []);
      // Store-style market: pill ecosystem tabs, rounded search, two-column
      // discovery rows with an icon square, and a click-through detail view —
      // layout follows the legacy Studio plugin store.
      const [eco, setEco] = useState('dsh');
      const [query, setQuery] = useState('');
      const [selected, setSelected] = useState(null);
      const [catalogLimit, setCatalogLimit] = useState(24);
      useEffect(() => { setCatalogLimit(24); }, [eco, query]);
      const ecoItems = items.filter(item => (item.ecosystem || '').toLowerCase() === eco);
      const normalized = query.trim().toLowerCase();
      const visibleItems = ecoItems.filter(item => !normalized || `${item.displayName || ''} ${item.name || ''} ${item.pluginId || ''} ${item.description || ''}`.toLowerCase().includes(normalized));
      const iconLetter = item => String(item?.displayName || item?.name || item?.pluginId || '?').trim().charAt(0).toUpperCase() || '?';
      const iconSquare = (item, size = 52) => {
        const style = { width: size + 'px', height: size + 'px', borderRadius: Math.round(size * 0.28) + 'px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.34) + 'px', fontWeight: 750, flex: '0 0 auto', overflow: 'hidden', border: '1px solid ' + BRAND.border, background: BRAND.surface, color: BRAND.inkMuted, boxShadow: '0 2px 8px rgba(11,18,32,0.05)' };
        const icon = item?.iconDataUrl || item?.iconUrl || item?.icon;
        if (icon) return h('span', { style }, h('img', { src: icon, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', style: { width: '72%', height: '72%', objectFit: 'contain' } }));
        return h('span', { style: { ...style, background: item?.ecosystem === 'codex' ? '#f2f0ff' : '#eef7ff', color: item?.ecosystem === 'codex' ? '#6656c8' : '#1478c9' } }, iconLetter(item));
      };
      const stateLabel = item => ({ active: '已加载', partial: '部分加载', selected: '已选择', disabled: '未启用', error: '加载失败', cached: '仅缓存', enabled: '已启用', available: '可安装' })[item.status] || (item.enabled ? '已启用' : '未启用');
      const lifecycleButtons = (item, compact = false) => {
        const key = `${item.ecosystem}:${item.pluginId || item.id}`;
        const isDsh = (item.ecosystem || '').toLowerCase() === 'dsh';
        const btn = (label, operation, extra = {}) => h('button', { type: 'button', disabled: Boolean(busyKey), onClick: event => { event.stopPropagation(); void mutate(item, operation); }, style: { ...buttonStyle(), padding: compact ? '4px 9px' : '5px 10px', fontSize: '10px', ...extra } }, busyKey === key ? '处理中…' : label);
        const isCodex = (item.ecosystem || '').toLowerCase() === 'codex';
        const installed = item.installed !== false;
        if (item.readOnlyReason) return h(Pill, null, ({ 'host-component': '宿主组件', 'codex-unavailable': '当前账户不可安装', 'codex-install-confirmation': '需在 Codex 中确认安装' })[item.readOnlyReason] || '宿主必需');
        if (item.lifecycleAvailable === false) return h(Pill, null, '仅缓存，状态未确认');
        return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', flexShrink: 0 } },
          isDsh && !installed ? btn('安装', 'install', { color: 'var(--dsw-static-neutral-00, #fff)', background: BRAND.primaryFill, borderColor: 'transparent' }) : null,
          isDsh && installed && item.removable ? btn('卸载', 'uninstall', { color: BRAND.danger }) : null,
          isDsh && item.source === 'bundled' ? h(Pill, null, '内置') : null,
          installed ? h(Pill, { tone: item.status === 'error' ? 'signal' : 'accent' }, stateLabel(item)) : null,
          isDsh && installed && item.enabled === false && !item.error ? btn('启用', 'enable') : null,
          isDsh && item.enabled !== false ? btn('停用', 'disable') : null,
          isDsh && item.removable ? btn('更新', 'update') : null,
          isCodex && !installed ? btn('安装', 'install', { color: 'var(--dsw-static-neutral-00, #fff)', background: BRAND.primaryFill, borderColor: 'transparent' }) : null,
          isCodex && installed ? btn('卸载', 'uninstall', { color: BRAND.danger }) : null,
        );
      };
      const discoveryRow = item => h('div', { key: `${item.ecosystem}-${item.pluginId || item.name}`, 'data-plugin-row': 'true', style: { display: 'flex', alignItems: 'center', gap: '15px', textAlign: 'left', padding: '15px 0', minWidth: 0, minHeight: '72px', background: 'transparent', color: BRAND.ink, width: '100%' } },
        iconSquare(item),
        h('button', { type: 'button', onClick: () => setSelected(item), style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px', textAlign: 'left', border: 0, background: 'transparent', color: BRAND.ink, cursor: 'pointer', padding: 0 } },
          h('strong', { style: { fontWeight: 550, fontSize: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' } }, item.displayName || item.name || item.pluginId || '未命名插件'),
          h('small', { style: { color: BRAND.inkMuted, fontSize: '13px', lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' } }, item.description || '查看插件详情与可用能力')),
        h('button', { type: 'button', 'aria-label': `${item.installed === false && !item.readOnlyReason ? '安装' : '管理'} ${item.displayName || item.name || item.pluginId}`, disabled: Boolean(busyKey), onClick: () => item.installed === false && !item.readOnlyReason ? void mutate(item, 'install') : setSelected(item), style: { border: 0, background: 'transparent', color: BRAND.ink, width: '36px', height: '36px', borderRadius: '50%', fontSize: item.installed === false ? '28px' : '22px', lineHeight: 1, cursor: 'pointer', flexShrink: 0 } }, item.installed === false && !item.readOnlyReason ? '+' : '···'));
      const infoRow = (label, value) => h('div', { style: { display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: '14px', padding: '8px 0', fontSize: '12px' } }, h('dt', { style: { color: BRAND.inkMuted } }, label), h('dd', { style: { margin: 0, color: BRAND.ink, wordBreak: 'break-all' } }, value || '—'));
      const detailView = selected ? h('div', null,
        h('button', { type: 'button', onClick: () => setSelected(null), style: { ...buttonStyle(), background: BRAND.surface, marginBottom: '16px' } }, '← 返回插件市场'),
        h('header', { style: { display: 'flex', justifyContent: 'space-between', gap: '18px', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', minWidth: 0 } },
            iconSquare(selected, 52),
            h('div', { style: { minWidth: 0 } }, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '18px' } }, selected.displayName || selected.name || selected.pluginId || '未命名插件'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '4px', wordBreak: 'break-all' } }, selected.pluginId || selected.name || '—'))),
          lifecycleButtons(selected)),
        selected.description ? h('p', { style: { whiteSpace: 'pre-wrap', color: BRAND.ink, lineHeight: 1.65, margin: '18px 0', fontSize: '13px' } }, selected.description) : null,
        h('dl', { style: { margin: '20px 0', padding: '14px 0', borderTop: '1px solid ' + BRAND.border, borderBottom: '1px solid ' + BRAND.border, display: 'grid', gap: '2px' } },
          infoRow('插件 ID', selected.pluginId || selected.name),
          infoRow('版本', selected.version),
          infoRow('生态', (selected.ecosystem || '').toUpperCase()),
          infoRow('状态', stateLabel(selected)),
          selected.marketplaceName ? infoRow('市场', selected.marketplaceName) : null,
          infoRow('来源', selected.source || '—'),
          selected.installSpec ? infoRow('安装源', selected.installSpec) : null,
          selected.risk ? infoRow('风险标记', JSON.stringify(selected.risk)) : null),
        selected.error ? h('p', { role: 'alert', style: { color: BRAND.danger, whiteSpace: 'pre-wrap' } }, `加载失败：${selected.error.diagnostic || selected.error.code}`) : null,
        selected.rows?.length ? h('div', null, h('h3', null, 'Host 加载的能力'), selected.rows.map(row => h('div', { key: row.rowId, style: { padding: '8px 0', fontSize: '12px', color: BRAND.inkMuted } }, `${row.moduleName || row.rowId} · ${row.fiberPhase === 'active' ? '已加载' : row.fiberPhase === 'failed' ? '加载失败' : row.fiberPhase || '未加载'}`))) : null,
        h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, selected.ecosystem === 'codex' ? '在新建的 Codex Agent 会话中加载。需要登录的连接器沿用 Codex 授权状态；其他 Harness 请从资源库导入 Skill 或绑定 MCP。' : '插件能力由 DSH Host 加载。需要重启的变更会在操作结果中提示；Agent 的工具绑定在编辑页维护。'),
        selected.ecosystem === 'codex' ? h(CodexPluginCapabilities, { key: selected.pluginId + ':' + inspectionRevision, pluginId: selected.pluginId }) : null,
      ) : null;
      const pluginSection = (title, rows) => rows.length ? h('section', { style: { marginTop: '34px' } }, h('h3', { style: { margin: '0 0 7px', fontSize: '20px', fontWeight: 650, letterSpacing: '-0.02em', color: BRAND.ink } }, `${title} · ${rows.length}`), h('div', { 'data-plugin-grid': 'true', style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: '48px', rowGap: '0' } }, rows.slice(0, catalogLimit).map(discoveryRow)), rows.length > catalogLimit ? h('button', { type: 'button', onClick: () => setCatalogLimit(limit => limit + 24), style: { ...buttonStyle(), marginTop: '12px' } }, `查看更多${title}（已显示 ${catalogLimit}/${rows.length}）`) : null) : null;
      const installedStrip = eco === 'codex' && !normalized ? h('section', { style: { marginTop: '24px' } }, h('h3', { style: { color: BRAND.ink, fontSize: '18px' } }, `已安装 · ${visibleItems.filter(item => item.installed).length}`), h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } }, visibleItems.filter(item => item.installed).map(item => h('button', { key: item.pluginId, type: 'button', title: item.displayName || item.name, 'aria-label': `管理 ${item.displayName || item.name || item.pluginId}`, onClick: () => setSelected(item), style: { padding: 0, border: 0, background: 'transparent', cursor: 'pointer' } }, iconSquare(item, 44))))) : null;
      const marketHeading = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '24px', marginBottom: '28px', flexWrap: 'wrap' } },
        h('div', null, h('h1', { style: { margin: 0, color: BRAND.ink, fontSize: '34px', lineHeight: 1.1, letterSpacing: '-0.04em', fontWeight: 750 } }, '插件'), h('p', { style: { color: BRAND.inkMuted, margin: '10px 0 0', lineHeight: 1.5, fontSize: '16px' } }, '在你常用的工具中与 Agent 协作。')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('input', { type: 'search', 'aria-label': '搜索插件', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索插件', style: { ...inputStyle(), width: '320px', borderRadius: '26px', padding: '12px 18px', marginTop: 0, fontSize: '14px', background: BRAND.surface } }), h('button', { type: 'button', 'aria-label': '添加插件', onClick: () => { setInstallSource(''); setInstallOpen(true); }, disabled: Boolean(busyKey), style: { width: '48px', height: '48px', border: '1px solid ' + BRAND.border, borderRadius: '50%', background: BRAND.surface, color: BRAND.ink, fontSize: '30px', lineHeight: 1, cursor: 'pointer', boxShadow: '0 2px 8px rgba(11,18,32,0.04)' } }, '+')));
      return h('div', { 'data-plugin-market': 'true', style: { maxWidth: '1120px', margin: '12px auto', padding: '8px 12px 40px' } },
        marketHeading,
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取插件目录', detail: '读取 DSH Host 和 Codex 官方插件目录。' }) : null,
        errors.length ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '10px 12px', borderRadius: '9px', background: 'var(--dsw-alias-state-warn-tertiary, #fff3da)', color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', fontSize: '12px' } }, errors.join('；')) : null,
        message ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '10px 12px', borderRadius: '9px', background: BRAND.accentSoft, color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
        authApps.length ? h('div', { role: 'status' }, '以下连接器仍需授权：', authApps.map(app => h('span', { key: app.id, style: { marginLeft: '12px' } }, app.installUrl ? h('a', { href: app.installUrl, target: '_blank', rel: 'noopener noreferrer' }, app.name) : app.name))) : null,
        busyKey ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, '正在安装或应用插件变更，请稍候…') : null,
        installOpen ? h(ResourceDialog, { title: `添加 ${eco === 'codex' ? 'Codex' : 'DSH'} 插件`, detail: eco === 'codex' ? '输入完整插件标识，例如 plugin-name@marketplace。市场需要已在 Codex 中配置。' : '输入 DSH 插件的 npm 包名、安装源或本地路径。Host 会先检查插件源与兼容性。', onClose: () => { if (!busyKey) setInstallOpen(false); } }, h('form', { onSubmit: async event => { event.preventDefault(); const source = installSource.trim(); if (source && await mutate({ pluginId: source, displayName: source, ecosystem: eco }, 'install')) setInstallOpen(false); }, style: { display: 'grid', gap: '14px' } },
          h('input', { 'aria-label': '插件安装源', value: installSource, onChange: event => setInstallSource(event.target.value), required: true, placeholder: eco === 'codex' ? 'plugin-name@marketplace' : '@scope/plugin-name', style: inputStyle() }),
          errors.length ? h('p', { role: 'alert', style: { color: BRAND.danger, whiteSpace: 'pre-wrap', margin: 0 } }, errors.join('；')) : null,
          h('button', { type: 'submit', disabled: Boolean(busyKey) || !installSource.trim(), style: buttonStyle() }, busyKey ? '正在安装…' : '安装插件'))) : null,
        status === 'ready' && !selected ? h('div', null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' } },
            h('div', { style: { display: 'inline-flex', gap: '4px', padding: '3px', border: '1px solid ' + BRAND.border, borderRadius: '18px', background: BRAND.surface } }, [['dsh', 'DSH 插件'], ['codex', 'Codex 插件']].map(([id, label]) => h('button', { key: id, type: 'button', 'aria-selected': eco === id ? 'true' : 'false', onClick: () => { setEco(id); setSelected(null); }, style: { border: 0, boxShadow: 'none', padding: '6px 14px', borderRadius: '15px', cursor: 'pointer', fontSize: '12px', fontWeight: 650, color: eco === id ? BRAND.accentStrong : BRAND.inkMuted, background: eco === id ? BRAND.accentSoft : 'transparent' } }, label))),
            h('button', { type: 'button', onClick: load, style: { ...buttonStyle(), background: 'transparent' } }, '刷新')),
          eco === 'codex' ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '目录和精选来自 Codex 官方 App Server；安装状态与当前 Codex 配置目录共享。新建 Codex Agent 会话后加载插件，连接器仍需完成服务授权。') : null,
          visibleItems.length ? h(React.Fragment, null, installedStrip || pluginSection('已安装', visibleItems.filter(item => item.installed !== false)), !normalized ? pluginSection('精选', visibleItems.filter(item => item.featured)) : null, pluginSection('插件目录', visibleItems.filter(item => item.installed === false && (normalized || !item.featured)))) : h(EmptyState, { icon: '⌘', title: query.trim() ? '没有匹配的插件' : eco === 'dsh' ? 'DSH 生态暂无可见插件' : '尚未安装 Codex 插件', detail: query.trim() ? '试试其他名称，或清空搜索查看全部插件。' : eco === 'codex' ? '点击添加插件，输入插件名@市场名即可安装。市场需已在 Codex 中配置。' : 'Profile 没有返回可见插件。', action: h('button', { type: 'button', onClick: query.trim() ? () => setQuery('') : eco === 'codex' ? () => { setInstallSource(''); setInstallOpen(true); } : load, style: buttonStyle() }, query.trim() ? '清空搜索' : eco === 'codex' ? '添加 Codex 插件' : '重新读取') }),
          h('div', { style: { marginTop: '16px' } }, h('button', { type: 'button', onClick: load, style: { ...buttonStyle(), background: BRAND.surface } }, '刷新目录')),
        ) : null,
        status === 'ready' && selected ? detailView : null,
      );
    }

    function UnsupportedStudioPage({ title, detail }) {
      return h('div', null,
        h(ContentIntro, { detail, action: h(Pill, { tone: 'signal' }, 'Host API 未接入') }),
        h(EmptyState, { icon: '·', title: title + '暂未接入', detail: '这个入口保留在产品信息架构中，但当前版本不会用假数据模拟。接入对应 Host 合同后再开放操作。' }));
    }

    function RuntimeResourcesPage() {
      const [status, setStatus] = useState('loading');
      const [resources, setResources] = useState([]);
      const [warnings, setWarnings] = useState([]);
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const groups = [['model', '模型'], ['mcp', 'MCP'], ['skill', 'Skill'], ['knowledge-base', '知识库'], ['memory-instance', '记忆库']];
      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const catalog = await hostRemote.resources({ limit: 200 });
          setResources(catalog?.items || []);
          setWarnings(catalog?.warnings || []);
          setStatus('ready');
        } catch (reason) { setStatus('error'); setError(reason?.message || '运行资源读取失败'); }
      };
      useEffect(() => { void load(); }, []);
      const normalized = query.trim().toLowerCase();
      const visible = resources.filter(item => !normalized || `${item.displayName || ''} ${item.name || ''} ${item.resourceId || ''}`.toLowerCase().includes(normalized));
      return h('div', null,
        h(ContentIntro, { detail: '汇总当前 Host 可发现的模型、MCP、Skill、知识库和记忆库，用于检查资源来源与连接状态。Agent 实际使用哪些资源，以其绑定和会话工具记录为准。', action: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h(Pill, { tone: status === 'ready' && !warnings.length ? 'accent' : 'signal' }, status === 'ready' ? warnings.length ? '部分目录需处理' : '目录已读取' : '读取中'), h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '刷新')) }),
        h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '此处展示资源清单，不表示云端已部署或 Agent 已执行验证。DSH 会话动态加载的工具请在原生会话轨迹中查看。'),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取运行资源', detail: '读取本地配置和各类云端资源目录。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '运行资源不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          warnings.length ? h('div', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6, marginBottom: '14px' } }, warnings.map((warning, index) => h('div', { key: index }, `${groups.find(([kind]) => kind === warning.kind)?.[1] || warning.kind}：${warning.message}`))) : null,
          h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索运行资源', 'aria-label': '搜索运行资源', style: { ...inputStyle(), margin: '0 0 14px', maxWidth: '460px' } }),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' } }, groups.map(([kind, label]) => {
            const matches = visible.filter(item => item.kind === kind);
            return h('section', { key: kind, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface, overflow: 'hidden' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '13px 14px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, label), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${matches.length} 项${matches.length > 8 ? ' · 显示前 8 项' : ''}`)),
              matches.length ? h('div', { style: { display: 'grid' } }, matches.slice(0, 8).map(item => {
                const state = resourceStatusPresentation(item, kind);
                return h('div', { key: item.resourceId || item.id, title: state.detail, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '9px', padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border } }, h('div', { style: { minWidth: 0 } }, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.displayName || item.name || item.resourceId), h('span', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, item.version || item.source || item.resourceId)), h(Pill, { tone: state.tone }, state.label));
              })) : h('div', { style: { padding: '20px 14px', color: BRAND.inkMuted, fontSize: '12px' } }, warnings.some(warning => warning.kind === kind) ? '目录未完整读取，请查看上方提示。' : normalized ? '没有匹配资源。' : '暂无资源。'));
          }))
        ) : null);
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

      const load = async (preferredAgent = selectedAgent) => {
        setStatus('loading');
        setError('');
        try {
          const [agentResult, deploymentResult, operationResult] = await Promise.all([
            hostRemote.agents(), hostRemote.deployments(), hostRemote.operations(),
          ]);
          const nextAgents = Array.isArray(agentResult?.items) ? agentResult.items : [];
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
          const builds = Array.isArray(detail?.builds) ? detail.builds : (Array.isArray(current?.builds) ? current.builds : []);
          if (nextAgent && detail) {
            setAgents(nextAgents.map(item => (item?.metadata?.id || item?.id) === nextAgent ? { ...item, ...detail } : item));
          }
          const readyBuild = builds.find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED') || builds[0];
          setSelectedBuild(String(readyBuild?.id || ''));
          setStatus('ready');
        } catch (reason) {
          setStatus('error');
          setError(reason?.message || '构建与部署状态不可用');
        }
      };
      useEffect(() => { void load(); }, []);

      const currentAgent = agents.find(item => (item?.metadata?.id || item?.id) === selectedAgent);
      const builds = Array.isArray(currentAgent?.builds) ? currentAgent.builds : [];
      const readyBuilds = builds.filter(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED');
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
        const id = event.target.value;
        setSelectedAgent(id);
        setSelectedBuild('');
        const nextAgent = agents.find(item => (item?.metadata?.id || item?.id) === id);
        const knownBuilds = Array.isArray(nextAgent?.builds) ? nextAgent.builds : [];
        const knownReady = knownBuilds.find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED') || knownBuilds[0];
        if (knownReady) setSelectedBuild(String(knownReady.id || ''));
        // Agent list rows do not carry build history. Hydrate the newly
        // selected row so switching targets does not regress to an empty
        // deployment selector.
        void hostRemote.agent(id).then(detail => {
          const detailBuilds = Array.isArray(detail?.builds) ? detail.builds : [];
          setAgents(previous => previous.map(item => (item?.metadata?.id || item?.id) === id ? { ...item, ...detail } : item));
          const ready = detailBuilds.find(item => String(item?.status || '').toUpperCase() === 'SUCCEEDED') || detailBuilds[0];
          setSelectedBuild(String(ready?.id || ''));
        }).catch(() => { /* the selected agent remains usable for a new build */ });
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
          setMessage(buildId ? `Build 已完成：${buildId}` : 'Build 已提交，正在等待 Host 完成');
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
      const buildRows = builds.length ? builds.map(item => h('tr', { key: item.id, style: { borderBottom: '1px solid ' + BRAND.border } },
        h('td', { style: { padding: '10px 12px', color: BRAND.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' } }, item.id || '—'),
        h('td', { style: { padding: '10px 12px', color: BRAND.inkMuted } }, item.revision ? `Revision ${item.revision}` : '—'),
        h('td', { style: { padding: '10px 12px' } }, h(Pill, { tone: String(item.status || '').toUpperCase() === 'SUCCEEDED' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')),
        h('td', { style: { padding: '10px 12px', display: 'flex', gap: '6px' } }, canRunBuild && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', onClick: () => window.__AGENTKIT_STUDIO_BIND_AGENT__?.({ agentId: selectedAgent, buildId: item.id }), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '在新会话运行') : null, directServerMode && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', onClick: () => downloadBuild(item.id), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '下载 ZIP') : null))) : h('tr', null, h('td', { colSpan: 4, style: { padding: '18px 12px', color: BRAND.inkMuted } }, '当前 Agent 还没有 Build。'));
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain / Delivery', title: '构建与部署', detail: directServerMode ? 'Build 固化 Agent Revision；本页支持本地构建、下载和运行，云端部署尚未接入。' : 'Build 固化 Agent Revision；Deployment 只接受已成功的 Build，所有动作由本地 Host 通过异步 operation 承载。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : '读取中') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取交付状态', detail: '读取 Agent、Build、Deployment 和 Operation。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '交付状态不可用', detail: error, action: h('button', { type: 'button', onClick: () => load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('section', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '12px', alignItems: 'end', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '目标 Agent', h('select', { value: selectedAgent, onChange: chooseAgent, style: inputStyle() }, agents.map(item => { const id = item?.metadata?.id || item?.id; return h('option', { key: id, value: id }, `${item?.metadata?.name || item?.name || id} · ${id}`); }))),
            h('button', { type: 'button', onClick: createBuild, disabled: saving || !selectedAgent, style: { ...buttonStyle(), color: saving || !selectedAgent ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !selectedAgent ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !selectedAgent ? BRAND.border : 'transparent' } }, saving ? '提交中…' : '构建当前 Revision')),
          h('section', { style: { marginTop: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', overflow: 'hidden', background: BRAND.surface } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, 'Build 历史'), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${builds.length} 个`)),
            h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } }, h('thead', null, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas } }, ['Build', '版本', '状态', '操作'].map(label => h('th', { key: label, style: { padding: '10px 12px', fontWeight: 750 } }, label)))), h('tbody', null, buildRows))),
          h('section', { style: { marginTop: '14px', display: 'grid', gap: '12px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('div', { style: { color: BRAND.ink, fontWeight: 800, fontSize: '14px' } }, directServerMode ? '云端部署' : '部署已成功的 Build'),
            directServerMode ? h('div', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55, padding: '10px 12px', borderRadius: '9px', background: BRAND.canvas } }, '当前构建产物尚未接入云端发布。你可以下载 Build，或使用冻结版本在本地运行对话。') : null,
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1fr 1fr auto', gap: '9px', alignItems: 'end' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Build', h('select', { value: selectedBuild, onChange: event => setSelectedBuild(event.target.value), disabled: directServerMode, style: inputStyle() }, h('option', { value: '' }, readyBuilds.length ? '请选择 Build' : '暂无成功 Build'), readyBuilds.map(item => h('option', { key: item.id, value: item.id }, `${item.id} · Revision ${item.revision || '—'}`)))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '区域', h('input', { value: region, onChange: event => setRegion(event.target.value), disabled: directServerMode, style: inputStyle() })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '环境', h('input', { value: environment, onChange: event => setEnvironment(event.target.value), disabled: directServerMode, style: inputStyle() })),
              h('button', { type: 'button', onClick: createDeployment, disabled: directServerMode || saving || !selectedBuild, style: { ...buttonStyle(), color: directServerMode || saving || !selectedBuild ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: directServerMode || saving || !selectedBuild ? BRAND.accentSoft : BRAND.primaryFill, borderColor: directServerMode || saving || !selectedBuild ? BRAND.border : 'transparent' } }, directServerMode ? '云端发布未接入' : '提交部署'))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginTop: '14px' } },
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '部署记录'), deployments.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, deployments.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, item.id || '—'), h(Pill, { tone: item.status === 'READY' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, directServerMode ? '本地 Build 尚未接入云端部署。' : '暂无部署记录。')),
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '异步操作'), operations.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, operations.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `${item.kind || item.type || 'operation'} · ${item.status || 'UNKNOWN'}`), (directServerMode ? ['QUEUED'] : ['RUNNING', 'PENDING', 'ADMITTING', 'DEPLOYING']).includes(String(item.status || '').toUpperCase()) ? h('button', { type: 'button', onClick: () => cancel(item.id), style: { ...buttonStyle(), padding: '4px 7px', fontSize: '10px' } }, '取消') : null))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无异步操作。'))),
          message ? h('div', { role: 'status', style: { marginTop: '12px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
          error ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        ) : null);
    }
