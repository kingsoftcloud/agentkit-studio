/** Lazy SDK adapters. No package manager or child process starts at construction. */
export function createIntegrationServices(ctx) {
  return {
    getDshPlugins: async () => import('../../studio-plugins.mjs').then(({ createStudioPlugins }) =>
      createStudioPlugins({ getService: name => ctx.get(name) })),
    getCodexPlugins: async () => import('../../studio-codex-plugins.mjs').then(({ createStudioCodexPlugins }) =>
      createStudioCodexPlugins({})),
    getSessionLogExporter: async () => import('@deepseek-ai/dsh-session-log-export'),
  };
}
