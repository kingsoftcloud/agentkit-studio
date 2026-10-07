/** Discover Codex models through the official App Server RPC, without starting an inference turn. */
import { withCodexCatalogRpc } from './codex-catalog-rpc.mjs';

export const CODEX_PROVIDER = 'agentkit-studio-codex';
const failure = (code, message) => Object.assign(new Error(message), { code });

export function codexModelSelection(agent, catalog) {
  const bindings = agent?.spec?.bindings || {};
  const first = bindings.modelProfileIds?.[0];
  const model = String(bindings.modelProfileId || (typeof first === 'string' ? first : first?.resourceId) || catalog.defaultModel || '');
  if (!catalog.items.some(item => item.resourceId === model)) throw failure('CODEX_MODEL_UNAVAILABLE', `Codex 模型不可用：${model || '未配置'}。请在 Agent 编辑页选择 Codex 模型。`);
  return { provider: CODEX_PROVIDER, model };
}

/** Publish the App Server catalog through DSH's public LLM directory. */
export function createCodexModelAdapter({ catalog, runtime }) {
  return Object.assign(Object.create(Object.getPrototypeOf(runtime)), runtime, {
    providerInfo(provider) { return { id: provider, name: 'Codex' }; },
    async listModels(provider) { return (await catalog.list()).items.map(item => ({ provider, id: item.resourceId, name: item.displayName })); },
    async resolveModel(provider, model) {
      const item = (await catalog.list()).items.find(item => item.resourceId === model);
      if (!item) throw failure('CODEX_MODEL_UNAVAILABLE', `Codex 模型不可用：${model}`);
      return { provider, id: model, name: item.displayName };
    },
  });
}

export function createCodexModelCatalog({ executable, spawnImpl, env = process.env, timeoutMs = 10000 } = {}) {
  let cached, expires = 0, inflight;
  async function readCatalog() {
    return withCodexCatalogRpc(async request => {
      const config = (await request('config/read', { includeLayers: false }))?.config || {};
      const rows = [], cursors = new Set(); let cursor;
      for (let page = 0; page < 10; page += 1) {
        const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data)) throw failure('CODEX_PROTOCOL_INVALID', 'Codex 模型目录结构无效。');
        rows.push(...result.data); cursor = result.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 9) throw failure('CODEX_CATALOG_TOO_LARGE', 'Codex 模型目录分页超过上限。');
        cursors.add(cursor);
      }
      const items = [...new Map(rows.filter(item => !item.hidden && (item.model || item.id)).map(item => {
        const model = String(item.model || item.id);
        return [model, { resourceId: model, name: model, displayName: String(item.displayName || model), provider: CODEX_PROVIDER, source: 'codex-app-server', isDefault: item.isDefault === true, status: 'available' }];
      })).values()];
      if (!items.length) throw failure('CODEX_CATALOG_EMPTY', 'Codex 没有可用模型，请检查登录和配置。');
      const configured = String(env.AGENTKIT_CODEX_MODEL || config.models?.new_thread?.model || config.model || '');
      return { items, defaultModel: configured || items.find(item => item.isDefault)?.resourceId || items[0].resourceId, source: 'codex-app-server' };
    }, { executable, spawnImpl, env, timeoutMs });
  }

  return {
    async list() {
      if (cached && Date.now() < expires) return cached;
      if (!inflight) inflight = readCatalog().then(value => { cached = value; expires = Date.now() + 60000; return value; }).finally(() => { inflight = undefined; });
      return inflight;
    },
  };
}
