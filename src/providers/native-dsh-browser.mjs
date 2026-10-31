import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { canonical, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';
import { createStudioBrowserWorkspacePort } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace';
import { NativePlaywrightBrowser } from '@kingsoftcloud/agentkit-harness-node/native/browser-playwright';
import { studioBrowserDefinition } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace-protocol';
import { resolveNativeBrowserExecutable } from '@kingsoftcloud/agentkit-harness-node/native/browser-availability';
import { workspaceBrowserCapability } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace-policy';

/** Preset-owned resources; session and ledger scope, never model arguments, select the owner. */
export function createNativeDshBrowserTools({ workspaceRoot, createBrowser, browserExecutablePath, evidenceRoot,
  environment = process.env, createOwner = createStudioBrowserWorkspacePort, toolTimeoutForSession = () => 110000 } = {}) {
  const workspace = resolve(workspaceRoot), pinnedRoot = realpathSync(workspace);
  invariant(browserExecutablePath === undefined || typeof browserExecutablePath === 'string'
    && isAbsolute(browserExecutablePath), 'studio_native_browser_executable_invalid');
  const executablePath = browserExecutablePath ?? resolveNativeBrowserExecutable({ env: environment });
  const available = createOwner !== createStudioBrowserWorkspacePort || typeof createBrowser === 'function'
    || !!(executablePath && resolveNativeBrowserExecutable({
    env: { KSADK_BROWSER_EXECUTABLE_PATH: executablePath } }));
  const backend = createBrowser ?? (options => new NativePlaywrightBrowser({ ...options, launchBrowser: async () => {
    invariant(executablePath, 'studio_native_browser_unavailable');
    const { chromium } = await import('playwright-core');
    return chromium.launch({ headless: true, executablePath });
  } }));
  const owners = new Map(), lifetime = new AbortController();
  let closed = false, closing;
  const identity = (sessionId, scope, toolTimeoutMs = toolTimeoutForSession(sessionId)) => {
    invariant(typeof sessionId === 'string' && sessionId.length > 0, 'studio_native_tool_agent_missing');
    scopeKey(scope);
    return `studio-browser-${createHash('sha256').update(canonical({
      schema: 'agentkit.studio-browser-owner/v1', root: pinnedRoot, sessionId, scope,
      ...(toolTimeoutMs !== 110000 ? { toolTimeoutMs } : {}),
    })).digest('hex')}`;
  };
  const owner = (sessionId, scope, toolTimeoutMs = toolTimeoutForSession(sessionId)) => {
    invariant(!closed, 'studio_native_browser_closed');
    invariant(realpathSync(workspace) === pinnedRoot, 'workspace_root_changed');
    const runtimeId = identity(sessionId, scope, toolTimeoutMs);
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
    get capability() { return workspaceBrowserCapability({ available }); },
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
        if (method === 'execute' && !available) return { status: 'error', content: {
          code: 'browser_backend_unavailable', executed: false, capability: workspaceBrowserCapability({ available: false }) } };
        const record = owner(sessionId, request.scope, method === 'retireResources' ? request.definition?.timeoutMs : undefined);
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
        recoverSessions: request => invoke(request, 'recoverSessions'), verifyPage: request => invoke(request, 'verifyPage'),
        retireResources: request => invoke(request, 'retireResources') };
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
