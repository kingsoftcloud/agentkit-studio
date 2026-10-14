/** Frozen Build and operation routes; the Host owns admission and cancellation. */
export function createBuildRoutes({ studioBuildPromise, agentStorePromise, serverClientPromise, portableBundles }) {
  return async (endpoint, payload, signal) => {
    const serverClient = await serverClientPromise;
    if (endpoint === 'builds/create' || endpoint === 'builds/list' || endpoint === 'builds/download' || endpoint === 'builds/export-portable' || endpoint === 'operations/list' || endpoint === 'operations/cancel') {
      const studio = await studioBuildPromise;
      try {
        if (endpoint === 'builds/create') {
          const { submitAgentBuild } = await import('../../build-operation.mjs');
          return { ok: true, value: await submitAgentBuild({ payload, localStore: await agentStorePromise, serverClient, ...studio, signal }) };
        }
        if (endpoint === 'builds/list') {
          const agentId = String(payload?.agentId || '').trim();
          if (!agentId) return { ok: true, value: { items: [] } };
          return { ok: true, value: { items: await studio.build.list(agentId) } };
        }
        if (endpoint === 'builds/export-portable') {
          try { return { ok: true, value: await portableBundles.prepare(String(payload?.agentId || ''), String(payload?.buildId || '')) }; }
          catch (error) { return { ok: false, error: { code: error?.code || 'PORTABLE_EXPORT_FAILED', message: error?.code?.startsWith('PORTABLE_') ? error.message : '运行包导出失败，请检查绑定的资源是否可读取', details: {} } }; }
        }
        if (endpoint === 'builds/download') return { ok: true, value: await studio.build.download(String(payload?.agentId || ''), String(payload?.buildId || '')) };
        if (endpoint === 'operations/list') {
          const items = await studio.operations.list({ resourceId: String(payload?.resourceId || '') || undefined, kind: String(payload?.kind || '') || undefined });
          return { ok: true, value: { items } };
        }
        const operation = await studio.operations.cancel(String(payload?.operationId || ''));
        return { ok: true, value: operation };
      } catch (error) {
        return { ok: false, error: {
          code: error?.code || 'STUDIO_OPERATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
          details: error?.details || {},
        } };
      }
    }
  };
}
