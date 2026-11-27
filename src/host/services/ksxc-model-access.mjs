import { createHash, randomUUID } from 'node:crypto';
import { hostFetch } from '../../http-fetch.mjs';
import { createAuthenticatedModelProxy } from '../../providers/codex-model-proxy.mjs';
import { KsxcRuntimeError } from '../../providers/ksxc-command.mjs';
import { assertKsxcCatalogModel, ksxcCatalogModels } from '../../providers/ksxc-runtime.mjs';
import { normalizeModelEndpoint } from '../../model-endpoint.mjs';

const failure = (code, message, status) => Object.assign(new KsxcRuntimeError(code, message), { status });
const required = () => failure('KSXC_CONNECTION_REQUIRED', '请先连接你自己的 KSXC 企业账号。', 401);
const denied = () => failure('KSXC_MODEL_FORBIDDEN', '请从当前 KSXC 企业账号的模型目录中重新选择。', 403);
const unavailable = () => failure('KSXC_CATALOG_UNAVAILABLE', '暂时无法读取 KSXC 企业模型目录。', 502);
const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const protocol = 'openai-responses';
const catalogTtlMs = 15_000;

/** Desktop-only access to the same enterprise model API used by the KSXC CLI. */
export function createKsxcModelAccess({ companyConfig, connection, fetchImpl = hostFetch }) {
  const baseUrl = normalizeModelEndpoint(companyConfig.baseUrl);
  let cached, proxy;
  let generation = randomUUID();
  const headers = () => ({ 'X-KSC-COMPANY-CODE': companyConfig.code, 'X-KSC-REQUEST-ID': randomUUID() });
  const accountKey = account => digest([generation, account.accountId, account.token]);
  const routeId = (model, key) => Buffer.from(model).toString('base64url') + '.' + digest([model, key]);
  async function readModels(account) {
    let response, data;
    try {
      response = await fetchImpl(new URL('/cli/models', baseUrl), {
        headers: { ...headers(), Authorization: 'Bearer ' + account.token },
        redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      data = await response.json();
    } catch { throw unavailable(); }
    if (response.status === 401 || data?.code === 401)
      throw failure('KSXC_CONNECTION_EXPIRED', 'KSXC 企业连接已失效，请重新授权。', 401);
    if (response.status === 403 || data?.code === 403) throw denied();
    if (!response.ok || data?.code !== 200 || !Array.isArray(data.data)) throw unavailable();
    return ksxcCatalogModels(data.data).filter(model => /^[^\s\x00-\x1f\x7f]{1,512}$/.test(model.id));
  }

  async function catalog(signal) {
    signal?.throwIfAborted();
    const account = await connection();
    if (!account) { cached = undefined; return null; }
    const key = accountKey(account);
    if (cached?.key !== key || cached.expires <= Date.now()) {
      const entry = { key, expires: Infinity };
      cached = entry;
      entry.result = readModels(account).then(models => {
        entry.expires = Date.now() + catalogTtlMs;
        return models;
      }, error => {
        if (cached === entry) cached = undefined;
        throw error;
      });
    }
    const models = await cached.result;
    signal?.throwIfAborted();
    const current = await connection();
    if (!current || accountKey(current) !== key) throw required();
    return { account: current, key, models };
  }

  return {
    invalidate() { generation = randomUUID(); cached = undefined; },
    async list() { return (await catalog())?.models ?? []; },
    async model(id, signal) {
      const result = await catalog(signal);
      if (!result) throw required();
      assertKsxcCatalogModel(result.models, id);
      return result.models.find(model => model.id === id);
    },
    async profile(id, signal) {
      const result = await catalog(signal);
      if (!result) throw required();
      assertKsxcCatalogModel(result.models, id);
      proxy ??= createAuthenticatedModelProxy({
        upstreamApi: 'responses', idleTimeoutMs: 960_000, fetchImpl,
        profileFor: async route => {
          const model = Buffer.from(route.split('.')[0], 'base64url').toString('utf8');
          const authorization = await catalog();
          if (!authorization) throw required();
          if (route !== routeId(model, authorization.key) || !authorization.models.some(entry => entry.id === model)) throw denied();
          return { protocol, baseUrl, modelName: model, apiKey: authorization.account.token, headers: headers() };
        },
      }).catch(error => { proxy = undefined; throw error; });
      const transport = await proxy;
      const idForGrant = routeId(id, result.key);
      return { id: 'ksxc:' + id, protocol, modelName: id, label: result.models.find(model => model.id === id).name,
        baseUrl: transport.modelUrl(idForGrant), apiKey: transport.apiKey };
    },
    async close() { await (await proxy)?.close(); },
  };
}
