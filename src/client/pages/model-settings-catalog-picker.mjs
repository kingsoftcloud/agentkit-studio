import { importedModelReasoning } from '../../model-catalog-reasoning.mjs';
import { formatEffortLevels, REASONING_LABELS as LEVEL_LABELS, renderEffortReport } from './model-settings-effort-probe.mjs';
import { priceMultiplier } from '../../model-cards.mjs';
import { renderModelCardDetails, renderModelCardSummary } from './model-card-view.mjs';

/** Reference for price multipliers: the connection's default model, else the first priced chat model. */
export function referenceCard(items, connection) {
  const wanted = [connection?.defaultModel, connection?.modelName].filter(Boolean);
  const byId = items.find(item => wanted.includes(item.id) && item.card?.pricing);
  return (byId || items.find(item => item.card?.category === 'chat' && item.card?.pricing))?.card || null;
}

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
  return items.filter(item => [item.id, item.name, item.card?.displayName].filter(Boolean).join(' ').toLowerCase().includes(term));
}

export function createModelCatalogPicker({ h, useState, DisclosureRow, Tag, InfoIcon }) {
  function ModelDisclosure({ card, multiplier }) {
    const [open, setOpen] = useState(false);
    return h(DisclosureRow, {
      className: 'ms-card-details', title: '模型详情', open, expandable: true,
      expandOnRowClick: true, onToggle: () => setOpen(!open),
      icon: h(InfoIcon, { size: 14, 'aria-hidden': true }),
    }, open ? renderModelCardDetails(h, card, multiplier) : null);
  }

  return ({ items, referenceItems = items, picks, existing, connection, onPick, manualIds, probing, reportFor }) => {
    const reference = referenceCard(referenceItems, connection);
    return h('ul', {
      className: 'ms-catalog-list', 'aria-label': '目录模型',
    }, items.map(item => {
      const multiplier = item.card ? priceMultiplier(item.card, reference) : null;
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
      const name = item.card?.displayName || item.id;
      const status = meta.length ? h('span', { className: 'ms-row-status ms-catalog-meta', title: meta.join(' · ') }, meta.join(' · ')) : null;
      return h('li', { key: item.id },
        h('label', { className: 'ms-catalog-row', 'data-configured': Boolean(configured) },
          h('input', { type: 'checkbox', 'aria-label': item.id, checked: Boolean(configured || checked), disabled: Boolean(configured || probing),
            onChange: event => onPick(item, event.target.checked) }),
          item.card ? h('span', { className: 'ms-card-content' },
            h('span', { className: 'ms-card-title-row' },
              h('span', { className: 'ms-model-name ms-card-name', title: item.id },
                h('span', { className: 'ms-card-display' }, name),
                name !== item.id ? h('span', { className: 'ms-card-id' }, item.id) : null), status),
            renderModelCardSummary(h, Tag, item.card, multiplier))
            : h('span', { className: 'ms-model-name', title: item.id }, name),
          item.card ? null : status),
        item.card ? h(ModelDisclosure, { card: item.card, multiplier }) : null,
        checked ? renderEffortReport(h, reportFor(item.id)) : null);
    }));
  };
}
