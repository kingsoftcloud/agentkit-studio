/** Display-only projection of the pinned Codex plugin and connector contracts. */
export function codexPluginSelector(pluginId, marketplaceName = '') {
  const value = String(pluginId || '').trim();
  const spec = value.includes('@') ? value : marketplaceName ? `${value}@${String(marketplaceName).trim()}` : value;
  if (!/^[^\s@]+@[^\s@]+$/.test(spec) || spec.startsWith('-')) {
    throw Object.assign(new Error('请使用完整插件标识：插件名@市场名'), { code: 'CODEX_PLUGIN_MARKETPLACE_MISSING' });
  }
  const [name, market] = spec.split('@');
  return { spec, name, market };
}

export function codexAppLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

export function codexAuthApps(values) {
  return Array.isArray(values) ? values.filter(item => typeof item?.id === 'string').map(item => ({
    id: item.id, name: String(item.name || item.id), installUrl: codexAppLink(item.installUrl),
  })) : [];
}

export async function readCodexPluginDetails(request, selector) {
  const catalog = await request('plugin/list', { forceRefetch: false });
  const market = catalog?.marketplaces?.find(item => item.name === selector.market);
  const summary = market?.plugins?.find(item => item.id === selector.spec || item.name === selector.name);
  if (!summary) throw Object.assign(new Error('Codex 目录中找不到该插件，请刷新目录。'), { code: 'CODEX_PLUGIN_NOT_FOUND' });
  const { plugin } = await request('plugin/read', { pluginName: selector.name,
    ...(market.path ? { marketplacePath: market.path } : { remoteMarketplaceName: selector.market }) });
  if (!Array.isArray(plugin?.apps) || !Array.isArray(plugin?.skills) || !Array.isArray(plugin?.mcpServers)) {
    throw Object.assign(new Error('Codex 插件详情格式不受支持，请检查固定 CLI 版本。'), { code: 'CODEX_PLUGIN_DETAILS_INVALID' });
  }
  let installedApps, runtimeError = '';
  if (plugin.apps.length) {
    try {
      const state = await request('app/installed', { forceRefresh: true });
      if (!Array.isArray(state?.apps)) throw new Error('invalid app runtime state');
      installedApps = state.apps;
    } catch { runtimeError = '连接器运行状态读取失败；授权链接仍可打开，刷新后重试。'; }
  }
  return {
    pluginId: selector.spec,
    authPolicy: summary.authPolicy || null,
    skills: plugin.skills.map(item => ({ name: String(item.name || ''), description: String(item.description || ''), enabled: item.enabled === true })),
    mcpServers: plugin.mcpServers.filter(item => typeof item === 'string'),
    apps: codexAuthApps(plugin.apps).map(app => {
      const state = installedApps?.find(item => item.id === app.id);
      return { ...app, state: !installedApps ? 'unknown' : !state ? 'not-loaded' : !state.enabled ? 'disabled' : state.callable ? 'callable' : 'not-callable' };
    }),
    ...(runtimeError ? { runtimeError } : {}),
  };
}
