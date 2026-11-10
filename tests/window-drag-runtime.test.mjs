import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductDocumentEffects } from '../src/client/dsh/product-document.mjs';

/* The window document effects: Windows writes inline `-webkit-app-region:
   no-drag` on <html>/<body> (stronger than any sheet) plus one explicit caption
   strip; macOS mounts one title-band strip for the Studio chrome pages. The
   strips must never cover the caption menu, the native window buttons or a
   control, and each platform must stay untouched by the other's surface. */

/** Minimal style declaration backed by a Map, mirroring the DOM API used here. */
class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, String(value)); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
  removeProperty(name) { this.values.delete(name); }
  set cssText(text) {
    this.text = String(text);
    for (const declaration of this.text.split(';')) {
      const separator = declaration.indexOf(':');
      if (separator <= 0) continue;
      this.setProperty(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
    }
  }
  get cssText() { return this.text || ''; }
}

/** Minimal element: attributes, inline style, children. */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.children = [];
    this.parent = null;
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(child) { child.parent = this; this.children.push(child); }
  insertBefore(child, reference) {
    child.parent = this;
    const index = reference === null || reference === undefined ? -1 : this.children.indexOf(reference);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }
  get firstChild() { return this.children[0] || null; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(candidate => candidate !== this);
    this.parent = null;
  }
}

/**
 * Build the document shape the product effects use.
 * @param options - preload markers, Electron UA, and whether a Studio chrome page is mounted.
 */
