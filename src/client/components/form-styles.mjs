import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createFormStyles(BRAND = DEFAULT_BRAND) {
  function inputStyle() {
    return { display: 'block', boxSizing: 'border-box', width: '100%', height: '32px', marginTop: '6px', padding: '0 8px', border: '0.5px solid ' + BRAND.controlBorder, borderRadius: 'var(--dsw-radius-md, 12px)', color: BRAND.ink, background: BRAND.surface, fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px' };
  }

  function buttonStyle() {
    return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px', minHeight: '36px', boxSizing: 'border-box', border: '0.5px solid ' + BRAND.border, borderRadius: 'var(--dsw-radius-md, 12px)', padding: '0 14px', color: BRAND.ink, background: 'transparent', fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px', fontWeight: 500, cursor: 'pointer' };
  }

  function pagerButtonStyle(disabled = false) {
    return {
      ...buttonStyle(), display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '68px', minHeight: '30px', padding: '6px 10px', flex: '0 0 auto',
      color: disabled ? 'var(--dsw-alias-label-secondary, #676767)' : BRAND.ink,
      background: disabled ? 'var(--dsw-alias-bg-layer-2, #f4f4f4)' : BRAND.surface,
      border: '1px solid ' + BRAND.border,
      opacity: 1,
    };
  }
  return { inputStyle, buttonStyle, pagerButtonStyle };
}
