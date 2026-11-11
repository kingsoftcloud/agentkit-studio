import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createNavigation({
  ui: { React: { createElement: h }, BRAND = DEFAULT_BRAND },
}) {
  function StudioSubnav({ items, value, onChange, variant, ariaLabel }) {
    if (variant === 'segmented') return h('nav', { 'aria-label': ariaLabel || 'Studio 二级导航', className: 'ak-segmented' },
      items.map(item => h('button', { key: item.id, type: 'button', onClick: () => onChange(item.id), 'aria-current': value === item.id ? 'page' : undefined }, item.label)));
    return h('nav', {
      'aria-label': 'Studio 二级导航',
      'data-studio-tabs': 'true',
      'data-studio-drag-region': 'true',
      // DSH only honours its own `[data-window-drag]` hook; the Studio marker
      // alone does not survive the shell's no-drag rules.
      'data-window-drag': 'true',
      className: 'studio-tabs',
    }, items.map(item => h('button', {
      key: item.id,
      type: 'button',
      onClick: () => onChange(item.id),
      'aria-current': value === item.id ? 'page' : undefined,
    }, item.label)));
  }

  function StudioPageTabs({ items, value, onChange, ariaLabel }) {
    return h('nav', {
      'aria-label': ariaLabel || '页面标签',
      'data-studio-tabs': 'true',
      'data-studio-drag-region': 'true',
      // DSH only honours its own `[data-window-drag]` hook; the Studio marker
      // alone does not survive the shell's no-drag rules.
      'data-window-drag': 'true',
      role: 'tablist',
      className: 'studio-tabs',
    }, items.map(item => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': value === item.id,
      onClick: () => onChange(item.id),
    }, item.label)));
  }
  return { StudioSubnav, StudioPageTabs };
}
