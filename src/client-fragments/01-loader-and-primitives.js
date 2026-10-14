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
    const { SecretInput, StudioMark, StudioWordmark, NavGlyph, Pill, SectionHeading, OperationalPageHeading, OperationalPanel, ContentIntro, Metric, EmptyState, DisabledAction } = createStudioPrimitives({ React });
    const { inputStyle, buttonStyle, pagerButtonStyle } = createFormStyles(BRAND);
    const ResourceDialog = createResourceDialog({ React, buttonStyle });
    const { IconSettingsOutlineMedium, IconChevronDownOutlineRegular, Menu, MenuItemButton, Input, Tooltip, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const { STUDIO_VERSION, STUDIO_PLUGIN_VERSION, DSH_VERSION } = readProductVersions(window.__AGENTKIT_STUDIO__);
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

    // These rows are mounted directly below DSH's New Session control. There
    // is no parent "AgentKit Studio" tab; DSH owns the workspace/session list
    // immediately below this product navigation.
    // Keep the first level small like the original Studio. A runtime is an
    // Agent Revision's execution target, while the operations group is where
    // runs, builds and their evidence live. The detailed domains are exposed
    // as secondary tabs inside these workspaces instead of nine competing
    // sidebar rows.

    // Fixed product artwork; controls continue to use the host theme tokens.
    const STUDIO_MARK_SVG = '__AGENTKIT_STUDIO_MARK_SVG__';

    // Operational pages use the compact document-header rhythm: one
    // compact title row, a short description and the actions at the same
    // baseline.  The application already owns the global page title, so repeating
    // the all-caps eyebrow here only consumed vertical space and made the
    // Channels/Automation/Evaluation pages look like nested mock screens.

    // The Studio application already owns the page title. Inner workspaces use this
    // compact context row so a panel never renders the same title twice.
