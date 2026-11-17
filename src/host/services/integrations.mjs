/** Lazy SDK adapters. No package manager or child process starts at construction. */
export function createIntegrationServices() {
  // The DSH plugin surface is the Host's own plugin manager page: Studio adds no
  // market row, so only the Codex and session-log adapters remain here.
  return {
    getCodexPlugins: async () => import('../../studio-codex-plugins.mjs').then(({ createStudioCodexPlugins }) =>
      createStudioCodexPlugins({})),
    getSessionLogExporter: async () => import('@deepseek-ai/dsh-session-log-export'),
  };
}
