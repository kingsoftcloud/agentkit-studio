/** Presentation helpers for the model-settings detail editor. Kept out of
 * model-settings.mjs so the section stays under the 1000-line source gate. */
import { lookupModelCapabilities } from '../../model-capability-catalog.mjs';
import { resolveModelBudgets } from '../../model-capabilities.mjs';

/** The capacity block: context window and output budget with their source. */
export function renderCapabilitySummary(h, selected) {
  const catalog = lookupModelCapabilities(selected);
  const budgets = resolveModelBudgets(selected, null);
  const source = configured => configured !== undefined ? '用户填写' : catalog ? '目录' : '默认';
  return h('div', { className: 'ms-capability-summary', 'data-capability-summary': true },
    h('span', { className: 'ms-label' }, '容量'),
    h('span', { className: 'ms-capability-item' }, `上下文 ${budgets.contextWindow.toLocaleString()}`,
      h('span', { className: 'ms-hint' }, ` · ${source(selected.contextWindow)}`)),
    h('span', { className: 'ms-capability-item' }, `最大输出 ${budgets.maxOutputTokens.toLocaleString()}`,
      h('span', { className: 'ms-hint' }, ` · ${source(selected.maxOutputTokens)}`)),
    catalog ? h('span', { className: 'ms-hint' }, `目录：${catalog.providerName || 'models.dev'}`) : null);
}

/** Levels a probe found usable (accepted or confirmed), ready to write back. */
export function applicableProbeLevels(report) {
  return (report?.outcomes || []).filter(row => row.outcome === 'accepted' || row.outcome === 'confirmed').map(row => row.level);
}

/** Write the probed levels into the profile as a reversible draft. */
export function createApplyProbeLevels({ patchProfile, selectedIndex, setMessage }) {
  return levels => {
    patchProfile(selectedIndex, {
      reasoningLevels: levels, reasoningEfforts: true,
      defaultReasoningEffort: levels.includes('high') ? 'high' : levels[levels.length - 1],
    });
    setMessage(`已应用探测到的 ${levels.length} 个档位，保存后生效`);
  };
}

/** Always-visible remove button, disabled with an explanation on the last enabled model. */
export function renderRemoveButton(h, { lastEnabled, onClick }) {
  return h('button', { type: 'button', 'data-size': 'sm', 'data-variant': 'danger', className: 'ms-btn',
    disabled: lastEnabled, title: lastEnabled ? '请先添加或启用另一个模型，再移除当前模型' : undefined,
    onClick }, '移除');
}

/** Chinese save-failure message, mapping the internal capabilities error code. */
export function saveFailureMessage(reason) {
  return reason?.code === 'invalid_model_capabilities'
    ? '模型预算校验失败：最大输出 Token 必须为正整数，并小于上下文窗口。'
    : reason?.message || '保存模型与凭证失败';
}

/** Sync to DSH, rolling the Host config back to its pre-save state on failure
 * so the two never end up out of sync. */
export async function applyProfilesWithRollback({ dshModel, persistedProfiles, keys, hostRemote, rollbackProfiles }) {
  try {
    await dshModel.applyProfiles({ profiles: persistedProfiles, keys });
  } catch (reason) {
    await hostRemote.updateSettings({ modelProfiles: rollbackProfiles }).catch(() => {});
    throw Object.assign(new Error(`同步到对话引擎失败：${reason?.message || reason}。本机配置已回滚到保存前，请重试。`), { code: reason?.code });
  }
}
