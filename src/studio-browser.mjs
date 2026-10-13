/** Ephemeral Agent → operator UI command. DSH owns navigation and all tab state. */
import { randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
export function browserUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('BROWSER_URL_INVALID', 'Supply an absolute HTTP(S) URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || String(value).length > 4096) {
    throw fail('BROWSER_URL_INVALID', 'Only HTTP(S) pages without embedded credentials can open in the Browser.');
  }
  return url.href;
}

export function createStudioBrowser({ timeoutMs = 30000 } = {}) {
  const pending = new Map();
  let disposed = false;
  function open(args, exec) {
    const sessionId = exec.agent?.session?.id;
    if (!sessionId) throw fail('BROWSER_SESSION_REQUIRED', 'Use this tool from a DSH conversation.');
    const url = browserUrl(args.url);
    exec.signal?.throwIfAborted();
    if (disposed) throw fail('BROWSER_UNAVAILABLE', 'Studio has been unloaded.');
    if (pending.has(sessionId)) throw fail('BROWSER_BUSY', 'This conversation already has a pending navigation.');
    return new Promise((resolve, reject) => {
      const request = { requestId: randomUUID(), sessionId, url, expiresAt: Date.now() + timeoutMs, claim: null };
      const finish = (error, value) => {
        clearTimeout(timer);
        exec.signal?.removeEventListener('abort', abort);
        pending.delete(sessionId);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(exec.signal.reason || fail('BROWSER_CANCELLED', 'Navigation cancelled.'));
      const timer = setTimeout(() => finish(fail('BROWSER_UI_UNAVAILABLE', 'No active Studio Browser confirmed navigation. Select this conversation and retry.')), timeoutMs);
      pending.set(sessionId, { request, finish });
      exec.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  function handle(endpoint, payload = {}) {
    const entry = pending.get(payload.sessionId);
    if (endpoint === 'browser/claim') {
      if (!entry || entry.request.claim) return null;
      entry.request.claim = randomUUID();
      return { ...entry.request };
    }
    if (!entry || payload.requestId !== entry.request.requestId || payload.claim !== entry.request.claim || !entry.request.claim) {
      throw fail('BROWSER_REQUEST_EXPIRED', 'Navigation is no longer pending.');
    }
    if (endpoint === 'browser/confirm') return { pending: true };
    if (endpoint !== 'browser/ack') throw fail('BROWSER_ENDPOINT_UNKNOWN', 'Unknown UI command endpoint.');
    if (payload.error || payload.kind !== 'browser' || typeof payload.tabId !== 'string' || !payload.tabId) {
      entry.finish(fail('BROWSER_OPEN_FAILED', 'The current Studio conversation could not open its Browser tab.'));
    } else {
      entry.finish(null, { destination: 'in-app', status: 'opened', url: entry.request.url, tabId: payload.tabId,
        message: 'Opened the official DSH Browser tab. Page loading is separate; this tool does not read or automate the page.' });
    }
    return { acknowledged: true };
  }
  function dispose() {
    disposed = true;
    for (const entry of pending.values()) entry.finish(fail('BROWSER_UNAVAILABLE', 'Studio has been unloaded.'));
  }
  const tool = {
    name: 'studio_open_browser',
    description: 'Open an HTTP(S) page in AgentKit Studio’s built-in right-side Browser, beside THIS conversation. Use this when the user asks to open a URL in the internal/in-app browser; do not use Playwright or shell open for that request. For a local HTML file, first serve it on loopback HTTP. This opens a tab and waits for the UI acknowledgement; it does not read or control the webpage. In PTC mode call tools.studio_open_browser({url: ...}) inside run_code, as with other tools.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute HTTP(S) URL, e.g. https://github.com/' } }, required: ['url'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: open,
    presentCall: args => ({ card: 'generic', title: '在内置浏览器打开网页', kind: 'read', subtitle: args.url }),
  };
  return { tool, handle, dispose };
}

export function registerStudioBrowser(ctx) {
  const browser = createStudioBrowser();
  ctx.connection.rpc.handle('/agentkit-ui', async (endpoint, payload) => {
    try { return { ok: true, value: browser.handle(endpoint, payload) }; }
    catch (error) { return { ok: false, error: { code: error.code || 'BROWSER_OPEN_FAILED', message: error.message, details: {} } }; }
  });
  ctx.inject(['tools'], scope => scope.tools.register(browser.tool));
  ctx.effect(() => () => browser.dispose(), 'agentkit-studio: browser commands lifetime');
}
