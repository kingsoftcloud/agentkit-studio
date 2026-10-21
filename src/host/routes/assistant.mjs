/** Only receipt-owned DSH deployments may be reached; tokens stay in Node. */
import { ASSISTANT_SCHEDULE_OPERATIONS, ASSISTANT_SCHEDULE_CAPABILITY } from '../../contracts/assistant-schedule.mjs';
import { createHash } from 'node:crypto';
import { createAssistantLifecycle } from '../../assistant-lifecycle.mjs';
import { ASSISTANT_ATTACHMENT_CAPABILITIES } from '../../contracts/assistant-attachments.mjs';
import { encodeAssistantInput, readAssistantResponse, assistantCloudFailure } from '../../assistant-transport.mjs';
import { ASSISTANT_NATIVE_CAPABILITY, ASSISTANT_NATIVE_OPERATIONS, isAssistantNativeOperation } from '../../contracts/assistant-native.mjs';
const operations = new Set([...ASSISTANT_NATIVE_OPERATIONS, ...ASSISTANT_SCHEDULE_OPERATIONS, 'snapshot', 'image-read', 'attachment-upload', 'file-read', 'approval-decide', 'cancel-turn', 'submit', 'cancel', 'identity-update', 'memory-list', 'memory-save', 'memory-update', 'memory-delete']);
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
    if (isAssistantNativeOperation(payload.operation) && !capabilities.includes(ASSISTANT_NATIVE_CAPABILITY)) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '此云端镜像尚未提供安全的原生会话连接，请更新后重试', 409);
    if (['schedule-catalog', 'schedule-get', 'schedule-history', 'schedule-update'].includes(payload.operation) && !capabilities.includes(ASSISTANT_SCHEDULE_CAPABILITY)) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '请更新云端 DSH 镜像以管理原生计划任务', 409);
    if (payload.operation === 'cancel-turn' && !capabilities.includes('personal-assistant-cancel-turn/v1')) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '此云端镜像尚未提供按任务停止能力，请更新后重试', 409);
    if (payload.operation === 'approval-decide' && !capabilities.includes('personal-assistant-approval-bridge/v1')) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '此云端镜像尚未提供实时审批接口', 409);
    if (payload.operation === 'image-read' && !capabilities.includes('personal-assistant-images/v1')) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '此云端镜像尚未提供助理图片读取能力', 409);
    if (payload.operation === 'identity-update' && !capabilities.includes('personal-assistant-identity/v1')) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '请更新云端 DSH 镜像以保存助理名字和称呼', 409);
    const capability = payload.operation === 'attachment-upload' ? ASSISTANT_ATTACHMENT_CAPABILITIES.upload
      : payload.operation === 'file-read' ? ASSISTANT_ATTACHMENT_CAPABILITIES.read
        : payload.operation === 'submit' && payload.input?.content !== undefined ? ASSISTANT_ATTACHMENT_CAPABILITIES.content : null;
    if (capability && !capabilities.includes(capability)) throw fail('ASSISTANT_IMAGE_UPGRADE_REQUIRED', '此云端镜像尚未提供所需附件能力，请更新后重试', 409);
    let journalScope;
    if (payload.operation === 'native-open') {
      const receipt = agent.deployment;
      if (!receipt || !['id', 'buildId', 'versionId'].every(key => typeof receipt[key] === 'string' && receipt[key])) throw fail('ASSISTANT_NATIVE_UNAVAILABLE', '当前部署缺少原生会话所需的归属信息', 409);
      // Only public receipt identity contributes to the browser draft namespace;
      // tokens, endpoints and account credentials are never hashed or exposed.
      journalScope = createHash('sha256').update(JSON.stringify([payload.agentId, receipt.id, receipt.buildId, receipt.versionId,
        payload.input?.conversation ?? 'personal'])).digest('hex');
    }
    const body = encodeAssistantInput(payload.operation, payload.input);
    const response = await fetchImpl(`${base}/v1/assistant/${payload.operation}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error',
      body, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)].filter(Boolean)) });
    const value = await readAssistantResponse(response);
    if (!response.ok) throw assistantCloudFailure(response.status, value);
    return { ok: true, value: journalScope ? { ...value, journalScope } : value };
  };
}
