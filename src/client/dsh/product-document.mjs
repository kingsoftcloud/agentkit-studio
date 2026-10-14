import responsiveStyles from '../styles/responsive.css.mjs';
import formsStyles from '../styles/forms.css.mjs';
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
      style.textContent = responsiveStyles;
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
      style.textContent = formsStyles;
      ownerDocument.head.append(style);
      return () => style.remove();
    });
  }
  return { productDocument, adoptProductDocumentTitle, adoptProductDocumentBrand, installResponsiveStyles, installStudioFormStyles };
}
