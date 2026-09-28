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
      const [mcpPreview, setMcpPreview] = useState(null);
      const [skillDialogOpen, setSkillDialogOpen] = useState(false);
      const [skillPreview, setSkillPreview] = useState(null);
      const [skillPreviewFile, setSkillPreviewFile] = useState(null);
      const [modelDialogOpen, setModelDialogOpen] = useState(false);
      const [toolDialogOpen, setToolDialogOpen] = useState(false);
      const [resourcePreview, setResourcePreview] = useState(null);
      const [deleting, setDeleting] = useState(false);
      const platformKinds = ['knowledge-base', 'memory-instance', 'skill-space'];
      const isPlatform = platformKinds.includes(resourceKind);
      const requestSeq = useRef(0);
      const resourceKinds = [
        ['model', '模型'], ['tool', 'Tool'], ['mcp', 'MCP'], ['skill', 'Skill'],
        ['knowledge-base', '知识库'], ['memory-instance', '记忆库'], ['skill-space', 'Skill Center'],
      ];
      const label = resourceKinds.find(item => item[0] === resourceKind)?.[1] || '资源';

      const load = async (kind = resourceKind, cursor = null, resetPaging = true) => {
        const seq = ++requestSeq.current;
        setStatus('loading'); setError(''); setMessage('');
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
      const reloadCatalog = () => load(resourceKind, null, true);
      const probeMcp = async resource => {
        setMessage(''); setError('');
        try {
          const result = await hostRemote.probeMcpResource(resource.resourceId);
          setMessage(`${resource.displayName || resource.name} 已探测，发现 ${result?.health?.toolCount || result?.toolCount || 0} 个 Tool。`);
          await reloadCatalog();
        } catch (reason) { setError(reason?.message || 'MCP 探测失败'); }
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
        if (typeof window !== 'undefined' && !window.confirm(`确定从资源目录删除“${name}”吗？Agent 已有的 Revision 不会被这里静默改写。`)) return;
        setDeleting(true); setError(''); setMessage('');
        try {
          await hostRemote.deleteResource(resource.resourceId);
          setMessage(`${name} 已从资源目录删除。需要变更 Agent 绑定时，请到 Agent 创建或编辑页提交新的 Revision。`);
          await reloadCatalog();
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
      const sourceLabel = item => item.source || item.provider || item.origin || '—';
      const kindDetail = item => item.contract?.model || item.contract?.entrypoint || item.contract?.transport || item.region || item.version || '—';
      const rows = isPlatform ? (platformCatalog?.items || []) : resources;
      const tableRows = rows.map(resource => {
            const id = resource.resourceId || resource.id || resource.name;
            const name = resource.displayName || resource.name || id;
            const canDelete = !isPlatform && resource.source === 'local';
            return h('tr', { key: id, style: { borderBottom: '1px solid ' + BRAND.border } },
              h('td', { style: { padding: '12px 13px', color: BRAND.ink } }, h('strong', null, name), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } }, id)),
              h('td', { style: { padding: '12px 13px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, sourceLabel(resource)),
              h('td', { style: { padding: '12px 13px', color: BRAND.inkMuted, whiteSpace: 'nowrap' } }, kindDetail(resource)),
              h('td', { style: { padding: '12px 13px', whiteSpace: 'nowrap' } }, h(Pill, { tone: resource.disabled ? 'signal' : String(resource.status || 'ready').toLowerCase() === 'ready' ? 'accent' : 'signal' }, resource.disabled ? '不可用' : resource.status || 'ready')),
              h('td', { style: { padding: '12px 13px', whiteSpace: 'nowrap' } },
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', { type: 'button', onClick: () => setResourcePreview(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看'),
                  resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => void probeMcp(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '重新探测') : null,
                  resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => setMcpPreview(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看工具') : null,
                  resourceKind === 'skill' ? h('button', { type: 'button', onClick: () => void previewInstalledSkill(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '查看文件') : null,
                  canDelete ? h('button', { type: 'button', disabled: deleting, onClick: () => void remove(resource), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px', color: BRAND.danger } }, '删除') : null,
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
          resourceKind === 'tool' ? h('button', { type: 'button', onClick: () => setToolDialogOpen(true), style: buttonStyle() }, '添加 Tool') : null,
          resourceKind === 'mcp' ? h('button', { type: 'button', onClick: () => setMcpDialogOpen(true), style: buttonStyle() }, '添加 MCP') : null,
          resourceKind === 'skill' ? h('button', { type: 'button', onClick: () => setSkillDialogOpen(true), style: buttonStyle() }, '扫描本地 Skill') : null,
          h('button', { type: 'button', onClick: () => void reloadCatalog(), style: buttonStyle() }, '刷新'),
          h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : 'Host 待接入')) }),
        h(StudioPageTabs, { ariaLabel: '资源类型', value: resourceKind, onChange: setResourceKind, items: resourceKinds.map(([id, value]) => ({ id, label: value })) }),
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
        toolDialogOpen ? h(ToolResourceDialog, { onClose: () => setToolDialogOpen(false), onCreated: reloadCatalog }) : null,
        mcpDialogOpen ? h(McpResourceDialog, { onClose: () => setMcpDialogOpen(false), onCreated: reloadCatalog }) : null,
        mcpPreview ? h(McpToolsDialog, { resource: mcpPreview, onClose: () => setMcpPreview(null) }) : null,
        skillDialogOpen ? h(SkillDiscoveryDialog, { onClose: () => setSkillDialogOpen(false), onImported: reloadCatalog }) : null,
        skillPreview ? h(SkillPreviewDialog, { title: skillPreview.title, preview: skillPreview.files, file: skillPreviewFile, onClose: () => { setSkillPreview(null); setSkillPreviewFile(null); }, onSelect: loadSkillFile }) : null,
        resourcePreview ? h(ResourceDialog, { title: resourcePreview.displayName || resourcePreview.name || resourcePreview.resourceId, detail: '只读查看 Host 资源声明。Agent 绑定关系不会在资源库页面修改。', onClose: () => setResourcePreview(null) }, h('pre', { style: { margin: 0, maxHeight: '520px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: BRAND.ink, background: BRAND.canvas, border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '12px', fontSize: '11px', lineHeight: 1.5 } }, JSON.stringify(resourcePreview, null, 2))) : null);
    }

    function MarketplacePage() {
      const [status, setStatus] = useState('loading');
      const [items, setItems] = useState([]);
      const [errors, setErrors] = useState([]);
      const [busyKey, setBusyKey] = useState('');
      const [message, setMessage] = useState('');
      const load = async () => {
        setStatus('loading');
        setMessage('');
        const results = await Promise.allSettled([hostRemote.dshPlugins(), hostRemote.codexPlugins()]);
        const next = [];
        const nextErrors = [];
        for (const [index, result] of results.entries()) {
          const ecosystem = index === 0 ? 'DSH' : 'Codex';
          if (result.status === 'fulfilled') {
            for (const item of (result.value?.items || [])) next.push({ ...item, ecosystem });
            if (result.value?.error?.message) nextErrors.push(`${ecosystem}：${result.value.error.message}`);
          } else nextErrors.push(`${ecosystem}：${result.reason?.message || '插件宿主不可用'}`);
        }
        setItems(next);
        setErrors(nextErrors);
        setStatus('ready');
      };
      const mutate = async (item, operation) => {
        const pluginId = String(item.pluginId || item.id || '').trim();
        if (!pluginId || busyKey) return;
        const key = `${item.ecosystem}:${pluginId}`;
        setBusyKey(key); setMessage(''); setErrors([]);
        try {
          if (item.ecosystem === 'dsh') {
            if (operation === 'install') {
              const source = item.source?.package || item.distributionName || pluginId;
              await hostRemote.installDshPlugin(source, true);
            } else if (operation === 'enable') await hostRemote.enableDshPlugin(pluginId);
            else if (operation === 'disable') await hostRemote.disableDshPlugin(pluginId);
            else if (operation === 'update') await hostRemote.updateDshPlugin(pluginId);
            else if (operation === 'uninstall') await hostRemote.uninstallDshPlugin(pluginId);
          } else if (operation === 'install') {
            await hostRemote.installCodexPlugin(pluginId, item.marketplaceName);
          } else if (operation === 'uninstall') {
            await hostRemote.uninstallCodexPlugin(pluginId);
          }
          setMessage(`${item.displayName || pluginId}：${operation === 'install' ? '已安装' : operation === 'uninstall' ? '已卸载' : operation === 'enable' ? '已启用' : operation === 'disable' ? '已停用' : '已更新'}。`);
          await load();
        } catch (reason) {
          setErrors([reason?.message || '插件操作失败']);
        } finally { setBusyKey(''); }
      };
      useEffect(() => { void load(); }, []);
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain', title: '插件市场', detail: '统一管理 DSH 与 Codex 两个插件生态；变更会调用对应 Host，并在 Profile 重载后生效。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? '目录已读取' : '正在读取') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取插件目录', detail: '分别询问 DSH Profile Host 和 Codex App Server。' }) : null,
        errors.length ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '10px 12px', borderRadius: '9px', background: 'var(--dsw-alias-state-warn-tertiary, #fff3da)', color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', fontSize: '12px' } }, errors.join('；')) : null,
        message ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '10px 12px', borderRadius: '9px', background: BRAND.accentSoft, color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
        status === 'ready' && items.length === 0 ? h(EmptyState, { icon: '⌘', title: '暂时没有可展示的插件', detail: '两个插件宿主都没有返回可见插件。', action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新读取') }) : null,
        items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' } }, items.map((item, index) => h('article', { key: `${item.ecosystem}-${item.pluginId || item.id || index}`, style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' } },
            h('div', null, h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '14px' } }, item.displayName || item.name || item.pluginId || '未命名插件'), h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '5px', wordBreak: 'break-all' } }, item.pluginId || item.id || '—')),
            h(Pill, { tone: item.ready || item.enabled || item.installed ? 'accent' : 'neutral' }, item.ecosystem)),
          h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.55, margin: '12px 0 0', fontSize: '12px' } }, item.description || item.interface?.shortDescription || '由插件生态提供的可选能力。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' } }, item.resolvedVersion ? h(Pill, null, 'v' + item.resolvedVersion) : null, item.providerRef ? h(Pill, { tone: 'accent' }, 'AgentProvider') : null, item.clientExtension ? h(Pill, null, '界面扩展') : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '14px' } },
            !item.installed ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => mutate(item, 'install'), style: buttonStyle() }, busyKey === `${item.ecosystem}:${item.pluginId || item.id}` ? '处理中…' : '安装') : null,
            item.installed && item.ecosystem === 'dsh' ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => mutate(item, item.enabled ? 'disable' : 'enable'), style: buttonStyle() }, item.enabled ? '停用' : '启用') : null,
            item.installed && item.ecosystem === 'dsh' ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => mutate(item, 'update'), style: buttonStyle() }, '更新') : null,
            item.installed ? h('button', { type: 'button', disabled: Boolean(busyKey), onClick: () => { if (window.confirm(`确定卸载 ${item.displayName || item.pluginId || item.id} 吗？`)) void mutate(item, 'uninstall'); }, style: { ...buttonStyle(), color: BRAND.danger } }, '卸载') : null,
          ),
        ))) : null,
        status === 'ready' ? h('button', { type: 'button', onClick: load, style: { ...buttonStyle(), marginTop: '16px' } }, '刷新目录') : null,
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
      const [workspace, setWorkspace] = useState(null);
      const [deployments, setDeployments] = useState([]);
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const load = async () => {
        setStatus('loading'); setError('');
        try {
          const [catalog, bootstrap, deploymentResult] = await Promise.all([
            hostRemote.resources({ limit: 200 }),
            hostRemote.bootstrap(),
            hostRemote.deployments(),
          ]);
          setResources(Array.isArray(catalog?.items) ? catalog.items : []);
          setWorkspace(bootstrap?.workspace || bootstrap || null);
          setDeployments(Array.isArray(deploymentResult?.items) ? deploymentResult.items : []);
          setStatus('ready');
        } catch (reason) { setStatus('error'); setError(reason?.message || '运行资源读取失败'); }
      };
      useEffect(() => { void load(); }, []);
      const normalized = query.trim().toLowerCase();
      const groups = [['model', '模型'], ['tool', 'Tool'], ['mcp', 'MCP Server'], ['skill', 'Skill']];
      const visible = resources.filter(item => !normalized || `${item.displayName || ''} ${item.name || ''} ${item.resourceId || ''}`.toLowerCase().includes(normalized));
      const readyCount = resources.filter(item => String(item.status || '').toLowerCase() === 'ready').length;
      const deploymentReady = deployments.filter(item => String(item.status || '').toUpperCase() === 'READY').length;
      return h('div', null,
        h(ContentIntro, { detail: '运行资源是当前 Host 可见的真实模型、Tool、MCP 和 Skill；状态来自 catalog，不在页面生成假数据。', action: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : status === 'loading' ? '读取中' : 'Host 待接入'), h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '刷新')) }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取运行资源', detail: '读取 Host catalog、工作区和部署回执。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '运行资源不可用', detail: error, action: h('button', { type: 'button', onClick: () => void load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('section', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' } },
            [['可见资源', resources.length], ['可用资源', readyCount], ['工作区', workspace?.path || workspace?.status || '已连接'], ['云端部署', deploymentReady ? `${deploymentReady} 已就绪` : '暂无就绪']].map(([label, value]) => h('div', { key: label, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } }, h('div', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, label), h('strong', { style: { display: 'block', marginTop: '6px', color: BRAND.ink, fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(value))))),
          h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '搜索运行资源', 'aria-label': '搜索运行资源', style: { ...inputStyle(), margin: '0 0 14px', maxWidth: '460px' } }),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' } }, groups.map(([kind, label]) => {
            const items = visible.filter(item => item.kind === kind).slice(0, 8);
            return h('section', { key: kind, style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface, overflow: 'hidden' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '13px 14px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, label), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${visible.filter(item => item.kind === kind).length} 项`)),
              items.length ? h('div', { style: { display: 'grid' } }, items.map(item => h('div', { key: item.resourceId, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '9px', padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border } }, h('div', { style: { minWidth: 0 } }, h('strong', { style: { display: 'block', color: BRAND.ink, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.displayName || item.name || item.resourceId), h('span', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, item.version || item.source || item.resourceId)), h(Pill, { tone: String(item.status || '').toLowerCase() === 'ready' ? 'accent' : 'signal' }, item.status || '未知')))) : h('div', { style: { padding: '20px 14px', color: BRAND.inkMuted, fontSize: '12px' } }, normalized ? '没有匹配资源。' : '暂无资源。'));
          }))
        ) : null);
    }

    function DeliveryPage() {
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
      const idempotency = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
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
          setMessage(`Build 已提交：${result?.buildId || result?.id || '等待异步完成'}`);
          await load(selectedAgent);
        } catch (reason) { setError(reason?.message || 'Build 提交失败'); }
        finally { setSaving(false); }
      };
      const createDeployment = async () => {
        if (!selectedBuild || saving) return;
        setSaving(true); setError(''); setMessage('');
        try {
          const result = await hostRemote.createDeployment(selectedBuild, {
            target: { region: region.trim(), environment: environment.trim() },
            binding: {},
            release_policy: { strategy: 'rolling', approval: 'none' },
          }, idempotency('studio-deploy'));
          setMessage(`部署已提交：${result?.operationId || result?.id || '等待异步完成'}`);
          await load(selectedAgent);
        } catch (reason) { setError(reason?.message || '部署提交失败'); }
        finally { setSaving(false); }
      };
      const cancel = async operationId => {
        try { await hostRemote.cancelOperation(operationId); await load(selectedAgent); }
        catch (reason) { setError(reason?.message || '取消操作失败'); }
      };
      const buildRows = builds.length ? builds.map(item => h('tr', { key: item.id, style: { borderBottom: '1px solid ' + BRAND.border } },
        h('td', { style: { padding: '10px 12px', color: BRAND.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' } }, item.id || '—'),
        h('td', { style: { padding: '10px 12px', color: BRAND.inkMuted } }, item.revision ? `Revision ${item.revision}` : '—'),
        h('td', { style: { padding: '10px 12px' } }, h(Pill, { tone: String(item.status || '').toUpperCase() === 'SUCCEEDED' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')))) : h('tr', null, h('td', { colSpan: 3, style: { padding: '18px 12px', color: BRAND.inkMuted } }, '当前 Agent 还没有 Build。'));
      return h('div', null,
        h(SectionHeading, { eyebrow: 'Studio domain / Delivery', title: '构建与部署', detail: 'Build 固化 Agent Revision；Deployment 只接受已成功的 Build，所有动作由本地 Host 通过异步 operation 承载。', action: h(Pill, { tone: status === 'ready' ? 'accent' : 'signal' }, status === 'ready' ? 'Host 已连接' : '读取中') }),
        status === 'loading' ? h(EmptyState, { icon: '·', title: '正在读取交付状态', detail: '读取 Agent、Build、Deployment 和 Operation。' }) : null,
        status === 'error' ? h(EmptyState, { icon: '!', title: '交付状态不可用', detail: error, action: h('button', { type: 'button', onClick: () => load(), style: buttonStyle() }, '重新读取') }) : null,
        status === 'ready' ? h(React.Fragment, null,
          h('section', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '12px', alignItems: 'end', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '目标 Agent', h('select', { value: selectedAgent, onChange: chooseAgent, style: inputStyle() }, agents.map(item => { const id = item?.metadata?.id || item?.id; return h('option', { key: id, value: id }, `${item?.metadata?.name || item?.name || id} · ${id}`); }))),
            h('button', { type: 'button', onClick: createBuild, disabled: saving || !selectedAgent, style: { ...buttonStyle(), color: saving || !selectedAgent ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !selectedAgent ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !selectedAgent ? BRAND.border : 'transparent' } }, saving ? '提交中…' : '构建当前 Revision')),
          h('section', { style: { marginTop: '14px', border: '1px solid ' + BRAND.border, borderRadius: '14px', overflow: 'hidden', background: BRAND.surface } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, 'Build 历史'), h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${builds.length} 个`)),
            h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } }, h('thead', null, h('tr', { style: { color: BRAND.inkMuted, textAlign: 'left', background: BRAND.canvas } }, ['Build', '版本', '状态'].map(label => h('th', { key: label, style: { padding: '10px 12px', fontWeight: 750 } }, label)))), h('tbody', null, buildRows))),
          h('section', { style: { marginTop: '14px', display: 'grid', gap: '12px', border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } },
            h('div', { style: { color: BRAND.ink, fontWeight: 800, fontSize: '14px' } }, '部署已成功的 Build'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 1fr 1fr auto', gap: '9px', alignItems: 'end' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Build', h('select', { value: selectedBuild, onChange: event => setSelectedBuild(event.target.value), style: inputStyle() }, h('option', { value: '' }, readyBuilds.length ? '请选择 Build' : '暂无成功 Build'), readyBuilds.map(item => h('option', { key: item.id, value: item.id }, `${item.id} · Revision ${item.revision || '—'}`)))),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '区域', h('input', { value: region, onChange: event => setRegion(event.target.value), style: inputStyle() })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '环境', h('input', { value: environment, onChange: event => setEnvironment(event.target.value), style: inputStyle() })),
              h('button', { type: 'button', onClick: createDeployment, disabled: saving || !selectedBuild, style: { ...buttonStyle(), color: saving || !selectedBuild ? BRAND.inkMuted : 'var(--dsw-static-neutral-00, #fff)', background: saving || !selectedBuild ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !selectedBuild ? BRAND.border : 'transparent' } }, '提交部署'))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginTop: '14px' } },
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '部署记录'), deployments.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, deployments.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, item.id || '—'), h(Pill, { tone: item.status === 'READY' ? 'accent' : 'signal' }, item.status || 'UNKNOWN')))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无部署记录。')),
            h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px', background: BRAND.surface } }, h('strong', { style: { color: BRAND.ink, fontSize: '14px' } }, '异步操作'), operations.length ? h('div', { style: { display: 'grid', gap: '8px', marginTop: '12px' } }, operations.slice(0, 8).map(item => h('div', { key: item.id, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', color: BRAND.inkMuted, fontSize: '11px' } }, h('span', null, `${item.kind || item.type || 'operation'} · ${item.status || 'UNKNOWN'}`), ['RUNNING', 'PENDING', 'ADMITTING', 'DEPLOYING'].includes(String(item.status || '').toUpperCase()) ? h('button', { type: 'button', onClick: () => cancel(item.id), style: { ...buttonStyle(), padding: '4px 7px', fontSize: '10px' } }, '取消') : null))) : h('p', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '暂无异步操作。'))),
          message ? h('div', { role: 'status', style: { marginTop: '12px', color: BRAND.accentStrong, fontSize: '12px' } }, message) : null,
          error ? h('div', { role: 'alert', style: { marginTop: '12px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
        ) : null);
    }
