/** Native DSH presentation; frozen cloud runtime owns prompts, resources and tools. */
import { CLOUD_PROVIDER } from './deployment-agents.mjs';
import { sha256, portableError } from './portable-resources.mjs';
import { cloudFrames } from './providers/dsh-runtime.mjs';
import { createCodexToolRecorder } from './providers/codex-tool-events.mjs';

export function createDeploymentConversation({ agents, fetchImpl = fetch }) {
  return async function* stream(options) {
    const { agent, endpoint, token } = await (await agents()).connect(options.agentId);
    const selected = options.studioSelectedModel || options.model;
    if (options.provider !== CLOUD_PROVIDER || selected !== agent.deployment.model) {
      throw portableError('DEPLOYMENT_MODEL_FROZEN', `云端运行使用冻结模型 ${agent.deployment.model}，请在模型选择器的“云端部署”组选择该模型；更换模型需要重新构建部署`);
    }
    if (!options.sessionId || !options.userMessage?.id) throw portableError('DEPLOYMENT_SESSION_REQUIRED', '云端对话需要原生会话和消息标识');
    const request = { input: options.input, stream: true, model: agent.deployment.model,
      session_id: `studio-${sha256(String(options.sessionId)).slice(0, 40)}`,
      request_id: `message-${sha256(JSON.stringify([options.sessionId, options.userMessage.id])).slice(0, 40)}` };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    const calls = new Map(), items = new Map();
    const recorder = createCodexToolRecorder(options.session, { label: '云端', code: 'CLOUD' });
    let responseId, verified = false, response, complete = false;
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
        if (type === 'response.completed') complete = true;
      }
      if (!verified) throw portableError('DEPLOYMENT_RESPONSE_UNVERIFIED', '云端流未返回可核验的 Agent 身份');
      if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const item = event.item;
        calls.set(item.call_id, item); items.set(item.id, item);
        recorder?.record({ type: 'tool', id: item.call_id, name: item.name, arguments: item.arguments, phase: 'started' });
        return Boolean(recorder);
      }
      if (type === 'response.function_call_arguments.done') {
        const item = items.get(event.item_id); if (item) item.arguments = event.arguments;
        return Boolean(recorder);
      }
      if (type === 'response.tool_result') {
        const item = calls.get(event.call_id);
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
      if (options.signal?.aborted) throw portableError('CLOUD_RUN_CANCELLED', '云端运行已取消');
      if (error?.code) throw error;
      throw portableError('DEPLOYMENT_CONNECTION_FAILED', '云端对话连接失败，请检查网络和运行状态');
    } finally {
      recorder?.close();
      if (!complete) {
        await response?.body?.cancel().catch(() => {});
        if (responseId) await fetchImpl(`${endpoint}/v1/responses/${responseId}/cancel`, { method: 'POST', headers,
          redirect: 'error', signal: AbortSignal.timeout(5000) }).then(reply => reply.body?.cancel()).catch(() => {});
      }
    }
  };
}
