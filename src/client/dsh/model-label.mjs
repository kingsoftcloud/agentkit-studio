/** Display-only annotations inside DSH's native model-selection controls. */
import { modelCard, modelDisplayName, modelScores } from '../../model-cards.mjs';
import { HARNESS_SERVICE_MODEL_PROVIDER } from '../../model-route.mjs';
import { renderModelPreview } from '../pages/model-card-view.mjs';
import modelCardStyles from '../styles/model-card.css.mjs';

export function createModelCardIndex(load) {
  let cards = {}, cardsByProvider = {}, sharedScores = {}, enabled = false, checked = false, pending = null, version = 0;
  const listeners = new Set();
  let menuListeners = 0;
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
      sharedScores = value?.sharedScores ?? {};
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
    sharedScores = {};
    enabled = false;
    checked = false;
    pending = null;
    emit();
  }
  return {
    refresh,
    invalidate,
    get version() { return version; },
    subscribe(listener, { menu = true } = {}) {
      listeners.add(listener);
      if (menu) menuListeners += 1;
      return () => {
        listeners.delete(listener);
        const lastMenu = menu && --menuListeners === 0;
        if (!listeners.size) invalidate();
        else if (lastMenu) {
          // Keep the trigger's name while the next menu opening revalidates prices.
          checked = false;
          pending = null;
        }
      };
    },
    card(provider, id, { allowCached = false, presentationProvider, metadata } = {}) {
      if (!enabled || !id || (!checked && !allowCached)) return null;
      const catalog = provider === HARNESS_SERVICE_MODEL_PROVIDER
        ? cards
        : Object.hasOwn(cardsByProvider, provider) ? cardsByProvider[provider] : {};
      if (Object.hasOwn(catalog, id)) return catalog[id];
      // An alias can use the exact upstream's card only when that identity is
      // explicit and also names a configured catalog route.
      if (presentationProvider && Object.hasOwn(cardsByProvider, presentationProvider)
        && Object.hasOwn(cardsByProvider[presentationProvider], id)) return cardsByProvider[presentationProvider][id];
      const scores = Object.hasOwn(sharedScores, id) ? sharedScores[id] : modelScores(id);
      if (!scores && !metadata?.inputModalities?.some(input => input !== 'text')
        && !metadata?.contextWindow && !metadata?.reasoning) return null;
      return { ...modelCard({ id, name: metadata?.name, input: metadata?.inputModalities, context_window: metadata?.contextWindow },
        { reasoningLevels: metadata?.reasoning?.efforts }), scores };
    },
  };
}

