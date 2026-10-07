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

function changeResult(change) {
  if (!change || !['applied', 'restart-required'].includes(change.application) || change.error) {
    const details = change || {};
    const diagnostic = String(change?.error?.diagnostic || '').slice(-1200);
    const code = change?.application === 'cancelled' ? 'DSH_PLUGIN_CANCELLED' : 'DSH_PLUGIN_OPERATION_FAILED';
    throw new StudioPluginsError(code, diagnostic || `插件操作未生效：${change?.error?.code || change?.application || '宿主没有返回结果'}`, details);
  }
  return { ok: true, ...change, note: change.application === 'restart-required' ? '配置已保存，需要重启 Host 后生效。' : 'Host 已应用插件变更。' };
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
    const bundles = await manager.listBundles();
    const entries = typeof manager.listPlugins === 'function' ? await manager.listPlugins() : [];
    const byId = new Map(entries.map(entry => [entry.entryId, entry]));
    const items = (bundles || []).map(bundle => {
      const rows = (bundle.rows || []).map(row => ({ ...row, ...(byId.get(row.entryId) || {}) }));
      const activeRows = rows.filter(row => row.fiberPhase === 'active');
      const failed = rows.some(row => row.fiberPhase === 'failed');
      const error = bundle.error || (failed ? { code: 'plugin-load-failed' } : undefined);
      return {
        pluginId: String(bundle.name),
        name: String(bundle.name),
        displayName: String(bundle.meta?.displayName || bundle.name),
        description: String(bundle.description || ''),
        version: String(bundle.version || ''),
        source: bundle.installed ? 'profile' : 'bundled',
        enabled: bundle.enabled !== false,
        kind: 'dsh',
        // installed=false means supplied by the DSH installation, not absent.
        installed: true,
        optional: bundle.optional === true,
        removable: bundle.removable === true,
        readOnlyReason: bundle.readOnlyReason || (!bundle.installed && !bundle.optional ? 'host-component' : ''),
        ...(error ? { error } : {}),
        rows,
        status: error ? 'error' : !bundle.enabled ? 'disabled'
          : activeRows.length === rows.length && rows.length ? 'active' : activeRows.length ? 'partial' : 'selected',
      };
    });
    return { items, source: 'plugin-manager' };
  }

  async function installDsh(spec) {
    const manager = service('pluginManager');
    const existing = (await manager.listBundles()).find(bundle => bundle.name === String(spec));
    if (existing) return changeResult(await manager.setBundleEnabled(existing.name, true));
    const inspection = await manager.inspect(String(spec), {});
    if (inspection?.status !== 'accepted') throw new StudioPluginsError('DSH_PLUGIN_INSPECTION_REFUSED', `插件源检查失败：${inspection?.reason || inspection?.problem || '未返回检查结果'}`, inspection || {});
    return changeResult(await manager.installBundle(String(spec), { enabled: true, ...(inspection.registry !== undefined ? { registry: inspection.registry } : {}) }));
  }

  async function uninstallDsh(name) {
    const manager = service('pluginManager');
    return changeResult(await manager.removeBundle(String(name)));
  }

  async function setDshEnabled(target, enabled) {
    const manager = service('pluginManager');
    const isBundle = (await manager.listBundles()).some(bundle => bundle.name === String(target));
    const change = await (isBundle
      ? manager.setBundleEnabled(String(target), Boolean(enabled))
      : manager.setPluginEnabled(String(target), Boolean(enabled)));
    return { pluginName: String(target), enabled: Boolean(enabled), ...changeResult(change) };
  }

  async function updateDsh(name) {
    const manager = service('pluginManager');
    const current = (await manager.listBundles()).find(bundle => bundle.name === String(name));
    if (!current) throw new StudioPluginsError('DSH_PLUGIN_NOT_FOUND', '待更新的插件不存在');
    return changeResult(await manager.installBundle(`${name}@latest`, { enabled: current.enabled !== false }));
  }

  return { listDsh, installDsh, uninstallDsh, setDshEnabled, updateDsh };
}
