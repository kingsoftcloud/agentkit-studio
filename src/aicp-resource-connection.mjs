/** Host-only AICP SDK configuration. Tool arguments never select an endpoint.
 * Reference: ksadk/common/aicp_env.py; no Python runtime is used. */
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { canonical, copy, invariant } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createAicpResourceClient } from './server-client.mjs';
import { hostFetch } from './http-fetch.mjs';

const byMode = Object.freeze({ internal: 'aicp.internal.api.ksyun.com', inner: 'aicp.inner.api.ksyun.com', public: 'aicp.api.ksyun.com' });
const autoEndpoints = [byMode.internal, byMode.inner, byMode.public];
const fields = ['cloudAccessKey', 'cloudSecretKey', 'cloudSessionToken', 'cloudRegion', 'cloudAccountId',
  'cloudServerUrl', 'cloudCustomSource', 'cloudServiceToken'];
const read = (env, key) => {
  const value = env[key] ?? '';
  invariant(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'AICP_RESOURCE_ENV_INVALID');
  return value.trim();
};

/** Python probes TCP/80, even for the public candidate whose eventual SDK
 * scheme is HTTPS. This sends no HTTP request or credentials. */
export function probeAicpEndpoint(host, { port = 80, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    let socket, timer, done = false;
    const finish = value => {
      if (done) return; done = true; clearTimeout(timer); socket?.destroy(); resolve(value);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = createConnection({ host, port });
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    } catch { finish(false); }
  });
}

/** Captures all inputs before asynchronous probing. An explicit endpoint wins
 * over mode; Studio's configured transport wins only when no SDK routing
 * override was supplied. With neither, retain Python's auto detection. */
export async function createAicpResourceConnection({ prefix, contract, configuration, env = {}, fetchImpl = hostFetch,
  probe = probeAicpEndpoint, serverUrl = '', sessionToken = '', innerKopUrl = '', innerIamUrl = '' }) {
  invariant(['KSADK_KB', 'KSADK_LTM'].includes(prefix), 'AICP_RESOURCE_PREFIX_INVALID');
  const rawTrafficSource = env.KSADK_TRAFFIC_SOURCE ?? '';
  invariant(typeof rawTrafficSource === 'string' && !/[^\x20-\x7e]/u.test(rawTrafficSource)
    && Buffer.byteLength(rawTrafficSource) <= 16384, 'AICP_RESOURCE_TRAFFIC_SOURCE_INVALID');
  const trafficSource = rawTrafficSource.trim() || 'agentkit';
  const names = ['ENDPOINT', 'SCHEME', 'REGION', 'ACCESS_KEY', 'SECRET_KEY', 'SESSION_TOKEN'].map(name => `${prefix}_${name}`);
  const fixed = Object.fromEntries([...names, 'KSADK_AICP_ENDPOINT_MODE', 'KSYUN_REGION', 'KSYUN_ACCESS_KEY',
    'KSYUN_ACCESS_KEY_ID', 'KSYUN_SECRET_ID', 'KSYUN_SECRET_KEY', 'KSYUN_SECRET_ACCESS_KEY', 'KSYUN_SESSION_TOKEN']
    .map(key => [key, read(env, key)]));
  const resolved = await configuration.resolve(), values = Object.fromEntries(fields.map(key => [key, resolved.values[key] ?? '']));
  invariant(Object.values(values).every(value => typeof value === 'string'), 'AICP_RESOURCE_CONFIG_INVALID');
  const get = name => fixed[`${prefix}_${name}`];
  const explicitScheme = get('SCHEME').toLowerCase();
  invariant(['', 'http', 'https'].includes(explicitScheme), 'AICP_RESOURCE_ENDPOINT_INVALID');
  const override = (field, ...keys) => { const key = keys.find(key => fixed[key]); if (key) values[field] = fixed[key]; };
  override('cloudAccessKey', `${prefix}_ACCESS_KEY`, 'KSYUN_ACCESS_KEY', 'KSYUN_ACCESS_KEY_ID', ...(prefix === 'KSADK_KB' ? ['KSYUN_SECRET_ID'] : []));
  override('cloudSecretKey', `${prefix}_SECRET_KEY`, 'KSYUN_SECRET_KEY', 'KSYUN_SECRET_ACCESS_KEY');
  override('cloudSessionToken', `${prefix}_SESSION_TOKEN`, 'KSYUN_SESSION_TOKEN');
  override('cloudRegion', `${prefix}_REGION`, 'KSYUN_REGION');
  const mode = fixed.KSADK_AICP_ENDPOINT_MODE.toLowerCase();
  const studio = !get('ENDPOINT') && !get('SCHEME') && !mode && Boolean(values.cloudServerUrl || serverUrl);
  let origin;
  if (!studio) {
    let endpoint = get('ENDPOINT') || byMode[mode];
    if (!endpoint && (!mode || ['auto', 'detect'].includes(mode))) {
      for (const candidate of autoEndpoints) if (await probe(candidate)) { endpoint = candidate; break; }
    }
    endpoint ||= byMode.public;
    // For explicit URL input keep its scheme unless SCHEME overrides it. Plain
    // SDK host[:port] follows the reference's internal/inner suffix rule.
    const embedded = endpoint.includes('://');
    const scheme = explicitScheme || (embedded ? '' : /\.(?:internal|inner)\.api\.ksyun\.com$/iu.test(endpoint) ? 'http' : 'https');
    let url;
    try { url = new URL(embedded ? endpoint : `${scheme}://${endpoint}`); if (explicitScheme) url.protocol = `${explicitScheme}:`; }
    catch { invariant(false, 'AICP_RESOURCE_ENDPOINT_INVALID'); }
    invariant(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash, 'AICP_RESOURCE_ENDPOINT_INVALID');
    origin = url.origin;
    values.cloudServerUrl = origin;
  }
  const snapshot = copy(values);
  const options = { configuration: { resolve: async () => ({ values: copy(snapshot) }) }, fetchImpl,
    serverUrl: studio ? serverUrl : '', sessionToken, innerKopUrl, innerIamUrl };
  const client = createAicpResourceClient({ ...options, timeoutMs: 60000, origin, trafficSource });
  const material = { contract, values, serverUrl, innerKopUrl, innerIamUrl, trafficSource,
    ...(!studio ? { sdkConnection: { contract: 'agentkit.aicp-resource-connection/v1', origin } } : {}) };
  return Object.freeze({ client, bindingDigest: createHash('sha256').update(canonical(material)).digest('hex') });
}
