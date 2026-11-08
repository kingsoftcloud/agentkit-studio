import test from 'node:test';
import assert from 'node:assert/strict';
import dragRegionStyles from '../src/client/styles/drag-region.css.mjs';

/* The chrome-row contract. `-webkit-app-region` makes the element's own box part
   of the window caption and Chromium composes the boxes from geometry in
   document order, so a drag rule whose subject can match the document element
   captions the whole client area: hover never reaches the renderer and each
   click is a non-client click. DSH marks the Windows titlebar on <html>
   (`data-windows-titlebar`, apps/desktop preload-windows.ts), so the sheet must
   never turn that marker into a drag region.
   Studio chrome rows are a macOS drag surface, like DSH's own `[data-window-drag]`
   rows (ui-web base.css scopes every rule to data-platform='darwin'). Windows
   keeps one explicit drag surface: the caption strip product-document mounts
   over the blank 40px band. */

/** Markers this sheet may make draggable, in their two platform roles. */
const MACOS_DRAG_MARKERS = ['data-studio-drag-region', 'data-studio-header', 'data-window-drag'];

/** The one Windows drag surface, mounted by product-document. */
const WINDOWS_DRAG_STRIP = 'data-studio-window-drag-strip';

/** The only selectors allowed to declare a drag region. */
const DRAG_MARKERS = [...MACOS_DRAG_MARKERS, WINDOWS_DRAG_STRIP];

/** The marker DSH sets on the document element, which can only ever be no-drag. */
const WINDOWS_ROOT_MARKER = 'data-windows-titlebar';

/** Scope of the macOS chrome rows. */
const DARWIN_SCOPE = "html[data-platform='darwin']";

/** Remove block comments so the parser sees only rules. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split on a separator that is not inside parentheses or attribute brackets. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** The last compound selector, which names the element the rule paints. */
function subjectOf(selector) {
  let depth = 0;
  let cut = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(character)) cut = index + 1;
  }
  return selector.slice(cut).trim();
}

/** The declared app-region value of a rule, or null when it declares none. */
function appRegion(body) {
  for (const declaration of body.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim();
    if (!/^(-webkit-)?app-region$/.test(property)) continue;
    return declaration.slice(separator + 1).trim().replace(/\s*!important$/, '');
  }
  return null;
}

/** Every (selector, declared app-region) pair in the sheet. */
function declarations(css) {
  const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.flatMap(([, selectorText, body]) => {
    const value = appRegion(body);
    if (value === null) return [];
    return splitTopLevel(selectorText.trim(), ',').map(selector => ({ selector, value }));
  });
}

/** Every rule with its selector list and declarations, for non-app-region claims. */
function rules(css) {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectorText, body]) => ({ selectors: splitTopLevel(selectorText.trim(), ','), body }));
}

const sheetDeclarations = declarations(dragRegionStyles);
const dragSelectors = sheetDeclarations.filter(entry => entry.value === 'drag').map(entry => entry.selector);
const noDragSelectors = sheetDeclarations.filter(entry => entry.value === 'no-drag').map(entry => entry.selector);

test('the sheet declares at least one drag region and one opt-out', () => {
  assert.ok(dragSelectors.length > 0, 'the Studio shell would lose window dragging entirely');
  assert.ok(noDragSelectors.length > 0, 'controls inside a drag region would stop receiving clicks');
});

test('no drag region can be the document root', () => {
  for (const selector of dragSelectors) {
    const subject = subjectOf(selector);
    assert.doesNotMatch(subject, /(^|[^\w-])(?:html|body)(?![\w-])/,
      `drag region must not target a document element: ${selector}`);
    assert.doesNotMatch(subject, /(^|[^\w-]):root(?![\w-])/,
      `drag region must not target :root: ${selector}`);
    assert.ok(!subject.startsWith('*'),
      `drag region must not be universal: ${selector}`);
  }
});

test('only explicit Studio chrome markers become drag regions', () => {
  const declaredMarkers = new Set();
  for (const selector of dragSelectors) {
    const markers = [...subjectOf(selector).matchAll(/\[(data-[\w-]+)/g)].map(([, marker]) => marker);
    assert.ok(markers.length > 0, `drag region is not gated by an explicit marker: ${selector}`);
    for (const marker of markers) {
      assert.ok(DRAG_MARKERS.includes(marker), `unexpected drag marker [${marker}] in: ${selector}`);
      declaredMarkers.add(marker);
    }
  }
  assert.deepEqual([...declaredMarkers].sort(), [...DRAG_MARKERS].sort(),
    'the draggable surfaces changed; macOS chrome rows and the Windows caption strip must keep their markers');
});

test('macOS keeps every chrome row draggable', () => {
  for (const marker of MACOS_DRAG_MARKERS) {
    const selectors = dragSelectors.filter(selector => subjectOf(selector).includes(`[${marker}]`));
    assert.equal(selectors.length, 1, `macOS lost the [${marker}] drag row`);
    assert.ok(selectors[0].startsWith(DARWIN_SCOPE),
      `macOS drag rows must stay scoped to the darwin platform: ${selectors[0]}`);
  }
});

test('Windows has exactly one drag surface: the caption strip', () => {
  const windowsDrag = dragSelectors.filter(selector => !selector.startsWith(DARWIN_SCOPE));
  assert.deepEqual(windowsDrag, [`html[${WINDOWS_ROOT_MARKER}] [${WINDOWS_DRAG_STRIP}]`],
    'a second Windows drag surface would caption content the user needs to click');
  assert.equal(subjectOf(windowsDrag[0]), `[${WINDOWS_DRAG_STRIP}]`);
});

test('the Windows titlebar marker never becomes a drag region', () => {
  for (const selector of dragSelectors) {
    assert.ok(!subjectOf(selector).includes(WINDOWS_ROOT_MARKER),
      `[${WINDOWS_ROOT_MARKER}] sits on <html>; dragging it captions the whole client area: ${selector}`);
  }
});

test('the Windows document element and body subtract themselves from any drag region', () => {
  const rootGuard = noDragSelectors.filter(selector => subjectOf(selector) === `html[${WINDOWS_ROOT_MARKER}]`);
  assert.equal(rootGuard.length, 1,
    `expected exactly one html[${WINDOWS_ROOT_MARKER}] no-drag rule, found ${rootGuard.length}`);
  assert.ok(noDragSelectors.includes(`html[${WINDOWS_ROOT_MARKER}] body`),
    'the body still inherits a draggable root box');
});

test('a control inside every macOS drag region keeps its own clicks', () => {
  for (const marker of MACOS_DRAG_MARKERS) {
    const optOut = noDragSelectors.filter(selector => selector.includes(`[${marker}]`)
      && /(^|[^\w-])button(?![\w-])/.test(subjectOf(selector)));
    assert.ok(optOut.length > 0, `a button inside [${marker}] would be a caption hit target`);
    assert.ok(optOut.some(selector => subjectOf(selector).includes('[tabindex]')),
      `a tabbable custom widget inside [${marker}] would be a caption hit target`);
    assert.ok(optOut.every(selector => selector.startsWith(DARWIN_SCOPE)),
      `the opt-out must not affect other platforms: ${optOut.join(', ')}`);
  }
});

test('fullscreen hides the caption strip with the caption band', () => {
  const hidden = rules(dragRegionStyles).filter(rule => rule.selectors.some(selector =>
    selector.includes('[data-fullscreen]') && subjectOf(selector) === `[${WINDOWS_DRAG_STRIP}]`));
  assert.equal(hidden.length, 1, 'the strip would cover content once the caption band disappears');
  assert.match(hidden[0].body, /display:\s*none/);
});
