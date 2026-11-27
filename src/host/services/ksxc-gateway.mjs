const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_MS = 10_000;

export function createKsxcGatewayStatus({ companyConfig, fetchImpl = fetch, now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS, cacheMs = DEFAULT_CACHE_MS }) {
  const endpoint = new URL('/cli/models', companyConfig.baseUrl);
  let cached;
  let pending;

  async function probe() {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'HEAD',
        headers: { 'X-KSC-COMPANY-CODE': companyConfig.code },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Authentication and routing statuses still prove that the gateway is
      // reachable. No account token or inference request is used for this check.
      if (response.body) await response.body.cancel().catch(() => {});
      return { reachable: true, checkedAt: now() };
    } catch {
      return { reachable: false, checkedAt: now() };
    }
  }

  return {
    async status({ refresh = false } = {}) {
      if (!refresh && cached && now() - cached.checkedAt < cacheMs) return cached;
      if (!pending) {
        pending = probe().then(value => { cached = value; return value; })
          .finally(() => { pending = null; });
      }
      return pending;
    },
  };
}
