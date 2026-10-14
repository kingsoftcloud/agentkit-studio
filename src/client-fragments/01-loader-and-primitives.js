/* global window */

/**
 * Browser half of AgentKit Studio.
 *
 * Studio contributes one DSH global panel containing its product surface. The
 * product surface owns Studio navigation and control-plane pages; DSH keeps ownership
 * of conversation, session, tool and dock state.
 */
window.__ModuleLoader__.load({
  id: '@kingsoftcloud/agentkit-studio',
  factory: require => {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const normalizeModelEndpoint = __AGENTKIT_MODEL_ENDPOINT_NORMALIZER__;

    /** Show only the value just typed; stored credentials are never read back. */
    function SecretInput({ label = 'API Key', value = '', style = {}, ...props }) {
      const [visible, setVisible] = useState(false);
      useEffect(() => { if (!value) setVisible(false); }, [value]);
      return h('span', { style: { position: 'relative', display: 'block' } },
        h('input', { ...props, 'aria-label': label, value, type: visible ? 'text' : 'password', autoComplete: 'new-password', style: { ...style, paddingRight: '42px' } }),
        h('button', { type: 'button', disabled: !value, 'aria-label': (visible ? '隐藏 ' : '显示 ') + label, 'aria-pressed': visible, onClick: () => setVisible(current => !current), style: { position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', width: '30px', height: '30px', display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary, #676767)', cursor: value ? 'pointer' : 'default' } },
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }), h('circle', { cx: 12, cy: 12, r: 3 }), visible ? h('path', { d: 'm3 3 18 18' }) : null)));
    }
    const { IconSettingsOutlineMedium, IconChevronDownOutlineRegular, Menu, MenuItemButton, Input, Tooltip, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const STUDIO_VERSION = String((window.__AGENTKIT_STUDIO__ || {}).version || 'Web 模式');
    const STUDIO_PLUGIN_VERSION = String((window.__AGENTKIT_STUDIO__ || {}).pluginVersion || '未提供');
    const DSH_VERSION = String((window.__AGENTKIT_STUDIO__ || {}).dshVersion || '0.2.0-rc.2');
    // DSH Native is the official DSH SDK-backed loop. Resource-bearing and
    // non-DSH revisions use the preset-scoped Studio provider bridge, while
    // the DSH loop and native conversation renderer remain authoritative.
    const ALLOWED_RUNTIME_TYPES = ['dsh-native', 'harness', 'codex'];
    const RUNTIME_LABELS = {
      'dsh-native': 'DSH Native Harness',
      harness: 'AgentKit Harness',
      codex: 'Codex Agent',
    };

    // The Host URL is injected by the Host half for packaged builds. A
    // loopback default keeps the local Web spike usable without requiring a
    // global CLI or a second browser application. Credentials never enter
    // this renderer; the Host owns session exchange and secret storage.
    // Temporary fragment composition; these owners are explicitly disposed by apply.
    const connectionOwner = createConnectionOwner();
    const hostRemote = createHostRemote(connectionOwner.connection);
    const { readConversationAgent, writeConversationAgent } = createConversationAgentState();

    // Global confirm dialog: a Studio-styled replacement for window.confirm.
    // Built with native DOM (no React mount point needed — StudioShell's
    // structure stays untouched) and returns a Promise<boolean>.
    function confirmDialog(options = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(10,14,18,0.55);backdrop-filter:blur(2px)';
        const card = document.createElement('div');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('data-studio-controls', 'true');
        card.style.cssText = 'width:min(420px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l3,#d4d4d4);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,#fff);padding:20px;box-shadow:0 18px 50px rgba(10,14,18,0.28);font-family:inherit';
        const title = document.createElement('strong');
        title.textContent = options.title || '确认操作';
        title.style.cssText = 'display:block;color:var(--dsw-alias-label-primary,#0d0d0d);font-size:15px';
        card.append(title);
        if (options.detail) {
          const detail = document.createElement('p');
          detail.textContent = options.detail;
          detail.style.cssText = 'color:var(--dsw-alias-label-secondary,#676767);font-size:14px;line-height:1.6;margin:10px 0 0;white-space:pre-wrap';
          card.append(detail);
        }
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = options.cancelLabel || '取消';
        cancel.style.cssText = 'font:inherit;cursor:pointer;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l3,#d4d4d4);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0d0d0d)';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.textContent = options.confirmLabel || '确定';
        confirm.autofocus = true;
        const danger = options.danger !== false;
        confirm.style.cssText = 'font:inherit;cursor:pointer;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:.5px solid transparent;color:' + (danger ? 'var(--dsw-static-neutral-00,#fff)' : 'var(--dsw-alias-label-primary-foreground,#fff)') + ';background:' + (danger ? 'var(--dsw-alias-state-danger-primary,#c2402a)' : 'var(--dsw-alias-button-primary-fill,#0b0b0d)');
        const settle = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
        const onKey = event => { if (event.key === 'Escape') settle(false); if (event.key === 'Enter') settle(true); };
        cancel.addEventListener('click', () => settle(false));
        confirm.addEventListener('click', () => settle(true));
        overlay.addEventListener('click', event => { if (event.target === overlay) settle(false); });
        document.addEventListener('keydown', onKey);
        actions.append(cancel, confirm);
        card.append(actions);
        overlay.append(card);
        document.body.append(overlay);
        confirm.focus();
      });
    }
    window.__AGENTKIT_CONFIRM__ = confirmDialog;

    const BRAND = {
      // Use the established Studio neutral console tokens. The AgentKit mark,
      // layout and product surfaces remain owned by this application.
      ink: 'var(--dsw-alias-label-primary, #0d0d0d)',
      inkMuted: 'var(--dsw-alias-label-secondary, #676767)',
      canvas: 'var(--dsw-alias-bg-layer-2, #f4f5f6)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      border: 'var(--dsw-alias-border-l3, #d4d4d4)',
      controlBorder: 'var(--dsw-alias-border-l4, #d4d4d4)',
      accent: 'var(--dsw-alias-brand-primary, #0d0d0d)',
      accentStrong: 'var(--dsw-alias-label-primary, #000000)',
      primaryFill: 'var(--dsw-alias-button-primary-fill, #0b0b0d)',
      primaryText: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      accentSoft: 'var(--dsw-alias-interactive-bg-hover, #f0f0f0)',
      signal: 'var(--dsw-alias-state-warn-primary, #946200)',
      danger: 'var(--dsw-alias-state-error-primary, #b42318)',
    };

    // These rows are mounted directly below DSH's New Session control. There
    // is no parent "AgentKit Studio" tab; DSH owns the workspace/session list
    // immediately below this product navigation.
    // Keep the first level small like the original Studio. A runtime is an
    // Agent Revision's execution target, while the operations group is where
    // runs, builds and their evidence live. The detailed domains are exposed
    // as secondary tabs inside these workspaces instead of nine competing
    // sidebar rows.
    const PANELS = [
      { id: 'studio-overview', page: 'overview', label: '总览', note: '工作区状态', glyph: '⌂' },
      { id: 'studio-agents', page: 'agents', label: 'Agents', note: '创建与版本', glyph: '✦' },
      { id: 'studio-resources', page: 'resource-hub', label: '资源库', note: '模型、工具与运行资源', glyph: '◈' },
      { id: 'studio-operations', page: 'operations', label: '运行中心', note: '构建、部署与观测', glyph: '↗' },
    ];

    // Fixed product artwork; controls continue to use the host theme tokens.
    const STUDIO_MARK_BODY = '__AGENTKIT_STUDIO_MARK_BODY__';
    const STUDIO_MARK_SVG = '__AGENTKIT_STUDIO_MARK_SVG__';

    function StudioMark({ size = 28, title = 'AgentKit Studio' }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 64 64',
        role: title ? 'img' : 'presentation', 'aria-label': title || undefined,
        'aria-hidden': title ? undefined : 'true',
        style: { display: 'block', flex: '0 0 auto' },
        dangerouslySetInnerHTML: { __html: STUDIO_MARK_BODY },
      });
    }

    function StudioWordmark() {
      return h('span', { style: { color: BRAND.ink } }, 'AgentKit ', h('span', { style: { color: 'light-dark(#1858d6, #78a4ff)' } }, 'Studio'));
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
          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 9px',
          borderRadius: '999px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap', ...styles,
        },
      }, children);
    }

    function SectionHeading({ eyebrow, title, detail, action }) {
      return h('div', { 'data-studio-heading': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px', marginBottom: '18px' } },
        h('div', null,
          eyebrow ? h('div', { style: { color: BRAND.accentStrong, fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '7px' } }, eyebrow) : null,
          h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '22px', letterSpacing: '-0.02em' } }, title),
          detail ? h('p', { style: { color: BRAND.inkMuted, margin: '7px 0 0', lineHeight: 1.55, fontSize: '13px' } }, detail) : null),
        action || null);
    }

    // Operational pages use the compact document-header rhythm: one
    // compact title row, a short description and the actions at the same
    // baseline.  The application already owns the global page title, so repeating
    // the all-caps eyebrow here only consumed vertical space and made the
    // Channels/Automation/Evaluation pages look like nested mock screens.
    function OperationalPageHeading({ title, detail, action }) {
      return h('div', {
        'data-studio-heading': 'true',
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: '16px', flexWrap: 'wrap', marginBottom: '14px', paddingBottom: '12px',
          borderBottom: '1px solid ' + BRAND.border,
        },
      },
      h('div', { style: { minWidth: 0 } },
        h('h2', { style: { margin: 0, color: BRAND.ink, fontSize: '19px', letterSpacing: '-0.02em' } }, title),
        detail ? h('p', { style: { color: BRAND.inkMuted, margin: '5px 0 0', lineHeight: 1.45, fontSize: '12px', maxWidth: '760px' } }, detail) : null),
      action || null);
    }

    function OperationalPanel({ title, detail, action, children }) {
      return h('section', {
        style: { border: '1px solid ' + BRAND.border, borderRadius: '12px', overflow: 'hidden', background: BRAND.surface },
      },
      (title || action) ? h('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '11px 14px', borderBottom: '1px solid ' + BRAND.border },
      }, h('div', null,
        title ? h('strong', { style: { color: BRAND.ink, fontSize: '13px' } }, title) : null,
        detail ? h('div', { style: { color: BRAND.inkMuted, fontSize: '11px', marginTop: '3px' } }, detail) : null), action || null) : null,
      children);
    }

    // The Studio application already owns the page title. Inner workspaces use this
    // compact context row so a panel never renders the same title twice.
    function ContentIntro({ detail, action }) {
      return h('div', {
        'data-studio-content-intro': 'true',
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '16px' },
      }, h('p', { style: { color: BRAND.inkMuted, margin: 0, lineHeight: 1.55, fontSize: '12px' } }, detail), action || null);
    }

    function Metric({ label, value, detail, tone = 'neutral' }) {
      return h('article', {
        style: {
          border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '16px',
          background: BRAND.surface, minHeight: '106px', boxShadow: '0 8px 24px rgba(11,18,32,0.04)',
        },
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
        h('span', { style: { color: BRAND.inkMuted, fontSize: '12px', fontWeight: 700 } }, label),
        tone === 'signal' ? h(Pill, { tone: 'signal' }, '待接入') : null),
      h('div', { style: { color: BRAND.ink, fontSize: '24px', fontWeight: 750, marginTop: '14px', letterSpacing: '-0.03em' } }, value),
      h('div', { style: { color: BRAND.inkMuted, fontSize: '12px', marginTop: '4px' } }, detail));
    }

    function EmptyState({ icon, title, detail, action }) {
      return h('div', {
        style: {
          minHeight: '220px', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '28px',
          border: '1px dashed ' + BRAND.border, borderRadius: '16px', background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.66))',
        },
      },
      h('div', null,
        h('div', { style: { margin: '0 auto 14px', display: 'grid', placeItems: 'center', width: '44px', height: '44px', borderRadius: '13px', color: BRAND.accentStrong, background: BRAND.accentSoft, fontSize: '22px', fontWeight: 800 } }, icon),
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
