import { resourceStatusPresentation } from '../state/resource-status.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createResourcePages({
  ui: { React: { createElement: h, useEffect, useRef, useState, Fragment }, ContentIntro, EmptyState, McpResourceDialog, McpToolsDialog, ModelResourceDialog, Pill, ResourceDialog, SkillDiscoveryDialog, SkillPreviewDialog, StudioPageTabs, buttonStyle, inputStyle, pagerButtonStyle, StudioSubnav, BRAND = DEFAULT_BRAND },
  hostRemote, actions, window = globalThis.window
}) {
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
      if (typeof window !== 'undefined' && !(await (actions.confirm({ title, detail, confirmLabel: cloud ? '删除云端 MCP' : '移除配置', danger: true })))) return;
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
      status === 'ready' ? h(Fragment, null,
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
      status === 'ready' ? h(Fragment, null,
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

  function UnsupportedStudioPage({ title, detail }) {
    return h('div', null,
      h(ContentIntro, { detail, action: h(Pill, { tone: 'signal' }, 'Host API 未接入') }),
      h(EmptyState, { icon: '·', title: title + '暂未接入', detail: '这个入口保留在产品信息架构中，但当前版本不会用假数据模拟。接入对应 Host 合同后再开放操作。' }));
  }

  function ResourceWorkspace() {
    const [tab, setTab] = useState(() => {
      try {
        const value = window.localStorage.getItem('agentkit-studio:resource-tab');
        if (value) window.localStorage.removeItem('agentkit-studio:resource-tab');
        return value === 'runtime-resources' ? value : 'models';
      } catch { return 'models'; }
    });
    return h('div', null,
      h(StudioSubnav, { value: tab, onChange: setTab, items: [{ id: 'models', label: '模型与工具' }, { id: 'runtime-resources', label: '运行资源' }] }),
      tab === 'models' ? h(ResourcesPage) : h(RuntimeResourcesPage));
  }
  return { ResourcesPage, RuntimeResourcesPage, ResourceWorkspace };
}
