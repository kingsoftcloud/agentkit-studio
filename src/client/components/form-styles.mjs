import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createFormStyles(BRAND = DEFAULT_BRAND) {
  function inputStyle() {
    return { display: 'block', boxSizing: 'border-box', width: '100%', height: '32px', marginTop: '6px', padding: '0 8px', border: '0.5px solid ' + BRAND.controlBorder, borderRadius: 'var(--dsw-radius-md, 12px)', color: BRAND.ink, background: BRAND.surface, fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px' };
  }

  function buttonStyle(variant = 'outline', size) {
    return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', minHeight: size === 'sm' ? '28px' : '32px', boxSizing: 'border-box', border: '0.5px solid ' + (variant === 'outline' ? BRAND.controlBorder : 'transparent'), borderRadius: size === 'sm' ? '8px' : '12px', padding: size === 'sm' ? '0 10px' : '0 12px', color: variant === 'primary' ? BRAND.primaryText : variant === 'ghost' ? BRAND.inkMuted : BRAND.ink, background: variant === 'primary' ? BRAND.primaryFill : 'transparent', fontFamily: 'inherit', fontSize: size === 'sm' ? '12px' : '13px', lineHeight: '20px', fontWeight: 400, cursor: 'pointer' };
  }

  function pagerButtonStyle(disabled = false) {
    return {
      ...buttonStyle('ghost', 'sm'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '28px', minHeight: '28px', padding: '0 8px', flex: '0 0 auto',
      color: disabled ? 'var(--dsw-alias-label-secondary, #676767)' : BRAND.ink,
      background: 'transparent',
      border: '0.5px solid transparent',
      opacity: disabled ? 0.4 : 1,
    };
  }
  return { inputStyle, buttonStyle, pagerButtonStyle };
}
