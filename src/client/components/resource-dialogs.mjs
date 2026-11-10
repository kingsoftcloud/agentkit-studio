import { parseMcpJsonImport } from '../state/mcp-json-import.mjs';
import { buildSkillFileTree, formatResourceSize } from '../state/skill-files.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createResourceDialogs({
  ui: { React: { createElement: h, useState }, ResourceDialog, SecretInput, buttonStyle, inputStyle, Pill, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent
}) {
  function McpResourceDialog({ resource, onClose, onCreated }) {
    const [savedResourceId, setSavedResourceId] = useState(resource?.resourceId || '');
    const editing = Boolean(savedResourceId);
    const server = resource?.server || {};
    const existingEnvRefs = server.envRefs && typeof server.envRefs === 'object' ? server.envRefs : {};
    const existingAuthorization = String(existingEnvRefs.Authorization || '');
    const initialCredentialName = existingAuthorization.replace(/^env:\/\//, '');
    // Older records may hold a bare credential name; it resolves identically but
    // the store now only accepts explicit env:// references.
    const normalizeRef = value => { const raw = String(value || '').trim(); return !raw || raw.startsWith('env://') ? raw : `env://${raw}`; };
    const [form, setForm] = useState(() => ({
      displayName: String(resource?.displayName || resource?.name || ''), name: String(resource?.name || server.name || ''),
      description: String(resource?.description || ''), version: String(resource?.version || server.version || '1.0.0'),
      transport: String(server.transport || 'http'), endpointUrl: String(server.endpointUrl || ''), command: String(server.command || ''),
      args: Array.isArray(server.args) ? JSON.stringify(server.args) : '', apiKeyName: initialCredentialName, apiKeyValue: '',
      envRefs: Object.entries(existingEnvRefs).map(([key, value]) => `${key}=${normalizeRef(value)}`).join(', '),
    }));
    const [jsonDraft, setJsonDraft] = useState('');
    const [jsonError, setJsonError] = useState('');
    const [recognition, setRecognition] = useState(null);
    const [credentialValues, setCredentialValues] = useState({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [draftHeader, setDraftHeader] = useState('');
    const [draftCredential, setDraftCredential] = useState('');
    const [credentialError, setCredentialError] = useState('');
    // Advanced section: collapsed for a blank form, auto-expanded as soon as a
    // recognized or saved custom credential row exists. `null` means "follow
    // the row count"; a boolean is the user's explicit choice.
    const [credentialOpen, setCredentialOpen] = useState(null);
    const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
    const requiredCredentialNames = new Set((resource?.requiredCredentials || []).map(row => row.name));
    // Every envRefs row is a Host credential reference. Keep a per-header secret
    // input so non-Authorization headers (for example X-Service-Token) can also be
    // configured and rotated instead of silently probing without credentials.
    const envRefRows = String(form.envRefs || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
      const [key, reference] = item.split('=').map(part => part.trim());
      return { key: String(key || ''), reference: String(reference || ''), name: String(reference || '').replace(/^env:\/\//, '') };
    }).filter(row => row.key && row.reference.startsWith('env://') && row.name && !requiredCredentialNames.has(row.name))
      .filter(row => form.transport === 'stdio' || row.key.toLowerCase() !== 'authorization');
    const addCredentialRow = () => {
      setCredentialError('');
      const header = draftHeader.trim(), credential = draftCredential.trim();
      if (!header || !credential) { setCredentialError('请填写 Header 名称和凭证名称。'); return; }
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) { setCredentialError('Header 名称格式无效。'); return; }
      if (!/^[A-Za-z_][A-Za-z0-9_./:-]{0,127}$/.test(credential)) { setCredentialError('凭证名称需要以字母或下划线开头，只能包含字母、数字、点、短横线、下划线、冒号或斜杠。'); return; }
      setDraftHeader(''); setDraftCredential('');
      if (header.toLowerCase() === 'authorization') { setField('apiKeyName', credential); return; }
      const rows = String(form.envRefs || '').split(',').map(item => item.trim()).filter(Boolean)
        .filter(item => item.split('=')[0].trim().toLowerCase() !== header.toLowerCase());
      rows.push(`${header}=env://${credential}`);
      setField('envRefs', rows.join(', '));
    };
    // Grow with the pasted document instead of scrolling inside a five-line box.
    const jsonRows = Math.min(20, Math.max(6, String(jsonDraft || '').split('\n').length + 1));
    const credentialExpanded = credentialOpen === null ? envRefRows.length > 0 : credentialOpen;
    const selectedEntry = recognition?.entries?.[recognition.index] || null;
    const applyEntry = (entries, index) => {
      const entry = entries[index];
      if (!entry) return;
      const authorization = entry.credentialHeaders.find(row => row.target === 'header' && row.key.toLowerCase() === 'authorization');
      setRecognition({ entries, index });
      setForm(current => ({ ...current,
        displayName: entry.displayName || entry.key, name: entry.key,
        description: entry.description, version: entry.version, transport: entry.transport,
        endpointUrl: entry.transport === 'stdio' ? '' : entry.endpointUrl, command: entry.command,
        args: entry.args.length ? JSON.stringify(entry.args) : '',
        envRefs: entry.credentialHeaders.map(row => `${row.key}=env://${row.reference}`).join(', '),
        apiKeyName: authorization?.reference || '', apiKeyValue: authorization?.value || '',
      }));
      // Literal JSON secrets only enter this transient form state; saving writes
      // them to the Host credential service, never to the resource declaration.
      // Switching entries must also drop the previous entry's imported secrets.
      const keptNames = new Set([...requiredCredentialNames, ...entry.credentialHeaders.map(row => row.reference)]);
      setCredentialValues(current => {
        const next = Object.fromEntries(Object.entries(current).filter(([credentialName]) => keptNames.has(credentialName)));
        for (const row of entry.credentialHeaders) if (row !== authorization && row.value !== undefined && row.value !== '') next[row.reference] = row.value;
        return next;
      });
    };
    const importJson = () => {
      setJsonError('');
      const result = parseMcpJsonImport(jsonDraft);
      if (!result.ok) { setRecognition(null); setJsonError(result.error); return; }
      applyEntry(result.entries, 0);
      const invalid = result.entries[0]?.errors || [];
      if (invalid.length) setJsonError(invalid.join('；'));
    };
    const save = async event => {
      event.preventDefault();
      if (saving) return;
      setError('');
      const name = form.name.trim() || form.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!name || !form.displayName.trim()) { setError('请填写 MCP 名称和显示名称。'); return; }
      if (form.transport === 'http' || form.transport === 'sse') {
        const rawEndpoint = form.endpointUrl.trim();
        if (!rawEndpoint) { setError('HTTP/SSE MCP 需要填写服务地址。'); return; }
        let endpoint = null;
        try { endpoint = new URL(rawEndpoint); } catch { endpoint = null; }
        if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol)) { setError('服务地址需要是有效的 http(s) URL。'); return; }
        if (endpoint.username || endpoint.password) { setError('服务地址不能内嵌用户名或密码，请改用认证 Header。'); return; }
        if (rawEndpoint.includes('${')) { setError('服务地址包含 ${...} 变量，当前不支持替换，请填写真实地址。'); return; }
      }
      if (form.transport === 'stdio' && !form.command.trim()) { setError('stdio MCP 需要填写启动命令。'); return; }
      const envRefs = {}, invalidRefs = [];
      form.envRefs.split(',').map(item => item.trim()).filter(Boolean).forEach(item => {
        const [key, ref] = item.split('=').map(part => part.trim());
        if (!key || !ref) return;
        // Credential references are the only accepted form: a literal value here
        // would otherwise be persisted into the public MCP record on disk.
        if (!/^env:\/\/[A-Za-z_][A-Za-z0-9_./:-]{0,127}$/.test(ref)) invalidRefs.push(key);
        envRefs[key] = ref;
      });
      if (invalidRefs.length) { setError(`环境变量引用需要使用 env://凭证名称 格式：${invalidRefs.join('、')}`); return; }
      const credentialName = form.apiKeyName.trim();
      let args;
      try { args = form.args.trim().startsWith('[') ? JSON.parse(form.args) : form.args.split(/\s+/).filter(Boolean); if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error(); }
      catch { setError('命令参数请填写字符串 JSON 数组，例如 ["-y", "@acme/server"]'); return; }
      // Public headers and non-secret stdio env values recognized from JSON keep
      // their literal values; every secret stays an env:// reference above.
      const headers = { ...(server.headers && typeof server.headers === 'object' ? server.headers : {}), ...(selectedEntry?.publicHeaders || {}) };
      const environment = { ...(server.env && typeof server.env === 'object' ? server.env : {}), ...(selectedEntry?.publicEnv || {}) };
      setSaving(true);
      try {
        for (const [credential, value] of Object.entries(credentialValues)) if (String(value).trim()) await hostRemote.putCredential(credential, String(value).trim());
        if (credentialName && form.apiKeyValue.trim()) await hostRemote.putCredential(credentialName, form.apiKeyValue.trim());
        if (credentialName) envRefs[form.transport === 'stdio' ? credentialName : 'Authorization'] = `env://${credentialName}`;
        const payload = {
          displayName: form.displayName.trim(), description: form.description.trim(),
          ...(resource?.catalogRef ? { catalogRef: resource.catalogRef } : {}),
          server: { name, version: form.version.trim() || '1.0.0', transport: form.transport, endpointUrl: form.endpointUrl.trim() || undefined, command: form.command.trim() || undefined, args, envRefs,
            ...(Object.keys(headers).length ? { headers } : {}), ...(Object.keys(environment).length ? { env: environment } : {}) },
        };
        const saved = editing ? await hostRemote.updateMcpResource(savedResourceId, payload) : await hostRemote.createMcpResource(payload);
        const id = saved.resourceId || savedResourceId;
        setSavedResourceId(id);
        onCreated?.(saved);
        // A newly added MCP is not bindable until the Host has performed a
        // real probe and persisted its tool contract. The probe stays on the
        // Host; the browser never connects.
        try { await hostRemote.probeMcpResource(id); }
        catch (reason) { setError(`配置已保存，探测失败：${reason?.message || 'MCP 连接不可用'}。修改后重试会更新同一资源。`); return; }
        onCreated?.(saved);
        onClose();
      } catch (reason) { setError(reason?.message || (editing ? 'MCP 更新失败' : 'MCP 创建失败')); }
      finally { setSaving(false); }
    };
    const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { type, value: form[key], placeholder, onChange: event => setField(key, event.target.value), style: inputStyle() }));
    return h(ResourceDialog, { title: editing ? '编辑 MCP Server' : '添加 MCP Server', detail: '凭证只保存到 Host 凭证服务；修改后会重新探测工具契约。绑定关系请在 Agent 创建或编辑页维护。', onClose },
      h('form', { onSubmit: save, style: { display: 'grid', gap: '12px' } },
        resource?.setupReasons?.length || resource?.authorizationRequired ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.7 } }, [...(resource.setupReasons || []), ...(resource.authorizationRequired ? ['需要你在此服务重新授权；源应用的登录状态不会迁移。请使用服务提供的访问凭证。'] : [])].join('；')) : null,
        ...(resource?.requiredCredentials || []).map(row => h('label', { key: row.name, style: { display: 'grid', gap: '5px', fontSize: '12px' } }, `${row.header} · ${row.name}${row.configured ? '（已有凭证，可留空）' : ''}`, h(SecretInput, { label: row.name, value: credentialValues[row.name] || '', onChange: event => setCredentialValues({ ...credentialValues, [row.name]: event.target.value }), placeholder: '仅保存到本机凭证服务', style: inputStyle() }))),
        h('section', { style: { display: 'grid', gap: '8px', padding: '12px', border: '1px solid ' + BRAND.border, borderRadius: '10px', background: BRAND.canvas } },
          h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '12px' } }, '从 JSON 识别 MCP'),
          h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, '支持 Claude/Cursor 的 mcpServers、VS Code 的 servers，或直接粘贴单个或多个服务配置；自定义认证 Header 会转成本机凭证引用，密钥不会写入资源目录。'),
          h('textarea', { 'aria-label': 'MCP JSON', value: jsonDraft, onChange: event => setJsonDraft(event.target.value), placeholder: '{ "custom-header-mcp": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "X-Service-Token": "${MCP_TOKEN}" } } }', rows: jsonRows, style: { ...inputStyle(), minHeight: '140px', maxHeight: '360px', overflow: 'auto', resize: 'vertical', fieldSizing: 'content', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' } }),
          jsonError ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px' } }, jsonError) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h('button', { type: 'button', onClick: importJson, disabled: !jsonDraft.trim(), style: buttonStyle() }, '识别并填充')),
          recognition ? h('div', { 'data-studio-mcp-recognition': 'true', style: { display: 'grid', gap: '5px', padding: '10px', border: '1px solid ' + BRAND.border, borderRadius: '8px', background: BRAND.surface } },
            h('div', { style: { color: BRAND.ink, fontSize: '11px', fontWeight: 750 } }, `已识别 ${recognition.entries.length} 个 MCP：${recognition.entries.map(entry => entry.key).join('、')}`),
            recognition.entries.length > 1 ? h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '选择要导入的 MCP', h('select', { 'aria-label': '识别到的 MCP', value: String(recognition.index), onChange: event => { const index = Number(event.target.value); applyEntry(recognition.entries, index); setJsonError(recognition.entries[index]?.errors?.join('；') || ''); }, style: inputStyle() }, recognition.entries.map((entry, index) => h('option', { key: `${entry.key}:${index}`, value: String(index) }, `${entry.key} · ${entry.transport.toUpperCase()}${entry.errors.length ? ' · 需修正' : ''}`)))) : null,
            selectedEntry ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.6 } },
              h('div', null, `${selectedEntry.transport.toUpperCase()} · ${selectedEntry.transport === 'stdio' ? selectedEntry.command : selectedEntry.endpointUrl}`),
              selectedEntry.credentialHeaders.length ? h('div', null, `认证：${selectedEntry.credentialHeaders.map(row => row.key).join('、')}（凭证只保存到本机凭证服务）`) : null,
              Object.keys(selectedEntry.publicHeaders).length ? h('div', null, `固定 Header：${Object.keys(selectedEntry.publicHeaders).join('、')}`) : null,
              Object.keys(selectedEntry.publicEnv).length ? h('div', null, `固定环境变量：${Object.keys(selectedEntry.publicEnv).join('、')}`) : null,
              selectedEntry.warnings.length ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary, #8a5b13)' } }, selectedEntry.warnings.join('；')) : null,
              selectedEntry.errors.length ? h('div', { role: 'alert', style: { color: BRAND.danger } }, selectedEntry.errors.join('；')) : null) : null) : null),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('显示名称', 'displayName', '例如：企业搜索'), field('资源名称', 'name', '例如：enterprise-search')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('版本', 'version', '1.0.0'), h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '传输方式', h('select', { value: form.transport, onChange: event => setField('transport', event.target.value), style: inputStyle() }, h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE'), h('option', { value: 'stdio' }, 'stdio')))),
        field('说明', 'description', '这个 MCP 提供什么能力？'),
        (form.transport === 'stdio' ? field('启动命令', 'command', '例如：npx') : field('服务地址', 'endpointUrl', '例如：https://mcp.example.com')),
        form.transport === 'stdio' ? field('命令参数', 'args', '例如：-y @acme/search-mcp') : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('Authorization 凭证名称（可选）', 'apiKeyName', '例如：SEARCH_API_KEY'), field('Authorization 凭证值（仅本次保存）', 'apiKeyValue', '不会写入资源目录', 'password')),
        field('环境变量引用（可选）', 'envRefs', '例如：API_KEY=env://SEARCH_API_KEY'),
        h('details', { 'data-studio-mcp-credentials': 'true', open: credentialExpanded, onToggle: event => setCredentialOpen(event.currentTarget.open),
          style: { padding: '12px', border: '1px solid ' + BRAND.border, borderRadius: '10px', background: BRAND.canvas } },
          h('summary', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '12px', cursor: 'pointer' } }, '认证 Header / 环境变量凭证（进阶）'),
          h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, '自定义认证 Header 不常见，默认收起；从 JSON 识别到时会自动展开，也可以在下面手动添加。每行是一个 Header（stdio 为环境变量）到 Host 凭证的引用；留空表示沿用已保存的凭证，填写的值只会保存到本机凭证服务。Authorization 请使用上方两个输入框。'),
          envRefRows.length ? envRefRows.map(row => h('label', { key: `credential:${row.key}:${row.name}`, style: { display: 'grid', gap: '5px', marginTop: '4px', fontSize: '12px' } }, `${row.key} · ${row.name}（留空沿用已保存凭证）`,
            h(SecretInput, { label: row.name, value: credentialValues[row.name] || '', onChange: event => setCredentialValues(current => ({ ...current, [row.name]: event.target.value })), placeholder: '仅保存到本机凭证服务', style: inputStyle() })))
            : h('div', { 'data-studio-mcp-credential-empty': 'true', style: { color: BRAND.inkMuted, fontSize: '11px' } }, '还没有认证 Header 凭证。'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: '8px', alignItems: 'end', marginTop: '4px' } },
            h('label', { style: { display: 'grid', gap: '4px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Header 名称',
              h('input', { 'aria-label': '新增 Header 名称', value: draftHeader, placeholder: '例如：X-KIP-Token', onChange: event => setDraftHeader(event.target.value), style: inputStyle() })),
            h('label', { style: { display: 'grid', gap: '4px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '凭证名称',
              h('input', { 'aria-label': '新增 Header 凭证名称', value: draftCredential, placeholder: '例如：KIP_TOKEN', onChange: event => setDraftCredential(event.target.value), style: inputStyle() })),
            h('button', { type: 'button', onClick: addCredentialRow, disabled: !draftHeader.trim() || !draftCredential.trim(), style: buttonStyle() }, '添加')),
          credentialError ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px' } }, credentialError) : null),
        error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: saving ? BRAND.inkMuted : BRAND.primaryText, background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '正在探测…' : editing ? '保存修改并探测' : '保存并探测'))));
  }

  function SkillPreviewDialog({ title, preview, file, onClose, onSelect }) {
    const files = Array.isArray(preview?.files) ? preview.files : [];
    const [collapsed, setCollapsed] = useState(() => new Set());
    const tree = buildSkillFileTree(files);
    const renderNodes = (nodes, depth = 0) => nodes.map(node => {
      if (node.directory) {
        const isCollapsed = collapsed.has(node.path);
        return h('div', { key: `dir:${node.path}` },
          h('button', {
            type: 'button',
            'aria-expanded': !isCollapsed,
            onClick: () => setCollapsed(current => {
              const next = new Set(current);
              if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
              return next;
            }),
            style: { display: 'flex', alignItems: 'center', gap: '5px', width: '100%', border: 0, borderRadius: '7px', padding: `6px 8px 6px ${8 + depth * 14}px`, textAlign: 'left', color: BRAND.ink, background: 'transparent', cursor: 'pointer', fontSize: '11px', fontWeight: 750 },
          }, isCollapsed ? '▸' : '▾', '▰', h('span', { title: node.name }, node.name)),
          !isCollapsed ? h('div', null, renderNodes(node.children, depth + 1)) : null);
      }
      const selected = file?.path === node.path;
      return h('button', {
        key: `file:${node.path}`,
        type: 'button',
        'aria-selected': selected,
        onClick: () => onSelect?.(node.path),
        style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', border: 0, borderRadius: '7px', padding: `6px 8px 6px ${20 + depth * 14}px`, textAlign: 'left', color: BRAND.ink, background: selected ? BRAND.accentSoft : 'transparent', cursor: 'pointer', fontSize: '11px' },
      }, node.file?.kind === 'script' ? '▧' : '▤', h('span', { title: node.path, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.name));
    });
    return h(ResourceDialog, { title: title || 'Skill 预览', detail: '只读查看 Skill 文件；导入前不会写入工作区。目录树和文件内容都由 Host 读取。', onClose },
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(190px, 0.8fr) minmax(0, 1.6fr)', gap: '12px', minHeight: '300px' } },
        h('div', { role: 'tree', 'aria-label': 'Skill 文件树', style: { border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '8px', overflow: 'auto', background: BRAND.surface } }, files.length ? renderNodes(tree) : h('div', { style: { color: BRAND.inkMuted, padding: '10px', fontSize: '12px' } }, '没有可预览文件。')),
        h('div', { style: { minWidth: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: '8px' } },
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file ? `${file.path} · ${file.kind || 'text'} · ${formatResourceSize(file.size)}` : '选择左侧文件查看内容'),
          h('pre', { style: { margin: 0, minHeight: '260px', maxHeight: '460px', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '12px', color: BRAND.ink, background: BRAND.canvas, whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: 1.5 } }, file ? (file.content || `${file.path} · ${formatResourceSize(file.size)}`) : '选择左侧文件查看内容'))));
  }

  function McpToolsDialog({ resource, onClose }) {
    const tools = Array.isArray(resource?.contract?.discoveredTools) ? resource.contract.discoveredTools : (Array.isArray(resource?.health?.tools) ? resource.health.tools : []);
    return h(ResourceDialog, { title: `${resource?.displayName || resource?.name || 'MCP'} · 工具清单`, detail: '以下清单来自 Host 最近一次 MCP 探测；绑定关系请在 Agent 创建或编辑页维护。', onClose },
      tools.length ? h('div', { style: { display: 'grid', gap: '8px', maxHeight: '520px', overflow: 'auto' } }, tools.map(tool => h('article', { key: tool.name, style: { border: '1px solid ' + BRAND.border, borderRadius: '10px', padding: '10px 12px', background: BRAND.surface } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' } }, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, tool.name || '未命名 Tool'), h('span', { style: { color: BRAND.inkMuted, fontSize: '10px' } }, tool.version || tool.executor || 'MCP')),
        h('p', { style: { margin: '5px 0 0', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, tool.description || '没有描述'),
        h('div', { style: { marginTop: '6px', color: BRAND.inkMuted, fontSize: '10px' } }, `${tool.approval ? `审批：${tool.approval}` : '审批策略由 Host 决定'}${tool.sideEffect ? ` · 副作用：${tool.sideEffect}` : ''}`)))) : h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', padding: '20px 8px', textAlign: 'center' } }, 'Host 尚未返回工具清单，请先重新探测 MCP。'));
  }

  function SkillDiscoveryDialog({ onClose, onImported }) {
    const [scanPaths, setScanPaths] = useState('');
    const [discovery, setDiscovery] = useState(null);
    const [selected, setSelected] = useState([]);
    const [preview, setPreview] = useState(null);
    const [previewFile, setPreviewFile] = useState(null);
    const [status, setStatus] = useState('idle');
    const [error, setError] = useState('');
    const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
    const scan = async () => {
      setStatus('scanning'); setError(''); setPreview(null); setPreviewFile(null); setSelected([]);
      try { setDiscovery(await hostRemote.discoverSkills(scanPaths.split(',').map(item => item.trim()).filter(Boolean))); setStatus('ready'); }
      catch (reason) { setStatus('error'); setError(reason?.message || 'Skill 扫描失败'); }
    };
    const toggle = id => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    const showPreview = async candidate => {
      try { const files = await hostRemote.previewDiscoveredSkill(discovery.inspectionToken, candidate.candidateId); setPreview({ title: candidate.displayName || candidate.name, files, candidate }); setPreviewFile(null); }
      catch (reason) { setError(reason?.message || 'Skill 预览失败'); }
    };
    const selectFile = async path => {
      if (!preview) return;
      try { setPreviewFile(await hostRemote.previewDiscoveredSkill(discovery.inspectionToken, preview.candidate.candidateId, path)); }
      catch (reason) { setError(reason?.message || 'Skill 文件读取失败'); }
    };
    const commit = async () => {
      if (!discovery?.inspectionToken || !selected.length || status === 'committing') return;
      setStatus('committing'); setError('');
      try { for (const id of selected) await hostRemote.commitDiscoveredSkill(discovery.inspectionToken, id, false); onImported?.(); onClose(); }
      catch (reason) { setStatus('error'); setError(reason?.message || 'Skill 导入失败；冲突项需要重新扫描后确认覆盖。'); }
    };
    return h(ResourceDialog, { title: '发现本地 Skill', detail: '扫描默认目录或指定目录，预览后确认导入。', onClose },
      h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'end' } }, h('label', { style: { flex: 1, display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '扫描目录（逗号分隔）', h('input', { value: scanPaths, onChange: event => setScanPaths(event.target.value), placeholder: '留空扫描 skills, .agents/skills, .codex/skills, .claude/skills', style: inputStyle() })), h('button', { type: 'button', disabled: status === 'scanning', onClick: scan, style: buttonStyle() }, status === 'scanning' ? '扫描中…' : '扫描')),
        error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
        candidates.length ? h('div', { style: { display: 'grid', gap: '7px', maxHeight: '330px', overflow: 'auto' } }, candidates.map(candidate => h('div', { key: candidate.candidateId, style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '10px', border: '1px solid ' + BRAND.border, borderRadius: '9px', background: BRAND.surface } }, h('input', { type: 'checkbox', checked: selected.includes(candidate.candidateId), disabled: candidate.status === 'invalid', onChange: () => toggle(candidate.candidateId), 'aria-label': `选择 ${candidate.displayName || candidate.name}` }), h('div', { style: { flex: 1, minWidth: 0 } }, h('strong', { style: { color: BRAND.ink, fontSize: '12px' } }, candidate.displayName || candidate.name), h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', marginTop: '3px' } }, `${candidate.path || '—'} · ${candidate.version || '未知版本'} · ${candidate.fileCount || 0} 文件`), candidate.risk?.requiresReview ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', fontSize: '10px' } }, '包含脚本或网络标记，需人工复核') : null), h(Pill, { tone: candidate.status === 'ready' ? 'accent' : 'signal' }, candidate.status === 'conflict' ? '已安装' : candidate.status === 'invalid' ? '无效' : '可导入'), h('button', { type: 'button', onClick: () => void showPreview(candidate), style: { ...buttonStyle(), padding: '5px 8px', fontSize: '10px' } }, '预览')))) : status === 'ready' ? h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', padding: '22px 0', textAlign: 'center' } }, '安全扫描目录中没有发现 Skill。') : null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '3px' } }, h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, discovery ? `发现 ${candidates.length} 个候选 · 已选择 ${selected.length}` : '请先扫描'), h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'button', disabled: !selected.length || status === 'committing', onClick: commit, style: { ...buttonStyle(), color: !selected.length || status === 'committing' ? BRAND.inkMuted : BRAND.primaryText, background: !selected.length || status === 'committing' ? BRAND.accentSoft : BRAND.primaryFill, borderColor: !selected.length || status === 'committing' ? BRAND.border : 'transparent' } }, status === 'committing' ? '导入中…' : '导入选中 Skill')))),
        preview ? h(SkillPreviewDialog, { title: preview.title, preview: preview.files, onClose: () => setPreview(null), onSelect: async path => { await selectFile(path); }, file: previewFile }) : null);
  }

  function ModelResourceDialog({ onClose, onCreated }) {
    const [form, setForm] = useState({ name: '', displayName: '', model: '', endpointUrl: '', credentialRef: 'env://MODEL_API_KEY', description: '' });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [draftHeader, setDraftHeader] = useState('');
    const [draftCredential, setDraftCredential] = useState('');
    const [credentialError, setCredentialError] = useState('');
    // Advanced section: collapsed for a blank form, auto-expanded as soon as a
    // recognized or saved custom credential row exists. `null` means "follow
    // the row count"; a boolean is the user's explicit choice.
    const [credentialOpen, setCredentialOpen] = useState(null);
    const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
    const save = async event => {
      event.preventDefault();
      if (saving) return;
      const name = form.name.trim().toLowerCase();
      if (!/^[a-z][a-z0-9._-]{1,127}$/.test(name)) { setError('名称需要是 2-128 位小写字母、数字、点、下划线或短横线。'); return; }
      if (!form.displayName.trim() || !form.model.trim() || !form.endpointUrl.trim()) { setError('请填写显示名称、模型 ID 和接口地址。'); return; }
      setSaving(true); setError('');
      try {
        const result = await hostRemote.createModelResource({
          name,
          displayName: form.displayName.trim(),
          version: '1.0.0',
          description: form.description.trim(),
          spec: { provider: 'openai-compatible', model: form.model.trim(), endpointUrl: form.endpointUrl.trim(), credentialRef: form.credentialRef.trim() || undefined, wireApi: 'chat' },
        });
        window.dispatchEvent(new CustomEvent('agentkit-studio:model-changed'));
        onCreated?.(result); onClose();
      } catch (reason) { setError(reason?.message || '模型创建失败'); }
      finally { setSaving(false); }
    };
    const field = (label, key, placeholder, type = 'text') => h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { type, value: form[key], placeholder, onChange: event => setField(key, event.target.value), style: inputStyle() }));
    return h(ResourceDialog, { title: '添加模型资源', detail: '资源页只登记模型端点；API Key 由设置页和全局配置管理，Agent 绑定在创建或编辑页完成。', onClose },
      h('form', { onSubmit: save, style: { display: 'grid', gap: '12px' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('资源名称', 'name', 'ksyun-chat'), field('显示名称', 'displayName', '金山云 Chat')),
        field('模型 ID', 'model', 'deepseek-v4-flash'),
        field('接口地址', 'endpointUrl', 'https://api.example.com/v1/chat/completions'),
        field('凭证引用（可选）', 'credentialRef', 'env://MODEL_API_KEY'),
        field('说明（可选）', 'description', '模型用途和协议说明'),
        error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: saving ? BRAND.inkMuted : BRAND.primaryText, background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '创建中…' : '创建模型'))));
  }

  function ToolResourceDialog({ onClose, onCreated }) {
    const [form, setForm] = useState({ name: '', displayName: '', description: '', category: 'custom', executor: 'builtin' });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [draftHeader, setDraftHeader] = useState('');
    const [draftCredential, setDraftCredential] = useState('');
    const [credentialError, setCredentialError] = useState('');
    // Advanced section: collapsed for a blank form, auto-expanded as soon as a
    // recognized or saved custom credential row exists. `null` means "follow
    // the row count"; a boolean is the user's explicit choice.
    const [credentialOpen, setCredentialOpen] = useState(null);
    const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
    const save = async event => {
      event.preventDefault();
      if (saving) return;
      const name = form.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) { setError('Tool 名称需要使用字母、数字和下划线。'); return; }
      if (!form.displayName.trim()) { setError('请填写显示名称。'); return; }
      setSaving(true); setError('');
      try {
        const result = await hostRemote.createToolResource({ displayName: form.displayName.trim(), category: form.category.trim() || 'custom', contract: { name, version: '1.0.0', description: form.description.trim(), inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' }, executor: form.executor } });
        onCreated?.(result); onClose();
      } catch (reason) { setError(reason?.message || 'Tool 创建失败'); }
      finally { setSaving(false); }
    };
    const field = (label, key, placeholder) => h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, label, h('input', { value: form[key], placeholder, onChange: event => setField(key, event.target.value), style: inputStyle() }));
    return h(ResourceDialog, { title: '添加 Tool 资源', detail: '先登记 Tool Contract，再在 Agent 创建或编辑页选择一个或多个 Tool。', onClose },
      h('form', { onSubmit: save, style: { display: 'grid', gap: '12px' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('Tool 名称', 'name', 'lookup_customer'), field('显示名称', 'displayName', '客户查询')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('分类', 'category', 'custom'), h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '执行器', h('select', { value: form.executor, onChange: event => setField('executor', event.target.value), style: inputStyle() }, h('option', { value: 'builtin' }, 'builtin'), h('option', { value: 'deferred' }, 'deferred'), h('option', { value: 'python' }, 'python'), h('option', { value: 'mcp' }, 'mcp')))),
        field('说明（可选）', 'description', 'Tool 的用途和副作用'),
        error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: saving ? BRAND.inkMuted : BRAND.primaryText, background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '创建中…' : '创建 Tool'))));
  }
  return { McpResourceDialog, SkillPreviewDialog, McpToolsDialog, SkillDiscoveryDialog, ModelResourceDialog };
}
