/** Explicit Skill Service transport. Endpoint and credentials are Host input;
 * tools cannot change either. KOP and legacy REST have separate paging rules. */
import aws4 from 'aws4';
import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

const prefix = 'KSADK_SKILL_SERVICE_';
const official = new Set(['aicp.api.ksyun.com', 'aicp.inner.api.ksyun.com', 'aicp.internal.api.ksyun.com']);
const actions = new Set(['ListSkillSpaces', 'ListSkillsBySpaceId', 'ListAvailablePremadeSkills', 'GetSkillDownloadUrl', 'GetPremadeSkillDownloadUrl']);
const names = ['URL', 'ENDPOINT', 'SCHEME', 'TOKEN', 'ACCESS_KEY', 'SECRET_KEY', 'ACCOUNT_ID', 'REGION', 'API_VERSION', 'SIGN_SERVICE'];
const aliases = ['KSYUN_ACCESS_KEY', 'KSYUN_SECRET_KEY', 'KS3_ACCESS_KEY', 'KS3_SECRET_KEY', 'KSYUN_ACCOUNT_ID',
  'KSYUN_REGION', 'KSYUN_SESSION_TOKEN', 'KSADK_AICP_ENDPOINT_MODE', 'AGENTENGINE_PRE_CONTROL_REGION', 'AGENTENGINE_PRE_CUSTOM_SOURCE'];
const read = (env, key) => {
  const value = env[key] ?? ''; invariant(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'NATIVE_SKILL_ENV_INVALID');
  return value.trim();
};

/** Returns null to retain Studio's existing configured KOP transport, including
 * its internal-account fallback. An explicit Skill override always wins. */
export function nativeSkillConnectionSettings(values, env) {
  const fixed = Object.fromEntries([...names.map(name => prefix + name), ...aliases].map(key => [key, read(env, key)]));
  if (!names.some(name => fixed[prefix + name]) && !aliases.some(key => fixed[key]
    && !(key === 'KSADK_AICP_ENDPOINT_MODE' && ['auto', 'detect'].includes(fixed[key].toLowerCase())))) return null;
  const get = name => fixed[prefix + name];
  const mode = fixed.KSADK_AICP_ENDPOINT_MODE.toLowerCase();
  const byMode = { public: 'aicp.api.ksyun.com', inner: 'aicp.inner.api.ksyun.com', internal: 'aicp.internal.api.ksyun.com' };
  const endpoint = get('ENDPOINT') || byMode[mode];
  const scheme = get('SCHEME') || (endpoint && /^aicp\.(inner|internal)\.api\.ksyun\.com$/u.test(endpoint) ? 'http' : 'https');
  const base = new URL(get('URL') || (endpoint ? `${scheme}://${endpoint}` : values.cloudServerUrl || 'https://aicp.api.ksyun.com'));
  invariant(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
    'NATIVE_SKILL_SERVICE_URL_INVALID');
  base.pathname = base.pathname.replace(/\/+$/u, '').replace(/\/openapi\.json$/u, '').replace(/\/docs$/u, '/api/v1');
  const kop = official.has(base.hostname) && (base.protocol === 'https:' || base.hostname !== 'aicp.api.ksyun.com');
  // An exact official hostname over cleartext cannot become a REST credential
  // destination merely because it failed the KOP TLS requirement.
  invariant(!official.has(base.hostname) || kop, 'NATIVE_SKILL_SERVICE_URL_INVALID');
  const region = get('REGION') || fixed.KSYUN_REGION || values.cloudRegion || 'cn-beijing-6';
  const token = get('TOKEN');
  // Global cloud credentials are used only at exact official KOP endpoints.
  const accessKey = get('ACCESS_KEY') || fixed.KSYUN_ACCESS_KEY || fixed.KS3_ACCESS_KEY || (kop ? values.cloudAccessKey : '') || '';
  const secretKey = get('SECRET_KEY') || fixed.KSYUN_SECRET_KEY || fixed.KS3_SECRET_KEY || (kop ? values.cloudSecretKey : '') || '';
  invariant(Boolean(accessKey) === Boolean(secretKey), 'NATIVE_SKILL_CREDENTIAL_PAIR_REQUIRED');
  invariant(!kop || !token, 'NATIVE_SKILL_KOP_TOKEN_UNSUPPORTED');
  return Object.freeze({ base: base.href.replace(/\/+$/u, ''), protocol: kop ? 'kop' : 'rest', accessKey, secretKey, token,
    sessionToken: fixed.KSYUN_SESSION_TOKEN || (kop ? values.cloudSessionToken : '') || '',
    accountId: get('ACCOUNT_ID') || fixed.KSYUN_ACCOUNT_ID || values.cloudAccountId || '',
    region: region.toLowerCase() === 'pre-online' ? fixed.AGENTENGINE_PRE_CONTROL_REGION || 'cn-beijing-6' : region,
    customSource: region.toLowerCase() === 'pre-online' ? fixed.AGENTENGINE_PRE_CUSTOM_SOURCE || values.cloudCustomSource || 'pre' : '',
    apiVersion: get('API_VERSION') || '2024-06-12', signService: get('SIGN_SERVICE') || 'aicp' });
}

