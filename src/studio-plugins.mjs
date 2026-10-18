/** DSH plugin ecosystem adapter for the Studio plugin Node host (0.2.1-rc.2).
 *
 * DSH 0.2.1-rc.2 ships a first-class plugin manager service
 * (`PluginManager`, `PluginInventoryGateway`) inside the host process. The
 * plugin Node half shares that context, so this adapter calls the services
 * directly — no profile file reads, no CLI forwarding.
 */
import { dshCuratedEntries, dshCuratedPlugin } from './dsh-plugin-catalog.mjs';
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

function rowIsActive(row) {
  return row?.fiberPhase === 'active';
}

function rowKey(row) {
  return String(row?.rowId || '').trim();
}

async function serviceReadiness(getService, requirement) {
  if (!requirement) return { state: 'not-configured', checks: [], note: '未配置能力验证清单。' };
  let target;
  try { target = getService?.(requirement.name); } catch (error) {
    return { state: 'failed', checks: [], note: `Host 服务 ${requirement.name} 不可用：${error?.message || '读取失败'}` };
  }
  if (!target) return { state: 'failed', checks: [], note: `Host 服务 ${requirement.name} 不可用。` };
  const checks = requirement.methods.map(method => ({ method, ok: typeof target[method] === 'function' }));
  const missing = checks.filter(item => !item.ok).map(item => item.method);
  if (missing.length) return { state: 'failed', checks, note: `Host 服务 ${requirement.name} 缺少能力：${missing.join('、')}` };
  if (requirement.probe) {
    try {
      const value = await target[requirement.probe]();
      checks.push({ method: `${requirement.probe}()`, ok: value !== undefined && value !== null, observed: Array.isArray(value) ? `${value.length} 项` : 'snapshot returned' });
      if (value === undefined || value === null) return { state: 'failed', checks, note: `Host 服务 ${requirement.name} 的 ${requirement.probe}() 没有返回结果。` };
    } catch (error) {
      checks.push({ method: `${requirement.probe}()`, ok: false });
      return { state: 'failed', checks, note: `Host 服务 ${requirement.name} 的 ${requirement.probe}() 失败：${error?.message || '调用失败'}` };
    }
  }
  return { state: 'ready', checks, note: 'Host 服务能力检查通过。' };
}

async function verifyItem(item, getService) {
  const curated = dshCuratedPlugin(item.pluginId);
  if (!curated) return { state: 'loaded', checks: [], note: 'Host 已加载声明的插件行；该插件没有 Studio 能力 smoke 清单。' };
  if (!item.installed) return { state: 'not-installed', checks: [], note: '插件尚未安装。' };
  if (item.enabled === false) return { state: 'disabled', checks: [], note: '插件已安装但未启用。' };
  if (item.error) return { state: 'failed', checks: [], note: `Host 报告加载错误：${item.error.diagnostic || item.error.code || 'unknown'}` };
  const rows = Array.isArray(item.rows) ? item.rows : [];
  const rowChecks = curated.expectedEntries.map(expected => {
    const row = rows.find(candidate => rowKey(candidate) === expected || rowKey(candidate).endsWith(`#${expected}`) || rowKey(candidate).endsWith(`:${expected}`));
    return { entry: expected, ok: Boolean(row && rowIsActive(row)), phase: row?.fiberPhase || 'missing' };
  });
  const missing = rowChecks.filter(check => !check.ok).map(check => check.entry);
  if (missing.length) return { state: 'failed', checks: rowChecks, note: `Host 尚未加载能力行：${missing.join('、')}` };
  const service = await serviceReadiness(getService, curated.service);
  if (service.state !== 'ready') return { state: 'failed', checks: [...rowChecks, ...service.checks], note: service.note };
  return { state: 'ready', checks: [...rowChecks, ...service.checks], note: curated.readinessNote };
}

