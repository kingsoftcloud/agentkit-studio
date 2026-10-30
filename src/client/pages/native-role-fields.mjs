// Authoring only. The Host still validates roles and intersects their tools,
// models and inherited resources with the frozen parent binding at admission.
import { NATIVE_CHILD_WORKSPACE_TOOLS } from '../../native-child-tools.mjs';

export function readNativeRoleDrafts(spec) {
  return structuredClone(spec.subAgents ?? spec.sub_agents ?? []).map(role => Object.fromEntries(
    Object.entries(role).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])));
}

export function validateNativeRoleDrafts(roles, { modelIds, toolIds, hasMcp, toolResources = [] }) {
  if (roles.length > 32) return '最多配置 32 个子任务角色。';
  const names = new Set();
  for (const role of roles) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(role.name ?? '') || names.has(role.name))
      return '子任务角色标识须唯一，使用小写字母、数字、下划线或连字符，最长 64 字符。';
    names.add(role.name);
    if (typeof role.instructions !== 'string' || !role.instructions.trim() || role.instructions.length > 32768)
      return `请填写 ${role.name} 的任务说明（最多 32768 字符）。`;
    if (role.modelProfileId && !modelIds.includes(role.modelProfileId)) return `${role.name} 的模型不在本 Agent 的可用模型中。`;
    if ((role.tools ?? []).some(id => !toolIds.includes(id))) return `${role.name} 使用了未绑定到本 Agent 的工具，请重新选择。`;
    if (role.concurrentSafe && (role.tools ?? []).some(id => {
      const contract = toolResources.find(tool => tool.resourceId === id)?.contract;
      return contract?.sideEffect && contract.sideEffect !== 'none';
    })) return `${role.name} 要求并发安全，不能选择会修改状态的工具；请移除该工具或关闭并发安全要求。`;
    if (role.inheritMcp && !hasMcp) return `${role.name} 启用了 MCP 继承，请先绑定 MCP。`;
    if (role.maxTurns !== undefined && (!Number.isInteger(role.maxTurns) || role.maxTurns < 1 || role.maxTurns > 32)
      || role.timeoutSeconds !== undefined && (!Number.isFinite(role.timeoutSeconds) || role.timeoutSeconds <= 0 || role.timeoutSeconds > 3600)
      || role.maxToolCalls != null && (!Number.isInteger(role.maxToolCalls) || role.maxToolCalls < 0 || role.maxToolCalls > 100000))
      return `${role.name} 的预算无效：模型调用 1–32 次，超时大于 0 且不超过 3600 秒，工具调用 0–100000 次。`;
  }
  return '';
}

