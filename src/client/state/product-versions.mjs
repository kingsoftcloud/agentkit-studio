import dshPin from '../../../dsh-pin.json' with { type: 'json' };
export function readProductVersions(bootstrap = {}) {
  return {
    STUDIO_VERSION: String(bootstrap?.version || 'Web 模式'),
    STUDIO_PLUGIN_VERSION: String(bootstrap?.pluginVersion || '未提供'),
    DSH_VERSION: String(bootstrap?.dshVersion || dshPin.version),
  };
}
