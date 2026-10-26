import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { canonical, invariant, scopeKey } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createStudioBrowserWorkspacePort } from '../../packages/agentkit-harness/src/native/browser-workspace.mjs';
import { NativePlaywrightBrowser } from '../../packages/agentkit-harness/src/native/browser-playwright.mjs';
import { studioBrowserDefinition } from '../../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';

/** Preset-owned resources; session and ledger scope, never model arguments, select the owner. */
export function createNativeDshBrowserTools({ workspaceRoot, createBrowser, browserExecutablePath, evidenceRoot,
  createOwner = createStudioBrowserWorkspacePort, toolTimeoutForSession = () => 110000 } = {}) {
  const workspace = resolve(workspaceRoot), pinnedRoot = realpathSync(workspace);
  invariant(browserExecutablePath === undefined || typeof browserExecutablePath === 'string'
    && isAbsolute(browserExecutablePath), 'studio_native_browser_executable_invalid');
  const backend = createBrowser ?? (options => new NativePlaywrightBrowser({ ...options, launchBrowser: async () => {
    const { chromium } = await import('playwright-core');
    return chromium.launch({ headless: true, ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}) });
  } }));
  const owners = new Map(), lifetime = new AbortController();
  let closed = false, closing;
  const identity = (sessionId, scope) => {
    invariant(typeof sessionId === 'string' && sessionId.length > 0, 'studio_native_tool_agent_missing');
    scopeKey(scope);
    return `studio-browser-${createHash('sha256').update(canonical({
      schema: 'agentkit.studio-browser-owner/v1', root: pinnedRoot, sessionId, scope,
      ...(toolTimeoutForSession(sessionId) !== 110000 ? { toolTimeoutMs: toolTimeoutForSession(sessionId) } : {}),
    })).digest('hex')}`;
  };
  const owner = (sessionId, scope) => {
    invariant(!closed, 'studio_native_browser_closed');
    invariant(realpathSync(workspace) === pinnedRoot, 'workspace_root_changed');
    const runtimeId = identity(sessionId, scope);
    const toolTimeoutMs = toolTimeoutForSession(sessionId);
    if (!owners.has(runtimeId)) {
      const record = { lifetime: new AbortController(), active: new Set(), closing: null };
      const pending = Promise.resolve().then(() => {
        invariant(!closed, 'studio_native_browser_closed');
        record.lifetime.signal.throwIfAborted();
        return createOwner({ scope: structuredClone(scope), root: workspace, runtimeId,
          toolTimeoutMs,
          reobserveAfterLoss: true, createBrowser: backend, ...(evidenceRoot ? { evidenceRoot: join(evidenceRoot, runtimeId) } : {}) });
      });
      record.pending = pending;
      owners.set(runtimeId, record);
      void pending.catch(() => { if (owners.get(runtimeId) === record) owners.delete(runtimeId); });
    }
    const record = owners.get(runtimeId);
    invariant(!record.closing, 'studio_native_browser_session_releasing');
    return record;
  };
  const release = (runtimeId, record) => {
    if (record.closing) return record.closing;
    record.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        record.pending.then(port => port.close(), () => {}),
        ...record.active,
      ]);
      // Invocation errors belong to their callers; cleanup failures fence this
      // owner so another activation cannot silently replace leaked resources.
      if (results[0].status === 'rejected') throw results[0].reason;
      if (owners.get(runtimeId) === record) owners.delete(runtimeId);
    });
    record.lifetime.abort(new Error('Studio Native browser session released'));
    return record.closing;
  };
  return {
    definition: studioBrowserDefinition(),
    forSession(sessionId) {
      invariant(typeof sessionId === 'string' && sessionId.length > 0, 'studio_native_tool_agent_missing');
      const invoke = async (request, method) => {
        invariant(!closed, 'studio_native_browser_closed');
        invariant(request.sessionId === sessionId, 'studio_native_tool_not_bound');
        const assertOwned = () => {
          if (request.assertCurrent) invariant(request.assertCurrent() === true, 'studio_native_browser_authority_stale');
        };
        const admission = AbortSignal.any([request.signal, lifetime.signal]);
        admission.throwIfAborted();
        assertOwned();
        const record = owner(sessionId, request.scope);
        const signal = AbortSignal.any([admission, record.lifetime.signal]);
        signal.throwIfAborted();
        const pending = (async () => {
          const port = await record.pending;
          signal.throwIfAborted();
          assertOwned();
          return port[method]({ ...request, signal });
        })();
        record.active.add(pending);
        try { return await pending; } finally { record.active.delete(pending); }
      };
      return { execute: request => invoke(request, 'execute'),
        recoverSessions: request => invoke(request, 'recoverSessions'), verifyPage: request => invoke(request, 'verifyPage') };
    },
    releaseSession({ sessionId, scope }) {
      const runtimeId = identity(sessionId, scope), record = owners.get(runtimeId);
      return record ? release(runtimeId, record) : Promise.resolve();
    },
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(new Error('Studio Native browser scope closed'));
      return closing = (async () => {
        const results = await Promise.allSettled([...owners].map(([runtimeId, record]) => release(runtimeId, record)));
        owners.clear();
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
    },
  };
}
