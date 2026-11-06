import test from 'node:test';
import assert from 'node:assert/strict';
import dragRegionStyles from '../src/client/styles/drag-region.css.mjs';

/* `-webkit-app-region` inherits, and Chromium composes drag regions from
   geometry, so a drag declaration on a box also captions every descendant that
   does not subtract itself. A drag rule whose subject can match the document
   element therefore captions the whole client area: hover never reaches the
   renderer and each click is a non-client click. DSH marks the Windows titlebar
   on <html> (`data-windows-titlebar`, apps/desktop preload-windows.ts), so the
   sheet must never turn that marker into a drag region. */

/** Markers this sheet may make draggable: explicit Studio chrome only. */
const DRAG_MARKERS = ['data-studio-drag-region', 'data-studio-header', 'data-window-drag'];

/** The marker DSH sets on the document element, which can only ever be no-drag. */
const WINDOWS_ROOT_MARKER = 'data-windows-titlebar';

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
    'the draggable chrome rows changed; macOS drag rows must keep their marker');
});

test('the Windows titlebar marker never becomes a drag region', () => {
  for (const selector of dragSelectors) {
    assert.ok(!subjectOf(selector).includes(WINDOWS_ROOT_MARKER),
      `[${WINDOWS_ROOT_MARKER}] sits on <html>; dragging it captions the whole client area: ${selector}`);
  }
});

test('the Windows document element subtracts itself from any drag region', () => {
  const rootGuard = noDragSelectors.filter(selector => subjectOf(selector) === `html[${WINDOWS_ROOT_MARKER}]`);
  assert.equal(rootGuard.length, 1,
    `expected exactly one html[${WINDOWS_ROOT_MARKER}] no-drag rule, found ${rootGuard.length}`);
});

test('a control inside every drag region keeps its own clicks', () => {
  for (const marker of DRAG_MARKERS) {
    const optOut = noDragSelectors.filter(selector => selector.includes(`[${marker}]`)
      && /(^|[^\w-])button(?![\w-])/.test(subjectOf(selector)));
    assert.ok(optOut.length > 0, `a button inside [${marker}] would be a caption hit target`);
    assert.ok(optOut.some(selector => subjectOf(selector).includes('[tabindex]')),
      `a tabbable custom widget inside [${marker}] would be a caption hit target`);
  }
});

test('the sheet applies the same rules on every platform', () => {
  for (const { selector } of sheetDeclarations) {
    assert.doesNotMatch(selector, /data-platform/,
      `platform-gated app-region rules split the Windows and macOS behaviour: ${selector}`);
  }
});
