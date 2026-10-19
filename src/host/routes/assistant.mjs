/** Only receipt-owned DSH deployments may be reached; tokens stay in Node. */
import { createAssistantLifecycle } from '../../assistant-lifecycle.mjs';
const operations = new Set(['snapshot', 'submit', 'cancel', 'identity-update', 'schedule-list', 'schedule-create', 'schedule-delete', 'memory-list', 'memory-save', 'memory-update', 'memory-delete']);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export function createAssistantRoutes({ deployments, assistantStoreDir, assistantSetup, runtimeFetch, fetchImpl = runtimeFetch || fetch }) {
  const lifecycle = createAssistantLifecycle({ directory: assistantStoreDir, deployments, fetchImpl });
  return async (endpoint, payload = {}, signal) => {
    if (endpoint === 'assistant/close') return { ok: true, value: await lifecycle.close(payload) };
    if (endpoint.startsWith('assistant/setup-')) {
      const service = await assistantSetup();
      const action = endpoint.slice('assistant/setup-'.length);
      if (!['options', 'start', 'status'].includes(action)) throw fail('ASSISTANT_OPERATION_INVALID', '不支持的开通操作');
      return { ok: true, value: await service[action](payload) };
    }
    const { agents } = await deployments();
    if (endpoint === 'assistant/catalog') {
      const result = await agents.list();
      return { ok: true, value: { items: result.items.filter(item => item.spec?.runtime?.type === 'dsh-native' && item.deployment?.available !== false), warnings: result.warnings || [] } };
    }
    if (!operations.has(payload.operation)) throw fail('ASSISTANT_OPERATION_INVALID', '不支持的助理操作');
    const { agent, endpoint: base, token, capabilities } = await agents.connect(payload.agentId);
    if (agent.spec?.runtime?.type !== 'dsh-native') throw fail('ASSISTANT_RUNTIME_INVALID', '个人助理需要 DSH Runtime');
    if (!capabilities.includes('personal-assistant/v1')) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '请更新云端 DSH 镜像以启用个人助理和后台会话恢复', 409);
    if (payload.operation === 'identity-update' && !capabilities.includes('personal-assistant-identity/v1')) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '请更新云端 DSH 镜像以保存助理名字和称呼', 409);
    const response = await fetchImpl(`${base}/v1/assistant/${payload.operation}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(payload.input || {}), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)].filter(Boolean)) });
    let value; try { value = await response.json(); } catch { throw fail('ASSISTANT_RESPONSE_INVALID', '云端助理返回格式无法识别', 502); }
    if (!response.ok) throw fail('ASSISTANT_CLOUD_REQUEST_FAILED', `云端助理请求未完成（${response.status}）；请刷新核对状态`, response.status);
    return { ok: true, value };
  };
}
