import { canonicalEngineWorkspace } from './engine-service-workspaces.mjs';
import { dshBrowserDefinition } from './dsh-node-browser-tools.mjs';

/** Presets share schemas. Workspace tools and their receipts belong to the
 * workspace in the actual tool call's Session header. */
export function createWorkspaceRoutedBuiltins({ create, defaultRoot, resolveHarnessWorkspace, applicationPreviewAvailable }) {
  const catalog = create(defaultRoot);
  const instances = new Map([[canonicalEngineWorkspace(defaultRoot), catalog]]);
  let closing;
  const bindings = cwd => {
    if (closing) throw Object.assign(new Error('工作区工具已关闭。'), { code: 'NATIVE_ENGINE_TOOLS_CLOSED' });
    const root = resolveHarnessWorkspace ? resolveHarnessWorkspace(cwd)?.workspaceRoot : canonicalEngineWorkspace(cwd);
    if (!root) throw Object.assign(new Error('工具会话没有绑定独立 Harness 工作区。'), { code: 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE' });
    if (!instances.has(root)) instances.set(root, create(root));
    return instances.get(root);
  };
  return {
    get definitions() {
      return catalog.definitions.map(definition => definition.name === 'browser_inspect_workspace' && applicationPreviewAvailable
        ? dshBrowserDefinition({ applicationPreview: true }) : definition);
    },
    supports: name => catalog.supports(name),
    execute: (name, args, exec) => bindings(exec?.agent?.session?.header?.cwd ?? null).execute(name, args, exec),
    observeA2aReceipt: (request, cwd) => bindings(cwd).observeA2aReceipt(request),
    a2aTaskHistory: (request, guard, cwd) => bindings(cwd).a2aTaskHistory(request, guard),
    controlA2aTask: (request, authority, cwd) => bindings(cwd).controlA2aTask(request, authority),
    close() {
      return closing ??= Promise.resolve().then(async () => {
        const results = await Promise.allSettled([...instances.values()].map(instance => instance.close()));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      });
    },
  };
}
