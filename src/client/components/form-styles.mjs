import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createFormStyles(BRAND = DEFAULT_BRAND) {
  function inputStyle() {
    return { display: 'block', boxSizing: 'border-box', width: '100%', height: '32px', marginTop: '6px', padding: '0 8px', border: '0.5px solid ' + BRAND.controlBorder, borderRadius: 'var(--dsw-radius-md, 12px)', color: BRAND.ink, background: BRAND.surface, fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px' };
  }

  function buttonStyle() {
    return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px', minHeight: '32px', boxSizing: 'border-box', border: '0.5px solid ' + BRAND.border, borderRadius: '16px', padding: '0 12px', color: BRAND.ink, background: 'transparent', fontFamily: 'inherit', fontSize: '13px', lineHeight: '20px', fontWeight: 500, cursor: 'pointer' };
  }

  function pagerButtonStyle(disabled = false) {
    return {
      ...buttonStyle(), display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '28px', minHeight: '28px', padding: '0 8px', flex: '0 0 auto',
      color: disabled ? 'var(--dsw-alias-label-secondary, #676767)' : BRAND.ink,
      background: 'transparent',
      border: '0.5px solid ' + BRAND.border,
      opacity: disabled ? 0.4 : 1,
    };
  }
  return { inputStyle, buttonStyle, pagerButtonStyle };
}
