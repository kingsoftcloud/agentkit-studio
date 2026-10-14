import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createNavigation({ ui }) {
  const { React, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h } = React;
  function StudioSubnav({ items, value, onChange }) {
    return h('nav', {
      'aria-label': 'Studio 二级导航',
      'data-studio-tabs': 'true',
      style: { display: 'flex', flexWrap: 'wrap', gap: 0, padding: 0, marginBottom: '20px', border: 0, borderBottom: '1px solid ' + BRAND.border, borderRadius: 0, background: 'transparent' },
    }, items.map(item => h('button', {
      key: item.id,
      type: 'button',
      onClick: () => onChange(item.id),
      'aria-current': value === item.id ? 'page' : undefined,
      style: { minHeight: '32px', border: 0, borderBottom: '2px solid ' + (value === item.id ? BRAND.accentStrong : 'transparent'), borderRadius: 0, padding: '0 16px', color: value === item.id ? BRAND.accentStrong : BRAND.inkMuted, background: 'transparent', fontSize: '12px', fontWeight: value === item.id ? 800 : 650, cursor: 'pointer' },
    }, item.label)));
  }

  function StudioPageTabs({ items, value, onChange, ariaLabel }) {
    return h('nav', {
      'aria-label': ariaLabel || '页面标签',
      'data-studio-tabs': 'true',
      role: 'tablist',
      style: { display: 'flex', flexWrap: 'wrap', gap: 0, padding: 0, marginBottom: '14px', border: 0, borderBottom: '1px solid ' + BRAND.border, borderRadius: 0, background: 'transparent' },
    }, items.map(item => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': value === item.id,
      onClick: () => onChange(item.id),
      style: { minHeight: '32px', border: 0, borderBottom: '2px solid ' + (value === item.id ? BRAND.accentStrong : 'transparent'), borderRadius: 0, padding: '0 16px', color: value === item.id ? BRAND.accentStrong : BRAND.inkMuted, background: 'transparent', fontSize: '12px', fontWeight: value === item.id ? 800 : 650, cursor: 'pointer' },
    }, item.label)));
  }
  return { StudioSubnav, StudioPageTabs };
}
