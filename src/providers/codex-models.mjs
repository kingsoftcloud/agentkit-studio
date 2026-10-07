/** Discover Codex models through the official App Server RPC, without starting an inference turn. */
import { resolveCodexCommand } from './codex-command.mjs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

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

export function createCodexModelCatalog({ executable, spawnImpl = spawn, env = process.env, timeoutMs = 10000 } = {}) {
  const command = resolveCodexCommand({ executable, env });
  let cached, expires = 0, inflight;
  async function readCatalog() {
    let child;
    try { child = spawnImpl(command.executable, [...command.prefixArgs, 'app-server', '--stdio'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env }); }
    catch { throw failure('CODEX_PROVIDER_UNAVAILABLE', '无法启动 Codex App Server，请安装并配置 Codex。'); }
    const pending = new Map(); let id = 0, closed = false, size = 0;
    const reject = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
    const error = () => reject(failure('CODEX_PROVIDER_UNAVAILABLE', 'Codex App Server 无法读取模型目录。'));
    child.on('error', error); child.stdin?.on('error', error); child.stderr?.on('data', () => {});
    child.on('exit', () => { if (!closed) error(); });
    if (!child.stdin || !child.stdout) { child.kill?.('SIGTERM'); throw failure('CODEX_PROVIDER_UNAVAILABLE', 'Codex 未提供 stdio 通道。'); }
    const lines = createInterface({ input: child.stdout });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) reject(failure('CODEX_CATALOG_TOO_LARGE', 'Codex 模型目录超过大小上限。')); });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { reject(failure('CODEX_PROTOCOL_INVALID', 'Codex 模型目录返回无效 JSON。')); return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(failure('CODEX_CATALOG_FAILED', 'Codex 拒绝读取模型目录，请检查本地配置。'));
      else entry.resolve(message.result);
    });
    const request = (method, params) => new Promise((resolve, rejectRequest) => {
      const requestId = ++id; pending.set(requestId, { resolve, reject: rejectRequest });
      try { child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n'); }
      catch (error) { pending.delete(requestId); rejectRequest(error); }
    });
    let timer;
    try {
      return await Promise.race([(async () => {
        await request('initialize', { clientInfo: { name: 'agentkit-studio', version: '0.0.1' }, capabilities: { experimentalApi: true } });
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
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
      })(), new Promise((resolve, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(failure('CODEX_CATALOG_TIMEOUT', '读取 Codex 模型目录超时。')), timeoutMs); })]);
    } finally {
      closed = true; clearTimeout(timer); lines.close();
      reject(failure('CODEX_TRANSPORT_CLOSED', 'Codex 模型目录读取已结束。'));
      child.stdin.end?.(); child.kill?.('SIGTERM');
    }
  }
  return {
    async list() {
      if (cached && Date.now() < expires) return cached;
      if (!inflight) inflight = readCatalog().then(value => { cached = value; expires = Date.now() + 60000; return value; }).finally(() => { inflight = undefined; });
      return inflight;
    },
  };
}
