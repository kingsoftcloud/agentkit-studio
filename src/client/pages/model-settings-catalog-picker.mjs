import { importedModelReasoning } from '../../model-catalog-reasoning.mjs';
import { formatEffortLevels, REASONING_LABELS as LEVEL_LABELS, renderEffortReport } from './model-settings-effort-probe.mjs';

export function catalogItems(response) {
  const items = new Map();
  for (const item of Array.isArray(response?.items) ? response.items : []) {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id && !items.has(id)) items.set(id, { ...item, id });
  }
  return [...items.values()];
}

export function matchingModels(items, query) {
  const term = query.trim().toLowerCase();
  return items.filter(item => [item.id, item.name].filter(Boolean).join(' ').toLowerCase().includes(term));
}

export function createModelCatalogPicker(h) {
  return ({ items, picks, existing, connection, onPick, manualIds, probing, reportFor }) => h('ul', {
    className: 'ms-catalog-list', 'aria-label': '目录模型',
  }, items.map(item => {
    const configured = existing?.has(item.id);
    const checked = Boolean(picks?.has(item.id));
    const effort = importedModelReasoning(item, connection).defaultReasoningEffort;
    const levels = item.reasoningLevels || [];
    const meta = configured ? ['已添加'] : [
      manualIds?.has(item.id) ? '手动添加' : '',
      levels.length ? '目录档位 · ' + formatEffortLevels(levels) : '',
      effort ? '默认' + LEVEL_LABELS[effort] : checked ? '沿用服务默认' : '',
      item.inputKnown !== false && item.input?.includes('image') ? '支持图片' : '',
    ].filter(Boolean);
    return h('li', { key: item.id }, h('label', { className: 'ms-catalog-row', 'data-configured': Boolean(configured) },
      h('input', { type: 'checkbox', 'aria-label': item.id, checked: Boolean(configured || checked), disabled: Boolean(configured || probing),
        onChange: event => onPick(item, event.target.checked) }),
      h('span', { className: 'ms-model-name', title: item.id }, item.id),
      meta.length ? h('span', { className: 'ms-row-status ms-catalog-meta', title: meta.join(' · ') }, meta.join(' · ')) : null),
      checked ? renderEffortReport(h, reportFor(item.id)) : null);
  }));
}
