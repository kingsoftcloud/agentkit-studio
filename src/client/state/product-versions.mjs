export function readProductVersions(bootstrap = {}) {
  return {
    STUDIO_VERSION: String(bootstrap?.version || 'Web 模式'),
    STUDIO_PLUGIN_VERSION: String(bootstrap?.pluginVersion || '未提供'),
    DSH_VERSION: String(bootstrap?.dshVersion || '0.2.1-rc.2'),
  };
}
