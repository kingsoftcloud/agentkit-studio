/** Bounded host-owned DOM handles for the Native Playwright browser adapter.
 *
 * Ported from ksadk/harness/browser_adapters/native_dom_snapshot.py @ 355059d. One page task
 * samples the DOM channels and returns metadata plus the exact elements that produced it.
 * Input values stay excluded; page-provided text never mints reference IDs. Element handles are
 * host-owned and stored only in this process-local map, never in page globals or DOM attributes.
 *
 * Format differences from the Python source (documented per the migration contract):
 *  - The page function returns camelCase meta/control keys (scrollX, scrollY, pointerLockActive,
 *    hitTestReachable, duplicateId) instead of Python's snake_case, matching the TS browser
 *    contract's camelCase BrowserObservation/BrowserControl. The capture logic is otherwise a
 *    faithful port of DOM_CAPTURE.
 *  - getProperties() returns a Map in Playwright JS (a dict in Python); iteration is adapted.
 *  - randomUUID() (with dashes stripped) replaces uuid4().hex; tokens remain 32 hex chars.
 */
import { randomUUID } from 'node:crypto';

/** Self-contained page function. Runs in the page; must not close over any module variable.
 *  Returns { refElements, meta }. refElements is the live node list used to mint element refs;
 *  meta is the JSON-serializable observation sample (no input values). */
function domCapture() {
  const semantic = Array.from(document.querySelectorAll(
    'button,input,textarea,select,a[href],[role="button"],[contenteditable="true"]'
  ));
  const pointer = Array.from(document.querySelectorAll('*')).slice(0, 4000).filter((el) => {
    const isPointer = getComputedStyle(el).cursor === 'pointer';
    return isPointer && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
  });
  const nodes = Array.from(new Set([...semantic, ...pointer]));
  const visible = nodes.filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const type = (el.getAttribute('type') || '').toLowerCase();
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
      && style.display !== 'none' && type !== 'password' && type !== 'hidden';
  });
  const structuralSelector = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 20) {
      const id = node.id && globalThis.CSS && CSS.escape ? '#' + CSS.escape(node.id) : null;
      if (id && document.querySelectorAll(id).length === 1) { parts.unshift(id); break; }
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((sibling) => sibling.tagName === node.tagName)
        : [node];
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
      node = node.parentElement;
    }
    if (node && node.parentElement && parts.length >= 20) return null;
    const candidate = parts.join(' > ');
    return candidate && candidate.length <= 512 && document.querySelectorAll(candidate).length === 1
      ? candidate : null;
  };
  const refElements = visible.slice(0, 40);
  const controls = refElements.map((el) => {
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    const hitX = Math.max(0, Math.min(innerWidth - 1,
      (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2));
    const hitY = Math.max(0, Math.min(innerHeight - 1,
      (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2));
    const hit = inViewport ? document.elementFromPoint(hitX, hitY) : null;
    const id = el.id && globalThis.CSS && CSS.escape ? '#' + CSS.escape(el.id) : null;
    const duplicateId = Boolean(id && document.querySelectorAll(id).length > 1);
    const selector = duplicateId ? null : id || structuralSelector(el);
    const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].innerText : '')
      || el.getAttribute('placeholder') || el.innerText || '';
    return {
      tag,
      role: el.getAttribute('role') || '',
      label: Array.from(String(label).trim()).slice(0, 160).join(''),
      selector,
      duplicateId,
      clickable: tag === 'button' || el.getAttribute('role') === 'button'
        || getComputedStyle(el).cursor === 'pointer',
      hitTestReachable: !inViewport ? null : !el.matches(':disabled') && (hit === el || el.contains(hit))
    };
  });
  return {
    refElements,
    meta: {
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText) || '',
      focus: (document.activeElement && document.activeElement.tagName) || '',
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      lifecycle: document.readyState,
      pointerLockActive: Boolean(document.pointerLockElement),
      controls
    }
  };
}

async function disposeHandles(handles) {
  for (const handle of handles) {
    try { await handle.dispose(); } catch { /* navigation/closing may have released the context */ }
  }
}

/** Latest bounded observation; unchanged DOM nodes retain their opaque ID across captures. */
export class BrowserElementRefs {
  constructor() { this._elements = new Map(); }

  async clear() {
    const previous = this._elements;
    this._elements = new Map();
    await disposeHandles([...previous.values()]);
  }

  /** Capture one DOM sample. Returns { meta, tokens } where tokens[i] is the opaque ref for
   *  control i (or null if no element was retained). Unchanged nodes keep their prior token. */
  async capture(page) {
    const transient = [];
    const acquired = [];
    let adopted = false;
    try {
      const collection = await page.evaluateHandle(domCapture);
      transient.push(collection);
      const metadata = await collection.getProperty('meta');
      transient.push(metadata);
      const nodes = await collection.getProperty('refElements');
      transient.push(nodes);
      const meta = await metadata.jsonValue();
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('invalid DOM snapshot');

      const handles = new Map();
      const props = await nodes.getProperties(); // Map<string, JSHandle>
      for (const [index, handle] of props) {
        acquired.push(handle);
        const element = handle.asElement();
        if (/^\d+$/.test(index) && Number(index) < 40 && element) handles.set(Number(index), element);
      }

      let priorTokens = [...this._elements.keys()];
      let priorHandles = [...this._elements.values()];
      if (priorHandles.length > 0) {
        let sameDocument = false;
        try { sameDocument = await priorHandles[0].evaluate((node) => node.ownerDocument === document); }
        catch { sameDocument = false; }
        if (!sameDocument) {
          // A successful click can navigate without _navigate(); its old execution context cannot
          // supply refs to the new document, which does not justify replaying that click.
          await this.clear();
          priorTokens = [];
          priorHandles = [];
        }
      }

      // Compare actual node identity in one browser task, without writing refs into an untrusted
      // DOM/global map or one RPC per element pair.
      const matches = handles.size > 0
        ? await nodes.evaluate((nodesArr, prior) => nodesArr.map((node) => prior.indexOf(node)), priorHandles)
        : [];

      const refs = new Map();
      const tokens = [];
      const controls = Array.isArray(meta.controls) ? meta.controls : [];
      for (let index = 0; index < Math.min(40, controls.length); index++) {
        const element = handles.get(index);
        if (!element) { tokens.push(null); continue; }
        const match = index < matches.length ? matches[index] : -1;
        const token = (match >= 0 && match < priorTokens.length) ? priorTokens[match] : randomUUID().replace(/-/g, '');
        refs.set(token, element);
        tokens.push(token);
      }

      const previous = this._elements;
      this._elements = refs;
      adopted = true;
      const retained = new Set(refs.values());
      await disposeHandles([...previous.values(), ...acquired.filter((h) => !retained.has(h))]);
      return { meta, tokens };
    } finally {
      if (!adopted) await disposeHandles(acquired);
      await disposeHandles(transient);
    }
  }

  /** Resolve a token to a live ElementHandle, or null if it is stale/detached/foreign. */
  async resolve(token) {
    const element = this._elements.get(token);
    if (!element) return null;
    try {
      const connected = await element.evaluate((node) => node.isConnected);
      return connected ? element : null;
    } catch { return null; }
  }
}

export { domCapture, domCapture as DOM_CAPTURE };
