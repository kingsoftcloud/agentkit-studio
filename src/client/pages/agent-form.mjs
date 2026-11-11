import { memorySourceContext, readAgentMemoryConfig, writeAgentMemoryConfig, validateAgentMemoryConfig, memoryRequiresCloudBinding, clampInt, clampFloat, MEMORY_WRITE_MODES, MEMORY_ROLLOUTS, MEMORY_PROVIDER_CLOUD } from '../state/agent-memory-config.mjs';
import { createNativeRoleFields, readNativeRoleDrafts, validateNativeRoleDrafts } from './native-role-fields.mjs';
import { nativeDefaultToolsFromCatalog } from '../../native-capability-defaults.mjs';
import { STUDIO_DEFAULT_AUTHORING_RUNTIME } from '../../authoring-defaults.mjs';
import { NATIVE_AGENT_POLICY_CONTRACT, normalizeNativeAgentPolicy } from '../../native-agent-policy.mjs';
import { NATIVE_CAPABILITY_PRESETS, nativeCapabilitySummary } from '../state/native-capabilities.mjs';
import { createFormKit } from '../components/form-kit.mjs';

const RUNTIME_HELP = 'DSH Native 使用本地原生循环；Star Harness 和 Codex 由各自运行端执行。决定可绑定的工具和记忆方式，创建后不可更改。';
const NATIVE_TOOL_HELP = 'Native 自动配备可用的文件、命令和网页工具，Agent 按需调用；写入与命令仍遵循会话审批，企业资源按授权使用。';
const POLICY_HELP = '规则随 Agent 版本固定；会话权限和 Host 审批仍可进一步拒绝。';
const RECALL_HELP = '本地按词项覆盖率检索，置信度非语义相关度；关闭后不再自动召回已有事实。';
const FLUSH_HELP = '压缩前刷新在上下文压缩前提取记忆候选；轮次后刷新在本轮完成后提取当前用户消息中的候选。实际写入由写入方式与开关决定。';
const EXTRACTION_HELP = '按累计的新对话提炼长期事实与偏好，会产生额外模型用量，每个任务最多调用 5 次。需选择候选写入、轮次后刷新和评估或实际写入；运行与子任务面板可查看状态和额外用量。';
const ROLLOUT_DESC = { shadow: '仅评估候选策略，不写入记忆库。', enabled: '实际写入本地记忆库，请确认后再开启。', off: '不写入记忆库，已写入事实仍可召回。' };

