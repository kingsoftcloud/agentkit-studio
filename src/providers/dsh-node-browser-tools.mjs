/** Stateless legacy inspection, owned by the original DSH Agent/Session/call.
 * Native's persistent BrowserSessionRef contract remains separate. */
import { isAbsolute, join, relative, resolve } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { browserInspectParameters, parseWorkspaceBrowserInput } from '../../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';
import { createBrowserWorkspaceServer, resolveBrowserWorkspaceEntry } from '../../packages/agentkit-harness/src/native/browser-workspace-server.mjs';
import { browserCanvasMetrics } from '../../packages/agentkit-harness/src/native/browser-canvas-metrics.mjs';
import { isInside, publishWorkspaceBytes, realpathExisting } from '../../packages/agentkit-harness/src/native/workspace-paths.mjs';
import { commandStateRoot, DshNodeCommandLedger } from './dsh-node-command-ledger.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_BROWSER_CONTRACT = 'agentkit.dsh-node-browser/v1';
export function dshBrowserDefinition() {
  const parameters = browserInspectParameters({ maxActions: 50 });
  // The Python legacy tool defaults omitted click/fill selectors to body.
  for (const action of parameters.properties.actions.items.oneOf) {
    delete action.properties.element_ref;
    delete action.not;
    if (['click', 'fill'].includes(action.properties.type.const)) delete action.oneOf;
  }
  return { name: 'browser_inspect_workspace', description: 'Inspect a local workspace HTML page in an isolated browser; bounded actions and screenshot evidence.',
    parameters, readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 110000 };
}
const rejected = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
function abortable(work, signal, late) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(signal.reason); } };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(value => {
      if (settled) { Promise.resolve().then(() => late?.(value)).catch(() => {}); return; }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error); } });
    if (signal.aborted) abort();
  });
}

