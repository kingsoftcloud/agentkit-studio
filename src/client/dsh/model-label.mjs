/** Display-only annotations inside DSH's native model-selection controls. */
import { modelDisplayName, modelScores, priceText } from '../../model-cards.mjs';
import { HARNESS_SERVICE_MODEL_PROVIDER } from '../../model-route.mjs';
import { renderModelScoreBars } from '../pages/model-card-view.mjs';

export function createModelCardIndex(load) {
  let cards = {}, cardsByProvider = {}, enabled = false, checked = false, pending = null, version = 0;
  const listeners = new Set();
  const emit = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  function refresh() {
    if (pending || checked) return pending;
    const request = Promise.resolve().then(load).then(value => {
      if (pending !== request) return;
      enabled = value?.enabled === true;
      cards = value?.cards ?? {};
      cardsByProvider = value?.cardsByProvider ?? {};
      checked = true;
      emit();
    }).catch(() => {}).finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  }
  function invalidate() {
    cards = {};
    cardsByProvider = {};
    enabled = false;
    checked = false;
    pending = null;
    emit();
  }
  return {
    refresh,
    invalidate,
    get version() { return version; },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        // Revalidate the plugin when the model menu opens again.
        if (!listeners.size) invalidate();
      };
    },
    card(provider, id) {
      if (!enabled || !id) return null;
      const catalog = provider === HARNESS_SERVICE_MODEL_PROVIDER
        ? cards
        : Object.hasOwn(cardsByProvider, provider) ? cardsByProvider[provider] : {};
      if (Object.hasOwn(catalog, id)) return catalog[id];
      const scores = modelScores(id);
      return scores ? { displayName: modelDisplayName(id), scores } : null;
    },
  };
}

export function modelLabel(h, Tag, card, model, placement) {
  const name = model?.name && model.name !== model.id ? model.name : card?.displayName || model?.name || model?.id || '';
  const text = model?.badge?.text;
  const badgeText = typeof text === 'string' ? text : text?.['zh-CN'] || text?.zh || text?.en;
  const badge = badgeText ? h(Tag, { tone: model.badge.tone }, badgeText) : null;
  const price = placement === 'trigger' ? '' : priceText(card);
  const bars = placement === 'trigger' ? null : renderModelScoreBars(h, card?.scores);
  const nameRow = h('span', { style: { display: 'inline-flex', minWidth: 0, alignItems: 'center', gap: '6px' } },
    placement === 'trigger' ? badge : null,
    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
    placement === 'trigger' ? null : badge);
  return h('span', { title: model?.id, 'data-studio-model-label': placement,
    style: { display: 'inline-flex', maxWidth: '100%', minWidth: 0, flexDirection: 'column', gap: '3px' } },
  nameRow, price || bars ? h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' } },
    price ? h('span', { title: '目录标价，每百万 tokens 输入 / 输出' }, h(Tag, { tone: 'neutral' }, price)) : null,
    bars) : null);
}

export function installModelLabel(ctx, { React, Tag, hostRemote, window }) {
  if (!ctx.slots?.inject || typeof hostRemote?.modelCards !== 'function') return;
  const index = createModelCardIndex(() => hostRemote.modelCards());
  function ModelLabel({ provider, model, placement }) {
    const [, setVersion] = React.useState(index.version);
    React.useEffect(() => {
      if (placement === 'trigger') return;
      const unsubscribe = index.subscribe(() => {
        setVersion(index.version);
        index.refresh();
      });
      index.refresh();
      return unsubscribe;
    }, [placement]);
    return modelLabel(React.createElement, Tag, index.card(provider?.id, model?.id), model, placement);
  }
  ctx.effect(() => {
    const invalidate = () => index.invalidate();
    window.addEventListener('agentkit-studio:model-credential-changed', invalidate);
    window.addEventListener('agentkit-studio:connection-reset', invalidate);
    return () => {
      window.removeEventListener('agentkit-studio:model-credential-changed', invalidate);
      window.removeEventListener('agentkit-studio:connection-reset', invalidate);
    };
  }, 'agentkit-studio:model-cards');
  ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register(
    { name: 'conversation.input.model.label' }, ModelLabel,
  ));
}
