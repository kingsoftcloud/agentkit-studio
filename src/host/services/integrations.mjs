/** Lazy SDK adapters. No package manager or child process starts at construction. */
export function createIntegrationServices(ctx) {
  // One adapter per Host process: the DSH plugin market keeps its remote
  // catalog cache (ten-minute TTL and last-good fallback) across requests.
  let dshPlugins;
  const getDshPlugins = async () => {
    if (!dshPlugins) {
      dshPlugins = import('../../studio-plugins.mjs').then(({ createStudioPlugins }) =>
        createStudioPlugins({ getService: name => ctx.get(name) }));
    }
    return dshPlugins;
  };
  return {
    getDshPlugins,
    getCodexPlugins: async () => import('../../studio-codex-plugins.mjs').then(({ createStudioCodexPlugins }) =>
      createStudioCodexPlugins({})),
    getSessionLogExporter: async () => import('@deepseek-ai/dsh-session-log-export'),
  };
}
