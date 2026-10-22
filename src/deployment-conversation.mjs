/** Native DSH presentation; frozen cloud runtime owns prompts, resources and tools. */
import { CLOUD_PROVIDER } from './deployment-agents.mjs';
import { clampExecutionMode } from './execution-policy.mjs';
import { sha256, portableError } from './portable-resources.mjs';
import { cloudFrames } from './providers/dsh-runtime.mjs';
import { createCodexToolRecorder } from './providers/codex-tool-events.mjs';
import { sanitizeResourceCheck } from './resource-checks.mjs';

export function createDeploymentConversation({ agents, fetchImpl = fetch, observability, permissionModeFor }) {
  return async function* stream(options) {
    const { agent, endpoint, token, capabilities, allowedPermissionModes = [], executionModeSwitching } = await (await agents()).connect(options.agentId);
    if ((options.cloudVersionId || 'initial') !== (agent.deployment.versionId || 'initial')) {
      throw portableError('DEPLOYMENT_SESSION_VERSION_CHANGED', '云端 Agent 已升级或回滚，请开启新会话使用当前版本；此会话历史仍保留');
    }
    const selected = options.studioSelectedModel || options.model;
    if (options.provider !== CLOUD_PROVIDER || !(agent.deployment.models || [agent.deployment.model]).includes(selected)) {
      throw portableError('DEPLOYMENT_MODEL_FROZEN', '请选择“云端部署”组中该冻结版本已绑定的模型；新增模型需修改 Agent 并构建后更新实例');
    }
    if (selected !== agent.deployment.model && capabilities && !capabilities.includes('bound-model-selection')) {
      throw portableError('DEPLOYMENT_MODEL_SWITCH_UNAVAILABLE', '当前云端镜像尚不支持切换绑定模型，请在构建与部署中更新原实例的镜像版本');
    }
    if (!options.sessionId || !options.userMessage?.id) throw portableError('DEPLOYMENT_SESSION_REQUIRED', '云端对话需要原生会话和消息标识');
    const request = { input: options.input, stream: true, model: selected,
      session_id: `studio-${sha256(String(options.sessionId)).slice(0, 40)}`,
      request_id: `message-${sha256(JSON.stringify([options.sessionId, options.userMessage.id])).slice(0, 40)}` };
    // The runtime owns the ceiling; a conversation may only select a mode the
    // frozen image declares. Old images ignore the absent header entirely.
    let permissionMode = null;
    if (executionModeSwitching && typeof permissionModeFor === 'function' && allowedPermissionModes.length) {
      const requested = await permissionModeFor(options.agentId);
      const clamped = requested ? clampExecutionMode(requested, allowedPermissionModes.at(-1)) : null;
      if (clamped && allowedPermissionModes.includes(clamped)) permissionMode = clamped;
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
      ...(permissionMode ? { 'x-agentkit-permission-mode': permissionMode } : {}) };
    const calls = new Map(), items = new Map();
    const recorder = createCodexToolRecorder(options.session, { label: '云端', code: 'CLOUD' });
    let responseId, verified = false, response, complete = false;
    const startedAt = new Date().toISOString(), events = [], resourceChecks = [];
    const bindings = agent.spec?.bindings || {}, ids = values => (values || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id).filter(Boolean);
    const resourceBindings = { mcpServers: ids(bindings.mcpServers), skills: ids(bindings.skills),
      platform: (bindings.plugins || []).map(item => item.config?.binding?.resource).filter(Boolean).map(item => ({ kind: item.kind, id: item.id || item.resourceId })) };
    let status = 'failed';
    const recordEvent = (event_type, payload) => events.push({ event_type, at: new Date().toISOString(), session_id: options.sessionId, run_id: responseId, payload });
    const onEvent = event => {
      const type = event.type || event.event;
      if (['response.created', 'response.in_progress', 'response.completed'].includes(type)) {
        const current = event.response || event, identity = current.metadata?.agentkit;
        if (identity?.agentId !== agent.deployment.agentId || identity?.buildId !== agent.deployment.buildId
          || !/^resp_[a-f0-9]{32}_[a-f0-9]{32}_[a-f0-9]{32}$/.test(current.id || '')
          || (responseId && current.id !== responseId) || (current.model && current.model !== request.model)) {
          throw portableError('DEPLOYMENT_RESPONSE_MISMATCH', '云端响应与当前 Agent 冻结版本不匹配');
        }
        responseId = current.id; verified = true;
        if (type === 'response.completed') {
          complete = true; status = 'completed'; recordEvent('run.completed', { usage: current.usage });
          for (const value of identity.resourceChecks || []) {
            const check = sanitizeResourceCheck(value);
            if (check && !resourceChecks.some(item => JSON.stringify(item) === JSON.stringify(check))) {
              resourceChecks.push(check); recordEvent('resource.checked', check);
            }
          }
        }
        else if (type === 'response.created') recordEvent('run.started', { cloudAgentId: options.agentId, buildId: agent.deployment.buildId, model: request.model, responseId });
      }
      if (!verified) throw portableError('DEPLOYMENT_RESPONSE_UNVERIFIED', '云端流未返回可核验的 Agent 身份');
      if (type === 'response.resource_check') {
        const check = sanitizeResourceCheck(event.check);
        if (check) {
          resourceChecks.push(check); recordEvent('resource.checked', check);
        }
        return false;
      }
      if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const item = event.item;
        calls.set(item.call_id, item); items.set(item.id, item);
        recordEvent('tool.started', { callId: item.call_id, name: item.name });
        recorder?.record({ type: 'tool', id: item.call_id, name: item.name, arguments: item.arguments, phase: 'started' });
        return Boolean(recorder);
      }
      if (type === 'response.function_call_arguments.done') {
        const item = items.get(event.item_id); if (item) item.arguments = event.arguments;
        return Boolean(recorder);
      }
      if (type === 'response.tool_result') {
        const item = calls.get(event.call_id);
        recordEvent(event.is_error ? 'tool.failed' : 'tool.completed', { callId: event.call_id, name: item?.name });
        if (item) recorder?.record({ type: 'tool', id: item.call_id, name: item.name, arguments: item.arguments,
          phase: event.is_error ? 'failed' : 'completed', result: { content: event.output } });
        return Boolean(recorder);
      }
      if (type === 'response.output_item.done') {
        if (event.item?.type === 'function_call') return Boolean(recorder); // Wait for the actual tool result.
        if (event.item?.status === 'incomplete') throw portableError('CLOUD_STREAM_INCOMPLETE', '云端推理尝试未完成，请检查运行结果');
      }
      return false;
    };
    try {
      response = await fetchImpl(`${endpoint}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(request), redirect: 'error', signal: options.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw portableError(response.status === 401 ? 'DEPLOYMENT_ACCESS_REJECTED' : 'DEPLOYMENT_RUN_FAILED', `云端对话请求未成功（HTTP ${response.status}），请在运行中心核对访问配置与日志`);
      }
      yield* cloudFrames(response.body, options.signal, { onEvent });
    } catch (error) {
      status = options.signal?.aborted ? 'canceled' : 'failed';
      recordEvent(`run.${status}`, { code: error?.code || 'DEPLOYMENT_CONNECTION_FAILED' });
      if (options.signal?.aborted) throw portableError('CLOUD_RUN_CANCELLED', '云端运行已取消');
      if (error?.code) throw error;
      throw portableError('DEPLOYMENT_CONNECTION_FAILED', '云端对话连接失败，请检查网络和运行状态');
    } finally {
      recorder?.close();
      if (verified) await observability?.syncTrace({ traceId: `cloud_${sha256(JSON.stringify([options.agentId, responseId]))}`, sessionId: options.sessionId,
        agentId: options.agentId, agentName: agent.metadata?.name, executionLocation: 'cloud', status, startedAt,
        completedAt: new Date().toISOString(), events, provenance: { cloudAgentId: options.agentId, agentId: agent.deployment.agentId,
          buildId: agent.deployment.buildId, versionId: agent.deployment.versionId || 'initial', responseId, model: request.model, resourceChecks,
          revision: agent.metadata?.revision, models: agent.deployment.models || [agent.deployment.model], resourceBindings,
          environment: agent.deployment.environment, region: agent.deployment.region } }).catch(() => {});
      if (!complete) {
        await response?.body?.cancel().catch(() => {});
        if (responseId) await fetchImpl(`${endpoint}/v1/responses/${responseId}/cancel`, { method: 'POST', headers,
          redirect: 'error', signal: AbortSignal.timeout(5000) }).then(reply => reply.body?.cancel()).catch(() => {});
      }
    }
  };
}