function abortable(signal, operation) {
  signal.throwIfAborted();
  let stop;
  const aborted = new Promise((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), aborted])
    .finally(() => signal.removeEventListener('abort', stop));
}

export function createExplicitNativeSkillClient(settings, fetchImpl) {
  async function skillAction(action, params = {}, { signal } = {}) {
    invariant(actions.has(action), 'NATIVE_SKILL_ACTION_NOT_ALLOWED');
    const deadline = AbortSignal.timeout(60000), requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const kop = settings.protocol === 'kop';
    const url = new URL(kop ? '/' : `${settings.base}/${action}`, settings.base);
    if (kop) { url.searchParams.set('Action', action); url.searchParams.set('Version', settings.apiVersion); }
    for (const [key, value] of Object.entries(params)) {
      invariant(!['Action', 'Version'].includes(key), 'NATIVE_SKILL_RESERVED_PARAMETER');
      if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (settings.accountId) headers['X-Ksc-Account-Id'] = settings.accountId;
    if (kop) {
      invariant(settings.accessKey && settings.secretKey, 'CLOUD_CREDENTIALS_MISSING');
      Object.assign(headers, { 'X-Action': action, 'X-Version': settings.apiVersion, 'X-Ksc-Region': settings.region, 'X-Ksc-Source': 'agentkit-studio' });
      if (settings.customSource) headers['X-KSC-CUSTOM-SOURCE'] = settings.customSource;
      Object.assign(headers, aws4.sign({ host: url.host, path: url.pathname + url.search, method: 'GET', headers,
        service: settings.signService, region: settings.region }, { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey,
        sessionToken: settings.sessionToken }).headers);
    } else if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    const response = await abortable(requestSignal, () => fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: requestSignal }));
    invariant(response.ok && response.body?.getReader, 'SKILL_SERVICE_HTTP_FAILED');
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    let payload;
    try {
      for (;;) {
        const next = await abortable(requestSignal, () => reader.read());
        if (next.done) break;
        bytes += next.value.byteLength; invariant(bytes <= 8 * 1024 * 1024, 'SKILL_SERVICE_RESPONSE_TOO_LARGE');
        chunks.push(next.value);
      }
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { throw Object.assign(new Error('Skill Service response must be UTF-8 JSON'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' }); }
    } finally {
      // A non-cooperative response cannot extend the request's cancellation.
      Promise.resolve(reader.cancel()).catch(() => {});
    }
    invariant(payload && typeof payload === 'object' && !Array.isArray(payload), 'SKILL_SERVICE_INVALID_RESPONSE');
    const code = payload.Code ?? payload.code;
    invariant(code == null || [0, 200, '0', '200'].includes(code), 'SKILL_SERVICE_FAILED');
    return { data: payload.Data ?? payload.data ?? {}, requestId: String(payload.RequestId ?? payload.request_id ?? '') };
  }
  return Object.freeze({ skillAction, skillProtocol: settings.protocol });
}
