/** Real Node Playwright Native browser adapter.
 *
 * Ported from ksadk/harness/browser_adapters/native_playwright.py @ 355059d. Each run gets its own
 * isolated Playwright context/page; references reconnect only while this owner lives. Browser
 * network interception supplements the host sandbox/egress policy; it is not an OS network sandbox.
 * Injected browsers must be host-owned and trusted. No provider, Studio or Native RunStore state is
 * mutated here. A successful action is never an acceptance verdict; raw page text cannot create
 * authority and a BrowserObservation is never a verification verdict.
 *
 * Documented divergences from the Python source (per the migration contract):
 *  - Constructor options and host structs use camelCase (idleTimeoutMs, maxTextChars, runtimeId,
 *    BrowserSessionRef.sessionId, BrowserObservation.scrollX, ToolResult.browserSessionRef, ...),
 *    matching the TS browser contract. The generic native_browser TOOL PARAMETERS schema stays
 *    snake_case (action, session_id, generation, timeout_ms, url, selector, element_ref, value,
 *    key, button, x, y, steps, delta_x, delta_y, duration_ms) to preserve the pinned model-facing
 *    protocol exactly; execute() maps those snake_case arguments to the camelCase BrowserAction.
 *  - Python launch_channels is replaced by an optional launchBrowser Host callback (the adapter owns
 *    and closes the browser it returns); a default launch dynamically imports Node playwright and
 *    launches bundled headless chromium (no Python, no browser download). An injected browser is
 *    borrowed and is never shut down by adapter cleanup.
 *  - JS Playwright exposes url()/isClosed()/isConnected()/resourceType() as methods (Python
 *    properties), route.request() and frame().page() as methods, routeWebSocket/CDP/newContext
 *    camelCase, JSHandle.getProperties() returns a Map, and page.evaluate accepts a function.
 *  - Cancellation/timeout use AbortSignal + Promise racing because JS has no asyncio cancellation.
 *    Unlike Python's asyncio.wait_for (which cancels the task), a JS abort cannot forcibly interrupt
 *    an in-flight Playwright call. Two invariants hold together: (a) act() returns boundedly on
 *    timeout/cancel, and (b) a new action never overlaps an old in-flight click, and late media is
 *    never published after an abort. Design: act() races _act() against the signal (_race) and
 *    returns boundedly; on abort, if the action may have dispatched input, the session is QUARANTINED
 *    — its context is closed (real Playwright cancels the pending input) and it stays lost. A new
 *    action on the old ref is refused with an uncertain observation (requires_reconcile) and never
 *    creates a new page on the same ref/generation/lease (that would disguise a replacement as
 *    continuity and violate the explicit-restart contract); recover reports lost; replay of the old
 *    action ID returns the canceled tombstone (non-replaying). Only explicit restart(ref)
 *    (generation+1 AND leaseEpoch+1) creates a replacement. The capture retry (after an
 *    ObservationCaptureFailure) is raced against the same deadline, so a blocked retry screenshot
 *    cannot outlive the action's timeout. The "no replay" invariant holds because _observe() only
 *    reads (DOM/screenshot/sink), never re-dispatches input.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonical, scopeKey } from '@kingsoftcloud/agentkit-harness-core/values';
import {
  validateBrowserSessionRef, validateBrowserAction, validateBrowserObservation, validateBrowserRecovery,
  browserObservationDigest, BrowserSessionError,
} from '@kingsoftcloud/agentkit-harness-core/browser-contract';
import { BrowserElementRefs, domCapture } from './browser-dom.mjs';
import { createBrowserActionAttempt } from './browser-action-observation.mjs';

const HTTP_WS_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const DEFAULT_VIEWPORT = [1280, 720];
const TOOL_TIMEOUT_MS = 90000; // must be < limits.effectTimeoutMs (default 120000), per configuration.mts

/** A failed page screenshot / DOM read before the artifact sink could run. Retrying observation is
 *  safe; replaying the input is not. */
class ObservationCaptureFailure extends Error {
  constructor(cause) { super('observation_capture_failed'); this.name = 'ObservationCaptureFailure'; if (cause) this.cause = cause; }
}
/** Input dispatch did not return a confirmed completion. */
class ActionDispatchFailure extends Error {
  constructor(cause) { super('action_dispatch_failed'); this.name = 'ActionDispatchFailure'; if (cause) this.cause = cause; }
}
/** Caller-driven cancellation (external AbortSignal) or the per-action timeout. */
class AbortError extends Error {
  constructor() { super('aborted'); this.name = 'AbortError'; }
}
const isAbortError = (e) => e instanceof AbortError || (e && e.name === 'AbortError');

function isPng(data) {
  return data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
}

/** Count Unicode code points (Pydantic str length parity), not UTF-16 code units. */
function codePointLength(str) {
  let count = 0;
  for (let i = 0; i < str.length;) {
    const unit = str.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { count++; i += 2; continue; }
    }
    count++; i++;
  }
  return count;
}
function clipCodePoints(str, max) {
  if (max <= 0) return '';
  let result = '', count = 0;
  for (let i = 0; i < str.length && count < max;) {
    const unit = str.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { result += str.slice(i, i + 2); count++; i += 2; continue; }
    }
    result += str[i]; count++; i++;
  }
  return result;
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!HTTP_WS_SCHEMES.has(parsed.protocol)) return url === 'about:blank' ? 'about:blank' : '[opaque-url]';
    const netloc = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return `${parsed.protocol}//${netloc}${parsed.pathname}`;
  } catch { return '[invalid-url]'; }
}

function redact(text) {
  text = text.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (m) => safeUrl(m));
  text = text.replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
  text = text.replace(/\b(authorization|cookie|api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/** Throw AbortError if the signal (if any) has aborted. Used to fence every async boundary so a
 *  canceled action never dispatches new input or publishes late media. */
function fence(signal) { if (signal && signal.aborted) throw new AbortError(); }

/** Per-session serialized action dispatch. */
class AsyncLock {
  constructor() { this._tail = Promise.resolve(); }
  acquire() {
    const prev = this._tail;
    let release;
    const next = new Promise((r) => { release = r; });
    this._tail = next;
    return prev.then(() => release);
  }
}

/** Race a promise against a 5s policy cap and an optional caller signal. Clears its timer on
 *  either signal abort or resolution so a hanging policy never outlives the calling action. */
function racePolicy(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; cleanup(); reject(new Error('policy_timeout')); }, 5000);
    const onAbort = () => { if (!settled) { settled = true; cleanup(); reject(new AbortError()); } };
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) {
      if (signal.aborted) { settled = true; clearTimeout(timer); reject(new AbortError()); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } },
      () => { if (!settled) { settled = true; cleanup(); reject(new Error('policy_rejected')); } }
    );
  });
}

function scopeEquals(a, b) {
  return a === b || (a && b && a.tenantId === b.tenantId && a.workspaceId === b.workspaceId
    && a.userId === b.userId && a.agentId === b.agentId);
}
function refEquals(a, b) {
  if (a === b) return true;
  return a && b && a.schemaVersion === b.schemaVersion && a.sessionId === b.sessionId && scopeEquals(a.scope, b.scope)
    && a.runId === b.runId && a.runtimeId === b.runtimeId && a.backend === b.backend
    && a.workspaceRevision === b.workspaceRevision && a.generation === b.generation && a.leaseEpoch === b.leaseEpoch;
}
/** Independent snapshot of a session ref so a caller mutating a returned ref cannot corrupt the
 *  adapter's internal identity. */
