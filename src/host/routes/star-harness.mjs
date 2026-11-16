export function createStarHarnessRoutes(manager) {
  return async (endpoint, payload, signal) => {
    if (!manager) {
      if (endpoint === 'star-harness/status') return { ok: true, value: { supported: false, canCreate: false } };
      throw Object.assign(new Error('当前 Studio 部署不提供本机 Star Harness 管理。'), { code: 'STAR_HARNESS_UNSUPPORTED' });
    }
    if (endpoint === 'star-harness/status') return { ok: true, value: await manager.status(payload, signal) };
    if (endpoint === 'star-harness/install') await manager.install(payload?.version, signal);
    if (endpoint === 'star-harness/enable') await manager.setEnabled(payload?.enabled, signal);
    if (endpoint === 'star-harness/bind') await manager.bind(payload?.workspace, payload?.profileId, signal);
    if (endpoint === 'star-harness/unbind') await manager.unbind(payload?.workspace, signal);
    return { ok: true, value: await manager.status({}, signal) };
  };
}
