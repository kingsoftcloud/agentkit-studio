/** DSH Session-bound web calls and their Host-owned receipts. */
import { toolInputRejection } from '../contracts/tool-input.mjs';
import { canonical, copy, invariant } from '../contracts/native-values.mjs';
import { redactDiagnosticText } from '../diagnostic-text.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createDshNodeToolOutputStore } from './dsh-node-tool-output-store.mjs';
import { resolveWebSearchConfig, resolveWebSsrfPolicy } from './native-web-configuration.mjs';
import { createSsrfPinnedFetch, isBlockedAddress } from './ssrf-pinned-fetch.mjs';
import { studioWebToolDefinitions, webFetch, webSearch } from './studio-web-transport.mjs';

export const DSH_NODE_WEB_CONTRACT = 'agentkit.dsh-node-web/v1';
export const DSH_WEB_TOOL_NAMES = Object.freeze(studioWebToolDefinitions().map(tool => tool.name));
const failure = code => Object.assign(new Error(code), { code });
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code } });
const discard = response => {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* already released */ }
};

/** Observe late rejection and settle even when the injected transport ignores abort. */
function abortable(promise, signal, onLate) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      reject(failure('dsh_node_web_canceled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      if (finished) { onLate?.(value); return; }
      finished = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}

/** The real DSH registry owns permission/presentation hooks. No Native identity is invented. */
export function createDshNodeWebTools({ agentId, fetchImpl, searchFetch = fetchImpl, publicWebSearch,
  providerConfig = {}, ssrfPolicy = {}, persistOutput, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim(), 'dsh_node_web_agent_id_missing');
  invariant(typeof fetchImpl === 'function' && typeof searchFetch === 'function', 'dsh_node_web_fetch_missing');
  invariant(typeof isClosed === 'function', 'dsh_node_web_is_closed_invalid');
  invariant(hostSignal === undefined || hostSignal instanceof AbortSignal, 'dsh_node_web_host_signal_invalid');
  const definitions = studioWebToolDefinitions(), formal = new Map(definitions.map(item => [item.name, item]));
  // The public copies never alias the private admission schemas.
  const config = { providerConfig: copy(providerConfig), ssrfPolicy: copy(ssrfPolicy) };
  const lifetime = new AbortController();
  const ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const assertOpen = () => {
    if (ownerSignal.aborted) throw failure('dsh_node_web_closed');
    const value = isClosed();
    if (value !== false) {
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
      throw failure(value === true ? 'dsh_node_web_closed' : 'dsh_node_web_is_closed_invalid');
    }
  };
  return {
    contract: DSH_NODE_WEB_CONTRACT,
    get definitions() { return definitions.map(item => copy(item)); },
    supports: name => formal.has(name),
    close() { lifetime.abort(failure('dsh_node_web_closed')); },
    async execute(name, args, exec) {
      const definition = formal.get(name);
      if (!definition) return errorResult('dsh_node_web_unbound');
      let original, body, bound, assertCurrent;
      try {
        assertOpen();
        invariant(exec?.agent?.session && typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.name === name
          && exec.signal instanceof AbortSignal, 'dsh_node_web_exec_unbound');
        const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        body = canonical(args);
        invariant(body === canonical(exec.arguments), 'dsh_node_web_arguments_mismatch');
        original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, name, signal: exec.signal };
        const signal = AbortSignal.any([original.signal, ownerSignal]);
        bound = { agentId, sessionId: original.sessionId,
          call: { callId: original.callId, name, arguments: copy(args) }, definition: copy(definition), signal };
        assertCurrent = () => {
          assertOpen(); signal.throwIfAborted();
          invariant(exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === original.sessionId && exec.callId === original.callId
            && exec.name === original.name && exec.signal === original.signal
            && canonical(args) === body && canonical(exec.arguments) === body, 'dsh_node_web_request_drifted');
        };
        assertCurrent();
        // Guard EVERY network and persistence boundary, including redirects.
        // A late fetch cannot persist output under a changed Session/call.
        const guardedFetch = fetch => async (url, init) => {
          assertCurrent();
          const response = await abortable(fetch(url, init), init.signal, discard);
          try { assertCurrent(); return response; }
          catch (error) { discard(response); throw error; }
        };
        const persist = typeof persistOutput === 'function' ? async (request, text, metadata) => {
          assertCurrent();
          const ref = await abortable(persistOutput(request, text, metadata), signal);
          assertCurrent(); return ref;
        } : undefined;
        const input = bound.call.arguments;
        const operation = name === 'web_fetch'
          ? webFetch({ fetch: guardedFetch(fetchImpl), url: input.url, maxChars: input.max_chars, offset: input.offset_chars,
            find: input.find, timeout: input.timeout, ssrfPolicy: config.ssrfPolicy, signal, persistOutput: persist,
            request: bound, checkCurrent: assertCurrent })
          : publicWebSearch ? publicWebSearch(input.query, input.max_results, signal).then(
            result => ({ ok: true, query: input.query, results: result.sources, provider: 'studio' }),
            error => ({ ok: false, error_type: error?.code ?? 'WebToolError', error_message: 'web search failed' }),
          ) : webSearch({ fetch: guardedFetch(searchFetch), providerConfig: config.providerConfig, query: input.query,
            maxResults: input.max_results, recencyDays: input.recency_days, signal });
        const content = await abortable(operation, signal).catch(() => {
          assertCurrent();
          return { ok: false, error_type: 'WebToolError', error_message: 'web tool failed' };
        });
        assertCurrent();
        if (content.ok) return { status: 'ok', content };
        return { status: 'error', content: { ...content,
          ...(content.url !== undefined ? { url: redactDiagnosticText(content.url, 1024) } : {}),
          error_message: redactDiagnosticText(content.error_message, 1024) } };
      } catch (error) {
        // A drift error inside the shared transport may have been sanitized;
        // recompute the original DSH guard before publishing anything.
        try { assertCurrent?.(); } catch (guardError) { error = guardError; }
        if (ownerSignal.aborted) return errorResult('dsh_node_web_closed');
        if (original?.signal.aborted) return errorResult('dsh_node_web_canceled');
        return errorResult(/^dsh_node_web_/.test(error?.code ?? '') ? error.code : 'dsh_node_web_failed');
      }
    },
  };
}

export function mountDshNodeWebTools({ agentId, stateDir, isClosed, signal, env = process.env, fetchImpl = hostFetch, persistOutput, publicWebSearch }) {
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_node_output_store_invalid');
  const output = persistOutput === undefined ? createDshNodeToolOutputStore({ directory: stateDir, agentId, isClosed, signal,
    toolDefinitions: studioWebToolDefinitions().filter(tool => tool.name === 'web_fetch') }) : null;
  const policy = resolveWebSsrfPolicy(env);
  const allowPrivate = policy.allowPrivate === true || policy.allow_private === true;
  const pinned = createSsrfPinnedFetch({ fetchImpl, ssrfBlockCheck: allowPrivate ? null : isBlockedAddress });
  const port = createDshNodeWebTools({ agentId, isClosed, signal, fetchImpl: pinned.fetch, searchFetch: fetchImpl, publicWebSearch,
    providerConfig: publicWebSearch ? {} : resolveWebSearchConfig(env), ssrfPolicy: { allowPrivate }, persistOutput: persistOutput ?? output?.persistOutput });
  let closing;
  return { ...port, get definitions() { return port.definitions; }, close() {
    port.close();
    output?.close();
    return closing ??= Promise.resolve(pinned.close());
  } };
}
