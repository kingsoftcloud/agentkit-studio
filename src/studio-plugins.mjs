/** DSH plugin ecosystem adapter for the Studio plugin Node host (rc.2+).
 *
 * DSH 0.2.0-rc.2 ships a first-class plugin manager service
 * (`PluginManager`, `PluginInventoryGateway`) inside the host process. The
 * plugin Node half shares that context, so this adapter calls the services
 * directly — no profile file reads, no CLI forwarding.
 */
export class StudioPluginsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioPluginsError';
    this.code = code;
    this.details = details;
  }
}

/** Resolve a host service by name from the plugin root context. */
export function createStudioPlugins({ getService } = {}) {
  function service(name) {
    const instance = getService?.(name);
    if (!instance) throw new StudioPluginsError('SERVICE_UNAVAILABLE', `宿主服务 ${name} 不可用（需要 DSH 0.2.0-rc.2+）`, { service: name });
    return instance;
  }

  async function listDsh() {
    // The market lists product bundles (profile manifest selections) —
    // installable, enable/disable-able via setBundleEnabled. The ~200 Loader
    // plugin rows belong to DSH settings' plugin manager page, not a store.
    const manager = service('pluginManager');
    const bundles = await manager.listBundles().catch(() => []);
    const items = (bundles || []).map(bundle => ({
      pluginId: String(bundle.name),
      name: String(bundle.name),
      displayName: String(bundle.meta?.displayName || bundle.name),
      description: String(bundle.description || ''),
      version: String(bundle.version || ''),
      source: bundle.installed ? 'profile' : 'bundled',
      enabled: bundle.enabled !== false,
      kind: 'dsh',
      installed: bundle.installed !== false,
    }));
    return { items, source: 'plugin-manager' };
  }

  async function installDsh(spec) {
    const manager = service('pluginManager');
    const inspection = await manager.inspect(String(spec), {});
    const change = await manager.installBundle(String(spec), inspection?.options || {});
    const requestId = change?.requestId;
    if (requestId) await manager.waitForInstall(requestId).catch(() => null);
    return { ok: true, output: JSON.stringify(change ?? {}).slice(0, 600) };
  }

  async function uninstallDsh(name) {
    const manager = service('pluginManager');
    const change = await manager.removeBundle(String(name));
    return { ok: true, output: JSON.stringify(change ?? {}).slice(0, 600) };
  }

  async function setDshEnabled(target, enabled) {
    const manager = service('pluginManager');
    // Plugin entries carry colon-joined ids; bundles are plain package names.
    // Try the bundle switch first and fall back to the entry switch.
    try {
      const change = await manager.setBundleEnabled(String(target), Boolean(enabled));
      return { pluginName: String(target), enabled, note: '原生 setBundleEnabled 已执行；Profile 重载后生效', change: JSON.stringify(change ?? {}).slice(0, 300) };
    } catch { /* not a bundle — try the loader entry */ }
    const change = await manager.setPluginEnabled(String(target), Boolean(enabled));
    return { pluginName: String(target), enabled, note: '原生 setPluginEnabled 已执行；Profile 重载后生效', change: JSON.stringify(change ?? {}).slice(0, 300) };
  }

  async function updateDsh(name) {
    return uninstallDsh(name).then(() => installDsh(`${name}@latest`));
  }

  return { listDsh, installDsh, uninstallDsh, setDshEnabled, updateDsh };
}