export function createNativeRoleFields({ React: { createElement: h }, buttonStyle, inputStyle }) {
  return function fields({ roles, onChange, models, selectedModels, tools, selectedTools, hasMcp }) {
    const update = (index, patch) => onChange(roles.map((role, at) => at === index ? { ...role, ...patch } : role));
    const updateLimit = (index, key, value) => onChange(roles.map((role, at) => {
      if (at !== index) return role;
      const next = { ...role }; if (value === '') delete next[key]; else next[key] = Number(value); return next;
    }));
    const label = (text, control) => h('label', { style: { display: 'block', marginTop: '10px' } }, text, control);
    return h('section', { 'aria-label': 'Native 子任务角色', style: { marginTop: '18px' } },
      h('h3', null, '子任务角色（可选）'),
      h('p', null, '允许 Agent 按角色委派任务。子任务共用父任务的权限和资源边界，并单独统计用量；未配置时不启用。'),
      ...roles.map((role, index) => h('fieldset', { key: index, style: { marginBottom: '12px', padding: '12px' } },
        h('legend', null, `角色 ${index + 1}`),
        label('角色标识', h('input', { 'aria-label': `角色 ${index + 1} 标识`, value: role.name ?? '', maxLength: 64,
          onChange: e => update(index, { name: e.target.value }), style: inputStyle() })),
        label('任务说明', h('textarea', { 'aria-label': `角色 ${index + 1} 任务说明`, value: role.instructions ?? '', rows: 3, maxLength: 32768,
          onChange: e => update(index, { instructions: e.target.value }), style: { ...inputStyle(), height: 'auto' } })),
        label('使用模型', h('select', { 'aria-label': `角色 ${index + 1} 模型`, value: role.modelProfileId ?? '',
          onChange: e => update(index, { modelProfileId: e.target.value || null }), style: inputStyle() },
          h('option', { value: '' }, '沿用父任务模型'),
          ...(role.modelProfileId && !selectedModels.includes(role.modelProfileId)
            ? [h('option', { value: role.modelProfileId, disabled: true }, `${role.modelProfileId}（未绑定）`)] : []),
          ...models.filter(model => selectedModels.includes(model.resourceId)).map(model => h('option', { key: model.resourceId,
            value: model.resourceId }, model.displayName || model.resourceId)))),
        h('p', null, '角色工具（选择父任务已绑定的工作区工具；MCP 和 Skills 通过下方开关继承）'),
        ...[...new Set([...selectedTools.filter(id => NATIVE_CHILD_WORKSPACE_TOOLS.includes(id)), ...(role.tools ?? [])])].map(id => h('label', { key: id, style: { display: 'block' } },
          h('input', { type: 'checkbox', 'aria-label': `角色 ${index + 1} 工具 ${id}`, checked: (role.tools ?? []).includes(id),
            onChange: e => update(index, { tools: e.target.checked ? [...(role.tools ?? []), id] : (role.tools ?? []).filter(tool => tool !== id) }) }),
          tools.find(tool => tool.resourceId === id)?.displayName || id, selectedTools.includes(id) ? '' : '（未绑定，请移除或重新绑定）')),
        label('模型调用上限（留空自动分配）', h('input', { type: 'number', 'aria-label': `角色 ${index + 1} 模型调用上限`, min: 1, max: 32,
          value: role.maxTurns ?? '', placeholder: '共享父任务预算',
          onChange: e => updateLimit(index, 'maxTurns', e.target.value), style: inputStyle() })),
        label('工具调用上限（留空使用默认值）', h('input', { type: 'number', 'aria-label': `角色 ${index + 1} 工具调用上限`, min: 0, max: 100000, value: role.maxToolCalls ?? '',
          onChange: e => update(index, { maxToolCalls: e.target.value === '' ? null : Number(e.target.value) }), style: inputStyle() })),
        label('超时秒数（留空自动分配）', h('input', { type: 'number', 'aria-label': `角色 ${index + 1} 超时秒数`, min: 1, max: 3600,
          value: role.timeoutSeconds ?? '', placeholder: '使用运行时上限',
          onChange: e => updateLimit(index, 'timeoutSeconds', e.target.value), style: inputStyle() })),
        label('继承父任务 Skills', h('input', { type: 'checkbox', 'aria-label': `角色 ${index + 1} 继承 Skills`, checked: role.inheritSkills ?? true,
          onChange: e => update(index, { inheritSkills: e.target.checked }) })),
        label('继承父任务 MCP', h('input', { type: 'checkbox', 'aria-label': `角色 ${index + 1} 继承 MCP`, checked: role.inheritMcp ?? false,
          disabled: !hasMcp && !role.inheritMcp, onChange: e => update(index, { inheritMcp: e.target.checked }) })),
        label('要求并发安全（只读工具）', h('input', { type: 'checkbox', 'aria-label': `角色 ${index + 1} 要求并发安全`, checked: role.concurrentSafe ?? false,
          onChange: e => update(index, { concurrentSafe: e.target.checked }) })),
        h('button', { type: 'button', style: buttonStyle(), onClick: () => onChange(roles.filter((_, at) => at !== index)) }, `移除角色 ${index + 1}`))),
      h('button', { type: 'button', style: buttonStyle(), disabled: roles.length >= 32,
        onClick: () => onChange([...roles, { name: '', instructions: '', tools: [] }]) }, '添加子任务角色'));
  };
}