function createDocument({ windowsTitlebar = false, platform = '', userAgent = '', studioShell = false } = {}) {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const root = new FakeElement('html');
  if (windowsTitlebar) root.setAttribute('data-windows-titlebar', '');
  if (platform) root.setAttribute('data-platform', platform);
  const shell = studioShell ? new FakeElement('main') : null;
  if (shell) { shell.setAttribute('data-studio-shell-main', 'true'); body.append(shell); }
  const document = {
    title: 'DeepSeek Harness',
    documentElement: root,
    head,
    body,
    createElement: tagName => new FakeElement(tagName),
    querySelector(selector) {
      if (selector === 'style[data-agentkit-studio-drag-region]') {
        return head.children.find(child => child.tagName === 'style'
          && child.getAttribute('data-agentkit-studio-drag-region') !== null) || null;
      }
      if (selector === '[data-studio-shell-main]') return shell;
      if (selector === 'title') return null;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const window = { parent: null, navigator: { userAgent } };
  window.parent = window;
  window.document = document;
  document.defaultView = window;
  return { document, window, root, body, head };
}

/** The one strip the effect mounts, or undefined. */
function dragStrip(body) {
  return body.children.find(child => child.getAttribute('data-studio-window-drag-strip') !== null);
}

/** The one macOS title-band strip, or undefined. */
function macDragStrip(body) {
  return body.children.find(child => child.getAttribute('data-studio-macos-drag-strip') !== null);
}

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AgentKitStudio/0.0.13 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AgentKitStudio/0.0.13 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36';
const MAC_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

test('Windows makes the client area non-draggable and mounts one blank caption strip', () => {
  const { document, window, root, body, head } = createDocument({ windowsTitlebar: true, userAgent: WINDOWS_UA });
  const effects = createProductDocumentEffects({ window, document });
  const dispose = effects.installWindowDragRegion();

  assert.equal(root.style.getPropertyValue('-webkit-app-region'), 'no-drag');
  assert.equal(body.style.getPropertyValue('-webkit-app-region'), 'no-drag');
  assert.equal(root.getAttribute('data-studio-window-region'), 'no-drag');
  assert.equal(body.getAttribute('data-studio-window-region'), 'no-drag');

  const style = head.children.find(child => child.getAttribute('data-agentkit-studio-drag-region') !== null);
  assert.ok(style, 'the drag sheet must still ship on Windows');

  const strip = dragStrip(body);
  assert.ok(strip, 'Windows lost its explicit drag surface');
  assert.equal(strip.style.getPropertyValue('-webkit-app-region'), 'drag');
  assert.equal(strip.style.getPropertyValue('position'), 'fixed');
  assert.equal(strip.style.getPropertyValue('top'), '0');
  assert.equal(strip.style.getPropertyValue('left'), '320px');
  assert.equal(strip.style.getPropertyValue('right'), '160px');
  assert.equal(strip.style.getPropertyValue('height'), '40px');
  assert.equal(strip.style.getPropertyValue('background'), 'transparent');
  assert.equal(strip.getAttribute('aria-hidden'), 'true');

  dispose();
  assert.equal(dragStrip(body), undefined, 'the strip outlived its owner');
  assert.equal(head.children.length, 0, 'the sheet outlived its owner');
  assert.equal(root.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(body.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(root.getAttribute('data-studio-window-region'), null);
  assert.equal(body.getAttribute('data-studio-window-region'), null);
});

test('macOS keeps its chrome rows and gains no Windows strip', () => {
  const { document, window, root, body, head } = createDocument({ platform: 'darwin', userAgent: MAC_UA, studioShell: true });
  const effects = createProductDocumentEffects({ window, document });
  const dispose = effects.installWindowDragRegion();

  assert.equal(root.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(body.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(root.getAttribute('data-studio-window-region'), null);
  assert.equal(dragStrip(body), undefined);
  assert.equal(macDragStrip(body), undefined, 'the Windows region installer must not mount the macOS strip');
  assert.equal(head.children.length, 1);

  const disposeMac = effects.installMacWindowDragStrip();
  assert.ok(macDragStrip(body));

  disposeMac();
  dispose();
});

test('a plain browser on Windows gets no strip and no inline override', () => {
  const { document, window, root, body } = createDocument({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' });
  createProductDocumentEffects({ window, document }).installWindowDragRegion();

  assert.equal(root.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(body.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(dragStrip(body), undefined);
});

test('an earlier inline app-region and marker are restored on dispose', () => {
  const { document, window, root, body } = createDocument({ windowsTitlebar: true, userAgent: WINDOWS_UA });
  root.style.setProperty('-webkit-app-region', 'drag');
  root.setAttribute('data-studio-window-region', 'previous');

  const dispose = createProductDocumentEffects({ window, document }).installWindowDragRegion();
  assert.equal(root.style.getPropertyValue('-webkit-app-region'), 'no-drag');
  assert.equal(root.getAttribute('data-studio-window-region'), 'no-drag');

  dispose();
  assert.equal(root.style.getPropertyValue('-webkit-app-region'), 'drag');
  assert.equal(root.getAttribute('data-studio-window-region'), 'previous');
});

/* The macOS chrome pages reserve the frame-top clearance (forms.css), so the
   header starts 48px down and the band above it is empty. The shell mounts one
   fixed strip there; it must cover only that blank band and let every control
   subtract itself. */

test('macOS mounts one blank title-band strip before every app control', () => {
  const { document, window, root, body } = createDocument({ platform: 'darwin', userAgent: MAC_UA, studioShell: true });
  const dispose = createProductDocumentEffects({ window, document }).installMacWindowDragStrip();

  const strip = macDragStrip(body);
  assert.ok(strip, 'macOS chrome pages lost their title-band drag surface');
  assert.equal(body.children[0], strip, 'the strip must precede every app control so their no-drag subtracts');
  assert.equal(strip.style.getPropertyValue('-webkit-app-region'), 'drag');
  assert.equal(strip.style.getPropertyValue('position'), 'fixed');
  assert.equal(strip.style.getPropertyValue('top'), '0');
  assert.equal(strip.style.getPropertyValue('left'), '80px');
  assert.equal(strip.style.getPropertyValue('right'), '0');
  assert.equal(strip.style.getPropertyValue('height'), '40px');
  assert.equal(strip.style.getPropertyValue('background'), 'transparent');
  assert.equal(strip.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(strip.getAttribute('aria-hidden'), 'true');
  assert.equal(strip.getAttribute('data-studio-window-region'), 'macos-drag');
  assert.equal(dragStrip(body), undefined, 'macOS must not mount the Windows caption strip');
  assert.equal(root.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(body.style.getPropertyValue('-webkit-app-region'), '');

  dispose();
  assert.equal(macDragStrip(body), undefined, 'the strip outlived its chrome page');
});

test('macOS leaves the native session page without a second strip', () => {
  const { document, window, body } = createDocument({ platform: 'darwin', userAgent: MAC_UA });
  createProductDocumentEffects({ window, document }).installMacWindowDragStrip();
  assert.equal(macDragStrip(body), undefined, 'the session page already owns DSH conversation-header drag');
});

test('a plain browser on macOS gets no strip', () => {
  const { document, window, body } = createDocument({ userAgent: MAC_BROWSER_UA, studioShell: true });
  createProductDocumentEffects({ window, document }).installMacWindowDragStrip();
  assert.equal(macDragStrip(body), undefined);
});

test('Windows gets no macOS strip', () => {
  const { document, window, body } = createDocument({ windowsTitlebar: true, userAgent: WINDOWS_UA, studioShell: true });
  createProductDocumentEffects({ window, document }).installMacWindowDragStrip();
  assert.equal(macDragStrip(body), undefined);
});

test('overlapping macOS mounts share one strip until the last owner releases', () => {
  const { document, window, body } = createDocument({ platform: 'darwin', userAgent: MAC_UA, studioShell: true });
  const effects = createProductDocumentEffects({ window, document });
  const first = effects.installMacWindowDragStrip();
  const second = effects.installMacWindowDragStrip();
  assert.equal(body.children.filter(child => child.getAttribute('data-studio-macos-drag-strip') !== null).length, 1);
  first();
  assert.ok(macDragStrip(body), 'the second owner still needs its drag surface');
  second();
  assert.equal(macDragStrip(body), undefined);
});
