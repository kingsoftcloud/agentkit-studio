/** Cloud assistant facade. DSH owns execution, history, persistence and timers. */
import { UNATTENDED_EXECUTION_POLICY } from './execution-policy.mjs';
import { createHash } from 'node:crypto';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const text = parts => (parts || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);

export function createPersonalAssistantRuntime({ ctx, agentId, buildId, frozen, admit, resources, retirement, identity }) {
  if (frozen.spec?.runtime?.type !== 'dsh-native') return null;
  const controller = ctx.get('sessionController');
  const identified = new WeakSet();
  const installIdentity = agent => {
    if (!identity || !agent.session.id.startsWith('assistant-') || identified.has(agent)) return;
    const prompt = agent.ctx?.get('systemPrompt');
    if (!prompt) throw fail('ASSISTANT_IDENTITY_UNAVAILABLE', '无法加载助理身份', 503);
    ctx.effect(() => agent.ctx.effect(() => prompt.section({ name: 'agentkit:assistant-identity', order: 10300, interpolate: false, text: identity.prompt })), 'agentkit-assistant:identity');
    identified.add(agent);
  };
  if (identity) {
    // Covers restored sessions and official timers before queued model work starts.
    ctx.on('agent/created', ({ agent }) => { installIdentity(agent); });
    for (const agent of ctx.get('agents').list()) installIdentity(agent);
  }
  const memoryBinding = frozen.spec?.bindings?.plugins?.find(item => item.config?.binding?.resource?.kind === 'memory-instance');
  const memoryId = memoryBinding?.config.binding.resource.id || memoryBinding?.config.binding.resource.resourceId;
  const memoryEnabled = Boolean(memoryId) && frozen.spec?.memory?.enabled !== false;
  const lanes = new Map();
  let retiring = false;
  const inFlight = new Set();
  const sessionFor = key => {
    if (!validKey(key)) throw fail('ASSISTANT_CONVERSATION_INVALID', '会话标识无效');
    return `assistant-${createHash('sha256').update(JSON.stringify([agentId, buildId, key])).digest('hex').slice(0, 40)}`;
  };
  const serialize = (id, work) => {
    const result = (lanes.get(id) || Promise.resolve()).catch(() => {}).then(work);
    lanes.set(id, result);
    void result.finally(() => { if (lanes.get(id) === result) lanes.delete(id); }).catch(() => {});
    return result;
  };
  async function ensure(sessionId) {
    if (retiring) throw fail('ASSISTANT_CLOSED', '助理正在关闭，不能继续使用', 410);
    if (!await controller.projections({ sessionId }, new AbortController().signal)) {
      const selected = await admit(agentId, frozen);
      await controller.create({ sessionId, agentPreset: selected.presetId });
      if (selected.modelSelection) await controller.selectModel({ sessionId, ...selected.modelSelection, saveDefault: false });
    }
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    installIdentity(resolved.agent);
    // Unattended tools retain confinement and cannot wait for a desktop approval.
    const presets = ctx.get('permissionPresets');
    if (!presets) throw fail('ASSISTANT_PERMISSION_UNAVAILABLE', '无法设置无人值守权限', 503);
    presets.set(resolved.agent.session, UNATTENDED_EXECUTION_POLICY.permissionMode);
    ctx.get('approval').setPolicy(resolved.agent, UNATTENDED_EXECUTION_POLICY.approvalPolicy, { actor: 'automation' });
    return resolved.agent;
  }
  async function snapshot(sessionId, beforeSeq) {
    const projection = await controller.projections({ sessionId }, new AbortController().signal);
    const profile = { identity: identity?.read() || null, canEditIdentity: Boolean(identity) };
    if (!projection) return { messages: [], status: 'idle', hasMore: false, ...profile, memoryEnabled, scheduleEnabled: Boolean(ctx.get('schedule')), canClose: Boolean(retirement) };
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw fail('ASSISTANT_CURSOR_INVALID', '历史游标无效');
    const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq,
      maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, new AbortController().signal);
    const events = (page.records || []).filter(row => row.type === 'event').map(row => row.event);
    const messages = events.flatMap(event => {
      const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
      if (!role) return [];
      const message = role === 'assistant' ? event.data?.message : event.data;
      if (role === 'user' && !['user', 'schedule'].includes(message?.source?.kind)) return [];
      const visibleText = message?.source?.kind === 'schedule' ? '定时任务已触发。' : text(message?.content);
      if (role === 'assistant' && !visibleText.trim()) return [];
      return [{ source: message?.source?.kind, id: `${sessionId}:${event.seq}`, seq: event.seq, role, text: visibleText, requestId: message?.source?.rpcId || '' }];
    });
    const end = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    const status = end?.type === 'turn/start' ? 'running' : end?.data?.reason?.kind === 'completed' ? 'completed'
      : end?.data?.reason?.kind === 'aborted' ? 'cancelled' : end ? 'failed' : 'idle';
    // Raw provider/tool failures can contain credentials; expose a stable
    // product error while retaining the original reason in the DSH log.
    const failure = status === 'failed' ? { code: 'ASSISTANT_TURN_FAILED', message: '助理本次任务未完成，请重试；若仍失败，请检查模型和工具连接。' } : null;
    const lastUser = messages.findLast(item => item.role === 'user' && item.source !== 'schedule');
    const retry = failure && lastUser ? { text: lastUser.text } : null;
    return { messages, status, failure, retry, hasMore: page.hasMore === true, beforeSeq: events[0]?.seq,
      ...profile, memoryEnabled, scheduleEnabled: Boolean(ctx.get('schedule')), canClose: Boolean(retirement) };
  }
  const run = async (operation, payload = {}) => {
    if (operation === 'close') {
      if (!retirement) throw fail('ASSISTANT_DELETE_UNAVAILABLE', '此 Host 未提供专属数据删除能力', 409);
      retiring = true;
      await Promise.allSettled([...inFlight]);
      return retirement(async () => {
        let count = 0;
        if (!memoryId) return { count };
        const adapter = await resources(), options = { agentId };
        const seen = new Set();
        for (let page = 0; page < 1000; page++) {
          const result = await adapter.listMemory(memoryId, 'studio-anonymous', options);
          if (!result.items.length) { if (result.hasMore) throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆列表不完整'); return { count }; }
          for (const item of result.items) {
            if (seen.has(item.id)) throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆删除结果尚未生效');
            if ((await adapter.deleteMemory(memoryId, 'studio-anonymous', item.id, options))?.accepted !== true) throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆删除未获确认');
            seen.add(item.id); count++;
          }
        }
        throw fail('ASSISTANT_MEMORY_DELETE_UNCONFIRMED', '记忆较多，请重新核对关闭结果');
      });
    }
    if (retiring) throw fail('ASSISTANT_CLOSED', '助理正在关闭，不能继续使用', 410);
    if (operation === 'identity-update') {
      if (!identity) throw fail('ASSISTANT_IDENTITY_UNAVAILABLE', '请更新云端镜像以保存助理名字和称呼', 409);
      return { identity: await identity.update(payload) };
    }
    const sessionId = sessionFor(payload.conversation || 'personal');
    if (operation === 'snapshot') return snapshot(sessionId, payload.beforeSeq);
    if (operation === 'submit') {
      if (!validKey(payload.requestId) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 32000) throw fail('ASSISTANT_INPUT_INVALID', '请输入 1 至 32000 字的消息及请求标识');
      return serialize(sessionId, () => ctx.get('agents').withoutInitiator(async () => {
        const agent = await ensure(sessionId);
        await controller.prompt({ sessionId, requestId: payload.requestId, mode: 'queue',
          requestFingerprint: createHash('sha256').update(payload.text).digest('hex'),
          content: [{ type: 'text', text: payload.text }], clientTimeZone: payload.timezone || 'Asia/Shanghai' }, new AbortController().signal);
        // Acceptance is sent only after DSH's persistence backend acknowledges.
        // A client disconnect never cancels this cloud-owned Agent.
        if (!await ctx.get('sessions').flush(agent.session)) throw fail('ASSISTANT_PERSISTENCE_UNAVAILABLE', '云端未确认保存，请先刷新会话核对提交结果', 503);
        return { accepted: true, requestId: payload.requestId, sessionId };
      }));
    }
    if (operation === 'cancel') return controller.cancel({ sessionId });
    if (operation.startsWith('schedule-')) {
      const schedule = ctx.get('schedule');
      if (!schedule) throw fail('ASSISTANT_SCHEDULE_UNAVAILABLE', '请在云端镜像启用 DSH 官方定时任务插件', 503);
      if (operation === 'schedule-list') return { items: (await schedule.catalog()).filter(item => item.sessionId === sessionId) };
      if (operation === 'schedule-create') return serialize(sessionId, async () => {
        await ensure(sessionId);
        return schedule.create(sessionId, payload.spec);
      });
      if (operation === 'schedule-delete') return schedule.delete({ sessionId, id: payload.id });
      throw fail('ASSISTANT_OPERATION_INVALID', '不支持的定时任务操作');
    }
    if (operation.startsWith('memory-')) {
      if (!memoryId || frozen.spec?.memory?.enabled === false) throw fail('ASSISTANT_MEMORY_UNAVAILABLE', '请给助理绑定并启用云端记忆库', 503);
      const adapter = await resources();
      const options = { agentId };
      // Same partition as the existing DSH resource bridge; one dedicated
      // deployment belongs to one personal assistant, never a shared tenant.
      if (operation === 'memory-list') return adapter.listMemory(memoryId, 'studio-anonymous', options);
      if (operation === 'memory-save') {
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) throw fail('ASSISTANT_MEMORY_INVALID', '记忆内容须为 1 至 4000 字');
        return adapter.writeMemory(memoryId, 'studio-anonymous', [{ role: 'user', content: `请记住：${payload.text}` }], { ...options, sessionId, flush: true });
      }
      if (operation === 'memory-delete' || operation === 'memory-update') {
        const { items } = await adapter.listMemory(memoryId, 'studio-anonymous', options);
        if (!items.some(item => item.id === payload.id)) throw fail('ASSISTANT_MEMORY_NOT_FOUND', '请刷新记忆列表后再操作', 404);
        if (operation === 'memory-delete') return adapter.deleteMemory(memoryId, 'studio-anonymous', payload.id, options);
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) throw fail('ASSISTANT_MEMORY_INVALID', '记忆内容须为 1 至 4000 字');
        return adapter.updateMemory(memoryId, 'studio-anonymous', payload.id, payload.text, options);
      }
    }
    throw fail('ASSISTANT_OPERATION_INVALID', '不支持的助理操作', 404);
  };
  const api = (operation, payload) => {
    const pending = run(operation, payload);
    if (operation !== 'close') { inFlight.add(pending); void pending.finally(() => inFlight.delete(pending)).catch(() => {}); }
    return pending;
  };
  api.deletionSupported = Boolean(retirement);
  api.identitySupported = Boolean(identity);
  api.retiring = () => retiring;
  return api;
}