function snapshotRef(ref) { return validateBrowserSessionRef(ref); }

/** One live browser session: ref, isolated context/page, serialized actions, bounded response cache. */
class Session {
  constructor(ref, context) {
    this.ref = ref;
    this.context = context;
    this.page = null;
    this.actionSeq = 0;
    this.lastUsed = performance.now();
    this.lock = new AsyncLock();
    this.results = new Map(); // actionId -> { fingerprint, observation }
    this.console = [];
    this.errors = [];
    this.errorLocations = [];
    this.failures = [];
    this.logsTruncated = false;
    this.closed = false;
    this.navigationRedirect = null;
    this.lastResponseStatus = null;
    this.idleTimer = null;
    this.cdp = null;
    this.elementRefs = new BrowserElementRefs();
    /** Revoked pages stay lost until an explicit restart advances generation and lease. */
    this.quarantined = false;
    this.quarantineCleanup = null;
  }
}

// --- generic native_browser tool definition (pinned snake_case parameters protocol) ---
const SESSION_SCHEMA = { session_id: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 } };
const TIMEOUT_SCHEMA = { timeout_ms: { type: 'integer', minimum: 1, maximum: 120000 } };
const ACTION_PROPERTIES = {
  url: { type: 'string', minLength: 1 },
  selector: { type: 'string', minLength: 1 },
  element_ref: { type: 'string', minLength: 1, maxLength: 64 },
  value: { type: ['string', 'integer'] },
  key: { type: ['string', 'integer'], minimum: 0, maximum: 9, minLength: 1 },
  button: { enum: ['left', 'right', 'middle'] },
  x: { type: 'integer', minimum: 0, maximum: 4096 },
  y: { type: 'integer', minimum: 0, maximum: 4096 },
  steps: { type: 'integer', minimum: 1, maximum: 30 },
  delta_x: { type: 'integer', minimum: -10000, maximum: 10000 },
  delta_y: { type: 'integer', minimum: -10000, maximum: 10000 },
  duration_ms: { type: 'integer', minimum: 0, maximum: 5000 },
};
const KNOWN_TOOL_ACTION_ARGS = new Set([
  'url', 'selector', 'element_ref', 'value', 'key', 'button', 'x', 'y', 'steps',
  'delta_x', 'delta_y', 'duration_ms', 'timeout_ms',
]);
function actionSchema(action, required = [], optionalTimeout = true) {
  const session = action === 'open' ? {} : SESSION_SCHEMA;
  const sessionRequired = action === 'open' ? [] : ['session_id', 'generation'];
  const fields = {
    action: { const: action },
    ...session,
    ...(optionalTimeout ? TIMEOUT_SCHEMA : {}),
    ...Object.fromEntries(required.map((name) => [name, ACTION_PROPERTIES[name]])),
    ...((action === 'click' || action === 'press') ? { duration_ms: ACTION_PROPERTIES.duration_ms } : {}),
    ...(action === 'click' ? { button: ACTION_PROPERTIES.button } : {}),
    ...(action === 'move' ? { steps: ACTION_PROPERTIES.steps } : {}),
    ...(action === 'scroll' ? Object.fromEntries(['x', 'y'].map((n) => [n, ACTION_PROPERTIES[n]])) : {}),
    ...((action === 'click' || action === 'fill' || action === 'press') ? { element_ref: ACTION_PROPERTIES.element_ref } : {}),
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', ...sessionRequired, ...required.filter((n) => n !== 'selector')],
    properties: fields,
    ...((action === 'click' || action === 'fill' || action === 'press')
      ? { oneOf: [{ required: ['selector'] }, { required: ['element_ref'] }] } : {}),
    ...(action === 'scroll' ? { dependentRequired: { x: ['y'], y: ['x'] } } : {}),
  };
}
const BROWSER_TOOL_DEFINITION = {
  name: 'native_browser',
  observationRole: 'browser',
  description:
    'Operate a persistent scoped browser. First call open with only action; it creates a blank '
    + 'session and returns session_ref. Then call navigate with the URL, session_id and generation '
    + 'from that ref. Reuse the same session_id and generation for click, fill, press, move, scroll, '
    + 'screenshot and close. For fill, value is text; an integer is accepted as its decimal text. '
    + 'For press, key is a string or a single digit integer. For click/fill/press, use exactly one of '
    + 'element_ref from returned controls or a CSS selector. Prefer element_ref for an observed '
    + 'control: it targets the same DOM node after reordering; a stale ref returns a fresh '
    + 'observation. Click and press can hold their input for duration_ms (0-5000) before release. '
    + 'Click can choose left/right/middle button; move uses viewport CSS pixel x/y. Scroll uses '
    + 'signed delta_x/delta_y CSS pixels, optionally at an x/y viewport point. Wheel dispatch does '
    + 'not prove scrolling settled; inspect the returned observation. Observations include '
    + 'screenshots; action success is not task acceptance.',
  parameters: {
    type: 'object',
    oneOf: [
      actionSchema('open', [], false),
      actionSchema('navigate', ['url']),
      actionSchema('click', ['selector']),
      actionSchema('fill', ['selector', 'value']),
      actionSchema('press', ['selector', 'key']),
      actionSchema('move', ['x', 'y']),
      actionSchema('scroll', ['delta_x', 'delta_y']),
      actionSchema('screenshot'),
      actionSchema('close'),
    ],
  },
  readOnly: false,
  concurrentSafe: false,
  permissions: [],
  timeoutMs: TOOL_TIMEOUT_MS,
  contextRole: 'none',
  progressObservation: true,
  contextRetention: 'normal',
};
/** Independent deep copy of the tool definition so a caller cannot mutate shared identity. */
function cloneDefinition() { return structuredClone(BROWSER_TOOL_DEFINITION); }

