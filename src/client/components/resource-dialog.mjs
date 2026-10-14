import { BRAND } from '../theme.mjs';

export function createResourceDialog({ React, buttonStyle }) {
  const { createElement: h } = React;
  function ResourceDialog({ title, detail, children, onClose, wide = false }) {
    return h('div', {
      role: 'presentation',
      onMouseDown: event => { if (event.target === event.currentTarget) onClose(); },
      style: { position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: '24px', background: 'rgba(7, 14, 24, 0.46)' },
    }, h('section', {
      role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-studio-dialog': 'true',
      style: { width: `min(${wide ? 920 : 680}px, 100%)`, maxHeight: 'min(760px, calc(100vh - 48px))', overflow: 'auto', border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '20px', background: BRAND.surface, boxShadow: '0 22px 70px rgba(7, 14, 24, 0.28)' },
    }, h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', marginBottom: '16px' } },
      h('div', null, h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '18px' } }, title), detail ? h('p', { style: { margin: '6px 0 0', color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.5 } }, detail) : null),
      h('button', { type: 'button', 'aria-label': '关闭', onClick: onClose, style: { ...buttonStyle(), padding: '5px 9px', fontSize: '14px' } }, '×')),
      children));
  }
  return ResourceDialog;
}
