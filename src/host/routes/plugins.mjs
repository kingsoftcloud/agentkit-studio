/** plugins operations; authentication and lifetime belong to the dispatcher. */
export function createPluginRoutes({ getDshPlugins, getCodexPlugins }) {
    return async (endpoint, payload, signal) => {
        if (endpoint.startsWith('plugins/')) {
            try {
                const plugins = await getDshPlugins();
                if (endpoint === 'plugins/dsh-list')
                    return { ok: true, value: await plugins.listDsh() };
                if (endpoint === 'plugins/dsh-discover')
                    return { ok: true, value: await plugins.discoverDsh({ force: payload?.force === true }) };
                if (endpoint === 'plugins/dsh-index-refresh')
                    return { ok: true, value: await plugins.refreshDshCatalog() };
                if (endpoint === 'plugins/dsh-install')
                    return { ok: true, value: await plugins.installDsh(payload?.source, payload?.acceptHostPermissions === true) };
                if (endpoint === 'plugins/dsh-remove')
                    return { ok: true, value: await plugins.uninstallDsh(payload?.pluginName) };
                if (endpoint === 'plugins/dsh-enable' || endpoint === 'plugins/dsh-disable') {
                    const plugins = await getDshPlugins();
                    return { ok: true, value: await plugins.setDshEnabled(payload?.pluginName, endpoint === 'plugins/dsh-enable') };
                }
                if (endpoint === 'plugins/dsh-update') {
                    const plugins = await getDshPlugins();
                    return { ok: true, value: await plugins.updateDsh(payload?.pluginName) };
                }
                if (endpoint === 'plugins/codex-install' || endpoint === 'plugins/codex-remove') {
                    const codex = await getCodexPlugins();
                    const result = endpoint === 'plugins/codex-install'
                        ? await codex.installCodex(payload?.pluginId, payload?.marketplaceName)
                        : await codex.uninstallCodex(payload?.pluginId, payload?.marketplaceName);
                    return { ok: true, value: result };
                }
                if (endpoint === 'plugins/codex-list' || endpoint === 'plugins/codex-inspect')
                    return { ok: true, value: await getCodexPlugins().then(codex => endpoint === 'plugins/codex-inspect' ? codex.inspectCodex(payload?.pluginId) : codex.listCodex()) };
            }
            catch (error) {
                return { ok: false, error: { code: error?.code || 'PLUGIN_ECOSYSTEM_FAILED', message: error instanceof Error ? error.message : String(error), details: error?.details || {} } };
            }
        }
    };
}
