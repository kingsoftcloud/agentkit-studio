const readEnv = (env_, name, fallback = '') => {
  const value = env_?.[name];
  return value == null ? fallback : String(value).trim();
};

/** Resolve the web search provider configuration from the environment.
 *  Mirrors ksadk.toolsets.web: _web_search_provider, _web_search_http,
 *  _web_search_ksyun, _ksyun_search_api_key, _ksyun_search_scope. */
export function resolveWebSearchConfig(env_ = process.env) {
  const provider = (readEnv(env_, 'KSADK_WEB_SEARCH_PROVIDER') || readEnv(env_, 'OPENCLAW_WEB_SEARCH_PROVIDER')).toLowerCase();
  if (!provider) return { provider: '' };
  const baseUrl = readEnv(env_, 'KSADK_WEB_SEARCH_BASE_URL') || readEnv(env_, 'OPENCLAW_WEB_SEARCH_BASE_URL');
  if (provider === 'ksyun') {
    const apiKey = ['KSADK_WEB_SEARCH_API_KEY', 'OPENCLAW_WEB_SEARCH_API_KEY', 'KSADK_MCP_KEY', 'KSC_AIPRO_API_KEY', 'KSC_AIPRO_APIKEY', 'AIPRO_API_KEY']
      .map(name => readEnv(env_, name)).find(Boolean) || '';
    return { provider, baseUrl, apiKey, scope: readEnv(env_, 'KSADK_WEB_SEARCH_SCOPE') || 'webpage' };
  }
  if (provider === 'http') {
    const apiKey = readEnv(env_, 'KSADK_WEB_SEARCH_API_KEY') || readEnv(env_, 'OPENCLAW_WEB_SEARCH_API_KEY');
    return { provider, baseUrl, apiKey };
  }
  return { provider }; // 'fake' or unsupported — no credential needed
}

/** Resolve the SSRF policy from the environment JSON, matching _ssrf_policy. */
export function resolveWebSsrfPolicy(env_ = process.env) {
  const raw = readEnv(env_, 'KSADK_WEB_SSRF_POLICY_JSON') || readEnv(env_, 'OPENCLAW_BROWSER_SSRF_POLICY_JSON');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
