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
      const [sourceFilter, setSourceFilter] = useState('all');
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
        ['knowledge-base', '知识库'], ['memory-instance', '记忆库'],
      ];
      const label = resourceKinds.find(item => item[0] === resourceKind)?.[1] || '资源';

      const load = async (kind = resourceKind, cursor = null, resetPaging = true, preserveMessage = false) => {
        const seq = ++requestSeq.current;
        setStatus('loading'); setError(''); if (!preserveMessage) setMessage('');
        if (resetPaging) { setPage(0); setCursorStack([null]); setNextCursor(null); }
        try {
          const result = platformKinds.includes(kind)
            ? await hostRemote.platformResources(kind)
            : await hostRemote.resources({ kind, limit: pageSize, cursor, query: submittedQuery.trim(), source: kind === 'skill' ? sourceFilter : 'all' });
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
      useEffect(() => { void load(resourceKind, null, true); }, [resourceKind, pageSize, submittedQuery, sourceFilter]);
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
              resourceKind === 'skill' ? h('select', { value: sourceFilter, 'aria-label': 'Skill 来源', onChange: event => setSourceFilter(event.target.value), style: {...inputStyle(), width: '140px', marginTop:0} }, h('option',{value:'all'},'全部来源'),h('option',{value:'local'},'本地'),h('option',{value:'cloud'},'云端')) : null,
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

    // The official DSH plugin center owns the page and navigation. This item
    // contributes the existing Codex ecosystem through its public item slot.
    function CodexPluginMarketItem({ view } = {}) {
      const [status, setStatus] = useState('idle');
      const [items, setItems] = useState([]);
      const [query, setQuery] = useState('');
      const [selectedId, setSelectedId] = useState('');
      const [busyId, setBusyId] = useState('');
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [authApps, setAuthApps] = useState([]);
      const [revision, setRevision] = useState(0);
      const [installOpen, setInstallOpen] = useState(false);
      const [installSource, setInstallSource] = useState('');
      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const result = await hostRemote.codexPlugins();
          const next = Array.isArray(result?.items) ? result.items : [];
          setItems(next);
          setError(result?.error?.message || '');
          setStatus('ready');
          return next;
        } catch (reason) {
          setStatus('error'); setError(reason?.message || 'Codex 插件目录不可用');
          return null;
        }
      };
      useEffect(() => { if (view === 'page') void load(); }, [view]);
      if (view !== 'page') return h('p', { style: { margin: 0, color: BRAND.inkMuted, lineHeight: 1.55, fontSize: '12px' } }, '管理 Codex 官方插件、市场来源、连接器授权和会话加载状态。');
      const id = item => String(item?.pluginId || item?.id || '');
      const label = item => item?.displayName || item?.name || id(item) || '未命名插件';
      const installed = item => item?.installed === true;
      const lifecycleAvailable = item => item?.lifecycleAvailable !== false && !item?.readOnlyReason;
      const stateLabel = item => item?.readOnlyReason
        ? ({ 'codex-unavailable': '当前账户不可安装', 'codex-install-confirmation': '需在 Codex 中确认安装' })[item.readOnlyReason] || '状态未确认'
        : item?.status === 'cached' || item?.lifecycleAvailable === false ? '仅缓存，状态未确认'
        : installed(item) ? item.enabled === false ? '未启用' : '已安装' : '可安装';
      const selected = items.find(item => id(item) === selectedId) || null;
      const normalized = query.trim().toLowerCase();
      const visible = items.filter(item => !normalized || `${label(item)} ${id(item)} ${item.description || ''} ${item.marketplaceName || item.marketplace || ''}`.toLowerCase().includes(normalized));
      const mutate = async (item, operation) => {
        const pluginId = id(item).trim();
        if (!pluginId || busyId) return false;
        setBusyId(pluginId); setMessage(''); setError(''); setAuthApps([]);
        try {
          const result = operation === 'install'
            ? await hostRemote.installCodexPlugin(pluginId, item.marketplaceName || item.marketplace)
            : await hostRemote.uninstallCodexPlugin(pluginId);
          const refreshed = await load();
          if (operation === 'install' && refreshed?.some(row => id(row) === pluginId)) setSelectedId(pluginId);
          setMessage(`${label(item)}：${operation === 'install' ? '已安装' : '已卸载'}。${result?.note || ''}${result?.warnings?.length ? ' 加载提示：' + result.warnings.join('；') : ''}`);
          setAuthApps(result?.appsNeedingAuth || []);
          setRevision(value => value + 1);
          return true;
        } catch (reason) { setError(reason?.message || 'Codex 插件操作失败'); return false; }
        finally { setBusyId(''); }
      };
      const openInstall = () => { setInstallSource(''); setError(''); setInstallOpen(true); };
      const lifecycleButton = (item, compact = false) => lifecycleAvailable(item) ? h('button', {
        type: 'button', disabled: Boolean(busyId), onClick: () => void mutate(item, installed(item) ? 'uninstall' : 'install'),
        style: { ...buttonStyle(), padding: compact ? '5px 9px' : '7px 12px', fontSize: compact ? '10px' : '12px', color: installed(item) ? BRAND.danger : BRAND.primaryText, background: installed(item) ? BRAND.surface : BRAND.primaryFill, borderColor: installed(item) ? BRAND.border : 'transparent' },
      }, busyId === id(item) ? '处理中…' : installed(item) ? '卸载' : '安装') : null;
      const iconSquare = item => {
        const icon = item?.iconDataUrl || item?.iconUrl || item?.icon;
        return h('div', { style: { width: '42px', height: '42px', display: 'grid', placeItems: 'center', borderRadius: '11px', overflow: 'hidden', background: '#f2f0ff', color: '#6656c8', fontWeight: 800 } }, icon
          ? h('img', { src: icon, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', style: { width: '70%', height: '70%', objectFit: 'contain' } }) : String(label(item)).charAt(0).toUpperCase());
      };
      const row = item => h('article', { key: id(item), style: { display: 'flex', flexWrap: 'wrap', gap: '11px', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid ' + BRAND.border } },
        iconSquare(item),
        h('button', { type: 'button', onClick: () => setSelectedId(id(item)), style: { flex: '1 1 180px', minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left', color: BRAND.ink, cursor: 'pointer' } },
          h('strong', { style: { display: 'block', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label(item)),
          h('span', { style: { display: 'block', marginTop: '3px', color: BRAND.inkMuted, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.description || item.marketplaceName || item.marketplace || id(item))),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, h(Pill, { tone: !lifecycleAvailable(item) ? 'signal' : installed(item) ? 'accent' : 'neutral' }, stateLabel(item)), lifecycleButton(item, true)));
      const section = (title, rows) => rows.length ? h('section', null,
        h('h3', { style: { margin: '12px 0 0', color: BRAND.ink, fontSize: '15px' } }, `${title} · ${rows.length}`), rows.map(row)) : null;
      const detail = selected ? h('section', { style: { display: 'grid', gap: '12px' } },
        h('button', { type: 'button', onClick: () => setSelectedId(''), style: { ...buttonStyle(), justifySelf: 'start', background: BRAND.surface } }, '← 返回 Codex 插件'),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, iconSquare(selected), h('div', null,
            h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '17px' } }, label(selected)),
            h('code', { style: { display: 'block', marginTop: '5px', color: BRAND.inkMuted, fontSize: '10px', wordBreak: 'break-word' } }, id(selected)))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, h(Pill, { tone: !lifecycleAvailable(selected) ? 'signal' : 'accent' }, stateLabel(selected)), lifecycleButton(selected))),
        selected.description ? h('p', { style: { margin: 0, color: BRAND.ink, lineHeight: 1.65, fontSize: '12px', whiteSpace: 'pre-wrap' } }, selected.description) : null,
        h('dl', { style: { margin: 0, padding: '10px 0', borderTop: '1px solid ' + BRAND.border, borderBottom: '1px solid ' + BRAND.border, display: 'grid', gap: '6px' } },
          [['版本', selected.version], ['市场', selected.marketplaceName || selected.marketplace], ['来源', selected.source], ['分类', selected.category], ['状态', stateLabel(selected)]].map(([key, value]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: '10px', fontSize: '11px' } }, h('dt', { style: { color: BRAND.inkMuted } }, key), h('dd', { style: { margin: 0, color: BRAND.ink, wordBreak: 'break-word' } }, value || '—')))),
        selected.error ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.danger, whiteSpace: 'pre-wrap', fontSize: '12px' } }, selected.error.message || selected.error.diagnostic || selected.error.code || 'Codex 目录错误') : null,
        h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '插件在新建的 Codex Agent 会话中加载。需要登录的连接器沿用 Codex 授权状态。'),
        installed(selected) && selected.lifecycleAvailable !== false ? h(CodexPluginCapabilities, { key: `${id(selected)}:${revision}`, pluginId: id(selected) }) : null) : null;
      return h('div', { 'data-codex-plugin-center': 'true', style: { display: 'grid', gap: '13px' } },
        error ? h('p', { role: 'alert', style: { margin: 0, color: BRAND.signal, fontSize: '12px', lineHeight: 1.55 } }, error) : null,
        message ? h('p', { role: 'status', style: { margin: 0, color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
        authApps.length ? h('p', { role: 'status', style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px' } }, '以下连接器仍需授权：', authApps.map(app => h('span', { key: app.id, style: { marginLeft: '10px' } }, app.installUrl ? h('a', { href: app.installUrl, target: '_blank', rel: 'noopener noreferrer' }, app.name) : app.name))) : null,
        busyId ? h('p', { role: 'status', style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px' } }, '正在应用 Codex 插件变更，请稍候…') : null,
        selected ? detail : h(React.Fragment, null,
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索 Codex 插件', 'aria-label': '搜索 Codex 插件', style: { ...inputStyle(), marginTop: 0, flex: '1 1 260px' } }),
            h('button', { type: 'button', onClick: openInstall, disabled: Boolean(busyId), style: buttonStyle() }, '添加 Codex 插件'),
            h('button', { type: 'button', onClick: () => void load(), disabled: status === 'loading' || Boolean(busyId), style: buttonStyle() }, status === 'loading' ? '读取中…' : '刷新')),
          h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '安装状态与当前 Codex 配置共享。新建 Codex Agent 会话后加载插件，连接器仍需完成服务授权。'),
          status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取 Codex 插件目录', detail: '读取可用插件和当前安装状态。' }) : null,
          status !== 'loading' && visible.length ? h('div', { style: { maxHeight: 'min(65vh, 620px)', overflow: 'auto' } },
            section('已安装', visible.filter(installed)),
            section('精选', visible.filter(item => !installed(item) && item.featured && !normalized)),
            section('插件目录', visible.filter(item => !installed(item) && (normalized || !item.featured)))) : null,
          status === 'ready' && !visible.length ? h(EmptyState, { icon: '⌘', title: query.trim() ? '没有匹配的 Codex 插件' : '尚未发现 Codex 插件', detail: query.trim() ? '试试其他名称，或清空搜索查看全部插件。' : '可以点击添加 Codex 插件，输入插件名@市场名。市场需已在 Codex 中配置。' }) : null),
        installOpen ? h(ResourceDialog, { title: '添加 Codex 插件', detail: '输入完整插件标识，例如 plugin-name@marketplace。市场需要已在 Codex 中配置。', onClose: () => { if (!busyId) setInstallOpen(false); } },
          h('form', { onSubmit: async event => { event.preventDefault(); const pluginId = installSource.trim(); if (pluginId && await mutate({ pluginId }, 'install')) setInstallOpen(false); }, style: { display: 'grid', gap: '14px' } },
            h('input', { 'aria-label': 'Codex 插件标识', value: installSource, onChange: event => setInstallSource(event.target.value), required: true, placeholder: 'plugin-name@marketplace', style: inputStyle() }),
            error ? h('p', { role: 'alert', style: { color: BRAND.danger, whiteSpace: 'pre-wrap', margin: 0 } }, error) : null,
            h('button', { type: 'submit', disabled: Boolean(busyId) || !installSource.trim(), style: buttonStyle() }, busyId ? '正在安装…' : '安装插件'))) : null);
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
        h('td', { style: { padding: '10px 12px', display: 'flex', gap: '6px' } }, canRunBuild && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', onClick: () => window.__AGENTKIT_STUDIO_BIND_AGENT__?.({ agentId: selectedAgent, buildId: item.id }), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '在新会话运行') : null, directServerMode && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', onClick: () => downloadBuild(item.id), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '下载定义 ZIP') : null, canRunBuild && directServerMode && String(item.status || '').toUpperCase() === 'SUCCEEDED' ? h('button', { type: 'button', disabled: saving, onClick: () => exportPortableBuild(item.id), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '导出运行包') : null))) : h('tr', null, h('td', { colSpan: 4, style: { padding: '18px 12px', color: BRAND.inkMuted } }, '当前 Agent 还没有 Build。'));
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
