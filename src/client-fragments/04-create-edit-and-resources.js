    function AgentEditPage({ agentId, onBack, onSaved }) {
      const [agent, setAgent] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        let alive = true;
        hostRemote.agent(agentId).then(value => { if (alive) setAgent(value?.draft || value); })
          .catch(reason => { if (alive) setError(reason?.message || '读取 Agent 失败'); });
        return () => { alive = false; };
      }, [agentId]);
      if (!agent) return h(EmptyState, { title: error || '正在读取 Agent', detail: '读取当前版本和已有绑定。', action: h('button', { onClick: onBack, style: buttonStyle() }, '返回 Agents') });
      return h(AgentCreatePage, { initialAgent: agent, onBack, onCreated: onSaved });
    }

    function AgentCreatePage({ initialAgent = null, onBack, onCreated }) {
      const editing = Boolean(initialAgent);
      const cloudEditing = editing && initialAgent?.source === 'agentengine-server';
      const originalSpec = initialAgent?.spec || {};
      const originalBindings = originalSpec.bindings || {};
      const idsOf = items => (items || []).map(item => typeof item === 'string' ? item : item.resourceId).filter(Boolean);
      const [step, setStep] = useState(0);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const [catalogStatus, setCatalogStatus] = useState('loading');
      const [catalog, setCatalog] = useState({ model: [], tool: [], mcp: [], skill: [] });
      const [selectedModel, setSelectedModel] = useState(originalBindings.modelProfileId || '');
      const [selectedModels, setSelectedModels] = useState(originalBindings.modelProfileIds || (originalBindings.modelProfileId ? [originalBindings.modelProfileId] : []));
      const [selectedTools, setSelectedTools] = useState(idsOf(originalBindings.tools));
      const [selectedMcp, setSelectedMcp] = useState(idsOf(originalBindings.mcpServers));
      const [selectedSkills, setSelectedSkills] = useState(idsOf(originalBindings.skills));
      const [platformBindings, setPlatformBindings] = useState(originalBindings.plugins || []);
      const [memoryEnabled, setMemoryEnabled] = useState(Boolean(originalSpec.memory?.enabled));
      const [policy, setPolicy] = useState(originalBindings.policyTemplate || 'strict');
      const [form, setForm] = useState({
        id: initialAgent?.metadata?.id || 'local-agent', name: initialAgent?.metadata?.name || '我的第一个 Agent', runtime: originalSpec.runtime?.type || 'dsh-native',
        description: originalSpec.description || '', prompt: originalSpec.instructions?.system || '', template: 'blank',
      });
      const runtimeOptions = [
        ...ALLOWED_RUNTIME_TYPES.map(runtimeType => ({ runtimeType, displayName: RUNTIME_LABELS[runtimeType] })),
        // A cloud Agent's server-owned framework is not a local authoring
        // runtime option, but it must remain visible while editing. Without
        // this option a disabled native <select> silently displays its first
        // entry (DSH Native) even when the Agent is actually langgraph,
        // hermes, openclaw or another AgentEngine runtime.
        ...(cloudEditing && form.runtime && !ALLOWED_RUNTIME_TYPES.includes(form.runtime)
          ? [{ runtimeType: form.runtime, displayName: `${form.runtime} · AgentEngine Server` }]
          : []),
      ];
      const runtimeLabel = runtimeOptions.find(item => item.runtimeType === form.runtime)?.displayName || form.runtime;
      const templates = [['blank', '通用助手', '通用问答起点，可自由修改提示词。', '你是一个可靠的通用助手，请直接回答用户问题；信息不足时先提出澄清问题。'], ['research', '研究助手', '适合资料检索、分析和带来源输出。', '你是研究助手。先明确问题与范围，优先使用已绑定的检索资源验证事实；回答给出来源，区分确认事实与推测。缺少资源或证据时直接说明，不得编造引用。']];
      const chooseTemplate = value => setForm(previous => {
        const next = templates.find(item => item[0] === value), old = templates.find(item => item[0] === previous.template);
        return { ...previous, template: value,
          name: previous.name === '我的第一个 Agent' || previous.name === old?.[1] ? next[1] : previous.name,
          description: !previous.description.trim() || previous.description === old?.[2] ? next[2] : previous.description,
          prompt: !previous.prompt.trim() || previous.prompt === old?.[3] ? next[3] : previous.prompt };
      });
      const steps = [['定义 Agent', '用途与提示词'], ['绑定能力', '模型、MCP、Skill 等资源'], ['运行策略', '执行目标与权限'], ['检查并创建', '确认后保存配置']];
      const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

      useEffect(() => {
        if (form.runtime === 'dsh-native' && !editing) setSelectedTools([]);
      }, [form.runtime]);

      useEffect(() => {
        let alive = true;
        setCatalogStatus('loading');
        Promise.allSettled(['model', 'tool', 'mcp', 'skill'].map(kind => kind === 'model' && form.runtime === 'codex' && !cloudEditing ? hostRemote.codexModels() : hostRemote.resources(kind)))
          .then(results => {
            if (!alive) return;
            const next = {};
            ['model', 'tool', 'mcp', 'skill'].forEach((kind, index) => {
              next[kind] = results[index]?.status === 'fulfilled' && Array.isArray(results[index].value?.items)
                ? results[index].value.items : [];
            });
            setCatalog(next);
            const defaultId = results[0]?.value?.defaultModel || next.model?.[0]?.resourceId || '';
            if (!editing || form.runtime === 'codex') {
              setSelectedModel(current => next.model.some(item => item.resourceId === current) ? current : defaultId);
              setSelectedModels(current => { const valid = current.filter(id => next.model.some(item => item.resourceId === id)); return valid.length ? valid : (defaultId ? [defaultId] : []); });
            }
            if (next.model.length) setCatalogStatus('ready');
            else {
              setCatalogStatus('error');
              const failed = results.find(result => result.status === 'rejected');
              setError(failed?.reason?.message || '模型资源目录读取失败');
            }
          });
        return () => { alive = false; };
      }, [form.runtime]);

      const canNext = step === 0
        ? Boolean(form.id.trim() && form.name.trim())
        : step === 1 || step === 3 ? (cloudEditing || (catalogStatus === 'ready' && Boolean(selectedModel))) : true;

      const create = async () => {
        if (saving || !form.id.trim() || !form.name.trim() || (!cloudEditing && (catalogStatus !== 'ready' || !selectedModel))) return;
        setSaving(true); setError('');
        const id = form.id.trim().toLowerCase();
        try {
          const prompt = form.prompt.trim() || form.description.trim() || templates.find(item => item[0] === form.template)?.[3] || templates[0][3];
          // The managed Harness executes through the local host process. Its
          // runtime admission contract requires this capability explicitly;
          // without it the build can succeed but conversation-surface must
          // fail closed with PLUGIN_PERMISSION_DENIED. MCP adds its own
          // network lease. DSH Native and Codex keep the deny-by-default
          // permission set because their native loops do not need the
          // KsADK host-user capability.
          const allowedPermissions = form.runtime === 'harness'
            ? ['process:host-user', ...(selectedMcp.length ? ['network:mcp'] : [])]
            : [];
          const spec = {
            ...originalSpec,
            description: form.description.trim() || '由 AgentKit Studio 本地创建',
            runtime: { ...originalSpec.runtime, type: form.runtime },
            instructions: { ...originalSpec.instructions, system: prompt, task: originalSpec.instructions?.task || '' },
            security: editing ? originalSpec.security : { toolPolicy: 'deny-by-default', allowedPermissions },
            bindings: {
              ...originalBindings,
              ...(!cloudEditing ? { modelProfileId: selectedModel, modelProfileIds: selectedModels.length ? selectedModels : [selectedModel] } : {}),
              policyTemplate: policy,
              tools: selectedTools.map(resourceId => (originalBindings.tools || []).find(item => item.resourceId === resourceId) || { resourceId }),
              mcpServers: selectedMcp.map(resourceId => (originalBindings.mcpServers || []).find(item => item.resourceId === resourceId) || { resourceId }),
              skills: selectedSkills.map(resourceId => (originalBindings.skills || []).find(item => item.resourceId === resourceId) || { resourceId }),
              plugins: platformBindings,
            },
            memory: { ...originalSpec.memory, providerRef: platformBindings.some(item => item?.config?.binding?.resource?.kind === 'memory-instance') ? 'binding://platform-memory-instance' : originalSpec.memory?.providerRef === 'binding://platform-memory-instance' ? 'local-default' : originalSpec.memory?.providerRef || 'local-default', enabled: memoryEnabled, recall: { ...originalSpec.memory?.recall, enabled: memoryEnabled } },
          };
          const created = editing ? await hostRemote.updateAgent(id, spec, initialAgent.metadata.revision, form.name.trim()) : await hostRemote.quickAuthorAgent({
            name: form.name.trim(), slug: id, runtimeType: form.runtime,
            template: form.template,
            description: form.description.trim() || '由 AgentKit Studio 本地创建', spec,
          });
          const metadata = created?.metadata || {};
          onCreated({ id: metadata.id || id, name: metadata.name || form.name.trim(), revision: metadata.revision || 1 });
        } catch (reason) { setError(reason?.message || '创建 Agent 失败'); }
        finally { setSaving(false); }
      };

      const templateCards = !editing ? h('details', { style: { marginBottom: '20px' } },
        h('summary', { style: { color: BRAND.inkMuted, fontSize: '12px', cursor: 'pointer' } }, '使用提示词模板（可选）'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginTop: '12px' } }, templates.map(([value, title, detail]) => h('button', {
          key: value, type: 'button', onClick: () => chooseTemplate(value),
          style: { minHeight: '88px', textAlign: 'left', border: '1px solid ' + (form.template === value ? BRAND.accentStrong : BRAND.border), borderRadius: '10px', padding: '13px', background: form.template === value ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' },
        }, h('div', { style: { fontWeight: 800, fontSize: '13px' } }, title), h('div', { style: { marginTop: '5px', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, detail))))) : null;

      const capabilityPicker = (kind, title, values, setValues) => h('section', {
        style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface },
      }, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '9px' } },
        h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, title),
        h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, `${values.length} 已选择`)),
      catalog[kind]?.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '7px' } }, catalog[kind].map(resource => {
        const id = resource.resourceId;
        const checked = values.includes(id);
        return h('label', { key: id, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 10px', border: '1px solid ' + (checked ? BRAND.accentStrong : BRAND.border), borderRadius: '8px', background: checked ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked, onChange: event => setValues(current => event.target.checked ? [...current, id] : current.filter(value => value !== id)) }),
          h('span', null, h('strong', { style: { display: 'block', fontSize: '12px' } }, resource.displayName || resource.name || id), h('span', { style: { display: 'block', marginTop: '2px', color: BRAND.inkMuted, fontSize: '10px' } }, resource.description || resource.version || id)));
      })) : h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', padding: '6px 0' } }, catalogStatus === 'loading' ? '正在读取目录…' : '暂无可用资源'));

      const stepContent = step === 0 ? h(React.Fragment, null,
        templateCards,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '14px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Agent ID', h('input', { value: form.id, disabled: editing, onChange: e => update('id', e.target.value), placeholder: 'local-agent', style: inputStyle() })),
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '名称', h('input', { value: form.name, onChange: e => update('name', e.target.value), placeholder: '我的 Agent', style: inputStyle() })),
          h('label', { style: { gridColumn: '1 / -1', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '用途描述', h('textarea', { value: form.description, onChange: e => update('description', e.target.value), placeholder: '例如：企业知识库问答与资料检索', rows: 4, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
          h('label', { style: { gridColumn: '1 / -1', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '运行时', h('select', { value: form.runtime, disabled: editing, onChange: e => update('runtime', e.target.value), style: inputStyle() }, runtimeOptions.map(item => h('option', { key: item.runtimeType, value: item.runtimeType }, item.displayName)))),
        ),
        h('label', { style: { display: 'block', marginTop: '14px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '角色与系统 Prompt', h('textarea', { value: form.prompt, disabled: cloudEditing, onChange: e => update('prompt', e.target.value), placeholder: cloudEditing ? '云端 Agent 的 Prompt 由 AgentEngine Server 管理' : '描述 Agent 的身份、边界和回答方式', rows: 5, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical', opacity: cloudEditing ? 0.65 : 1 } })),
      ) : step === 1 ? h(React.Fragment, null,
        cloudEditing ? h('div', { role: 'status', style: { marginBottom: '14px', padding: '11px 12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55 } }, '当前是云端 Agent。模型、MCP、本地 Skill 和 Tool 由 AgentEngine Runtime 自身管理；本页只保存知识库、记忆库和 Skill Center 这三类云端 ComponentConfig。') : null,
        !cloudEditing ? h('div', { style: { marginBottom: '14px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55 } }, '模型、MCP、Skill 支持多选；知识库和记忆库各选一个。保存后形成新的 Agent 配置版本。') : null,
        !cloudEditing && form.runtime === 'codex' ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, '可选 Codex 账户模型或已配置的网关模型；网关模型使用对应提供商的凭证和 API 设置。导出运行包时只支持网关模型。') : null,
        !cloudEditing ? h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface, marginBottom: '10px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '默认模型', h('select', { value: selectedModel, onChange: event => { setSelectedModel(event.target.value); setSelectedModels(current => current.includes(event.target.value) ? current : [event.target.value, ...current]); }, style: inputStyle() }, h('option', { value: '' }, catalogStatus === 'loading' ? '正在读取模型…' : '请选择模型'), catalog.model.map(resource => h('option', { key: resource.resourceId, value: resource.resourceId }, `${resource.displayName || resource.name} · ${resource.resourceId}`)))),
          h('div', { style: { marginTop: '12px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '可用模型（可多选）'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '7px', marginTop: '7px' } }, catalog.model.map(resource => {
            const checked = selectedModels.includes(resource.resourceId);
            return h('label', { key: resource.resourceId, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 9px', border: '1px solid ' + (checked ? BRAND.accentStrong : BRAND.border), borderRadius: '8px', background: checked ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } }, h('input', { type: 'checkbox', checked, onChange: event => setSelectedModels(current => event.target.checked ? [...current, resource.resourceId] : current.filter(id => id !== resource.resourceId)) }), h('span', null, resource.displayName || resource.name || resource.resourceId));
          }))) : null,
        !cloudEditing && form.runtime === 'dsh-native'
          ? h('div', { style: { marginBottom: '10px', padding: '11px 12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, 'DSH Native 使用 DSH 自身的工具循环；本次创建不会绑定 KsADK 原生 Tool。MCP、Skill 和平台资源仍可按需绑定。')
          : !cloudEditing ? capabilityPicker('tool', 'Tools', selectedTools, setSelectedTools) : null,
        !cloudEditing ? capabilityPicker('mcp', 'MCP Servers', selectedMcp, setSelectedMcp) : null,
        !cloudEditing ? capabilityPicker('skill', 'Skills', selectedSkills, setSelectedSkills) : null,
        h(PlatformResourcePicker, { value: platformBindings, onChange: setPlatformBindings, onMemory: value => setMemoryEnabled(value) }),
      ) : step === 2 ? h(React.Fragment, null,
        h('h3', { style: { margin: '0 0 6px', color: BRAND.ink, fontSize: '16px' } }, '运行目标与策略'),
        h('p', { style: { margin: '0 0 16px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55 } }, '运行目标会写入 Agent Revision。DSH Native 使用本地原生循环，AgentKit Harness 和 Codex 由各自运行端执行。'),
        h('div', { style: { display: 'grid', gap: '8px' } }, runtimeOptions.map(item => h('button', { key: item.runtimeType, type: 'button', onClick: () => update('runtime', item.runtimeType), style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', border: '1px solid ' + (form.runtime === item.runtimeType ? BRAND.accentStrong : BRAND.border), borderRadius: '10px', padding: '14px', background: form.runtime === item.runtimeType ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } }, h('span', null, h('strong', { style: { display: 'block', fontSize: '13px' } }, item.displayName), h('span', { style: { display: 'block', marginTop: '4px', color: BRAND.inkMuted, fontSize: '11px' } }, item.runtimeType)), form.runtime === item.runtimeType ? h(Pill, { tone: 'accent' }, '已选择') : null))),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px' } },
          h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '权限策略', h('select', { value: policy, onChange: event => setPolicy(event.target.value), style: inputStyle() }, h('option', { value: 'strict' }, '严格权限'), h('option', { value: 'loose' }, '宽松权限'), h('option', { value: 'custom' }, '自定义权限'))),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '23px', color: BRAND.ink, fontSize: '12px', fontWeight: 700 } }, h('input', { type: 'checkbox', checked: memoryEnabled, onChange: event => setMemoryEnabled(event.target.checked) }), '启用跨会话记忆')),
        h('div', { style: { marginTop: '18px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '运行目标属于 Agent Revision；权限策略和记忆开关会随本次创建一起保存。'),
      ) : h(React.Fragment, null,
        h('h3', { style: { margin: '0 0 14px', color: BRAND.ink, fontSize: '16px' } }, '检查并创建'),
        h('div', { style: { display: 'grid', borderTop: '1px solid ' + BRAND.border } }, [['Agent ID', form.id.trim().toLowerCase()], ['名称', form.name.trim()], ['运行目标', runtimeLabel], ['默认模型', catalog.model.find(item => item.resourceId === selectedModel)?.displayName || selectedModel || '未选择'], ['模型白名单', `${selectedModels.length || (selectedModel ? 1 : 0)} 个`], ['能力', `${selectedTools.length} Tool · ${selectedMcp.length} MCP · ${selectedSkills.length} Skill`], ['平台资源', `${platformBindings.length} 项（知识库 / 记忆库 / Skill Center）`], ['记忆', memoryEnabled ? '已启用' : '未启用'], ['模板', templates.find(item => item[0] === form.template)?.[1]]].map(([label, value]) => h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: '20px', padding: '12px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: '12px' } }, h('span', { style: { color: BRAND.inkMuted } }, label), h('strong', { style: { color: BRAND.ink, textAlign: 'right' } }, value)))),
        h('div', { style: { marginTop: '16px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, editing ? (cloudEditing ? '保存后调用 AgentEngine UpdateAgent；云端已有会话继续使用旧快照，新运行使用更新后的组件绑定。' : `保存后创建新的配置版本；当前版本为 r${initialAgent.metadata.revision}。已有会话和构建不会被自动切换。`) : '创建后保存 Prompt、模型和资源绑定，随后可构建并开始对话。'),
      );
      return h('div', { 'data-studio-agent-form': true },
        h(SectionHeading, { title: editing ? '编辑 Agent' : '手动配置 Agent', detail: '直接填写提示词、资源绑定和运行策略，检查后保存。', action: h('button', { type: 'button', onClick: onBack, style: buttonStyle() }, '返回 Agents') }),
        h('section', { 'data-agent-form-layout': true, style: { display: 'grid', gridTemplateColumns: '210px minmax(0, 1fr)', gap: '20px', alignItems: 'start' } },
          h('aside', { 'data-agent-form-steps': true, style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '12px', background: BRAND.surface } },
            h('div', { style: { color: BRAND.inkMuted, fontSize: '10px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '8px 10px 12px' } }, '创建流程'),
            h('div', null, steps.map(([label, detail], index) => h('button', { key: label, type: 'button', onClick: () => (editing || index <= step) && setStep(index), style: { display: 'block', width: '100%', border: 0, borderLeft: '2px solid ' + (index === step ? BRAND.accentStrong : BRAND.border), borderRadius: '0 8px 8px 0', padding: '10px 10px 10px 12px', textAlign: 'left', color: index === step ? BRAND.ink : BRAND.inkMuted, background: index === step ? BRAND.accentSoft : 'transparent', cursor: editing || index <= step ? 'pointer' : 'default' } }, h('div', { style: { fontSize: '12px', fontWeight: 800 } }, `${index + 1}. ${label}`), h('div', { style: { marginTop: '3px', fontSize: '10px', lineHeight: 1.45 } }, detail)))),
            h('div', { style: { margin: '14px 10px 6px', paddingTop: '12px', borderTop: '1px solid ' + BRAND.border, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.55 } }, '模型、MCP、Skill、知识库、记忆库、Prompt 和记忆策略可在本次创建直接绑定；创建后仍可在 Agent 详情中继续编辑。')),
          h('div', { 'data-agent-form-body': true, style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '22px', background: BRAND.surface, minWidth: 0 } },
            stepContent,
            error ? h('div', { role: 'alert', style: { marginTop: '16px', color: BRAND.danger, fontSize: '12px' } }, error) : null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '24px' } },
              h('button', { type: 'button', onClick: step === 0 ? onBack : () => setStep(step - 1), style: buttonStyle() }, step === 0 ? '取消' : '上一步'),
              step < 3 ? h('button', { type: 'button', disabled: !canNext, onClick: () => setStep(step + 1), style: { ...buttonStyle(), color: canNext ? BRAND.primaryText : BRAND.inkMuted, background: canNext ? BRAND.primaryFill : BRAND.accentSoft, borderColor: canNext ? 'transparent' : BRAND.border } }, '下一步') : h('button', { type: 'button', disabled: saving || !canNext, onClick: create, style: { ...buttonStyle(), color: saving || !canNext ? BRAND.inkMuted : BRAND.primaryText, background: saving || !canNext ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving || !canNext ? BRAND.border : 'transparent' } }, saving ? '保存中…' : editing ? '保存 Agent' : '创建 Agent'))
          )
        )
      );
    }

    function inputStyle() {
      return { display: 'block', boxSizing: 'border-box', width: '100%', height: '32px', marginTop: '6px', padding: '0 8px', border: '0.5px solid ' + BRAND.controlBorder, borderRadius: 'var(--dsw-radius-md, 12px)', color: BRAND.ink, background: BRAND.surface, fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px' };
    }

    function buttonStyle() {
      return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px', minHeight: '36px', boxSizing: 'border-box', border: '0.5px solid ' + BRAND.border, borderRadius: 'var(--dsw-radius-md, 12px)', padding: '0 14px', color: BRAND.ink, background: 'transparent', fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px', fontWeight: 500, cursor: 'pointer' };
    }

    function pagerButtonStyle(disabled = false) {
      return {
        ...buttonStyle(), display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: '68px', minHeight: '30px', padding: '6px 10px', flex: '0 0 auto',
        color: disabled ? 'var(--dsw-alias-label-secondary, #676767)' : BRAND.ink,
        background: disabled ? 'var(--dsw-alias-bg-layer-2, #f4f4f4)' : BRAND.surface,
        border: '1px solid ' + BRAND.border,
        opacity: 1,
      };
    }

    function DomainPage({ page }) {
      const content = {
        agents: ['Agent', '创建、配置和版本化可运行的 Agent。', '✦', 'Agent Catalog 与 Revision 接通后，这里会成为 Agent 的工作台。'],
        runtime: ['运行时', '选择执行目标，查看能力和运行状态。', '⌁', '当前 Agent 运行目标为 DSH Native、AgentKit Harness 和 Codex；不绑定 Agent 时使用 DSH 原生会话。资源绑定会在运行能力未就绪时明确阻止构建。'],
        resources: ['资源', '管理模型、工具、MCP 与 Skill 的目录生命周期。', '◈', '资源目录只负责发现、导入、探测、查看、刷新和删除；Agent 绑定在创建或编辑页完成。'],
        delivery: ['构建与部署', '从 Revision 到 Build、Deploy 和回滚。', '↗', '云端 API gap 完成核对后，这里接入真实异步 operation 和部署状态。'],
      }[page];
      return h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '22px', background: BRAND.surface } },
        h(SectionHeading, { eyebrow: 'Studio domain', title: content[0], detail: content[1], action: h(Pill, { tone: 'signal' }, 'Host 待接入') }),
        h(EmptyState, { icon: content[2], title: content[0] + '正在准备', detail: content[3], action: h(DisabledAction, null, '等待 Host 能力') }));
    }

    function ResourceDialog({ title, detail, children, onClose, wide = false }) {
      return h('div', {
        role: 'presentation',
        onMouseDown: event => { if (event.target === event.currentTarget) onClose(); },
        style: { position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: '24px', background: 'rgba(7, 14, 24, 0.46)' },
      }, h('section', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-studio-dialog': 'true',
        style: { width: `min(${wide ? 920 : 680}px, 100%)`, maxHeight: 'min(760px, calc(100vh - 48px))', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface, boxShadow: '0 22px 70px rgba(7, 14, 24, 0.28)' },
      }, h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', marginBottom: '16px' } },
        h('div', null, h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '18px' } }, title), detail ? h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.5 } }, detail) : null),
        h('button', { type: 'button', 'aria-label': '关闭', onClick: onClose, style: { ...buttonStyle(), padding: '5px 9px', fontSize: '14px' } }, '×')),
        children));
    }

    function McpResourceDialog({ resource, onClose, onCreated }) {
      const [savedResourceId, setSavedResourceId] = useState(resource?.resourceId || '');
      const editing = Boolean(savedResourceId);
      const server = resource?.server || {};
      const existingEnvRefs = server.envRefs && typeof server.envRefs === 'object' ? server.envRefs : {};
      const existingAuthorization = String(existingEnvRefs.Authorization || '');
      const initialCredentialName = existingAuthorization.startsWith('env://') ? existingAuthorization.slice(6) : '';
      const [form, setForm] = useState(() => ({
        displayName: String(resource?.displayName || resource?.name || ''), name: String(resource?.name || server.name || ''),
        description: String(resource?.description || ''), version: String(resource?.version || server.version || '1.0.0'),
        transport: String(server.transport || 'http'), endpointUrl: String(server.endpointUrl || ''), command: String(server.command || ''),
        args: Array.isArray(server.args) ? server.args.join(' ') : '', apiKeyName: initialCredentialName, apiKeyValue: '',
        envRefs: Object.entries(existingEnvRefs).map(([key, value]) => `${key}=${value}`).join(', '),
      }));
      const [jsonDraft, setJsonDraft] = useState('');
      const [jsonError, setJsonError] = useState('');
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }));
      const importJson = () => {
        setJsonError('');
        let parsed;
        try { parsed = JSON.parse(jsonDraft); }
        catch { setJsonError('JSON 格式无法解析，请粘贴完整的 mcpServers 配置。'); return; }
        const entries = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? Object.entries(parsed.mcpServers) : [];
        if (!entries.length || !entries[0][1] || typeof entries[0][1] !== 'object') { setJsonError('没有找到 mcpServers 配置。'); return; }
        const [key, descriptor] = entries[0];
        const headers = descriptor.headers && typeof descriptor.headers === 'object' ? descriptor.headers : {};
        const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        const match = String(authorization || '').match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
        const credentialName = match?.[1] || '';
        const rawUrl = String(descriptor.url || descriptor.endpointUrl || '').trim();
        const endpointUrl = rawUrl.replace(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/, '$2');
        const declaredType = String(descriptor.type || descriptor.transport || '').toLowerCase();
        const transport = declaredType === 'stdio' || descriptor.command ? 'stdio' : 'http';
        const envRefs = credentialName ? `Authorization=env://${credentialName}` : '';
        if (!String(key).trim() || (transport === 'http' && !/^https?:\/\//i.test(endpointUrl)) || (transport === 'stdio' && !String(descriptor.command || '').trim())) {
          setJsonError('配置缺少有效的 MCP 名称或 Endpoint。'); return;
        }
        setForm(current => ({ ...current,
          displayName: String(descriptor.name || key), name: String(key),
          description: String(descriptor.description || ''), version: String(descriptor.version || '1.0.0'),
          transport, endpointUrl: transport === 'http' ? endpointUrl : '', command: String(descriptor.command || ''),
          args: Array.isArray(descriptor.args) ? descriptor.args.join(' ') : '',
          apiKeyName: credentialName, apiKeyValue: '', envRefs,
        }));
      };
      const save = async event => {
        event.preventDefault();
        if (saving) return;
        setError('');
        const name = form.name.trim() || form.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!name || !form.displayName.trim()) { setError('请填写 MCP 名称和显示名称。'); return; }
        if ((form.transport === 'http' || form.transport === 'sse') && !form.endpointUrl.trim()) { setError('HTTP/SSE MCP 需要填写服务地址。'); return; }
        if (form.transport === 'stdio' && !form.command.trim()) { setError('stdio MCP 需要填写启动命令。'); return; }
        const envRefs = {};
        form.envRefs.split(',').map(item => item.trim()).filter(Boolean).forEach(item => { const [key, ref] = item.split('=').map(part => part.trim()); if (key && ref) envRefs[key] = ref; });
        const credentialName = form.apiKeyName.trim();
        setSaving(true);
        try {
          if (credentialName && form.apiKeyValue.trim()) await hostRemote.putCredential(credentialName, form.apiKeyValue.trim());
          if (credentialName) envRefs[form.transport === 'stdio' ? credentialName : 'Authorization'] = `env://${credentialName}`;
          const payload = {
            displayName: form.displayName.trim(), description: form.description.trim(),
            server: { name, version: form.version.trim() || '1.0.0', transport: form.transport, endpointUrl: form.endpointUrl.trim() || undefined, command: form.command.trim() || undefined, args: form.args.split(/\s+/).map(item => item.trim()).filter(Boolean), envRefs },
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
          h('section', { style: { display: 'grid', gap: '8px', padding: '12px', border: '1px solid ' + BRAND.border, borderRadius: '10px', background: BRAND.canvas } },
            h('div', { style: { color: BRAND.ink, fontWeight: 750, fontSize: '12px' } }, '从 JSON 识别 MCP'),
            h('p', { style: { margin: 0, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, '支持 mcpServers 配置；只读取名称、说明、Endpoint 和环境变量引用，不会把 JSON 中的密钥写入资源目录。'),
            h('textarea', { 'aria-label': 'MCP JSON', value: jsonDraft, onChange: event => setJsonDraft(event.target.value), placeholder: '{ "mcpServers": { "search": { "type": "streamable-http", "url": "https://...", "headers": { "Authorization": "Bearer ${SEARCH_API_KEY}" } } } }', rows: 5, style: { ...inputStyle(), resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' } }),
            jsonError ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '11px' } }, jsonError) : null,
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h('button', { type: 'button', onClick: importJson, disabled: !jsonDraft.trim(), style: buttonStyle() }, '识别并填充'))),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('显示名称', 'displayName', '例如：企业搜索'), field('资源名称', 'name', '例如：enterprise-search')),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('版本', 'version', '1.0.0'), h('label', { style: { display: 'grid', gap: '5px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '传输方式', h('select', { value: form.transport, onChange: event => setField('transport', event.target.value), style: inputStyle() }, h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE'), h('option', { value: 'stdio' }, 'stdio')))),
          field('说明', 'description', '这个 MCP 提供什么能力？'),
          (form.transport === 'stdio' ? field('启动命令', 'command', '例如：npx') : field('服务地址', 'endpointUrl', '例如：https://mcp.example.com')),
          form.transport === 'stdio' ? field('命令参数', 'args', '例如：-y @acme/search-mcp') : null,
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, field('凭证名称（可选）', 'apiKeyName', '例如：SEARCH_API_KEY'), field('API Key（仅本次保存）', 'apiKeyValue', '不会写入资源目录', 'password')),
          field('环境变量引用（可选）', 'envRefs', '例如：API_KEY=env://SEARCH_API_KEY'),
          error ? h('div', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: BRAND.primaryText, background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '正在探测…' : editing ? '保存修改并探测' : '保存并探测'))));
    }

    function formatResourceSize(value) {
      const bytes = Number(value || 0);
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    }

    // Keep the file tree in the browser surface, but let the Host remain the
    // only authority that reads file contents. The browser renders the file
    // tree from that contract without adding a second resource store.
    function buildSkillFileTree(files) {
      const root = { name: '', path: '', directory: true, children: [] };
      for (const file of files) {
        const parts = String(file?.path || '').split('/').filter(Boolean);
        let parent = root;
        parts.forEach((part, index) => {
          const path = parts.slice(0, index + 1).join('/');
          const directory = index < parts.length - 1;
          let node = parent.children.find(item => item.name === part && item.directory === directory);
          if (!node) {
            node = { name: part, path, directory, file: directory ? undefined : file, children: [] };
            parent.children.push(node);
          }
          parent = node;
        });
      }
      const sortNodes = nodes => {
        nodes.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
        nodes.forEach(node => sortNodes(node.children));
      };
      sortNodes(root.children);
      return root.children;
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
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '3px' } }, h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, discovery ? `发现 ${candidates.length} 个候选 · 已选择 ${selected.length}` : '请先扫描'), h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'button', disabled: !selected.length || status === 'committing', onClick: commit, style: { ...buttonStyle(), color: BRAND.primaryText, background: !selected.length || status === 'committing' ? BRAND.accentSoft : BRAND.primaryFill, borderColor: !selected.length || status === 'committing' ? BRAND.border : 'transparent' } }, status === 'committing' ? '导入中…' : '导入选中 Skill')))),
          preview ? h(SkillPreviewDialog, { title: preview.title, preview: preview.files, onClose: () => setPreview(null), onSelect: async path => { await selectFile(path); }, file: previewFile }) : null);
    }

    function ModelResourceDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({ name: '', displayName: '', model: '', endpointUrl: '', credentialRef: 'env://MODEL_API_KEY', description: '' });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
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
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: BRAND.primaryText, background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '创建中…' : '创建模型'))));
    }

    function ToolResourceDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({ name: '', displayName: '', description: '', category: 'custom', executor: 'builtin' });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
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
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, h('button', { type: 'button', onClick: onClose, style: buttonStyle() }, '取消'), h('button', { type: 'submit', disabled: saving, style: { ...buttonStyle(), color: BRAND.primaryText, background: saving ? BRAND.accentSoft : BRAND.primaryFill, borderColor: saving ? BRAND.border : 'transparent' } }, saving ? '创建中…' : '创建 Tool'))));
    }
