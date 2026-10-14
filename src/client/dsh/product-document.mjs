import { leaseDocumentResource } from './document-resource.mjs';
import { AGENTKIT_STUDIO_MARK_SVG as STUDIO_MARK_SVG } from '../../brand.js';

export function createProductDocumentEffects({ window = globalThis.window, document = globalThis.document, MutationObserver = globalThis.MutationObserver }) {
  function productDocument() {
    if (typeof document === 'undefined') return null;
    // DSH Web mounts global panels in a same-origin srcdoc frame. Browser
    // chrome belongs to the top-level document, so brand that document when
    // the embedding boundary permits it and otherwise stay frame-local.
    try {
      const parentDocument = window.parent && window.parent !== window ? window.parent.document : null;
      return parentDocument || document;
    } catch { return document; }
  }

  function adoptProductDocumentTitle() {
    const ownerDocument = productDocument();
    if (!ownerDocument) return () => {};
    const project = () => {
      const current = String(ownerDocument.title || '').trim();
      const base = current.split(' — ')[0].trim();
      const isDshBuildTitle = base.startsWith('DSH') || base === 'DeepSeek Harness';
      const next = base === 'AgentKit Studio'
        ? 'AgentKit Studio'
        : base && !isDshBuildTitle
          ? `${base} — AgentKit Studio`
          : 'AgentKit Studio';
      // Writing even an unchanged title queues another MutationObserver
      // callback and can keep the browser on the plugin boot screen forever.
      if (ownerDocument.title !== next) ownerDocument.title = next;
    };
    project();
    const title = ownerDocument.querySelector('title');
    if (!title || typeof MutationObserver === 'undefined') return () => {};
    const observer = new MutationObserver(project);
    observer.observe(title, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }

  function adoptProductDocumentBrand() {
    const ownerDocument = productDocument();
    if (!ownerDocument) return () => {};
    return leaseDocumentResource(ownerDocument, 'agentkit-studio:favicon', () => {
    const mark = encodeURIComponent(STUDIO_MARK_SVG);
    const href = `data:image/svg+xml,${mark}`;
    const existing = Array.from(ownerDocument.querySelectorAll('link[rel~="icon"]'));
    const links = existing.length ? existing : [ownerDocument.createElement('link')];
    const previous = links.map(link => ({ link, rel: link.rel, type: link.type, href: link.href }));
    links.forEach(link => { link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = href; if (!link.isConnected) ownerDocument.head.append(link); });
    return () => previous.forEach(({ link, rel, type, href: previousHref }) => { if (!existing.length) link.remove(); else { link.rel = rel; link.type = type; link.href = previousHref; } });
      });
  }

  function installResponsiveStyles() {
    const ownerDocument = productDocument();
    if (!ownerDocument) return () => {};
    return leaseDocumentResource(ownerDocument, 'agentkit-studio:responsive', () => {
      if (ownerDocument.querySelector('style[data-agentkit-studio-responsive]')) return () => {};
      const style = ownerDocument.createElement('style');
      style.setAttribute('data-agentkit-studio-responsive', 'true');
      style.textContent = `
      .agentkit-settings-launcher {
        flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
        height: 42px; padding: 0 10px 0 8px; margin: 0; box-sizing: border-box;
        border: 0; border-radius: var(--dsw-radius-md, 12px); background: transparent;
        color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 14px;
      }
      .agentkit-settings-launcher:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .agentkit-settings-launcher:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4b73e8); outline-offset: 2px; }
      .agentkit-settings-launcher[data-wide="false"] { flex: none; width: 36px; height: 36px; padding: 0; gap: 0; justify-content: center; }
      :where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button:not(:disabled):hover {
        background: var(--dsw-alias-interactive-bg-hover, #f0f0f0) !important;
      }
      :where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls]) button[style*="--dsw-alias-button-primary-fill"]:not(:disabled):hover {
        background: var(--dsw-alias-button-primary-hover, #303030) !important;
      }
      :where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button:disabled { opacity: .4; cursor: not-allowed !important; }
      :where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) :is(button, input, select, textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4b73e8); outline-offset: 2px; }
      :where([data-agentkit-studio="product-application"], [data-studio-model-settings]) :is(input, select, textarea)::placeholder { color: var(--dsw-alias-label-dimmed, #999); }
      [data-agentkit-studio="product-application"] [data-studio-tabs] { overflow-x: auto; scrollbar-width: thin; }
      [data-agentkit-studio="product-application"] [data-studio-tabs] > button { flex: 0 0 auto; white-space: nowrap; }
      [data-agentkit-studio="product-application"] [data-studio-heading],
      [data-agentkit-studio="product-application"] [data-studio-content-intro] { flex-wrap: wrap; align-items: flex-start; }
      [data-studio-model-settings] { container-type: inline-size; }
      [data-studio-model-settings] input, [data-studio-model-settings] select { min-width: 0; box-sizing: border-box; }
      [data-studio-model-settings] { font-size: 14px; line-height: 22px; }
      [data-studio-model-settings] label { font-size: 14px !important; font-weight: 500 !important; }
      [data-studio-model-settings] input, [data-studio-model-settings] select { height: 32px; font: inherit !important; border-radius: var(--dsw-radius-md, 12px) !important; }
      [data-studio-model-settings] details { font-size: 13px !important; }
      [data-studio-model-settings] form > section:last-of-type { border: 0 !important; border-top: 1px solid var(--dsw-alias-border-l3, #d4d4d4) !important; border-radius: 0 !important; padding: 20px 0 0 !important; background: transparent !important; }
      [data-studio-model-settings] h3 { font-size: 16px !important; font-weight: 600 !important; }
      [data-studio-model-settings] section > div > div > p { font-size: 13px !important; line-height: 1.5; margin-top: 6px !important; }
      @container (max-width: 540px) {
        [data-studio-model-settings] [style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
      }
      @media (max-width: 960px) {
        [data-agentkit-studio="product-application"] > main { padding: 18px 16px 28px !important; }
        [data-agentkit-studio="product-application"] [style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
        [data-agentkit-studio="product-application"] [data-studio-heading],
        [data-agentkit-studio="product-application"] [data-studio-content-intro] { align-items: flex-start; }
        [data-agentkit-studio="product-application"] [data-studio-header] { gap: 14px !important; }
        [data-agentkit-studio="product-application"] [data-studio-pager] { flex-wrap: wrap !important; }
      }
      @media (max-width: 760px) {
        [data-agentkit-studio="product-application"] > main { padding: 16px 12px 28px !important; }
        [data-agentkit-studio="product-application"] [data-studio-header] { flex-wrap: wrap !important; gap: 12px !important; margin-bottom: 16px !important; }
        [data-agentkit-studio="product-application"] [data-studio-header] > div:last-child { width: 100%; justify-content: flex-start; }
        [data-agentkit-studio="product-application"] [style*="display: flex"] { flex-wrap: wrap !important; }
        [data-agentkit-studio="product-application"] [data-studio-pager] { align-items: flex-start !important; }
        [data-agentkit-studio="product-application"] [data-studio-pager] > div { width: 100%; justify-content: flex-start !important; flex-wrap: wrap !important; }
        [data-agentkit-studio="product-application"] [data-studio-pager] select { max-width: 100%; }
        [data-agentkit-studio="product-application"] [data-studio-dialog] { width: calc(100vw - 20px) !important; max-height: calc(100vh - 20px) !important; padding: 14px !important; }
        [data-agentkit-studio="product-application"] table { font-size: 11px !important; }
      }
    `;
      ownerDocument.head.append(style);
      return () => style.remove();
    });
  }

  function installStudioFormStyles() {
    const ownerDocument = productDocument();
    if (!ownerDocument) return () => {};
    return leaseDocumentResource(ownerDocument, 'agentkit-studio:forms', () => {
      if (ownerDocument.querySelector('style[data-agentkit-studio-forms]')) return () => {};
      const style = ownerDocument.createElement('style');
      style.setAttribute('data-agentkit-studio-forms', 'true');
      style.textContent = `
      [data-agentkit-studio="product-application"] [data-studio-shell-main] { padding-top: max(24px,var(--dsh-frame-top-clearance,0px)) !important; }
      :where([data-studio-settings], [data-studio-model-settings], [data-studio-agent-form], .agentkit-start-checks) {
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
        container-type: inline-size; min-width: 0;
      }
      .agentkit-form-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
      .agentkit-form-heading h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
      .agentkit-form-heading p, .agentkit-form-note { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
      [data-studio-settings] [data-studio-settings-group] { margin-bottom: 24px; }
      [data-studio-settings] [data-studio-settings-group] > h3 { margin: 0 0 4px; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
      [data-studio-settings-row] { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
      [data-studio-settings-row] > div { flex: 1; min-width: 0; }
      [data-studio-settings-row] .agentkit-check-label { font-size: 14px; font-weight: 400; line-height: 22px; }
      [data-studio-settings-row] > span { max-width: 55%; text-align: right; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      [data-studio-settings] .agentkit-guide-entry { margin-top: 8px; padding-top: 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
      :where([data-studio-settings], [data-studio-model-settings], [data-studio-agent-form], .agentkit-start-checks) button { font: inherit; }
      :where([data-studio-settings], .agentkit-start-checks) button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
      :where([data-studio-settings], [data-studio-agent-form], .agentkit-start-checks) :is(button,input,select,textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      [data-studio-model-settings] form { gap: 24px !important; }
      [data-studio-model-settings] article { padding: 18px 0 !important; }
      [data-studio-model-settings] :is(label,input,select) { font-weight: 400 !important; }
      [data-studio-model-settings] [data-model-input-capability] { padding: 8px 0; border-block: .5px solid var(--dsw-alias-border-l2); }
      [data-studio-model-settings] details summary { font-size: 13px; font-weight: 400 !important; }
      [data-studio-model-settings] [data-studio-form-footer] { justify-content: flex-start !important; padding-top: 16px; }
      [data-studio-agent-form] [data-studio-heading] h2 { font-size: 18px !important; font-weight: 500; }
      [data-studio-agent-form] [data-studio-heading] p { font-size: 12px !important; }
      [data-studio-agent-form] [data-agent-form-layout] { grid-template-columns: 170px minmax(0,1fr) !important; gap: 24px !important; }
      [data-studio-agent-form] [data-agent-form-steps] { border: 0 !important; background: transparent !important; padding: 0 !important; }
      [data-studio-agent-form] [data-agent-form-body] { border: 0 !important; border-left: .5px solid var(--dsw-alias-border-l2) !important; border-radius: 0 !important; padding: 0 0 0 24px !important; background: transparent !important; }
      [data-studio-agent-form] label { font-size: 13px !important; font-weight: 400 !important; }
      [data-studio-agent-form] :is(input,select,textarea) { font-size: 14px !important; }
      [data-studio-agent-form] h3 { font-size: 16px !important; font-weight: 500; }
      .agentkit-check-toggle { display: flex; justify-content: flex-end; margin-top: 12px; }
      .agentkit-check-toggle button { font-size: 12px; padding: 5px 10px !important; }
      .agentkit-start-checks { margin: 12px 0; padding: 18px 20px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-layer-3); }
      .agentkit-check-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
      .agentkit-check-row > div:first-child { min-width: 0; }
      .agentkit-check-label { font-size: 14px; line-height: 22px; }
      .agentkit-check-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
      .agentkit-check-state { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
      [data-check-state=confirmed] .agentkit-check-state { color: var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary)); }
      [data-check-state=missing] .agentkit-check-state { color: var(--dsw-alias-state-warn-primary); }
      @container (max-width: 540px) {
        [data-studio-agent-form] [data-agent-form-layout] { grid-template-columns: minmax(0,1fr) !important; }
        [data-studio-agent-form] [data-agent-form-body] { border-left: 0 !important; padding-left: 0 !important; }
        [data-studio-agent-form] [data-agent-form-steps] > div:nth-child(2) { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        [data-studio-agent-form] [style*="grid-template-columns"] { grid-template-columns: minmax(0,1fr) !important; }
        [data-studio-settings-row], .agentkit-check-row { flex-wrap: wrap; gap: 8px; }
        [data-studio-settings-row] > div { flex-basis: 100%; }
        [data-studio-settings-row] > span { max-width: 100%; text-align: left; }
        .agentkit-form-heading { flex-wrap: wrap; gap: 8px; }
        .agentkit-check-actions { flex-wrap: wrap; }
      }
    `;
      ownerDocument.head.append(style);
      return () => style.remove();
    });
  }
  return { productDocument, adoptProductDocumentTitle, adoptProductDocumentBrand, installResponsiveStyles, installStudioFormStyles };
}