export function modelLabel(h, Tag, card, model, placement, anchor) {
  const name = model?.name && model.name !== model.id ? model.name : card?.displayName || modelDisplayName(model?.id) || model?.name || '';
  const effort = placement === 'option' && model?.reasoning?.efforts?.find(item => item.id === model.reasoning.defaultEffort);
  const text = model?.badge?.text;
  const badgeText = typeof text === 'string' ? text : text?.['zh-CN'] || text?.zh || text?.en;
  const badge = badgeText ? h(Tag, { tone: model.badge.tone }, badgeText) : null;
  const nameRow = h('span', { style: { display: 'inline-flex', minWidth: 0, alignItems: 'center', gap: '6px' } },
    placement === 'trigger' ? badge : null,
    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
    effort ? h('span', { title: '默认思考等级', style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, effort.name) : null,
    placement === 'trigger' ? null : badge);
  return h('span', { ref: anchor, 'data-studio-model-label': placement,
    style: { display: 'inline-flex', maxWidth: '100%', minWidth: 0 } }, nameRow);
}

export function installModelLabel(ctx, { React, ReactDOM, Tag, hostRemote, window }) {
  if (!ctx.slots?.inject || typeof hostRemote?.modelCards !== 'function') return;
  const index = createModelCardIndex(() => hostRemote.modelCards());
  function ModelLabel({ provider, model, placement }) {
    const h = React.createElement;
    const anchor = React.useRef(null);
    const popup = React.useRef(null);
    const tooltipId = React.useId();
    const [row, setRow] = React.useState(null);
    const [show, setShow] = React.useState(false);
    const [, setVersion] = React.useState(index.version);
    React.useEffect(() => {
      const menu = placement !== 'trigger';
      const unsubscribe = index.subscribe(() => {
        setVersion(index.version);
        if (menu) index.refresh();
      }, { menu });
      if (menu) index.refresh();
      setVersion(index.version);
      return unsubscribe;
    }, [placement]);
    const card = index.card(provider?.id, model?.id, {
      allowCached: placement === 'trigger', presentationProvider: model?.presentationProvider?.id, metadata: placement === 'option' ? model : undefined,
    });
    const hasPreview = placement === 'option' && Boolean(card?.intro || card?.scores || card?.pricing);
    React.useEffect(() => {
      if (!hasPreview) return;
      const option = anchor.current?.closest('button[role="menuitemradio"]');
      if (!option) return;
      setRow(option);
      const menu = option.closest('[role="menu"]');
      let pointerInside = false;
      let keyboard = false;
      const refresh = () => setShow(pointerInside || keyboard && option.hasAttribute('data-highlighted'));
      const enter = event => { if (event.pointerType !== 'touch') { pointerInside = true; refresh(); } };
      const leave = () => { pointerInside = false; refresh(); };
      const key = event => {
        if (event.key === 'Escape') { keyboard = false; pointerInside = false; }
        if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(event.key)) {
          keyboard = true;
          pointerInside = false;
        }
        refresh();
      };
      const focus = () => { keyboard = option.matches(':focus-visible'); refresh(); };
      const blur = () => { keyboard = false; refresh(); };
      const observer = new window.MutationObserver(refresh);
      observer.observe(option, { attributes: true, attributeFilter: ['data-highlighted'] });
      option.addEventListener('pointerenter', enter);
      option.addEventListener('pointerleave', leave);
      option.addEventListener('focus', focus);
      option.addEventListener('blur', blur);
      // The menu may keep focus in its search box during arrow navigation.
      menu?.parentElement?.addEventListener('keydown', key, true);
      pointerInside = option.matches(':hover') && window.matchMedia('(hover: hover)').matches;
      refresh();
      return () => {
        observer.disconnect();
        option.removeEventListener('pointerenter', enter);
        option.removeEventListener('pointerleave', leave);
        option.removeEventListener('focus', focus);
        option.removeEventListener('blur', blur);
        menu?.parentElement?.removeEventListener('keydown', key, true);
      };
    }, [hasPreview]);
    React.useLayoutEffect(() => {
      const element = popup.current;
      if (!show || !row || !element) return;
      const previous = row.getAttribute('aria-describedby');
      row.setAttribute('aria-describedby', [previous, tooltipId].filter(Boolean).join(' '));
      const place = () => {
        const bounds = row.getBoundingClientRect();
        const menu = row.closest('[role="menu"]')?.getBoundingClientRect() ?? bounds;
        const gap = 8;
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const beside = menu.right + gap + width <= window.innerWidth
          ? menu.right + gap : menu.left - gap - width;
        const fitsSide = beside >= gap;
        const left = fitsSide ? beside : Math.max(gap, Math.min(bounds.left, window.innerWidth - width - gap));
        const below = bounds.bottom + gap;
        const top = fitsSide ? bounds.top : below + height <= window.innerHeight ? below : bounds.top - height - gap;
        element.style.left = left + 'px';
        element.style.top = Math.max(gap, Math.min(top, window.innerHeight - height - gap)) + 'px';
        element.style.visibility = bounds.bottom <= menu.top || bounds.top >= menu.bottom ? 'hidden' : 'visible';
      };
      place();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      return () => {
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
        if (previous === null) row.removeAttribute('aria-describedby');
        else row.setAttribute('aria-describedby', previous);
      };
    }, [card, row, show, tooltipId]);
    return h(React.Fragment, null, modelLabel(h, Tag, card, model, placement, anchor),
      hasPreview && show && row && ReactDOM?.createPortal
        ? ReactDOM.createPortal(h('div', { ref: popup, id: tooltipId, role: 'tooltip', 'data-studio-model-preview': true },
          h('strong', null, card.displayName || model.name),
          renderModelPreview(h, Tag, card)), window.document.body) : null);
  }
  ctx.effect(() => {
    const style = window.document.createElement('style');
    style.textContent = modelCardStyles;
    window.document.head.append(style);
    const invalidate = () => {
      index.invalidate();
      window.dispatchEvent(new window.Event('agentkit-studio:routemind-changed'));
    };
    const unsubscribe = ctx.remote?.$on?.('plugin-manager/changed', invalidate);
    window.addEventListener('agentkit-studio:model-credential-changed', invalidate);
    window.addEventListener('agentkit-studio:connection-reset', invalidate);
    return () => {
      unsubscribe?.();
      style.remove();
      window.removeEventListener('agentkit-studio:model-credential-changed', invalidate);
      window.removeEventListener('agentkit-studio:connection-reset', invalidate);
    };
  }, 'agentkit-studio:model-cards');
  ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register(
    { name: 'conversation.input.model.label' }, ModelLabel,
  ));
}
