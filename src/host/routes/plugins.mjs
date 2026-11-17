/** plugins operations; authentication and lifetime belong to the dispatcher.
 *
 * DSH owns the DSH plugin market (its official 已安装 / 发现 tabs read the plugin
 * index), so Studio only contributes the independent Codex ecosystem here.
 */
export function createPluginRoutes({ getCodexPlugins }) {
    return async (endpoint, payload) => {
        if (endpoint.startsWith('plugins/')) {
            try {
                if (endpoint === 'plugins/codex-install' || endpoint === 'plugins/codex-remove') {
                    const codex = await getCodexPlugins();
                    const result = endpoint === 'plugins/codex-install'
                        ? await codex.installCodex(payload?.pluginId, payload?.marketplaceName)
                        : await codex.uninstallCodex(payload?.pluginId, payload?.marketplaceName);
                    return { ok: true, value: result };
                }
                if (endpoint === 'plugins/codex-list' || endpoint === 'plugins/codex-inspect') {
                    const codex = await getCodexPlugins();
                    const value = endpoint === 'plugins/codex-inspect' ? codex.inspectCodex(payload?.pluginId) : codex.listCodex();
                    return { ok: true, value: await value };
                }
            }
            catch (error) {
                return { ok: false, error: { code: error?.code || 'PLUGIN_ECOSYSTEM_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
            }
        }
    };
}