export class NativePlaywrightBrowser {
  constructor({
    scope, runtimeId, workspaceRevision, networkPolicy = null, artifactSink = null,
    browser = null, launchBrowser = null, viewport = DEFAULT_VIEWPORT, idleTimeoutMs = 900000,
    maxTextChars = 12000, maxImageBytes = 8 * 1024 * 1024, maxLogEntries = 50, maxCachedImages = 8,
    maxActions = 512, maskSelectors = [],
  } = {}) {
    if (!scope) throw new TypeError('invalid browser configuration');
    scopeKey(scope); // throws invalid_scope on a malformed scope
    if (typeof runtimeId !== 'string' || !runtimeId || typeof workspaceRevision !== 'string' || !workspaceRevision) {
      throw new TypeError('invalid browser configuration');
    }
    if (!Number.isFinite(idleTimeoutMs) || !(idleTimeoutMs > 0)) throw new TypeError('invalid browser configuration');
    // Viewport must be a dense 2-tuple of finite safe integers in [1,4096]; Array#every skips
    // sparse holes, so check each index explicitly via hasOwnProperty.
    if (!Array.isArray(viewport) || viewport.length !== 2
      || !Object.prototype.hasOwnProperty.call(viewport, 0) || !Object.prototype.hasOwnProperty.call(viewport, 1)
      || !Number.isSafeInteger(viewport[0]) || !Number.isSafeInteger(viewport[1])
      || viewport[0] < 1 || viewport[0] > 4096 || viewport[1] < 1 || viewport[1] > 4096) {
      throw new TypeError('invalid viewport');
    }
    // Each budget must be a finite safe positive integer; Math.min(NaN) is NaN and NaN <= 0 is false,
    // so a NaN budget would silently pass a Math.min guard.
    const budgets = [maxTextChars, maxImageBytes, maxLogEntries, maxCachedImages, maxActions];
    if (!budgets.every((v) => Number.isSafeInteger(v) && v > 0)) throw new TypeError('invalid observation limits');
    this.scope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId, agentId: scope.agentId };
    this.runtimeId = runtimeId;
    this.workspaceRevision = workspaceRevision;
    this._policy = networkPolicy;
    this._sink = artifactSink;
    this._maxCachedImages = maxCachedImages;
    this._maxActions = maxActions;
    this._browser = browser;
    this._ownedBrowser = browser == null; // borrowed injected browsers are never shut down here
    this._launchBrowser = launchBrowser;
    this._playwright = null;
    this._browserChannel = browser != null ? 'injected' : 'unavailable';
    this._viewport = [viewport[0], viewport[1]];
    this._idleTimeout = idleTimeoutMs;
    this._maxText = maxTextChars;
    this._maxImage = maxImageBytes;
    this._maxLogs = maxLogEntries;
    this._masks = ['input[type="password"]', '[autocomplete="current-password"]', '[autocomplete="new-password"]', ...maskSelectors];
    this._sessions = new Map();
    this._openResults = new Map();
    this._ownerLock = new AsyncLock();
    this._closed = false;
    this._digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
  }

  get browserChannel() { return this._browserChannel; }
  get browserVersion() { return this._browser != null ? this._browser.version() : null; }

  static definition() { return cloneDefinition(); }
  definition() { return cloneDefinition(); }

  _definitionMatches(def) {
    if (!def) return false;
    const self = BROWSER_TOOL_DEFINITION;
    return def.name === self.name && def.observationRole === self.observationRole
      && canonical(def.parameters) === canonical(self.parameters);
  }

  async _ensureBrowser() {
    if (this._closed) throw new BrowserSessionError('adapter_closed');
    if (this._browser == null) {
      try {
        if (this._launchBrowser) {
          this._browser = await this._launchBrowser();
          this._browserChannel = 'host-launched';
        } else {
          let chromium;
          try { ({ chromium } = await import('playwright')); }
          catch { try { ({ chromium } = await import('playwright-core')); } catch { throw new BrowserSessionError('browser_dependency_missing'); } }
          if (!chromium) throw new BrowserSessionError('browser_dependency_missing');
          this._browser = await chromium.launch({ headless: true });
          this._browserChannel = 'bundled-chromium';
        }
      } catch (err) {
        if (err instanceof BrowserSessionError) throw err;
        throw new BrowserSessionError('browser_unavailable');
      }
    }
    if (!this._browser.isConnected()) throw new BrowserSessionError('browser_disconnected');
    return this._browser;
  }

  async _allowed(ref, url, signal) {
    if (url === 'about:blank') return true;
    fence(signal);
    try {
      const parsed = new URL(url);
      if (!HTTP_WS_SCHEMES.has(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return false;
      if (this._policy == null) return false;
      const result = this._policy(ref, url);
      if (result && typeof result.then === 'function') return (await racePolicy(result, signal)) === true;
      return result === true;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return false;
    }
  }

  _log(session, bucket, value) {
    if (bucket.length >= this._maxLogs) { session.logsTruncated = true; return; }
    const clean = redact(String(value));
    if (codePointLength(clean) > 1000) session.logsTruncated = true;
    bucket.push(clipCodePoints(clean, 1000));
  }

  _exceptionLocation(session, event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    const details = event.exceptionDetails;
    if (!details || typeof details !== 'object' || Array.isArray(details) || !session.page) return;
    const { url: rawUrl, lineNumber: line, columnNumber: column } = details;
    if (typeof rawUrl !== 'string' || !Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return;
    if (line < 0 || column < 0) return;
    let source, current;
    try { source = new URL(rawUrl); current = new URL(session.page.url()); } catch { return; }
    if (source.protocol !== 'http:' && source.protocol !== 'https:') return;
    if (source.protocol !== current.protocol || source.host !== current.host) return;
    const path = (source.pathname || '/').replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 300);
    this._log(session, session.errorLocations, `${path}:${line + 1}:${column + 1}`);
  }

  /** True when the session must not touch the network: closed, quarantined (an aborted action left
   *  an in-flight dispatch), or the adapter is closed. A quarantined page's late requests/sockets
   *  are denied so an old canceled page cannot reach the network or connect a WebSocket. */
  _revoked(session) { return session.closed || session.quarantined || this._closed; }

  async _route(session, route) {
    const request = route.request();
    const url = request.url();
    try {
      if (request.frame().page() !== session.page) {
        this._log(session, session.failures, 'popup_request_denied');
        await route.abort('blockedbyclient');
        return;
      }
    } catch { /* workers may not expose a frame; their requests still pass policy */ }
    if (this._revoked(session) || !(await this._allowed(session.ref, url, null))) {
      this._log(session, session.failures, 'network_denied: ' + safeUrl(url));
      await route.abort('blockedbyclient');
      return;
    }
    // Revalidate after the async permission resolves: a close/quarantine that landed while the policy
    // was pending must not let a late fulfill reach a revoked session.
    if (this._revoked(session)) { await route.abort('blockedbyclient'); return; }
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 });
      if (this._revoked(session)) { await route.abort('blockedbyclient'); return; }
      const status = response.status();
      if (status >= 400 && (request.resourceType() === 'script' || request.resourceType() === 'stylesheet')) {
        let path = url; try { path = new URL(url).pathname; } catch {}
        this._log(session, session.failures, `asset_http_error:${status}: ${path}`);
      }
      const headers = response.headers();
      const location = headers.location ?? headers.Location ?? Object.keys(headers).find((h) => h.toLowerCase() === 'location' ? headers[h] : null);
      if (status >= 300 && status < 400 && location) {
        let target; try { target = new URL(location, url).href; } catch { target = location; }
        if (this._revoked(session) || !(await this._allowed(session.ref, target, null))) {
          this._log(session, session.failures, 'redirect_denied: ' + safeUrl(target));
          await route.abort('blockedbyclient');
          return;
        }
        if (this._revoked(session)) { await route.abort('blockedbyclient'); return; }
        // Chromium can skip route handlers after a fulfilled 302; never hand it a redirect. A
        // top-level navigation is retried as a fresh policy-checked goto, without replaying the click.
        if (request.isNavigationRequest() && request.frame() === session.page.mainFrame()) {
          session.navigationRedirect = target;
        } else {
          this._log(session, session.failures, 'subresource_redirect_blocked: ' + safeUrl(target));
        }
        await route.abort('aborted');
        return;
      }
      if (this._revoked(session)) { await route.abort('blockedbyclient'); return; }
      await route.fulfill({ response });
    } catch {
      this._log(session, session.failures, 'network_request_failed: ' + safeUrl(url));
      await route.abort('failed');
    }
  }

  async _socket(session, socket) {
    // Revalidate after the async permission resolves, before connecting. A quarantined session's
    // late socket is denied so an old canceled page cannot open a WebSocket.
    if (!this._revoked(session) && (await this._allowed(session.ref, socket.url(), null)) && !this._revoked(session)) {
      socket.connectToServer();
    } else {
      this._log(session, session.failures, 'websocket_denied: ' + safeUrl(socket.url()));
      await socket.close({ code: 1008, reason: 'network_policy' });
    }
  }

  _rejectPopup(session, page) {
    if (page !== session.page) {
      this._log(session, session.failures, 'popup_denied');
      return page.close().catch(() => {});
    }
    return Promise.resolve();
  }

  async _newSession(ref, signal) {
    fence(signal);
    const browser = await this._ensureBrowser();
    fence(signal);
    const context = await browser.newContext({
      viewport: { width: this._viewport[0], height: this._viewport[1] },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const session = new Session(ref, context);
    try {
      await this._setupContext(session, signal);
      this._sessions.set(ref.sessionId, session);
      this._scheduleIdle(session);
      return ref;
    } catch (err) {
      this._sessions.delete(ref.sessionId);
      await context.close().catch(() => {});
      throw err;
    }
  }

  /** Install handlers only on the new context owned by open or explicit restart. */
  async _setupContext(session, signal) {
    fence(signal);
    const context = session.context;
    if (typeof context.routeWebSocket !== 'function') throw new BrowserSessionError('websocket_policy_unavailable');
    await context.route('**/*', (route) => this._route(session, route));
    await context.routeWebSocket('**/*', (socket) => this._socket(session, socket));
    session.page = await context.newPage();
    fence(signal);
    context.on('page', (page) => this._rejectPopup(session, page));
    session.page.on('console', (msg) => this._log(session, session.console, `${msg.type()}: ${msg.text()}`));
    session.page.on('pageerror', (error) => this._log(session, session.errors, String(error)));
    if (typeof context.newCDPSession === 'function') {
      try {
        session.cdp = await context.newCDPSession(session.page);
        session.cdp.on('Runtime.exceptionThrown', (event) => this._exceptionLocation(session, event));
        await session.cdp.send('Runtime.enable');
      } catch { /* non-Chromium or restricted injected browsers keep pageerror observations */ session.cdp = null; }
    }
    fence(signal); // a cancel during the awaited CDP setup must not leave a live page
    session.page.on('requestfailed', (request) => this._log(session, session.failures, 'request_failed: ' + safeUrl(request.url())));
  }

  /** Quarantine a session whose action aborted with possible in-flight input dispatch: close the
   *  context (real Playwright cancels the pending click on close, so the stuck _perform drains) and
   *  mark the session lost. NO replacement page is created on the same ref/generation/lease — that
   *  would disguise a replacement as continuity and violate the explicit-restart contract. The
   *  session stays quarantined: recover reports lost, a new action on the old ref is refused with an
   *  uncertain observation (requires_reconcile), and only explicit restart(ref) (generation+1 AND
   *  leaseEpoch+1) may create a replacement. */
  async _quarantine(session) {
    session.quarantined = true;
    session.closed = true;
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
    // Revoke synchronously; cleanup cannot delay the caller's abort/deadline.
    // Start context shutdown even if a handle's disposal is stuck in the driver.
    session.quarantineCleanup ??= Promise.allSettled([
      Promise.resolve().then(() => session.context.close()),
      Promise.resolve().then(() => session.elementRefs.clear()),
    ]).then(() => {});
    return session.quarantineCleanup;
  }

  _scheduleIdle(session) {
    const tick = async () => {
      if (session.closed) return;
      const remaining = this._idleTimeout - (performance.now() - session.lastUsed);
      if (remaining > 0) { session.idleTimer = this._armIdle(tick, remaining); return; }
      const release = await session.lock.acquire();
      try { if (!session.closed && performance.now() - session.lastUsed >= this._idleTimeout) await this._closeSession(session); }
      catch { session.closed = true; this._log(session, session.errors, 'idle_cleanup_failed'); }
      finally { release(); }
    };
    session.idleTimer = this._armIdle(tick, this._idleTimeout);
  }
  _armIdle(tick, ms) {
    const t = setTimeout(tick, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  async open(runId, { operationKey, signal } = {}) {
    fence(signal);
    const release = await this._ownerLock.acquire();
    try {
      if (this._closed) throw new BrowserSessionError('adapter_closed');
      fence(signal);
      const key = operationKey != null ? `${runId}\0${operationKey}` : null;
      if (key != null && this._openResults.has(key)) return snapshotRef(this._openResults.get(key));
      const ref = validateBrowserSessionRef({
        sessionId: randomUUID().replace(/-/g, ''),
        scope: this.scope, runId, runtimeId: this.runtimeId, backend: 'playwright', workspaceRevision: this.workspaceRevision,
      });
      const result = await this._newSession(ref, signal);
      // Store the canonical ref; return an independent snapshot so a caller mutating the returned
      // ref cannot corrupt the session's internal identity.
      if (key != null) this._openResults.set(key, result);
      return snapshotRef(result);
    } finally { release(); }
  }

  _validateRef(ref) {
    if (!scopeEquals(ref.scope, this.scope) || ref.runtimeId !== this.runtimeId || ref.workspaceRevision !== this.workspaceRevision) {
      throw new BrowserSessionError('scope_mismatch');
    }
    if (ref.backend !== 'playwright') throw new BrowserSessionError('backend_mismatch');
  }
  _lookup(ref) {
    this._validateRef(ref);
    const session = this._sessions.get(ref.sessionId);
    if (!session) throw new BrowserSessionError('session_lost');
    if (!refEquals(ref, session.ref)) throw new BrowserSessionError('stale_session_ref');
    return session;
  }

  _live(session) {
    if (session.closed || this._closed || !this._browser.isConnected() || session.page.isClosed()) return false;
    if (performance.now() - session.lastUsed > this._idleTimeout) {
      return this._closeSession(session).then(() => false);
    }
    return true;
  }

  async _closeSession(session) {
    if (session.quarantined) return this._quarantine(session);
    session.closed = true;
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
    await session.elementRefs.clear().catch(() => {});
    await session.context.close().catch(() => {});
  }

  _incomplete(session, action, code) {
    return validateBrowserObservation({
      sessionRef: session.ref,
      actionId: action.actionId,
      actionSeq: session.actionSeq,
      status: 'uncertain',
      errorCode: code,
      complete: false,
      retryability: 'requires_reconcile',
      url: safeUrl(session.page ? session.page.url() : ''),
      statusCode: session.lastResponseStatus,
      viewport: this._viewport,
      console: session.console.slice(),
      pageErrors: session.errors.slice(),
      pageErrorLocations: session.errorLocations.slice(),
      networkFailures: session.failures.slice(),
      logsTruncated: session.logsTruncated,
      sourceTrust: 'untrusted_page',
    });
  }
  _readOnlyFailure(session, action, code) {
    const incomplete = this._incomplete(session, action, code);
    return validateBrowserObservation({ ...incomplete, status: 'error', complete: true, retryability: 'safe' });
  }

  async _captureDom(page, signal) {
    fence(signal);
    let handle, metaHandle;
    try {
      handle = await page.evaluateHandle(domCapture);
      fence(signal);
      metaHandle = await handle.getProperty('meta');
      const meta = await metaHandle.jsonValue();
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new ObservationCaptureFailure();
      return meta;
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ObservationCaptureFailure();
    } finally {
      if (metaHandle) try { await metaHandle.dispose(); } catch {}
      if (handle) try { await handle.dispose(); } catch {}
    }
  }

  async _observe(session, action, signal, attempt) {
    fence(signal);
    const page = session.page;
    if (attempt) attempt.phase = 'capture_dom';
    const before = await this._captureDom(page, signal);
    fence(signal);
    let data;
    try {
      if (attempt) attempt.phase = 'capture_screenshot';
      data = await page.screenshot({
        type: 'png', fullPage: false,
        timeout: Math.max(1, Math.min(4000, Math.floor(action.timeoutMs / 3))),
        mask: this._masks.map((s) => page.locator(s)),
      });
    } catch (err) { if (isAbortError(err)) throw err; throw new ObservationCaptureFailure(); }
    // A canceled action must never publish late media to the artifact sink.
    fence(signal);
    // Async UI work can finish while screenshotting. Return the latest single DOM sample and
    // disclose detected drift, rather than pairing pre-screenshot text with a later frame as
    // though both were current. This observation does not wait for stability or repeat an input.
    let meta, tokens;
    if (attempt) attempt.phase = 'capture_controls';
    try { ({ meta, tokens } = await session.elementRefs.capture(page)); }
    catch (err) { if (isAbortError(err)) throw err; throw new ObservationCaptureFailure(); }
    fence(signal);

    const title = clipCodePoints(redact(String(meta.title || '')), 500);
    const text = redact(String(meta.text || ''));
    const controls = [];
    const rawControls = Array.isArray(meta.controls) ? meta.controls.slice(0, 40) : [];
    for (let index = 0; index < rawControls.length; index++) {
      const value = rawControls[index];
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.tag !== 'string') continue;
      let selector = value.selector;
      if (typeof selector !== 'string' || !selector || codePointLength(selector) > 512) selector = null;
      controls.push({
        tag: clipCodePoints(redact(value.tag), 32),
        role: clipCodePoints(redact(String(value.role || '')), 80),
        label: clipCodePoints(redact(String(value.label || '')), 160),
        selector: selector != null ? redact(selector) : null,
        elementRef: index < tokens.length ? tokens[index] : null,
        clickable: value.clickable === true,
        hitTestReachable: typeof value.hitTestReachable === 'boolean' ? value.hitTestReachable : null,
        duplicateId: value.duplicateId === true,
      });
    }
    if (data.length > this._maxImage || !isPng(data) || data.length < 24) {
      throw new BrowserSessionError('screenshot_invalid_or_oversize');
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    let contentRef = 'sha256:' + createHash('sha256').update(data).digest('hex');
    if (this._sink) {
      if (attempt) attempt.phase = 'publish';
      fence(signal); // do not call the sink after an abort
      let sinkRef = this._sink(session.ref, data, 'image/png');
      if (sinkRef && typeof sinkRef.then === 'function') sinkRef = await sinkRef;
      fence(signal); // do not publish after an async sink resolves post-abort
      if (typeof sinkRef !== 'string' || !(sinkRef.startsWith('artifact:') || sinkRef.startsWith('sha256:')) || sinkRef.includes('?')) {
        throw new BrowserSessionError('invalid_artifact_ref');
      }
      contentRef = sinkRef;
    }
    const image = {
      contentRef, mimeType: 'image/png', width, height,
      contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data.toString('base64') } },
    };
    const textClipped = clipCodePoints(text, this._maxText);
    const observation = validateBrowserObservation({
      sessionRef: session.ref, actionId: action.actionId, actionSeq: session.actionSeq,
      status: 'ok', complete: true, retryability: 'safe',
      url: safeUrl(String(meta.url || '')), statusCode: session.lastResponseStatus,
      title, viewport: this._viewport, focus: clipCodePoints(String(meta.focus || ''), 100),
      scrollX: Number.isSafeInteger(meta.scrollX) ? meta.scrollX : null,
      scrollY: Number.isSafeInteger(meta.scrollY) ? meta.scrollY : null,
      lifecycle: clipCodePoints(String(meta.lifecycle || 'unknown'), 32),
      pointerLockActive: typeof meta.pointerLockActive === 'boolean' ? meta.pointerLockActive : null,
      text: textClipped, textTruncated: codePointLength(text) > this._maxText,
      domChangedDuringCapture: canonical(before) !== canonical(meta),
      controls,
      console: session.console.slice(), pageErrors: session.errors.slice(),
      pageErrorLocations: session.errorLocations.slice(), networkFailures: session.failures.slice(),
      logsTruncated: session.logsTruncated, screenshot: image, sourceTrust: 'untrusted_page',
    });
    session.console.length = 0; session.errors.length = 0; session.errorLocations.length = 0;
    session.failures.length = 0; session.logsTruncated = false;
    return observation;
  }

  async _selectorError(session, action, code = 'selector_not_visible', signal, attempt) {
    try {
      const observation = await this._observe(session, action, signal, attempt);
      return validateBrowserObservation({ ...observation, status: 'error', errorCode: code, complete: true, retryability: 'safe' });
    } catch (err) {
      if (isAbortError(err)) throw err; // propagate abort; never synthesize a safe error after cancel
      return validateBrowserObservation({
        sessionRef: session.ref, actionId: action.actionId, actionSeq: session.actionSeq,
        status: 'error', errorCode: code, complete: true, retryability: 'safe',
        url: safeUrl(session.page ? session.page.url() : ''), viewport: this._viewport, sourceTrust: 'untrusted_page',
      });
    }
  }

  // Only call before input dispatch. A later locator failure cannot prove that
  // an input did not happen and must retain the existing uncertain outcome.
  async _selectorFailureCode(locator, action, signal, fallback) {
    if (action.elementRef != null) return fallback;
    try {
      const matches = await locator.count();fence(signal);
      if (matches > 1) return 'selector_ambiguous';
      return matches === 0 && fallback !== null ? 'selector_not_found' : fallback;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return 'selector_resolution_failed';
    }
  }

  async _navigate(session, url, timeoutMs, signal, attempt) {
    await session.elementRefs.clear();
    for (let hop = 0; hop < 10; hop++) {
      fence(signal);
      session.navigationRedirect = null;
      if (!(await this._allowed(session.ref, url, signal))) throw new BrowserSessionError('network_denied');
      fence(signal); // after async policy, before dispatch
      try {
        if (attempt) { attempt.phase = 'navigate'; attempt.dispatchStarted = true; attempt.dispatchCompleted = false; }
        const response = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        if (attempt) attempt.dispatchCompleted = true;
        session.lastResponseStatus = response ? response.status() : null;
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (session.navigationRedirect === null) throw err;
      }
      fence(signal);
      if (session.navigationRedirect === null) return;
      url = session.navigationRedirect;
    }
    throw new BrowserSessionError('redirect_limit_exceeded');
  }

  async _perform(session, action, signal, attempt) {
    fence(signal);
    const page = session.page;
    if (action.kind === 'close') {
      if (attempt) attempt.phase = 'close';
      await this._closeSession(session);
      return validateBrowserObservation({
        sessionRef: session.ref, actionId: action.actionId, actionSeq: session.actionSeq,
        status: 'ok', complete: true, retryability: 'safe', viewport: this._viewport, lifecycle: 'closed', sourceTrust: 'untrusted_page',
      });
    }
    if (action.kind === 'navigate') {
      await this._navigate(session, action.url, action.timeoutMs, signal, attempt);
    } else {
      session.navigationRedirect = null;
      let locator = null;
      if (action.kind === 'click' || action.kind === 'fill' || action.kind === 'press') {
        if (attempt) attempt.phase = 'target';
        if (action.elementRef != null) {
          fence(signal);
          locator = await session.elementRefs.resolve(action.elementRef);
          if (!locator) return await this._selectorError(session, action, 'element_ref_stale', signal, attempt);
        } else {
          locator = page.locator(action.selector);
          const code = await this._selectorFailureCode(locator, action, signal, null);
          if (code) return await this._selectorError(session, action, code, signal, attempt);
        }
        try {
          fence(signal);
          const timeout = Math.min(3000, Math.max(1, Math.floor(action.timeoutMs / 3)));
          if (action.elementRef != null) await locator.waitForElementState('visible', { timeout });
          else await locator.waitFor({ state: 'visible', timeout });
          // Critical fence: a cancel that lands while waitFor is blocked must not let a later click
          // dispatch. The visibility check has not mutated the page, so bailing here is safe.
          fence(signal);
        } catch (err) {
          if (isAbortError(err)) throw err;
          const code = await this._selectorFailureCode(locator, action, signal, 'selector_not_visible');
          return await this._selectorError(session, action, code, signal, attempt);
        }
      }
      try {
        fence(signal);
        if (action.kind === 'click') {
          // trial checks actionability without dispatching; a not-actionable control throws a safe
          // error BEFORE any dispatch. The real click then commits; a throw AFTER it is a committed
          // input (ActionDispatchFailure -> uncertain), never a safe selector_not_actionable.
          try {
            if (attempt) attempt.phase = 'actionability';
            fence(signal);
            await locator.click({ trial: true, timeout: Math.min(3000, Math.max(1, Math.floor(action.timeoutMs / 3))), button: action.button || 'left' });
          } catch (err) {
            if (isAbortError(err)) throw err;
            const code = await this._selectorFailureCode(locator, action, signal, 'selector_not_actionable');
            return await this._selectorError(session, action, code, signal, attempt);
          }
          fence(signal); // do not commit the real click after an abort
          if (attempt) { attempt.phase = 'dispatch'; attempt.dispatchStarted = true; }
          await locator.click({ timeout: Math.max(1, Math.min(10000, Math.floor(action.timeoutMs / 2))), delay: action.durationMs || 0, button: action.button || 'left' });
        } else if (action.kind === 'fill') {
          if (attempt) { attempt.phase = 'dispatch'; attempt.dispatchStarted = true; }
          await locator.fill(action.value, { timeout: Math.max(1, Math.min(10000, Math.floor(action.timeoutMs / 2))) });
        } else if (action.kind === 'press') {
          if (attempt) { attempt.phase = 'dispatch'; attempt.dispatchStarted = true; }
          await locator.press(action.key, { timeout: Math.max(1, Math.min(10000, Math.floor(action.timeoutMs / 2))), delay: action.durationMs || 0 });
        } else if (action.kind === 'move') {
          if (action.x >= this._viewport[0] || action.y >= this._viewport[1]) return this._readOnlyFailure(session, action, 'position_outside_viewport');
          fence(signal);
          if (attempt) { attempt.phase = 'dispatch'; attempt.dispatchStarted = true; }
          await page.mouse.move(action.x, action.y, { steps: action.steps || 1 });
        } else if (action.kind === 'scroll') {
          if (action.x != null) {
            if (action.x >= this._viewport[0] || action.y >= this._viewport[1]) return this._readOnlyFailure(session, action, 'position_outside_viewport');
            fence(signal);
            if (attempt) { attempt.phase = 'dispatch'; attempt.dispatchStarted = true; }
            await page.mouse.move(action.x, action.y);
          }
          fence(signal);
          // Wheel can target an inner scroll container. Observe the actual result; dispatch
          // completion is not settled motion.
          if (attempt) { attempt.phase = 'dispatch'; attempt.dispatchStarted = true; }
          await page.mouse.wheel(action.deltaX, action.deltaY);
        }
        if (attempt?.dispatchStarted) attempt.dispatchCompleted = true;
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (session.navigationRedirect === null) throw new ActionDispatchFailure(err);
      }
      fence(signal);
      if (session.navigationRedirect != null) {
        await this._navigate(session, session.navigationRedirect, action.timeoutMs, signal, attempt);
      } else if (action.kind === 'click') {
        // A click can dispatch an async fetch whose DOM result is not visible when Playwright's
        // click returns. Give that request a bounded chance to settle before capturing the
        // observation; an idle timeout cannot justify replaying the committed click.
        if (attempt) attempt.phase = 'settle';
        try { await page.waitForLoadState('networkidle', { timeout: Math.min(1500, Math.max(1, Math.floor(action.timeoutMs / 4))) }); }
        catch {}
        fence(signal);
      }
    }
    fence(signal);
    return await this._observe(session, action, signal, attempt);
  }

  /** Race a unit of async work against the signal. On abort, reject with AbortError immediately so
   *  the caller can proceed (act returns boundedly, or a retry honors the deadline), while the work
   *  itself is NOT cancelled — it drains in the background, quarantined by fence() checks so it
   *  never dispatches new input or publishes late media. */
  _race(work, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => { if (!settled) { settled = true; cleanup(); reject(new AbortError()); } };
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      if (signal) {
        if (signal.aborted) { reject(new AbortError()); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve().then(() => work()).then(
        (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } },
        (e) => { if (!settled) { settled = true; cleanup(); reject(e); } }
      );
    });
  }

  async act(ref, action, { signal, observeAction } = {}) {
    const session = this._lookup(ref);
    action = validateBrowserAction(action);
    const controller = new AbortController();
    const onExternal = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternal, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), action.timeoutMs);
    const internal = controller.signal;
    const attempt = createBrowserActionAttempt(action);
    let observation, failureCode;
    // _act holds the session lock until _perform (and any capture retry) FULLY drains. act returns
    // boundedly via this race, but _act may keep running in the background (a JS abort cannot forcibly
    // interrupt an in-flight Playwright call). An aborted started attempt revokes the page; later
    // input requires explicit restart. A queued attempt cannot revoke another action's page.
    // The late _act drain quarantines the action (action_canceled) and never
    // publishes late media (fence checks + signal.aborted guard).
    try {
      observation = await this._race(() => this._act(ref, action, internal, attempt), internal);
      return observation;
    } catch (err) {
      failureCode = err instanceof BrowserSessionError ? err.code : 'browser_action_error';
      if (isAbortError(err)) {
        // The aborted action may have an in-flight input dispatch on the current page that JS
        // cannot cancel. Quarantine the session: close its context (real Playwright cancels the
        // pending input) and mark it lost. No replacement page is created on the same ref — only
        // explicit restart(ref) (generation+1, leaseEpoch+1) may create one. A capture/close that
        // already started is also revoked so late driver work cannot interfere with later input.
        if (attempt.started) {
          void this._quarantine(session).catch(() => {});
        }
        if (signal && signal.aborted) throw err; // external cancel: caller sees the rejection
        // per-action timeout: a recorded tombstone means dispatch began; otherwise it never did
        if (session.results.has(action.actionId)) return this._incomplete(session, action, 'action_timed_out');
        throw new BrowserSessionError('action_not_dispatched_timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternal);
      attempt.publish(observeAction, { signal, internal, observation, failureCode });
    }
  }

  async _act(ref, action, signal, attempt) {
    const session = this._lookup(ref);
    const fingerprint = createHash('sha256').update(canonical(action)).digest('hex');
    // A quarantined session (an aborted action left an in-flight dispatch JS cannot cancel) stays
    // lost: no new page is created on the same ref/generation/lease. A new input-dispatching action
    // is refused with an uncertain observation (requires_reconcile) so the caller must reconcile;
    // replay of the old action ID returns the existing canceled tombstone (non-replaying). Only an
    // explicit restart(ref) — which increments generation AND leaseEpoch — may create a replacement.
    if (session.quarantined) {
      if (action.kind === 'close') {
        await this._closeSession(session);
        return validateBrowserObservation({
          sessionRef: session.ref, actionId: action.actionId, actionSeq: session.actionSeq,
          status: 'ok', complete: true, retryability: 'safe', viewport: this._viewport, lifecycle: 'closed', sourceTrust: 'untrusted_page',
        });
      }
      // A changed payload under the same actionId remains action_conflict even for a quarantined
      // session; only an identical replay returns the cached canceled tombstone (non-replaying).
      const prior = session.results.get(action.actionId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new BrowserSessionError('action_conflict');
        attempt.phase = 'replay';
        return validateBrowserObservation(prior.observation);
      }
      return validateBrowserObservation({
        sessionRef: session.ref, actionId: action.actionId, actionSeq: session.actionSeq,
        status: 'uncertain', errorCode: 'session_quarantined', complete: false, retryability: 'requires_reconcile',
        url: safeUrl(session.page ? session.page.url() : ''), viewport: this._viewport, sourceTrust: 'untrusted_page',
      });
    }
    const release = await session.lock.acquire();
    try {
      attempt.phase = 'preflight';
      if (!refEquals(ref, session.ref)) throw new BrowserSessionError('stale_session_ref');
      const prior = session.results.get(action.actionId);
      if (prior && prior.fingerprint !== fingerprint) throw new BrowserSessionError('action_conflict');
      if (action.kind !== 'close') {
        fence(signal);
        const live = await Promise.resolve(this._live(session));
        if (!live) throw new BrowserSessionError('session_lost');
        fence(signal);
        const urls = [session.page.url(), action.url];
        for (let index = 0; index < urls.length; index++) {
          const url = urls[index];
          if (url != null) {
            fence(signal);
            const allowed = await this._allowed(ref, url, signal);
            if (!allowed) {
              if (index === 0) await this._closeSession(session);
              throw new BrowserSessionError('network_denied');
            }
          }
        }
      }
      if (prior) { attempt.phase = 'replay'; return validateBrowserObservation(prior.observation); }
      if (session.results.size >= this._maxActions && action.kind !== 'close') throw new BrowserSessionError('action_capacity_reached');
      attempt.started = true;
      session.actionSeq += 1;
      // Cache uncertainty before yielding to the driver. Cancellation and timeouts must never make
      // the same click silently dispatch twice.
      session.results.set(action.actionId, { fingerprint, observation: this._incomplete(session, action, 'action_in_flight') });
      let result;
      try {
        result = await this._perform(session, action, signal, attempt);
      } catch (err) {
        if (isAbortError(err)) {
          // A dispatch may have already happened. Quarantine the page: a new action revives a fresh
          // page so it never overlaps this abandoned in-flight work. Never publish a real result for
          // an aborted action; keep the canceled tombstone so a replay never re-dispatches.
          session.quarantined = true;
          session.results.set(action.actionId, { fingerprint, observation: this._incomplete(session, action, 'action_canceled') });
          throw err;
        } else if (err instanceof ObservationCaptureFailure) {
          // A failed capture has not reached the artifact sink. Observe again WITHOUT replaying the
          // already completed input action — but race this retry against the same deadline too, so a
          // blocked retry screenshot cannot outlive the action's timeout. The no-replay invariant
          // holds: _observe only reads (DOM/screenshot/sink), never re-dispatches the input.
          try {
            result = await this._race(() => this._observe(session, action, signal, attempt), signal);
          } catch (e) {
            if (isAbortError(e)) {
              session.results.set(action.actionId, { fingerprint, observation: this._incomplete(session, action, 'action_canceled') });
              throw e;
            } else if (e instanceof ObservationCaptureFailure) {
              result = action.kind === 'screenshot' ? this._readOnlyFailure(session, action, 'observation_failed')
                : this._incomplete(session, action, 'observation_capture_failed_after_action');
            } else {
              result = this._incomplete(session, action, 'observation_sink_failed_or_timed_out');
            }
          }
        } else if (err instanceof ActionDispatchFailure) {
          result = this._incomplete(session, action, 'action_dispatch_failed_or_timed_out');
        } else {
          const code = err instanceof BrowserSessionError ? err.code : 'action_failed_or_timed_out';
          result = this._incomplete(session, action, code);
        }
      } finally {
        session.lastUsed = performance.now();
      }
      // Only publish a real result if the signal never aborted; an abort during/after dispatch
      // quarantines the action as canceled so late media and late results never land.
      if (signal.aborted) {
        session.quarantined = true;
        session.results.set(action.actionId, { fingerprint, observation: this._incomplete(session, action, 'action_canceled') });
        throw new AbortError();
      }
      session.results.set(action.actionId, { fingerprint, observation: result });
      this._trimImages(session);
      return validateBrowserObservation(result);
    } finally {
      release();
    }
  }

  _trimImages(session) {
    const images = [...session.results.entries()].filter(([, { observation }]) => observation.screenshot != null).map(([key]) => key);
    const evict = images.slice(0, Math.max(0, images.length - this._maxCachedImages));
    for (const key of evict) {
      const { fingerprint, observation } = session.results.get(key);
      // Retain action identity forever within this session: dropping an image must not make an old
      // click eligible to execute again.
      session.results.set(key, { fingerprint, observation: validateBrowserObservation({
        ...observation, screenshot: null, complete: false, status: 'uncertain',
        errorCode: 'response_cache_evicted', retryability: 'requires_reconcile',
      }) });
    }
  }

  async recover(ref, { signal } = {}) {
    fence(signal);
    this._validateRef(ref);
    const session = this._sessions.get(ref.sessionId);
    if (!session) return validateBrowserRecovery({ status: 'lost', sessionRef: snapshotRef(ref), lastActionSeq: 0, reason: 'owner_unavailable', reobserveAvailable: false });
    if (!refEquals(ref, session.ref)) throw new BrowserSessionError('stale_session_ref');
    // A quarantined session is lost and its old action's lock may never release (JS cannot cancel
    // the in-flight dispatch); report lost without waiting on that lock.
    if (session.quarantined) return validateBrowserRecovery({ status: 'lost', sessionRef: snapshotRef(ref), lastActionSeq: session.actionSeq, reason: 'page_unavailable', reobserveAvailable: false });
    const release = await session.lock.acquire();
    try {
      fence(signal); // a cancel while waiting for an in-flight action's lock must not observe
      const live = await Promise.resolve(this._live(session));
      fence(signal);
      return validateBrowserRecovery({
        status: live ? 'reconnected' : 'lost', sessionRef: snapshotRef(ref), lastActionSeq: session.actionSeq,
        reason: live ? null : 'page_unavailable', reobserveAvailable: false,
      });
    } finally { release(); }
  }

  async recoverSessions({ refs, signal, ...identity } = {}) {
    // READ-ONLY probe: validate the complete host-owned batch before probing/expiring pages. Never
    // restarts pages or replays actions.
    for (const ref of refs) {
      this._validateRef(ref);
      const session = this._sessions.get(ref.sessionId);
      if (session && !refEquals(ref, session.ref)) throw new BrowserSessionError('stale_session_ref');
    }
    const results = [];
    for (const ref of refs) results.push(await this.recover(ref, { signal, ...identity }));
    return results;
  }

  async restart(ref, { signal } = {}) {
    fence(signal);
    this._validateRef(ref);
    const release = await this._ownerLock.acquire();
    try {
      fence(signal);
      const existing = this._sessions.get(ref.sessionId);
      if (existing) {
        if (!refEquals(ref, existing.ref)) throw new BrowserSessionError('stale_session_ref');
        if (existing.quarantined) {
          // Revoked by _quarantine; its old action's lock may never release.
          // Cleanup keeps running on the retired context; new refs cannot use it.
          this._sessions.delete(ref.sessionId);
        } else {
          const rel = await existing.lock.acquire();
          try { await this._closeSession(existing); } finally { rel(); }
        }
      }
      const replacement = validateBrowserSessionRef({
        ...ref, generation: ref.generation + 1, leaseEpoch: ref.leaseEpoch + 1,
      });
      const result = await this._newSession(replacement, signal);
      return validateBrowserRecovery({ status: 'restarted', sessionRef: snapshotRef(result), lastActionSeq: 0, reason: null, reobserveAvailable: false });
    } finally { release(); }
  }

  async close(ref, { signal, confirmClosed = false } = {}) {
    fence(signal);
    const session = this._lookup(ref);
    const close = async () => {
      await this._closeSession(session);
      // Normal disposal is best effort. A recovery fence is stronger: the
      // context driver must acknowledge closure, including after quarantine's
      // background cleanup rejected. Never infer that from session.closed.
      if (confirmClosed) await session.context.close();
    };
    if (session.quarantined) return this._race(close, signal);
    const release = await session.lock.acquire();
    try { fence(signal); await this._race(close, signal); } finally { release(); }
  }

  async aclose() {
    const release = await this._ownerLock.acquire();
    try {
      this._closed = true;
      for (const session of this._sessions.values()) {
        if (session.quarantined) { await this._closeSession(session); continue; }
        const rel = await session.lock.acquire();
        try { await this._closeSession(session); } finally { rel(); }
      }
      if (this._ownedBrowser && this._browser) { await this._browser.close().catch(() => {}); }
    } finally { release(); }
  }
  dispose() { return this.aclose(); }

  _observationContent(observation) {
    const content = {};
    for (const key of Object.keys(observation)) content[key] = observation[key];
    if (observation.screenshot) {
      content.screenshot = {
        contentRef: observation.screenshot.contentRef, mimeType: observation.screenshot.mimeType,
        width: observation.screenshot.width, height: observation.screenshot.height,
      };
    }
    return content;
  }

  async execute(request) {
    let activeRef = null;
    try {
      if (!scopeEquals(request.scope, this.scope) || request.call.name !== 'native_browser' || !this._definitionMatches(request.definition)) {
        throw new BrowserSessionError('scope_or_tool_mismatch');
      }
      const args = { ...request.call.arguments };
      const kind = args.action; delete args.action;
      if (kind === 'open') {
        if (Object.keys(args).length > 0) throw new BrowserSessionError('invalid_arguments');
        const ref = await this.open(request.runId, { operationKey: request.operationKey, signal: request.signal });
        return { status: 'ok', content: { sessionRef: snapshotRef(ref) }, browserSessionRef: ref, browserSessionClosed: false };
      }
      const sessionId = args.session_id; delete args.session_id;
      const generation = args.generation; delete args.generation;
      const session = typeof sessionId === 'string' ? this._sessions.get(sessionId) : undefined;
      if (!session || session.ref.runId !== request.runId || !Number.isSafeInteger(generation) || session.ref.generation !== generation) {
        throw new BrowserSessionError('session_scope_or_generation_mismatch');
      }
      activeRef = session.ref;
      for (const key of Object.keys(args)) {
        if (!KNOWN_TOOL_ACTION_ARGS.has(key)) throw new BrowserSessionError('invalid_arguments');
      }
      const action = validateBrowserAction({
        actionId: request.operationKey, kind,
        url: args.url ?? null, selector: args.selector ?? null, elementRef: args.element_ref ?? null,
        value: args.value ?? null, key: args.key ?? null, button: args.button ?? null,
        x: args.x ?? null, y: args.y ?? null, steps: args.steps ?? null,
        deltaX: args.delta_x ?? null, deltaY: args.delta_y ?? null,
        durationMs: args.duration_ms ?? null, timeoutMs: args.timeout_ms,
      });
      const observation = await this.act(session.ref, action, { signal: request.signal });
      const content = this._observationContent(observation);
      const contentBlocks = observation.screenshot ? [observation.screenshot.contentBlock] : [];
      return {
        status: observation.status,
        progressObservationDigest: browserObservationDigest(observation, this._digest),
        content, contentBlocks, context: { content: canonical(content),
          ...(contentBlocks.length ? { media: structuredClone(contentBlocks) } : {}) },
        browserSessionRef: observation.sessionRef,
        browserSessionClosed: kind === 'close' && observation.status === 'ok' && observation.lifecycle === 'closed',
        browserObservation: observation,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const code = err instanceof BrowserSessionError ? err.code : 'invalid_arguments';
      return { status: 'error', content: { error_code: code }, ...(activeRef ? { browserSessionRef: snapshotRef(activeRef) } : {}) };
    }
  }
}

export { ObservationCaptureFailure, ActionDispatchFailure, AsyncLock, AbortError };
