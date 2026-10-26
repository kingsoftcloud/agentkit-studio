import { memorySourceContext, readAgentMemoryConfig, writeAgentMemoryConfig, validateAgentMemoryConfig, memoryRequiresCloudBinding, clampInt, clampFloat, MEMORY_WRITE_MODES, MEMORY_ROLLOUTS, MEMORY_PROVIDER_CLOUD } from '../state/agent-memory-config.mjs';
import { createNativeRoleFields, readNativeRoleDrafts, validateNativeRoleDrafts } from './native-role-fields.mjs';

export function createAgentForm({
  ui: { React: { createElement: h, useState, useEffect, Fragment }, BRAND, ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS, buttonStyle, inputStyle, SectionHeading, PlatformResourcePicker, Pill },
  hostRemote
}) {
  const nativeRoleFields = createNativeRoleFields({ React: { createElement: h }, buttonStyle, inputStyle });
  function AgentCreatePage({ initialAgent = null, creationSeed = null, onBack, onCreated }) {
    const editing = Boolean(initialAgent);
    const cloudEditing = editing && initialAgent?.source === 'agentengine-server';
    const originalSpec = initialAgent?.spec || creationSeed?.spec || {};
    const requirements = creationSeed?.requirements || [];
    const templateSource = creationSeed?.templateSource || initialAgent?.metadata?.templateSource;
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
    const initialRuntime = originalSpec.runtime?.type || 'dsh-native';
    const [memoryConfig, setMemoryConfig] = useState(() => readAgentMemoryConfig({ spec: originalSpec, runtime: initialRuntime, cloudEditing, creationSeed, editing }));
    const updateMemory = patch => setMemoryConfig(previous => ({ ...previous, ...patch }));
    const memoryEnabled = memoryConfig.enabled;
    const [taskPrompt, setTaskPrompt] = useState(originalSpec.instructions?.task || '');
    const [nativeRoles, setNativeRoles] = useState(() => initialRuntime === 'harness' && !cloudEditing ? readNativeRoleDrafts(originalSpec) : []);
    const [policy, setPolicy] = useState(originalBindings.policyTemplate || 'strict');
    const [form, setForm] = useState({
      id: initialAgent?.metadata?.id || 'local-agent', name: initialAgent?.metadata?.name || creationSeed?.name || '我的第一个 Agent', runtime: originalSpec.runtime?.type || 'dsh-native',
      description: originalSpec.description || creationSeed?.description || '', prompt: originalSpec.instructions?.system || '', template: 'blank',
    });
    const runtimeOptions = [
      ...ALLOWED_RUNTIME_TYPES.filter(type => !creationSeed?.runtimes || creationSeed.runtimes.includes(type)).map(runtimeType => ({ runtimeType, displayName: RUNTIME_LABELS[runtimeType] })),
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
      Promise.allSettled(['model', 'tool', 'mcp', 'skill'].map(kind => kind === 'model' && form.runtime === 'codex' && !cloudEditing ? hostRemote.codexModels() : hostRemote.resources(kind === 'tool' ? { kind, runtimeType: form.runtime } : kind)))
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

    const boundKinds = platformBindings.filter(item => item.enabled !== false).map(item => item?.config?.binding?.resource?.kind);
    const selectedCounts = { model: selectedModel ? 1 : 0, tool: selectedTools.length, mcp: selectedMcp.length, skill: selectedSkills.length };
    const memoryCtx = memorySourceContext({ runtime: form.runtime, cloudEditing, creationSeed });
    const effectiveMemorySource = memoryCtx.canLocal ? memoryConfig.source : 'cloud';
    // A harness Agent using local-default memory satisfies a template's
    // memory-instance requirement through the local store, not a cloud binding.
    const localMemorySatisfiesMemoryRequirement = memoryCtx.canLocal && memoryConfig.enabled && effectiveMemorySource !== 'cloud';
    const missingRequirements = requirements.filter(item => item.required && !(boundKinds.includes(item.kind) || selectedCounts[item.kind] >= (item.count || 1) || (item.kind === 'memory-instance' && localMemorySatisfiesMemoryRequirement)));
    const memoryInstanceBound = boundKinds.includes('memory-instance');
    const requiresCloudBinding = memoryRequiresCloudBinding({ state: { ...memoryConfig, source: effectiveMemorySource }, ctx: memoryCtx, memoryInstanceBound });
    const memoryBindingOk = !memoryEnabled || !requiresCloudBinding || memoryInstanceBound;
    const bindingReady = !missingRequirements.length && memoryBindingOk;
    const canNext = step === 0
      ? Boolean(form.id.trim() && form.name.trim())
      : step === 1 || step === 3 ? (cloudEditing || (catalogStatus === 'ready' && Boolean(selectedModel) && bindingReady)) : (step !== 2 || bindingReady);

    const create = async () => {
      if (!cloudEditing && !bindingReady) { setError(requiresCloudBinding && !memoryInstanceBound ? '启用云记忆前，请在「绑定能力」步骤选择记忆库。' : (missingRequirements.map(item => item.label).join('、') || '启用长期记忆前请选择记忆库')); setStep(1); return; }
      const memoryValidation = validateAgentMemoryConfig({ ...memoryConfig, source: effectiveMemorySource });
      if (!memoryValidation.ok) { setError(memoryValidation.errors.map(item => item.message).join('；')); setStep(2); return; }
      if (form.runtime === 'harness' && !cloudEditing) {
        const roleError = validateNativeRoleDrafts(nativeRoles, { modelIds: selectedModels.length ? selectedModels : [selectedModel],
          toolIds: selectedTools, hasMcp: selectedMcp.length > 0, toolResources: catalog.tool });
        if (roleError) { setError(roleError); setStep(2); return; }
      }
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
        const builtMemory = writeAgentMemoryConfig({ state: { ...memoryConfig, source: effectiveMemorySource }, originalSpec, platformBindings, runtime: form.runtime, cloudEditing, creationSeed });
        const spec = {
          ...originalSpec,
          description: form.description.trim() || '由 AgentKit Studio 本地创建',
          runtime: { ...originalSpec.runtime, type: form.runtime },
          instructions: { ...originalSpec.instructions, system: prompt, task: taskPrompt },
          security: editing ? originalSpec.security : { toolPolicy: 'deny-by-default', allowedPermissions },
          bindings: {
            ...originalBindings,
            ...(!cloudEditing ? { modelProfileId: selectedModel, modelProfileIds: selectedModels.length ? selectedModels : [selectedModel] } : {}),
            policyTemplate: policy,
            tools: selectedTools.map(resourceId => (originalBindings.tools || []).find(item => item.resourceId === resourceId) || { resourceId }),
            mcpServers: selectedMcp.map(resourceId => (originalBindings.mcpServers || []).find(item => item.resourceId === resourceId) || { resourceId }),
            skills: selectedSkills.map(resourceId => (originalBindings.skills || []).find(item => item.resourceId === resourceId) || { resourceId }),
            plugins: builtMemory.plugins,
          },
          memory: builtMemory.memory,
          context: builtMemory.useLocal
            ? { ...originalSpec.context, rollout: { ...originalSpec.context?.rollout, memoryWrite: builtMemory.rollout } }
            : originalSpec.context,
        };
        if (form.runtime === 'harness' && !cloudEditing) { delete spec.sub_agents; spec.subAgents = nativeRoles; }
        const created = editing ? await hostRemote.updateAgent(id, spec, initialAgent.metadata.revision, form.name.trim()) : await hostRemote.quickAuthorAgent({
          name: form.name.trim(), slug: id, runtimeType: form.runtime,
          template: form.template, ...(creationSeed ? { templateSource: creationSeed.templateSource } : {}),
          description: form.description.trim() || '由 AgentKit Studio 本地创建', spec,
        });
        const metadata = created?.metadata || {};
        onCreated({ id: metadata.id || id, name: metadata.name || form.name.trim(), revision: metadata.revision || 1 });
      } catch (reason) { setError(reason?.message || '创建 Agent 失败'); }
      finally { setSaving(false); }
    };

    const templateCards = !editing && !creationSeed ? h('details', { style: { marginBottom: '20px' } },
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

    // Native memory configuration. The local-default path (harness, blank/edit)
    // exposes recall/write/rollout; every other enabled path is cloud-only and
    // keeps the original minimal memory UI. recall.enabled stays independent
    // of memory.enabled; shadow evaluates without writing. Both flush points
    // consume original user sources through the local Native Memory owner.
    const memoryConfigPanel = () => {
      if (!memoryEnabled) return null;
      if (cloudEditing) return h('div', { 'data-memory-cloud-edit': true, style: { marginTop: '16px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '云端 Agent 的记忆由 AgentEngine Server 管理记忆库绑定；如需调整请在「绑定能力」步骤操作，本地记忆配置不适用。');
      const canLocal = memoryCtx.canLocal;
      const source = effectiveMemorySource;
      const validation = validateAgentMemoryConfig({ ...memoryConfig, source });
      const divider = { borderTop: '1px solid ' + BRAND.border, marginTop: '12px', paddingTop: '12px' };
      return h('section', { 'data-memory-config': true, style: { marginTop: '16px', border: '1px solid ' + BRAND.border, borderRadius: '12px', padding: '14px', background: BRAND.surface } },
        canLocal ? h('div', { style: { marginBottom: '12px' } },
          h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700, marginBottom: '6px' } }, '记忆来源'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, [['local', '本地记忆', '使用 AgentKit Harness 自带的本地记忆（local-default），无需绑定云记忆库。'], ['cloud', '云记忆库', '绑定云端记忆库（memory-instance），由 AICP 召回与写入。']].map(([value, title, detail]) => h('button', { key: value, type: 'button', 'aria-label': '记忆来源-' + title, onClick: () => { updateMemory({ source: value }); if (value === 'local') setPlatformBindings(bindings => bindings.filter(binding => binding?.config?.binding?.resource?.kind !== 'memory-instance')); }, style: { textAlign: 'left', border: '1px solid ' + (source === value ? BRAND.accentStrong : BRAND.border), borderRadius: '8px', padding: '10px', background: source === value ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } }, h('div', { style: { fontWeight: 700, fontSize: '12px' } }, title), h('div', { style: { marginTop: '4px', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.45 } }, detail))))) : h('div', { style: { marginBottom: '12px', padding: '10px', borderRadius: '8px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, '当前运行时使用云记忆库（memory-instance）；请在「绑定能力」步骤选择记忆库。'),
        source === 'local' ? h(Fragment, null,
          h('div', null,
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: BRAND.ink, fontSize: '12px', fontWeight: 700 } }, h('input', { type: 'checkbox', 'aria-label': '启用召回', checked: memoryConfig.recallEnabled, onChange: event => updateMemory({ recallEnabled: event.target.checked }) }), '启用本地召回'),
            h('p', { style: { margin: '6px 0 10px', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, '本地按词项覆盖率检索，置信度非语义相关度；关闭后不再自动召回已有事实。'),
            memoryConfig.recallEnabled ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' } },
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '召回最大 token', h('input', { type: 'number', 'aria-label': '召回最大 token 数', min: 0, value: memoryConfig.recallMaxTokens, onChange: event => updateMemory({ recallMaxTokens: clampInt(event.target.value, 0, 100000, 1600) }), style: inputStyle() })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '召回条数 (topK)', h('input', { type: 'number', 'aria-label': '召回条数', min: 1, max: 64, value: memoryConfig.recallTopK, onChange: event => updateMemory({ recallTopK: clampInt(event.target.value, 1, 64, 8) }), style: inputStyle() })),
              h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '最低相似度', h('input', { type: 'number', 'aria-label': '召回最低相似度', min: 0, max: 1, step: 0.05, value: memoryConfig.recallMinScore, onChange: event => updateMemory({ recallMinScore: clampFloat(event.target.value, 0, 1, 0.45) }), style: inputStyle() }))) : null),
          h('div', { style: divider },
            h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '记忆写入方式', h('select', { 'aria-label': '记忆写入方式', value: memoryConfig.writeMode, onChange: event => updateMemory({ writeMode: event.target.value }), style: inputStyle() }, h('option', { value: 'off' }, '不提取记忆候选'), h('option', { value: 'explicit_only' }, '仅在我明确要求时记住'), h('option', { value: 'candidate' }, '每轮完成后提取可用记忆'))),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' } },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: BRAND.ink, fontSize: '12px' } }, h('input', { type: 'checkbox', 'aria-label': '压缩前刷新记忆', checked: memoryConfig.writeFlushBeforeCompaction, onChange: event => updateMemory({ writeFlushBeforeCompaction: event.target.checked }) }), '压缩前刷新'),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: BRAND.ink, fontSize: '12px' } }, h('input', { type: 'checkbox', 'aria-label': '轮次后刷新记忆', checked: memoryConfig.writeFlushAfterTurn, onChange: event => updateMemory({ writeFlushAfterTurn: event.target.checked }) }), '轮次后刷新')),
            h('p', { style: { margin: '8px 0 0', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, '压缩前刷新在上下文压缩前提取记忆候选；轮次后刷新在本轮完成后提取当前用户消息中的候选。实际写入由写入方式与开关决定。')),
          h('div', { style: divider },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: BRAND.ink, fontSize: '12px' } },
              h('input', { type: 'checkbox', 'aria-label': '启用模型记忆提炼', checked: memoryConfig.extractionEnabled,
                onChange: event => updateMemory({ extractionEnabled: event.target.checked }) }), '使用模型自动提炼记忆'),
            h('p', { style: { margin: '6px 0', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } },
              '按累计的新对话提炼长期事实与偏好，会产生额外模型用量，每个任务最多调用 5 次。需选择候选写入、轮次后刷新和评估或实际写入；运行与子任务面板可查看状态和额外用量。'),
            memoryConfig.extractionEnabled ? h('label', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '累计用户字符数',
              h('input', { type: 'number', 'aria-label': '记忆提炼累计字符数', min: 1, max: 100000,
                value: memoryConfig.extractionMinUserCharacters,
                onChange: event => updateMemory({ extractionMinUserCharacters: clampInt(event.target.value, 1, 100000, 64) }),
                style: inputStyle() })) : null),
          h('div', { style: divider },
            h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '记忆写入开关', h('select', { 'aria-label': '记忆写入开关', value: memoryConfig.rollout, onChange: event => updateMemory({ rollout: event.target.value }), style: inputStyle() }, h('option', { value: 'off' }, '关闭写入'), h('option', { value: 'shadow' }, '仅评估（shadow）'), h('option', { value: 'enabled' }, '实际写入'))),
            h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.5 } }, memoryConfig.rollout === 'shadow' ? 'shadow 仅评估候选策略，不写入记忆库。' : memoryConfig.rollout === 'enabled' ? 'enabled 实际写入本地记忆库；请确认后再开启。' : '关闭后不写入记忆库，已写入事实仍可召回。'))) : h(Fragment, null,
          h('label', { style: { display: 'block', color: BRAND.inkMuted, fontSize: '12px' } }, '记忆写入方式', h('select', { 'aria-label': '记忆写入方式', value: memoryConfig.writeMode, onChange: event => updateMemory({ writeMode: event.target.value }), style: inputStyle() }, h('option', { value: 'explicit_only' }, '仅在我明确要求时记住'), h('option', { value: 'candidate' }, '每轮完成后提取可用记忆'))),
          h('p', { style: { fontSize: '11px', lineHeight: 1.6, marginTop: '6px' } }, memoryInstanceBound ? '使用已绑定的记忆库，按当前用户与 Agent 隔离。关闭记忆后不再召回和写入。' : '尚未绑定记忆库，请在「绑定能力」步骤选择。')),
        !validation.ok ? h('div', { role: 'alert', style: { marginTop: '10px', color: BRAND.danger, fontSize: '11px' } }, validation.errors.map(item => item.message).join('；')) : null);
    };

    const stepContent = step === 0 ? h(Fragment, null,
      templateCards,
      templateSource ? h('p', { style: { color: BRAND.inkMuted, fontSize: '12px', marginBottom: '16px' } }, `基于专家模板 · ${creationSeed?.name || templateSource.id} · v${templateSource.version}，所有配置均可修改。`) : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '14px' } },
        h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, 'Agent ID', h('input', { value: form.id, disabled: editing, onChange: e => update('id', e.target.value), placeholder: 'local-agent', style: inputStyle() })),
        h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '名称', h('input', { value: form.name, onChange: e => update('name', e.target.value), placeholder: '我的 Agent', style: inputStyle() })),
        h('label', { style: { gridColumn: '1 / -1', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '用途描述', h('textarea', { value: form.description, onChange: e => update('description', e.target.value), placeholder: '例如：企业知识库问答与资料检索', rows: 4, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical' } })),
        h('label', { style: { gridColumn: '1 / -1', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '运行时', h('select', { value: form.runtime, disabled: editing, onChange: e => update('runtime', e.target.value), style: inputStyle() }, runtimeOptions.map(item => h('option', { key: item.runtimeType, value: item.runtimeType }, item.displayName)))),
      ),
      h('label', { style: { display: 'block', marginTop: '14px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '角色与系统 Prompt', h('textarea', { value: form.prompt, disabled: cloudEditing, onChange: e => update('prompt', e.target.value), placeholder: cloudEditing ? '云端 Agent 的 Prompt 由 AgentEngine Server 管理' : '描述 Agent 的身份、边界和回答方式', rows: 5, style: { ...inputStyle(), height: 'auto', padding: '10px', resize: 'vertical', opacity: cloudEditing ? 0.65 : 1 } })),
      h('label', { style: { display: 'block', marginTop: '14px', color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '任务说明（可选）', h('textarea', { value: taskPrompt, disabled: cloudEditing, onChange: event => setTaskPrompt(event.target.value), rows: 3, style: { ...inputStyle(), height: 'auto', padding: '10px' } })),
    ) : step === 1 ? h(Fragment, null,
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
      missingRequirements.length ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, '此模板需要：' + missingRequirements.map(item => item.label).join('、')) : null,
      h(PlatformResourcePicker, { value: platformBindings, onChange: setPlatformBindings, onMemory: value => updateMemory({ enabled: value, source: value ? 'cloud' : (memoryCtx.canLocal ? 'local' : 'cloud') }) }),
    ) : step === 2 ? h(Fragment, null,
      h('h3', { style: { margin: '0 0 6px', color: BRAND.ink, fontSize: '16px' } }, '运行目标与策略'),
      h('p', { style: { margin: '0 0 16px', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.55 } }, '运行目标会写入 Agent Revision。DSH Native 使用本地原生循环，AgentKit Harness 和 Codex 由各自运行端执行。'),
      h('div', { style: { display: 'grid', gap: '8px' } }, runtimeOptions.map(item => h('button', { key: item.runtimeType, type: 'button', onClick: () => update('runtime', item.runtimeType), style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', border: '1px solid ' + (form.runtime === item.runtimeType ? BRAND.accentStrong : BRAND.border), borderRadius: '10px', padding: '14px', background: form.runtime === item.runtimeType ? BRAND.accentSoft : BRAND.surface, color: BRAND.ink, cursor: 'pointer' } }, h('span', null, h('strong', { style: { display: 'block', fontSize: '13px' } }, item.displayName), h('span', { style: { display: 'block', marginTop: '4px', color: BRAND.inkMuted, fontSize: '11px' } }, item.runtimeType)), form.runtime === item.runtimeType ? h(Pill, { tone: 'accent' }, '已选择') : null))),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px' } },
        h('label', { style: { color: BRAND.inkMuted, fontSize: '11px', fontWeight: 700 } }, '权限策略', h('select', { value: policy, onChange: event => setPolicy(event.target.value), style: inputStyle() }, h('option', { value: 'strict' }, '严格权限'), h('option', { value: 'loose' }, '宽松权限'), h('option', { value: 'custom' }, '自定义权限'))),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '23px', color: BRAND.ink, fontSize: '12px', fontWeight: 700 } }, h('input', { type: 'checkbox', 'aria-label': '启用跨会话记忆', checked: memoryEnabled, disabled: cloudEditing, onChange: event => updateMemory({ enabled: event.target.checked }) }), '启用跨会话记忆')),
      memoryConfigPanel(),
      form.runtime === 'harness' && !cloudEditing ? nativeRoleFields({ roles: nativeRoles, onChange: setNativeRoles,
        models: catalog.model, selectedModels: selectedModels.length ? selectedModels : [selectedModel],
        tools: catalog.tool, selectedTools, hasMcp: selectedMcp.length > 0 }) : null,
      h('div', { style: { marginTop: '18px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, '运行目标属于 Agent Revision；权限策略和记忆配置会随本次创建一起保存。'),
    ) : h(Fragment, null,
      h('h3', { style: { margin: '0 0 14px', color: BRAND.ink, fontSize: '16px' } }, '检查并创建'),
      h('div', { style: { display: 'grid', borderTop: '1px solid ' + BRAND.border } }, [['Agent ID', form.id.trim().toLowerCase()], ['名称', form.name.trim()], ['运行目标', runtimeLabel], ['默认模型', catalog.model.find(item => item.resourceId === selectedModel)?.displayName || selectedModel || '未选择'], ['模型白名单', `${selectedModels.length || (selectedModel ? 1 : 0)} 个`], ['能力', `${selectedTools.length} Tool · ${selectedMcp.length} MCP · ${selectedSkills.length} Skill`], ['平台资源', `${platformBindings.length} 项（知识库 / 记忆库 / Skill Center）`], ['记忆', memoryEnabled ? (effectiveMemorySource === 'local' ? '本地记忆' : '云记忆库') : '未启用'], ['模板', creationSeed?.name || templateSource?.id || templates.find(item => item[0] === form.template)?.[1]]].map(([label, value]) => h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: '20px', padding: '12px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: '12px' } }, h('span', { style: { color: BRAND.inkMuted } }, label), h('strong', { style: { color: BRAND.ink, textAlign: 'right' } }, value)))),
      form.runtime === 'harness' && !cloudEditing ? h('p', null, `子任务角色：${nativeRoles.length ? nativeRoles.map(role => role.name).join('、') : '未启用'}`) : null,
      h('div', { style: { marginTop: '16px', padding: '12px', borderRadius: '9px', background: BRAND.canvas, color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 } }, editing ? (cloudEditing ? '保存后调用 AgentEngine UpdateAgent；云端已有会话继续使用旧快照，新运行使用更新后的组件绑定。' : `保存后创建新的配置版本；当前版本为 r${initialAgent.metadata.revision}。已有会话和构建不会被自动切换。`) : '创建后保存 Prompt、模型和资源绑定，随后可构建并开始对话。'),
    );
    return h('div', { 'data-studio-agent-form': true },
      h(SectionHeading, { title: editing ? '编辑 Agent' : creationSeed ? '配置你的专家' : '手动配置 Agent', detail: '直接填写提示词、资源绑定和运行策略，检查后保存。', action: h('button', { type: 'button', onClick: onBack, style: buttonStyle() }, creationSeed ? '返回模板' : '返回 Agents') }),
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
  return AgentCreatePage;
}