export function createDshNodeBrowserTools({ ctx, agentId, agentRevision = 1, buildId = null, workspaceRoot, stateDir,
  browserExecutablePath, launchBrowser, backend = 'local_process', isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && Number.isSafeInteger(agentRevision) && agentRevision > 0
    && (buildId === null || typeof buildId === 'string' && buildId.trim()) && typeof isClosed === 'function'
    && (hostSignal === undefined || hostSignal instanceof AbortSignal)
    && (browserExecutablePath === undefined || isAbsolute(browserExecutablePath))
    && ['local_process', 'e2b'].includes(backend), 'dsh_node_browser_binding_invalid');
  const state = commandStateRoot(join(stateDir, 'browser'), workspaceRoot, agentId), definition = dshBrowserDefinition();
  const binding = Object.freeze({ contract: DSH_NODE_BROWSER_CONTRACT, agentId, agentRevision, buildId, workspace: state.workspace,
    executable: browserExecutablePath ?? null, backend, browser: 'playwright-chromium', network: 'local-workspace-only/v1' });
  const launch = launchBrowser ?? (async () => {
    const { chromium } = await import('playwright-core');
    return chromium.launch({ headless: true, ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}) });
  });
  const lifetime = new AbortController(), lifetimeSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const ledgers = new Map(), active = new Set(), disposing = new Set(), cleanupFailures = new Set(); let closing;
  const dispose = value => {
    // A stalled driver must not block retirement or prevent closing the file
    // server. A deadline reports unknown cleanup, never proves process exit.
    let timer;
    const pending = Promise.race([Promise.resolve().then(() => value.close()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('dsh_node_browser_cleanup_unknown'),
        { code: 'dsh_node_browser_cleanup_unknown' })), 5000);
    })]).finally(() => { clearTimeout(timer); disposing.delete(pending); });
    disposing.add(pending); pending.catch(error => cleanupFailures.add(error)); return pending;
  };
  const open = () => {
    lifetimeSignal.throwIfAborted(); const value = isClosed();
    if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
    invariant(value === false, 'dsh_node_browser_closed'); state.guard(); lifetimeSignal.throwIfAborted();
  };
  const targetFor = input => {
    const target = realpathExisting(resolve(state.workspace, input.screenshotPath));
    invariant(isInside(target, state.workspace), 'screenshot_path_invalid'); return target;
  };
  async function inspect(input, request, guard) {
    let browser, context, page, server, abortCleanup, cleanup;
    const step = async (work, late) => {
      guard(); const result = await abortable(work, request.signal, late);
      try { guard(); return result; } catch (error) {
        // Preserve the original authority/cancellation error even if disposal
        // itself rejects. Never allow a late cleanup rejection to escape.
        try { await late?.(result); } catch {}
        throw error;
      }
    };
    let sent = false;
    const errors = [], pageErrors = [], failures = [], actions = [];
    const log = (rows, value) => { if (rows.length < 20) rows.push(String(value).slice(0, 2000)); };
    const release = () => cleanup ??= (async () => {
      // Closing a Playwright Browser concurrently with its Context can leave
      // the Browser close waiting for its 30s driver timeout after goto abort.
      // Drain the owned Context first, then stop Chromium and the file server.
      // A failed close must not prevent attempting the remaining resources.
      const errors = [];
      for (const value of [context, browser, server]) if (value) {
        try { await dispose(value); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    })();
    try {
      server = await step(() => createBrowserWorkspaceServer({ root: state.workspace, path: input.path, signal: request.signal }), dispose);
      browser = await step(launch, dispose);
      context = await step(() => browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block', acceptDownloads: false }), dispose);
      abortCleanup = () => { void release().catch(() => {}); };
      request.signal.addEventListener('abort', abortCleanup, { once: true });
      if (request.signal.aborted) abortCleanup();
      invariant(typeof context.routeWebSocket === 'function', 'dsh_node_browser_websocket_policy_unavailable');
      await step(() => context.route('**/*', async route => {
        try {
          guard(); const req = route.request();
          if (req.frame().page() !== page || !server.allows(req.url()) || !['GET', 'HEAD'].includes(req.method())) {
            log(failures, 'browser_network_denied'); await route.abort('blockedbyclient'); return;
          }
          // Never hand Chromium a redirect; fulfilled redirects may bypass
          // route handlers. The private workspace server has no external redirects.
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 }); guard();
          if (response.status() >= 300 && response.status() < 400) { log(failures, 'browser_redirect_denied'); await route.abort('blockedbyclient'); }
          else await route.fulfill({ response });
        } catch { try { await route.abort('blockedbyclient'); } catch {} }
      }));
      await step(() => context.routeWebSocket('**/*', socket => { log(failures, 'browser_websocket_denied'); return socket.close({ code: 1008, reason: 'local_workspace_only' }); }));
      page = await step(() => context.newPage());
      context.on('page', popup => { if (popup !== page) { log(failures, 'browser_popup_denied'); void popup.close().catch(() => {}); } });
      page.on('console', message => { if (message.type() === 'error') log(errors, message.text()); });
      page.on('pageerror', error => log(pageErrors, error.message));
      page.on('requestfailed', () => log(failures, 'browser_request_failed'));
      page.setDefaultTimeout(10000);
      sent = true;
      const response = await step(() => page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
      if (input.waitMs) await step(() => page.waitForTimeout(input.waitMs));
      for (const [index, action] of input.actions.entries()) {
        const locator = () => page.locator(action.selector ?? 'body');
        try {
          if (action.kind === 'click') await step(() => locator().click({ timeout: 10000, delay: action.durationMs ?? 0, button: action.button ?? 'left' }));
          else if (action.kind === 'fill') await step(() => locator().fill(action.value, { timeout: 5000 }));
          else if (action.kind === 'press') await step(() => locator().press(action.key, { timeout: 10000, delay: action.durationMs ?? 0 }));
          else if (action.kind === 'move') await step(() => page.mouse.move(action.x, action.y, { steps: action.steps ?? 1 }));
          else if (action.kind === 'wait') await step(() => page.waitForTimeout(action.ms));
          else if (action.kind === 'scroll') {
            if (action.x != null) await step(() => page.mouse.move(action.x, action.y));
            await step(() => page.mouse.wheel(action.deltaX, action.deltaY));
          } else if (action.kind === 'reload') await step(() => page.reload({ waitUntil: 'domcontentloaded' }));
          else throw Object.assign(new Error('unsupported_browser_action'), { code: 'unsupported_browser_action' });
          actions.push({ index, type: action.kind, ok: true });
        } catch (error) { actions.push({ index, type: action.kind, ok: false, error_type: error.code ?? error.name }); throw error; }
      }
      const screenshot = await step(() => page.screenshot({ type: 'png', fullPage: true, timeout: 5000 }));
      invariant(screenshot.length <= 16 * 1024 * 1024, 'dsh_node_browser_screenshot_limit');
      const body = await step(() => page.locator('body').innerText({ timeout: 5000 }));
      const visualCount = await step(() => page.locator('canvas,svg,img,video').count());
      const appChildCount = await step(() => page.locator('#app > *').count());
      const metrics = await browserCanvasMetrics(page, step); guard();
      const title = await step(() => page.title()), rendered = Boolean(body.trim() || visualCount || appChildCount);
      const content = { ok: Boolean(response?.ok() && rendered && !errors.length && !pageErrors.length && !failures.length),
        entry_path: relative(state.workspace, server.entry).split('\\').join('/'), screenshot_path: input.screenshotPath,
        status_code: response?.status() ?? null, title, rendered, body_text_preview: [...body.trim()].slice(0, 2000).join(''),
        visual_element_count: visualCount, canvas_metrics: metrics,
        visual_warnings: metrics.filter(row => row.viewport_coverage >= .2 && row.visually_uniform).map(() => 'large canvas appears visually uniform after requested actions'),
        app_child_count: appChildCount, console_errors: errors, page_errors: pageErrors, request_failures: failures, actions_ok: true, actions };
      await release(); guard(); const target = targetFor(input); guard(); publishWorkspaceBytes(target, screenshot); guard();
      return { status: 'ok', content };
    } catch (error) {
      return sent || request.signal.aborted ? { status: 'uncertain', content: { ok: false, error_type: 'dsh_node_browser_outcome_unknown',
        evidence_incomplete: true, actions, instruction: 'Inspect the original call; never automatically replay browser actions.' } }
        : rejected(/^dsh_node_browser_/.test(error.code ?? '') ? error.code : 'browser_runtime_unavailable');
    } finally {
      request.signal.removeEventListener('abort', abortCleanup);
      try { await release(); } catch { /* original durable receipt remains authoritative */ }
    }
  }
  return { contract: DSH_NODE_BROWSER_CONTRACT, get binding() { return copy(binding); },
    get definitions() { return [copy(definition)]; }, supports: name => name === definition.name,
    close() {
      if (!closing) {
        lifetime.abort(); closing = (async () => {
          await Promise.allSettled([...active]); await Promise.allSettled([...disposing]);
          if (cleanupFailures.size) throw new AggregateError([...cleanupFailures], 'dsh_node_browser_cleanup_unknown');
        })();
      }
      return closing;
    },
    async execute(name, args, exec) {
      let guard;
      try {
        open(); invariant(name === definition.name && exec?.name === name && typeof exec?.agent?.session?.id === 'string'
          && exec.agent.session.id.trim() && typeof exec.callId === 'string' && exec.callId.trim()
          && exec.signal instanceof AbortSignal, 'dsh_node_browser_unbound');
        const invalid = toolInputRejection(definition, { name, callId: exec.callId, arguments: args });
        if (invalid) return { status: 'error', content: invalid };
        if (backend !== 'local_process') return rejected('BROWSER_LOCAL_BACKEND_REQUIRED');
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, args: canonical(args) };
        const request = { agentId, agentRevision, buildId, sessionId: original.sessionId, operationKey: `dsh-browser:${original.callId}`,
          call: { callId: original.callId, name, arguments: copy(args) }, definition: copy(definition),
          signal: AbortSignal.any([original.signal, lifetimeSignal, AbortSignal.timeout(definition.timeoutMs)]) };
        const stable = () => {
          request.signal.throwIfAborted();
          invariant(exec.agent === original.agent && exec.agent.session === original.session && exec.agent.session.id === original.sessionId
            && exec.callId === original.callId && exec.signal === original.signal && exec.name === name
            && canonical(args) === original.args && canonical(exec.arguments) === original.args, 'dsh_node_browser_request_drifted');
        };
        guard = () => { stable(); open(); stable(); return true; }; guard();
        const normalized = { ...copy(args), actions: (args.actions ?? []).map(row => ['click', 'fill'].includes(row.type)
          && row.selector === undefined && row.element_ref === undefined ? { ...row, selector: 'body' } : row) };
        const input = parseWorkspaceBrowserInput(normalized, request.operationKey, { maxActions: 50 });
        invariant(!input.actions.some(row => row.elementRef !== undefined && row.elementRef !== null), 'dsh_node_browser_element_ref_unavailable');
        resolveBrowserWorkspaceEntry(state.workspace, input.path); targetFor(input);
        await abortable(() => authorizeNativeBuiltin(ctx, { ...exec, signal: request.signal }, definition), request.signal); guard();
        if (!ledgers.has(original.sessionId)) ledgers.set(original.sessionId, new DshNodeCommandLedger({ root: state.root,
          agentId, sessionId: original.sessionId, assertRoot: state.guard }));
        const pending = ledgers.get(original.sessionId).execute({ request, binding, assertCurrent: guard,
          dispatch: () => inspect(input, request, guard) });
        active.add(pending); try { return await pending; } finally { active.delete(pending); }
      } catch (error) {
        try { guard?.(); } catch (live) { error = live; }
        return rejected(error.code ?? 'dsh_node_browser_rejected');
      }
    },
  };
}
