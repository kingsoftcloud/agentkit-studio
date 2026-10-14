/** Credential values stay inside the Host and are never echoed in results. */
export function createCredentialRoute({ credentialsService }) {
  return async payload => {
      const name = String(payload?.name || '').trim();
      const value = String(payload?.value || '');
      if (!/^[A-Za-z_][A-Za-z0-9_./:-]{0,127}$/.test(name)) return { ok: false, error: { code: 'CREDENTIAL_NAME_INVALID', message: '凭证名称无效', details: {} } };
      if (!value) return { ok: false, error: { code: 'CREDENTIAL_VALUE_MISSING', message: '凭证值不能为空', details: {} } };
      try {
        await credentialsService.set(name, value);
      } catch (error) {
        // Process-injected credentials are intentionally read-only in DSH.
        // The browser may still submit the same name when the value was
        // supplied through the Host environment; acknowledge that existing
        // effective credential without persisting or echoing its value.
        const current = typeof credentialsService.describe === 'function'
          ? await credentialsService.describe(name).catch(() => null)
          : null;
        const effective = current?.configured && current.source === 'env' ? await credentialsService.resolve(name).catch(() => null) : null;
        if (effective?.value !== value) throw error;
        return { ok: true, value: { name, configured: true, source: 'env', persistence: 'process-environment' } };
      }
      return { ok: true, value: { name, configured: true, persistence: 'managed-store' } };
  };
}
