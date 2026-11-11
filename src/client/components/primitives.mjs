import { BRAND } from '../theme.mjs';
import { AGENTKIT_STUDIO_BRAND as PRODUCT_BRAND, AGENTKIT_STUDIO_MARK_BODY as STUDIO_MARK_BODY } from '../../brand.js';

export function createStudioPrimitives({ React }) {
  const { createElement: h, useEffect, useState } = React;
  const HelpTip = text => text ? h('i', { className: 'studio-help', role: 'img', 'aria-label': text, title: text, tabIndex: 0 }, 'i') : null;
  function SecretInput({ label = 'API Key', value = '', style = {}, ...props }) {
    const [visible, setVisible] = useState(false);
    useEffect(() => { if (!value) setVisible(false); }, [value]);
    return h('span', { style: { position: 'relative', display: 'block' } },
      h('input', { ...props, 'aria-label': label, value, type: visible ? 'text' : 'password', autoComplete: 'new-password', style: { ...style, paddingRight: '42px' } }),
      h('button', { type: 'button', disabled: !value, 'aria-label': (visible ? '隐藏 ' : '显示 ') + label, 'aria-pressed': visible, onClick: () => setVisible(current => !current), style: { position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', width: '30px', height: '30px', display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary, #676767)', cursor: value ? 'pointer' : 'default' } },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }), h('circle', { cx: 12, cy: 12, r: 3 }), visible ? h('path', { d: 'm3 3 18 18' }) : null)));
  }

  function StudioMark({ size = 28, title = PRODUCT_BRAND.name }) {
    return h('svg', {
      width: size, height: size, viewBox: '0 0 64 64',
      role: title ? 'img' : 'presentation', 'aria-label': title || undefined,
      'aria-hidden': title ? undefined : 'true',
      style: { display: 'block', flex: '0 0 auto' },
      dangerouslySetInnerHTML: { __html: STUDIO_MARK_BODY },
    });
  }

  function StudioWordmark() {
    const prefix = `${PRODUCT_BRAND.shortName} `;
    return h('span', { style: { color: BRAND.ink } }, PRODUCT_BRAND.name.startsWith(prefix)
      ? [prefix, h('span', { key: 'suffix', style: { color: 'light-dark(#1858d6, #78a4ff)' } }, PRODUCT_BRAND.name.slice(prefix.length))]
      : PRODUCT_BRAND.name);
  }

  function NavGlyph({ glyph, active }) {
    return h('span', {
      'aria-hidden': 'true',
      style: {
        display: 'grid',
        placeItems: 'center',
        width: '24px',
        height: '24px',
        borderRadius: '7px',
        color: active ? BRAND.accentStrong : BRAND.inkMuted,
        background: active ? BRAND.accentSoft : 'transparent',
        fontSize: '15px',
        fontWeight: 700,
      },
    }, glyph || '·');
  }

  function Pill({ children, tone = 'neutral' }) {
    const styles = {
      neutral: { color: BRAND.inkMuted, background: 'var(--dsw-alias-bg-layer-2, #edf2f7)' },
      accent: { color: BRAND.accentStrong, background: BRAND.accentSoft },
      signal: { color: 'var(--dsw-alias-state-warn-primary, #8a5b13)', background: 'var(--dsw-alias-state-warn-tertiary, #fff3da)' },
    }[tone];
    return h('span', {
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '0 8px',
        borderRadius: '999px', fontSize: '12px', lineHeight: '20px', fontWeight: 500, whiteSpace: 'nowrap', ...styles,
      },
    }, children);
  }

  function SectionHeading({ title, detail, action }) {
    return h('div', { 'data-studio-heading': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '16px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '16px', fontWeight: 500, lineHeight: '24px' } }, title),
        HelpTip(detail)),
      action || null);
  }

  function OperationalPageHeading({ title, detail, action }) {
    return h('div', {
      'data-studio-heading': 'true',
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '16px', flexWrap: 'wrap', marginBottom: '16px',
      },
    },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
      h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '16px', lineHeight: '24px', fontWeight: 500 } }, title),
      HelpTip(detail)),
    action || null);
  }

  function OperationalPanel({ title, detail, action, children }) {
    return h('section', {
      style: { border: '0.5px solid var(--dsw-alias-border-l2, #e5e5e5)', borderRadius: 'var(--dsw-radius-xl, 16px)', padding: '16px', overflow: 'hidden', background: BRAND.surface },
    },
    (title || action) ? h('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' },
    }, h('div', null,
      title ? h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, title) : null,
      detail ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px' } }, detail) : null), action || null) : null,
    children);
  }

  function ContentIntro({ detail, action }) {
    return h('div', {
      'data-studio-content-intro': 'true',
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '16px' },
    }, HelpTip(detail), action || null);
  }

  function Metric({ label, value, detail, tone = 'neutral' }) {
    return h('article', {
      style: {
        border: '0.5px solid var(--dsw-alias-border-l2, #e5e5e5)', borderRadius: 'var(--dsw-radius-xl, 16px)', padding: '16px',
        background: BRAND.surface, minHeight: '106px',
      },
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
      h('span', { style: { color: BRAND.inkMuted, fontSize: '12px', fontWeight: 500 } }, label),
      tone === 'signal' ? h(Pill, { tone: 'signal' }, '待接入') : null),
    h('div', { style: { color: BRAND.ink, fontSize: '20px', fontWeight: 500, marginTop: '14px' } }, value),
    h('div', { title: detail, style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, detail));
  }

  function EmptyState({ icon, title, detail, action }) {
    return h('div', {
      style: {
        minHeight: '220px', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '28px',
        border: 0, background: 'transparent',
      },
    },
    h('div', null,
      h('div', { style: { margin: '0 auto 14px', display: 'grid', placeItems: 'center', width: '40px', height: '40px', border: '0.5px solid var(--dsw-alias-border-l2, #e5e5e5)', borderRadius: '12px', color: BRAND.inkMuted, fontSize: '20px', fontWeight: 500 } }, icon),
      h('h3', { style: { margin: 0, color: BRAND.ink, fontSize: '16px' } }, title),
      h('p', { style: { maxWidth: '420px', color: BRAND.inkMuted, lineHeight: 1.6, margin: '8px auto 16px', fontSize: '13px' } }, detail),
      action || null));
  }

  function DisabledAction({ children }) {
    return h('button', {
      type: 'button', disabled: true,
      style: { border: '1px solid ' + BRAND.border, borderRadius: '9px', padding: '8px 12px', color: 'var(--dsw-alias-label-tertiary, #8290a1)', background: 'var(--dsw-alias-bg-layer-2, #f4f7fa)', fontSize: '12px', fontWeight: 700, cursor: 'not-allowed' },
    }, children);
  }
  return { SecretInput, StudioMark, StudioWordmark, Pill, SectionHeading, OperationalPageHeading, OperationalPanel, ContentIntro, Metric, EmptyState, DisabledAction };
}
