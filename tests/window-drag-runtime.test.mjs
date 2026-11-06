import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductDocumentEffects } from '../src/client/dsh/product-document.mjs';

/* The Windows document effect: inline `-webkit-app-region: no-drag` on <html>
   and <body> (stronger than any sheet) plus the one explicit caption strip. The
   strip must never cover the caption menu or the native window buttons, and
   macOS must stay untouched. */

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
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(candidate => candidate !== this);
    this.parent = null;
  }
}

/**
 * Build the document shape the product effects use.
 * @param options - whether the Windows preload marker and Electron UA are present.
 */
function createDocument({ windowsTitlebar = false, userAgent = '' } = {}) {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const root = new FakeElement('html');
  if (windowsTitlebar) root.setAttribute('data-windows-titlebar', '');
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

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AgentKitStudio/0.0.13 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AgentKitStudio/0.0.13 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36';

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
  const { document, window, root, body, head } = createDocument({ userAgent: MAC_UA });
  const dispose = createProductDocumentEffects({ window, document }).installWindowDragRegion();

  assert.equal(root.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(body.style.getPropertyValue('-webkit-app-region'), '');
  assert.equal(root.getAttribute('data-studio-window-region'), null);
  assert.equal(dragStrip(body), undefined);
  assert.equal(head.children.length, 1);
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