/** Resolve a host service by name from the plugin root context. */
export function createStudioPlugins({ getService } = {}) {
  function service(name) {
    const instance = getService?.(name);
    if (!instance) throw new StudioPluginsError('SERVICE_UNAVAILABLE', `宿主服务 ${name} 不可用（需要 DSH 0.2.1-rc.2）`, { service: name });
    return instance;
  }

  async function readDshItems(manager) {
    // The market lists product bundles (profile manifest selections) —
    // installable, enable/disable-able via setBundleEnabled. The ~200 Loader
    // plugin rows belong to DSH settings' plugin manager page, not a store.
    const bundles = await manager.listBundles();
    const entries = typeof manager.listPlugins === 'function' ? await manager.listPlugins() : [];
    const byId = new Map(entries.map(entry => [entry.entryId, entry]));
    const items = await Promise.all((bundles || []).map(async bundle => {
      const curated = dshCuratedPlugin(bundle.name);
      const rows = (bundle.rows || []).map(row => ({ ...row, ...(byId.get(row.entryId) || {}) }));
      const activeRows = rows.filter(rowIsActive);
      const failed = rows.some(row => row.fiberPhase === 'failed');
      const error = bundle.error || (failed ? { code: 'plugin-load-failed' } : undefined);
      const item = {
        pluginId: String(bundle.name),
        name: String(bundle.name),
        displayName: String(bundle.meta?.displayName || curated?.displayName || bundle.name),
        description: String(bundle.description || curated?.description || ''),
        version: String(bundle.version || ''),
        source: bundle.installed ? 'profile' : bundle.availability === 'installation' ? 'bundled' : 'catalog',
        enabled: bundle.enabled !== false,
        kind: 'dsh',
        availability: bundle.availability,
        installTarget: bundle.installTarget,
        installed: bundle.installed || bundle.availability !== 'missing',
        optional: bundle.optional === true,
        removable: bundle.removable === true,
        readOnlyReason: bundle.readOnlyReason || (bundle.availability === 'installation' && !bundle.installed && !bundle.optional ? 'host-component' : ''),
        ...(error ? { error } : {}),
        rows,
        status: error ? 'error' : bundle.availability === 'missing' && !bundle.installed ? 'available' : !bundle.enabled ? 'disabled'
          : activeRows.length === rows.length && rows.length ? 'active' : activeRows.length ? 'partial' : 'selected',
      };
      return { ...item, ...(curated ? { ...curated, pluginId: item.pluginId, name: item.name, version: item.version, source: item.source, enabled: item.enabled, installed: item.installed, optional: item.optional, removable: item.removable, readOnlyReason: item.readOnlyReason, rows: item.rows, status: item.status, verification: await verifyItem(item, getService) } : {}) };
    }));
    const known = new Set(items.map(item => item.pluginId));
    for (const curated of dshCuratedEntries()) {
      if (known.has(curated.id)) continue;
      items.push({ ...curated, pluginId: curated.id, name: curated.id, version: '', source: 'catalog', installed: false, enabled: false, optional: true, removable: false, status: 'available', verification: { state: 'not-installed', checks: [], note: '插件尚未安装。' } });
    }
    items.sort((left, right) => (right.featured === true) - (left.featured === true) || String(left.displayName || left.pluginId).localeCompare(String(right.displayName || right.pluginId)));
    return { items, source: 'plugin-manager' };
  }

  async function listDsh() {
    const manager = service('pluginManager');
    return readDshItems(manager);
  }

  async function verifyUsable(manager, name, change) {
    if (change.application === 'restart-required') return { state: 'pending-restart', checks: [], note: '配置已保存，需要重启 Host 后才能验证插件能力。' };
    const catalog = await readDshItems(manager);
    const item = catalog.items.find(row => row.pluginId === String(name));
    if (!item) throw new StudioPluginsError('DSH_PLUGIN_NOT_FOUND_AFTER_CHANGE', '插件变更后 Host 清单中找不到该插件。', { pluginName: String(name), change });
    const verification = item.verification || { state: 'loaded', checks: [], note: 'Host 已加载插件。' };
    if (verification.state === 'failed') throw new StudioPluginsError('DSH_PLUGIN_NOT_USABLE', `插件已安装但能力验证失败：${verification.note}`, { pluginName: String(name), change, verification });
    return verification;
  }

  async function installDsh(spec) {
    const manager = service('pluginManager');
    const existing = (await manager.listBundles()).find(bundle => bundle.name === String(spec));
    if (existing) {
      const change = changeResult(existing.availability === 'missing' && existing.installTarget
        ? await manager.installBundle(existing.installTarget.spec, { enabled: true, saveExact: true })
        : await manager.setBundleEnabled(existing.name, true));
      const verification = await verifyUsable(manager, existing.name, change);
      return { ...change, verification, note: verification.note };
    }
    const inspection = await manager.inspect(String(spec), {});
    if (inspection?.status !== 'accepted') throw new StudioPluginsError('DSH_PLUGIN_INSPECTION_REFUSED', `插件源检查失败：${inspection?.reason || inspection?.problem || '未返回检查结果'}`, inspection || {});
    const change = changeResult(await manager.installBundle(String(spec), { enabled: true, ...(inspection.registry !== undefined ? { registry: inspection.registry } : {}) }));
    const verification = await verifyUsable(manager, String(inspection.name || spec).trim(), change);
    return { ...change, verification, note: verification.note };
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
    const result = changeResult(change);
    const verification = enabled ? await verifyUsable(manager, String(target), result) : { state: 'disabled', checks: [], note: '插件已停用。' };
    return { pluginName: String(target), enabled: Boolean(enabled), ...result, verification, note: verification.note };
  }

  async function updateDsh(name) {
    const manager = service('pluginManager');
    const current = (await manager.listBundles()).find(bundle => bundle.name === String(name));
    if (!current) throw new StudioPluginsError('DSH_PLUGIN_NOT_FOUND', '待更新的插件不存在');
    const change = changeResult(await manager.installBundle(current.installTarget?.spec || `${name}@latest`, { enabled: current.enabled !== false, ...(current.installTarget ? { saveExact: true } : {}) }));
    const verification = current.enabled !== false ? await verifyUsable(manager, name, change) : { state: 'disabled', checks: [], note: '插件已更新但保持停用。' };
    return { ...change, verification, note: verification.note };
  }

  return { listDsh, installDsh, uninstallDsh, setDshEnabled, updateDsh };
}