export function createAgentForm({
  ui: { React, BRAND, ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS, buttonStyle, inputStyle, SectionHeading, PlatformResourcePicker },
  hostRemote
}) {
  const { createElement: h, useState, useEffect, Fragment } = React;
  const kit = createFormKit({ React });
  const { Section, Row, Field, Input, TextArea, Select, Switch, Choice, CheckCard, Button, Note, Collapsible, Summary, HelpTip } = kit;
  const nativeRoleFields = createNativeRoleFields({ React, kit });
  function AgentCreatePage({ initialAgent = null, creationSeed = null, onBack, onCreated, onReload, allowHarnessRuntime = false }) {
    const editing = Boolean(initialAgent);
    const cloudEditing = editing && ['agentengine-server', 'agentengine-managed-runtime'].includes(initialAgent?.source);
    const originalSpec = initialAgent?.spec || creationSeed?.spec || {};
    const requirements = creationSeed?.requirements || [];
    const templateSource = creationSeed?.templateSource || initialAgent?.metadata?.templateSource;
    const originalBindings = originalSpec.bindings || {};
    const idsOf = items => (items || []).map(item => typeof item === 'string' ? item : item.resourceId).filter(Boolean);
    const [step, setStep] = useState(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [conflict, setConflict] = useState(false);
    const [catalogStatus, setCatalogStatus] = useState('loading');
    const [catalog, setCatalog] = useState({ model: [], tool: [], mcp: [], skill: [] });
    const [selectedModel, setSelectedModel] = useState(originalBindings.modelProfileId || '');
    const [selectedModels, setSelectedModels] = useState(originalBindings.modelProfileIds || (originalBindings.modelProfileId ? [originalBindings.modelProfileId] : []));
    const [selectedTools, setSelectedTools] = useState(idsOf(originalBindings.tools));
    const [selectedMcp, setSelectedMcp] = useState(idsOf(originalBindings.mcpServers));
    const [selectedSkills, setSelectedSkills] = useState(idsOf(originalBindings.skills));
    const [platformBindings, setPlatformBindings] = useState(originalBindings.plugins || []);
    const initialRuntime = originalSpec.runtime?.type || (editing ? 'dsh-native' : STUDIO_DEFAULT_AUTHORING_RUNTIME);
    const [memoryConfig, setMemoryConfig] = useState(() => readAgentMemoryConfig({ spec: originalSpec, runtime: initialRuntime, cloudEditing, creationSeed, editing }));
    const updateMemory = patch => setMemoryConfig(previous => ({ ...previous, ...patch }));
    const memoryEnabled = memoryConfig.enabled;
    const [taskPrompt, setTaskPrompt] = useState(originalSpec.instructions?.task || '');
    const [nativeRoles, setNativeRoles] = useState(() => initialRuntime === 'harness' && !cloudEditing ? readNativeRoleDrafts(originalSpec) : []);
    const [policy, setPolicy] = useState(originalBindings.nativeAgentPolicy?.mode || originalBindings.policyTemplate || 'strict');
    const [policyRules, setPolicyRules] = useState(() => JSON.stringify(originalBindings.nativeAgentPolicy?.rules || originalBindings.policyRules || {}, null, 2));
    const [form, setForm] = useState({
      id: initialAgent?.metadata?.id || 'local-agent', name: initialAgent?.metadata?.name || creationSeed?.name || '我的第一个 Agent', runtime: initialRuntime,
      description: originalSpec.description || creationSeed?.description || '', prompt: originalSpec.instructions?.system || '', template: 'blank',
    });
    // Star Harness is paused for new Agents: keep it visible only when editing an
    // existing harness Agent or when a caller explicitly re-enables creation.
    const creatableRuntime = type => type !== 'harness' || editing || allowHarnessRuntime;
    const runtimeOptions = [
      ...ALLOWED_RUNTIME_TYPES.filter(type => creatableRuntime(type) && (!creationSeed?.runtimes || creationSeed.runtimes.includes(type))).map(runtimeType => ({ runtimeType, displayName: RUNTIME_LABELS[runtimeType] })),
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
    const steps = ['基本信息', '绑定能力', '策略与确认'];
    const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

    useEffect(() => {
      if (form.runtime === 'dsh-native' && !editing) setSelectedTools([]);
    }, [form.runtime, cloudEditing]);

    useEffect(() => {
      let alive = true;
      if (cloudEditing) {
        setCatalogStatus('ready');
        setCatalog({ model: [], tool: [], mcp: [], skill: [] });
        return () => { alive = false; };
      }
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
          if (!editing && form.runtime === 'harness' && !Object.hasOwn(originalBindings, 'tools'))
            setSelectedTools(nativeDefaultToolsFromCatalog(next.tool));
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
    const capabilities = nativeCapabilitySummary({ tools: selectedTools, mcp: selectedMcp, skills: selectedSkills });
    const capabilitySummary = () => form.runtime === 'harness' && !cloudEditing ? h('section', { 'aria-label': 'Native 能力范围', className: 'af-stack', style: { margin: '0 0 12px' } },
      h('p', { className: 'af-note', style: { margin: 0 } }, capabilities.text),
      capabilities.names.length ? h('p', { className: 'af-note', style: { margin: 0, overflowWrap: 'anywhere' } }, capabilities.names.join('、')) : null,
      h('p', { className: 'af-note', style: { margin: 0 } }, capabilities.hint)) : null;
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
      : cloudEditing || (catalogStatus === 'ready' && Boolean(selectedModel) && bindingReady);

    const create = async () => {
      if (!cloudEditing && !bindingReady) { setError(requiresCloudBinding && !memoryInstanceBound ? '启用云记忆前，请在「绑定能力」步骤选择记忆库。' : (missingRequirements.map(item => item.label).join('、') || '启用长期记忆前请选择记忆库')); setStep(1); return; }
      const memoryValidation = validateAgentMemoryConfig({ ...memoryConfig, source: effectiveMemorySource });
      if (!memoryValidation.ok) { setError(memoryValidation.errors.map(item => item.message).join('；')); setStep(2); return; }
      if (form.runtime === 'harness' && !cloudEditing) {
        const roleError = validateNativeRoleDrafts(nativeRoles, { modelIds: selectedModels.length ? selectedModels : [selectedModel],
          toolIds: selectedTools, hasMcp: selectedMcp.length > 0, toolResources: catalog.tool });
        if (roleError) { setError(roleError); setStep(2); return; }
      }
      let boundPolicy = null;
      if (form.runtime === 'harness' && !cloudEditing) {
        try { boundPolicy = normalizeNativeAgentPolicy({ contract: NATIVE_AGENT_POLICY_CONTRACT, mode: policy,
          rules: policy === 'custom' ? JSON.parse(policyRules) : {} }); }
        catch { setError('自定义权限规则必须是 JSON 对象：工具名对应 inherit、ask 或 deny。'); setStep(2); return; }
      }
      if (saving || !form.id.trim() || !form.name.trim() || (!cloudEditing && (catalogStatus !== 'ready' || !selectedModel))) return;
      setSaving(true); setError(''); setConflict(false);
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
            ...(boundPolicy ? { policyTemplate: policy, nativeAgentPolicy: boundPolicy } : {}),
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
        onCreated({ id: metadata.id || id, name: metadata.name || form.name.trim(), revision: metadata.revision || 1, ...(initialAgent?.source ? { source: initialAgent.source } : {}) });
      } catch (reason) {
        setConflict(reason?.code === 'AGENT_EXPECTED_REVISION_CONFLICT');
        setError(reason?.code === 'AGENT_EXPECTED_REVISION_CONFLICT'
          ? 'Agent 已被其他窗口更新。当前未保存的内容仍保留；读取最新版本会替换这些内容，请重新核对后保存。'
          : reason?.message || '创建 Agent 失败');
      }
      finally { setSaving(false); }
    };

    const templateCards = !editing && !creationSeed ? Collapsible({ summary: '使用提示词模板（可选）' },
      h('div', { className: 'af-choices' }, templates.map(([value, title, detail]) => Choice({
        key: value, selected: form.template === value, title, desc: detail, onClick: () => chooseTemplate(value),
      })))) : null;

    const capabilityPicker = (kind, title, values, setValues) => Section({ title, meta: title ? `${values.length} 已选择` : undefined, className: title ? undefined : 'af-section-plain' },
      catalog[kind]?.length ? h('div', { className: 'af-choices' }, catalog[kind].map(resource => {
        const id = resource.resourceId;
        return CheckCard({ key: id, checked: values.includes(id), disabled: resource.disabled === true,
          title: resource.displayName || resource.name || id, desc: resource.unavailableReason || resource.description || resource.version || '',
          onChange: event => setValues(current => event.target.checked ? [...current, id] : current.filter(value => value !== id)) });
      })) : h('div', { className: 'af-empty' }, catalogStatus === 'loading' ? '正在读取目录…' : '暂无可用资源'));

    // Native memory configuration. The local-default path (harness, blank/edit)
    // exposes recall/write/rollout; every other enabled path is cloud-only and
    // keeps the original minimal memory UI. recall.enabled stays independent
    // of memory.enabled; shadow evaluates without writing. Both flush points
    // consume original user sources through the local Native Memory owner.
    const memoryConfigPanel = () => {
      if (!memoryEnabled) return null;
      if (cloudEditing) return Note({ 'data-memory-cloud-edit': true }, '云端 Agent 的记忆由 AgentEngine Server 管理记忆库绑定；如需调整请在「绑定能力」步骤操作，本地记忆配置不适用。');
      const canLocal = memoryCtx.canLocal;
      const source = effectiveMemorySource;
      const validation = validateAgentMemoryConfig({ ...memoryConfig, source });
      return Section({ 'data-memory-config': true, title: '记忆设置' },
        canLocal ? h('div', { className: 'af-choices', style: { marginBottom: '12px' } }, [['local', '本地记忆', 'Harness 自带本地记忆，无需绑定云记忆库。'], ['cloud', '云记忆库', '绑定云端记忆库，由 AICP 召回与写入。']].map(([value, title, detail]) => Choice({
          key: value, 'aria-label': '记忆来源-' + title, selected: source === value, title, desc: detail,
          onClick: () => { updateMemory({ source: value }); if (value === 'local') setPlatformBindings(bindings => bindings.filter(binding => binding?.config?.binding?.resource?.kind !== 'memory-instance')); },
        }))) : Note(null, '当前运行时使用云记忆库；请在「绑定能力」步骤选择记忆库。'),
        source === 'local' ? h(Fragment, null,
          Row({ title: '本地召回', help: RECALL_HELP }, Switch({ 'aria-label': '启用召回', checked: memoryConfig.recallEnabled, onChange: event => updateMemory({ recallEnabled: event.target.checked }) })),
          memoryConfig.recallEnabled ? h('div', { className: 'af-grid-3', style: { paddingTop: '12px' } },
            Field({ label: '召回最大 token' }, Input({ type: 'number', 'aria-label': '召回最大 token 数', min: 0, value: memoryConfig.recallMaxTokens, onChange: event => updateMemory({ recallMaxTokens: clampInt(event.target.value, 0, 100000, 1600) }) })),
            Field({ label: '召回条数' }, Input({ type: 'number', 'aria-label': '召回条数', min: 1, max: 64, value: memoryConfig.recallTopK, onChange: event => updateMemory({ recallTopK: clampInt(event.target.value, 1, 64, 8) }) })),
            Field({ label: '最低相似度' }, Input({ type: 'number', 'aria-label': '召回最低相似度', min: 0, max: 1, step: 0.05, value: memoryConfig.recallMinScore, onChange: event => updateMemory({ recallMinScore: clampFloat(event.target.value, 0, 1, 0.45) }) }))) : null,
          Row({ title: '记忆写入方式' }, Select({ 'aria-label': '记忆写入方式', value: memoryConfig.writeMode, onChange: event => updateMemory({ writeMode: event.target.value }) }, h('option', { value: 'off' }, '不提取记忆候选'), h('option', { value: 'explicit_only' }, '仅在我明确要求时记住'), h('option', { value: 'candidate' }, '每轮完成后提取可用记忆'))),
          Row({ title: '压缩前刷新', help: FLUSH_HELP }, Switch({ 'aria-label': '压缩前刷新记忆', checked: memoryConfig.writeFlushBeforeCompaction, onChange: event => updateMemory({ writeFlushBeforeCompaction: event.target.checked }) })),
          Row({ title: '轮次后刷新', help: FLUSH_HELP }, Switch({ 'aria-label': '轮次后刷新记忆', checked: memoryConfig.writeFlushAfterTurn, onChange: event => updateMemory({ writeFlushAfterTurn: event.target.checked }) })),
          Row({ title: '使用模型自动提炼记忆', help: EXTRACTION_HELP }, Switch({ 'aria-label': '启用模型记忆提炼', checked: memoryConfig.extractionEnabled, onChange: event => updateMemory({ extractionEnabled: event.target.checked }) })),
          memoryConfig.extractionEnabled ? Row({ title: '累计用户字符数' }, Input({ type: 'number', 'aria-label': '记忆提炼累计字符数', min: 1, max: 100000, value: memoryConfig.extractionMinUserCharacters, onChange: event => updateMemory({ extractionMinUserCharacters: clampInt(event.target.value, 1, 100000, 64) }) })) : null,
          Row({ title: '记忆写入开关', desc: ROLLOUT_DESC[memoryConfig.rollout] || ROLLOUT_DESC.off }, Select({ 'aria-label': '记忆写入开关', value: memoryConfig.rollout, onChange: event => updateMemory({ rollout: event.target.value }) }, h('option', { value: 'off' }, '关闭写入'), h('option', { value: 'shadow' }, '仅评估（shadow）'), h('option', { value: 'enabled' }, '实际写入')))) : h(Fragment, null,
          Row({ title: '记忆写入方式', desc: memoryInstanceBound ? '使用已绑定的记忆库，按当前用户与 Agent 隔离。' : '尚未绑定记忆库，请在「绑定能力」步骤选择。' }, Select({ 'aria-label': '记忆写入方式', value: memoryConfig.writeMode, onChange: event => updateMemory({ writeMode: event.target.value }) }, h('option', { value: 'explicit_only' }, '仅在我明确要求时记住'), h('option', { value: 'candidate' }, '每轮完成后提取可用记忆')))),
        !validation.ok ? Note({ role: 'alert', tone: 'danger', style: { marginTop: '10px' } }, validation.errors.map(item => item.message).join('；')) : null);
    };

    const stepContent = step === 0 ? h(Fragment, null,
      templateCards,
      templateSource ? Note(null, `基于专家模板 ${creationSeed?.name || templateSource.id} · v${templateSource.version}，所有配置均可修改。`) : null,
      h('div', { className: 'af-grid-2' },
        Field({ label: 'Agent ID' }, Input({ value: form.id, disabled: editing, onChange: e => update('id', e.target.value), placeholder: 'local-agent' })),
        Field({ label: '名称' }, Input({ value: form.name, onChange: e => update('name', e.target.value), placeholder: '我的 Agent' }))),
      Field({ label: '运行时', help: RUNTIME_HELP }, Select({ value: form.runtime, disabled: editing, onChange: e => update('runtime', e.target.value) }, runtimeOptions.map(item => h('option', { key: item.runtimeType, value: item.runtimeType }, item.displayName)))),
      Field({ label: '用途描述' }, TextArea({ value: form.description, onChange: e => update('description', e.target.value), placeholder: '例如：企业知识库问答与资料检索', rows: 3 })),
      Field({ label: cloudEditing ? '云端系统 Prompt' : '角色与系统 Prompt' }, TextArea({ value: form.prompt, onChange: e => update('prompt', e.target.value), placeholder: '描述 Agent 的身份、边界和回答方式', rows: 6 })),
      !cloudEditing ? Field({ label: '任务说明（可选）' }, TextArea({ value: taskPrompt, onChange: event => setTaskPrompt(event.target.value), rows: 3 })) : null,
    ) : step === 1 ? h(Fragment, null,
      cloudEditing ? Note({ role: 'status' }, '当前是云端 Agent。模型、MCP、本地 Skill 和 Tool 由 AgentEngine Runtime 自身管理；本页只保存知识库、记忆库和 Skill Center 这三类云端 ComponentConfig。') : null,
      !cloudEditing && form.runtime === 'codex' ? Note({ role: 'status' }, '可选 Codex 账户模型或已配置的网关模型；网关模型使用对应提供商的凭证和 API 设置。导出运行包时只支持网关模型。') : null,
      !cloudEditing ? Section({ title: '模型' },
        Field({ label: '默认模型' }, Select({ value: selectedModel, onChange: event => { setSelectedModel(event.target.value); setSelectedModels(current => current.includes(event.target.value) ? current : [event.target.value, ...current]); } }, h('option', { value: '' }, catalogStatus === 'loading' ? '正在读取模型…' : '请选择模型'), catalog.model.map(resource => h('option', { key: resource.resourceId, value: resource.resourceId }, resource.displayName || resource.name || resource.resourceId)))),
        h('div', { className: 'af-field-label' }, '可用模型', HelpTip('对话中可切换到这些模型；默认模型始终可用。')),
        h('div', { className: 'af-choices' }, catalog.model.map(resource => CheckCard({ key: resource.resourceId, checked: selectedModels.includes(resource.resourceId), title: resource.displayName || resource.name || resource.resourceId,
          onChange: event => setSelectedModels(current => event.target.checked ? [...current, resource.resourceId] : current.filter(id => id !== resource.resourceId)) })))) : null,
      !cloudEditing && form.runtime === 'dsh-native'
        ? Section({ title: '工具' }, Note({ style: { margin: 0 } }, 'DSH Native 使用自带的工具循环，无需绑定工具；MCP、Skill 和平台资源仍可按需绑定。'))
        : !cloudEditing && form.runtime === 'harness' ? Section({ title: '工具', help: NATIVE_TOOL_HELP, meta: `${selectedTools.length} 已选择` },
          catalog.tool.find(tool => tool.resourceId === 'web_search')?.disabled
            ? Note({ role: 'status' }, catalog.tool.find(tool => tool.resourceId === 'web_search').unavailableReason) : null,
          Collapsible({ summary: '按能力组调整（可选）' }, h('div', { className: 'af-chips', style: { marginBottom: 0 } }, NATIVE_CAPABILITY_PRESETS.map(preset => {
            const available = preset.tools.filter(name => catalog.tool.some(tool => tool.resourceId === name && !tool.disabled));
            return Button({ key: preset.id, size: 'sm', title: preset.detail, disabled: !available.length, onClick: () => setSelectedTools(current => [...new Set([...current, ...available])]) }, preset.label);
          }))),
          Collapsible({ summary: '高级：调整工具范围', style: { marginBottom: 0 } }, capabilitySummary(), capabilityPicker('tool', '', selectedTools, setSelectedTools)))
        : !cloudEditing ? Section({ title: '工具', meta: `${selectedTools.length} 已选择` }, capabilityPicker('tool', '工具', selectedTools, setSelectedTools)) : null,
      !cloudEditing ? capabilityPicker('mcp', 'MCP 服务', selectedMcp, setSelectedMcp) : null,
      !cloudEditing ? capabilityPicker('skill', '技能', selectedSkills, setSelectedSkills) : null,
      missingRequirements.length ? Note({ role: 'status', tone: 'warn' }, '此模板需要：' + missingRequirements.map(item => item.label).join('、')) : null,
      h(PlatformResourcePicker, { value: platformBindings, onChange: setPlatformBindings, onMemory: value => updateMemory({ enabled: value, source: value ? 'cloud' : (memoryCtx.canLocal ? 'local' : 'cloud') }) }),
    ) : h(Fragment, null,
      Section({ title: '权限与记忆' },
        form.runtime === 'harness' && !cloudEditing
          ? Row({ title: 'Agent 工具约束', help: POLICY_HELP }, Select({ value: policy, onChange: event => setPolicy(event.target.value) }, h('option', { value: 'strict' }, '严格：写入和未知副作用需审批'), h('option', { value: 'loose' }, '遵循会话与 Host 权限'), h('option', { value: 'custom' }, '自定义：默认拒绝未知副作用')))
          : Row({ title: '权限', desc: '由当前运行端和 Host 管理' }),
        form.runtime === 'harness' && editing && !originalBindings.nativeAgentPolicy && originalBindings.policyTemplate
          ? Note({ role: 'status', tone: 'warn' }, '旧版本的权限策略只保存了名称；本次保存会创建正式生效的策略。') : null,
        form.runtime === 'harness' && !cloudEditing && policy === 'custom' ? Field({ label: '逐工具规则（JSON）', hint: '例如 {"read_workspace_file":"inherit","save_crm":"ask"}；未列出的只读工具遵循 Host，其他工具拒绝。', style: { marginTop: '12px' } },
          TextArea({ 'data-mono': true, value: policyRules, onChange: event => setPolicyRules(event.target.value), rows: 5, 'aria-label': '逐工具权限规则' })) : null,
        Row({ title: '跨会话记忆' }, Switch({ 'aria-label': '启用跨会话记忆', checked: memoryEnabled, disabled: cloudEditing, onChange: event => updateMemory({ enabled: event.target.checked }) }))),
      memoryConfigPanel(),
      form.runtime === 'harness' && !cloudEditing ? nativeRoleFields({ roles: nativeRoles, onChange: setNativeRoles,
        models: catalog.model, selectedModels: selectedModels.length ? selectedModels : [selectedModel],
        tools: catalog.tool, selectedTools, hasMcp: selectedMcp.length > 0 }) : null,
      Section({ title: '确认配置' },
        capabilitySummary(),
        Summary({ rows: [['Agent ID', form.id.trim().toLowerCase()], ['名称', form.name.trim()], ['运行时', runtimeLabel], ['默认模型', (model => model?.displayName || model?.name)(catalog.model.find(item => item.resourceId === selectedModel)) || selectedModel || '未选择'], ['可用模型', `${selectedModels.length || (selectedModel ? 1 : 0)} 个`], ['能力', `${selectedTools.length} Tool · ${selectedMcp.length} MCP · ${selectedSkills.length} Skill`], ['平台资源', `${platformBindings.length} 项`], ['记忆', memoryEnabled ? (effectiveMemorySource === 'local' ? '本地记忆' : '云记忆库') : '未启用'],
          ...(form.runtime === 'harness' && !cloudEditing ? [['子任务角色', nativeRoles.length ? nativeRoles.map(role => role.name).join('、') : '未启用']] : []),
          ['模板', creationSeed?.name || templateSource?.id || templates.find(item => item[0] === form.template)?.[1]]] }),
        editing ? Note({ style: { marginTop: '12px' } }, cloudEditing ? '保存后调用 AgentEngine UpdateAgent；云端已有会话继续使用旧快照，新运行使用更新后的组件绑定。' : `保存后创建新的配置版本（当前 r${initialAgent.metadata.revision}）；已有会话和构建不会被自动切换。`) : null),
    );
    return h('div', { 'data-studio-agent-form': true },
      h('header', { 'data-studio-heading': 'true', className: 'af-page-heading' },
        Button({ onClick: onBack, className: 'af-back', 'aria-label': creationSeed ? '返回模板' : '返回 Agents', title: creationSeed ? '返回模板' : '返回 Agents' },
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' }, h('path', { d: 'm14 6-6 6 6 6', strokeLinecap: 'round', strokeLinejoin: 'round' }))),
        h(SectionHeading, { compact: true, title: editing ? '编辑 Agent' : creationSeed ? '配置你的专家' : '手动配置 Agent' })),
      h('section', { className: 'af-layout' },
        h('nav', { className: 'af-steps', 'aria-label': '创建流程' }, steps.map((label, index) => h('button', {
          key: label, type: 'button', className: 'af-step', 'aria-current': index === step ? 'step' : undefined, 'data-done': index < step ? 'true' : undefined,
          disabled: !(editing || index <= step), onClick: () => setStep(index),
        }, h('span', { className: 'af-step-index', 'aria-hidden': 'true' }, index + 1), label))),
        h('div', { className: 'af-body' },
          stepContent,
          error ? Note({ role: 'alert', tone: 'danger', style: { marginTop: '16px' } }, error) : null,
          conflict && onReload ? Button({ disabled: saving, onClick: onReload }, '读取最新版本') : null,
          h('div', { className: 'af-footer' },
            Button({ onClick: step === 0 ? onBack : () => setStep(step - 1) }, step === 0 ? '取消' : '上一步'),
            step < steps.length - 1 ? Button({ variant: 'primary', disabled: !canNext, onClick: () => setStep(step + 1) }, '下一步')
              : Button({ variant: 'primary', disabled: saving || !canNext, onClick: create }, saving ? '保存中…' : editing ? '保存 Agent' : '创建 Agent'))
        )
      )
    );
  }
  return AgentCreatePage;
}
