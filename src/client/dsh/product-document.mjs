import responsiveStyles from '../styles/responsive.css.mjs';
import formsStyles from '../styles/forms.css.mjs';
import dragRegionStyles from '../styles/drag-region.css.mjs';
import { leaseDocumentResource } from './document-resource.mjs';
import { AGENTKIT_STUDIO_BRAND as PRODUCT_BRAND, AGENTKIT_STUDIO_MARK_SVG as STUDIO_MARK_SVG } from '../../brand.js';

/** DSH's Windows preload marks the document element; the marker selects the shell. */
const WINDOWS_TITLEBAR_ATTRIBUTE = 'data-windows-titlebar';
/** Marks the elements whose inline app-region the plugin owns, for verification. */
const WINDOW_REGION_ATTRIBUTE = 'data-studio-window-region';
/** Marks the plugin's one explicit Windows drag surface. */
const WINDOW_DRAG_STRIP_ATTRIBUTE = 'data-studio-window-drag-strip';

/**
 * Whether this document belongs to the Windows desktop shell.
 *
 * The preload marker is authoritative. The Electron/Windows user-agent pair is
 * the fallback for a plugin that boots before the marker lands; a plain browser
 * on Windows never matches the Electron half, so the web surface gains no
 * overlay and keeps its own click handling.
 * @param ownerDocument - document the product effects write to.
 * @returns true for the Windows desktop document only.
 */
function isWindowsDesktopDocument(ownerDocument) {
  const root = ownerDocument?.documentElement;
  if (root?.hasAttribute?.(WINDOWS_TITLEBAR_ATTRIBUTE)) return true;
  const userAgent = String(ownerDocument?.defaultView?.navigator?.userAgent || '');
  return /Electron/i.test(userAgent) && /Windows/i.test(userAgent);
}

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
    return leaseDocumentResource(ownerDocument, 'agentkit-studio:title', () => {
    let previous = String(ownerDocument.title || ''), projected;
    const project = () => {
      const current = String(ownerDocument.title || '').trim();
      if (current === projected) return;
      previous = current;
      const base = current.split(' — ')[0].trim();
      const isDshBuildTitle = base.startsWith('DSH') || base === 'DeepSeek Harness';
      const next = base === PRODUCT_BRAND.name
        ? PRODUCT_BRAND.name
        : base && !isDshBuildTitle
          ? `${base} — ${PRODUCT_BRAND.name}`
          : PRODUCT_BRAND.name;
      projected = next;
      // Writing even an unchanged title queues another MutationObserver
      // callback and can keep the browser on the plugin boot screen forever.
      if (ownerDocument.title !== next) ownerDocument.title = next;
    };
    project();
    const title = ownerDocument.querySelector('title');
    const observer = title && typeof MutationObserver !== 'undefined' ? new MutationObserver(project) : null;
    observer?.observe(title, { childList: true, characterData: true, subtree: true });
    return () => { observer?.disconnect(); if (ownerDocument.title === projected) ownerDocument.title = previous; };
    });
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
  /**
   * Make the Windows client area non-draggable and give the window one explicit
   * drag surface.
   *
   * The inline `-webkit-app-region` on `<html>` and `<body>` is the strongest
   * source on the page: no stylesheet, priority or later marker can turn the
   * root box back into the window caption. The strip is a real element mounted
   * at the end of `<body>`, because Chromium composes drag regions from element
   * geometry in document order — a later drag box beats the root no-drag boxes.
   * Its geometry covers the blank 40px caption band only: `left: 320px` clears
   * the caption menu (which starts at 48/84px and widens with the locale) and
   * `right: 160px` clears the native window buttons. Fullscreen is excluded by
   * the sheet because the caption band does not exist there.
   * @param ownerDocument - Windows desktop document to update.
   * @returns disposer restoring the document exactly.
   */
  function installWindowsWindowRegion(ownerDocument) {
    const root = ownerDocument.documentElement;
    if (!root) return () => {};
    const applied = [];
    for (const element of [root, ownerDocument.body]) {
      if (!element?.style?.setProperty) continue;
      const previousRegion = element.style.getPropertyValue('-webkit-app-region');
      const previousMark = element.getAttribute?.(WINDOW_REGION_ATTRIBUTE) ?? null;
      element.style.setProperty('-webkit-app-region', 'no-drag');
      element.setAttribute?.(WINDOW_REGION_ATTRIBUTE, 'no-drag');
      applied.push({ element, previousRegion, previousMark });
    }
    let strip = null;
    if (ownerDocument.body) {
      strip = ownerDocument.createElement('div');
      strip.setAttribute(WINDOW_DRAG_STRIP_ATTRIBUTE, 'true');
      strip.setAttribute('aria-hidden', 'true');
      strip.style.cssText = 'position:fixed;top:0;left:320px;right:160px;height:40px;margin:0;padding:0;'
        + 'border:0;background:transparent;z-index:2147483000;-webkit-app-region:drag;app-region:drag';
      ownerDocument.body.append(strip);
    }
    return () => {
      strip?.remove();
      for (const { element, previousRegion, previousMark } of applied) {
        if (previousRegion) element.style.setProperty('-webkit-app-region', previousRegion);
        else element.style.removeProperty('-webkit-app-region');
        if (previousMark === null) element.removeAttribute?.(WINDOW_REGION_ATTRIBUTE);
        else element.setAttribute?.(WINDOW_REGION_ATTRIBUTE, previousMark);
      }
    };
  }

  function installWindowDragRegion() {
    const ownerDocument = productDocument();
    if (!ownerDocument) return () => {};
    return leaseDocumentResource(ownerDocument, 'agentkit-studio:drag-region', () => {
      const disposers = [];
      if (!ownerDocument.querySelector('style[data-agentkit-studio-drag-region]')) {
        const style = ownerDocument.createElement('style');
        style.setAttribute('data-agentkit-studio-drag-region', 'true');
        style.textContent = dragRegionStyles;
        ownerDocument.head.append(style);
        disposers.push(() => style.remove());
      }
      if (isWindowsDesktopDocument(ownerDocument)) disposers.push(installWindowsWindowRegion(ownerDocument));
      return () => { while (disposers.length) disposers.pop()(); };
    });
  }
  return { productDocument, adoptProductDocumentTitle, adoptProductDocumentBrand, installResponsiveStyles, installStudioFormStyles,
    installWindowDragRegion };
}
