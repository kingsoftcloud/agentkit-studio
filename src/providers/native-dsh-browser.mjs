import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonical, invariant, scopeKey } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createStudioBrowserWorkspacePort } from '../../packages/agentkit-harness/src/native/browser-workspace.mjs';
import { NativePlaywrightBrowser } from '../../packages/agentkit-harness/src/native/browser-playwright.mjs';
import { studioBrowserDefinition } from '../../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';

/** Preset-owned resources; session and ledger scope, never model arguments, select the owner. */
export function createNativeDshBrowserTools({ workspaceRoot, createBrowser, browserExecutablePath,
  createOwner = createStudioBrowserWorkspacePort } = {}) {
  const workspace = resolve(workspaceRoot), pinnedRoot = realpathSync(workspace);
  invariant(browserExecutablePath === undefined || typeof browserExecutablePath === 'string'
    && isAbsolute(browserExecutablePath), 'studio_native_browser_executable_invalid');
  const backend = createBrowser ?? (options => new NativePlaywrightBrowser({ ...options, launchBrowser: async () => {
    const { chromium } = await import('playwright-core');
    return chromium.launch({ headless: true, ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}) });
  } }));
  const owners = new Map(), lifetime = new AbortController();
  let closed = false, closing;
  const owner = (sessionId, scope) => {
    invariant(!closed, 'studio_native_browser_closed');
    invariant(realpathSync(workspace) === pinnedRoot, 'workspace_root_changed');
    scopeKey(scope);
    const runtimeId = `studio-browser-${createHash('sha256').update(canonical({
      schema: 'agentkit.studio-browser-owner/v1', root: pinnedRoot, sessionId, scope,
    })).digest('hex')}`;
    if (!owners.has(runtimeId)) {
      const pending = Promise.resolve().then(() => {
        invariant(!closed, 'studio_native_browser_closed');
        return createOwner({ scope: structuredClone(scope), root: workspace, runtimeId,
          reobserveAfterLoss: true, createBrowser: backend });
      });
      owners.set(runtimeId, pending);
      void pending.catch(() => { if (owners.get(runtimeId) === pending) owners.delete(runtimeId); });
    }
    return owners.get(runtimeId);
  };
  return {
    definition: studioBrowserDefinition(),
    forSession(sessionId) {
      invariant(typeof sessionId === 'string' && sessionId.length > 0, 'studio_native_tool_agent_missing');
      const invoke = async (request, method) => {
        invariant(!closed, 'studio_native_browser_closed');
        invariant(request.sessionId === sessionId, 'studio_native_tool_not_bound');
        const signal = AbortSignal.any([request.signal, lifetime.signal]);
        signal.throwIfAborted();
        const port = await owner(sessionId, request.scope);
        signal.throwIfAborted();
        return port[method]({ ...request, signal });
      };
      return { execute: request => invoke(request, 'execute'),
        recoverSessions: request => invoke(request, 'recoverSessions') };
    },
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(new Error('Studio Native browser scope closed'));
      return closing = (async () => {
        const results = await Promise.allSettled([...owners.values()].map(pending => pending.then(port => port.close(), () => {})));
        owners.clear();
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
    },
  };
}
