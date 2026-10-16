/** Cloud assistant facade. DSH owns execution, history, persistence and timers. */
import { createHash } from 'node:crypto';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const text = parts => (parts || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);

export function createPersonalAssistantRuntime({ ctx, agentId, buildId, frozen, admit, resources }) {
  if (frozen.spec?.runtime?.type !== 'dsh-native') return null;
  const controller = ctx.get('sessionController');
  const memoryBinding = frozen.spec?.bindings?.plugins?.find(item => item.config?.binding?.resource?.kind === 'memory-instance');
  const memoryId = memoryBinding?.config.binding.resource.id || memoryBinding?.config.binding.resource.resourceId;
  const memoryEnabled = Boolean(memoryId) && frozen.spec?.memory?.enabled !== false;
  const lanes = new Map();
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
    if (!await controller.projections({ sessionId }, new AbortController().signal)) {
      const selected = await admit(agentId, frozen);
      await controller.create({ sessionId, agentPreset: selected.presetId });
      if (selected.modelSelection) await controller.selectModel({ sessionId, ...selected.modelSelection, saveDefault: false });
    }
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    // Unattended tools retain confinement and cannot wait for a desktop approval.
    const permission = await ctx.get('commands').execute(resolved.agent, '/permission read-only', [], new AbortController().signal);
    if (!permission) throw fail('ASSISTANT_PERMISSION_UNAVAILABLE', '无法设置无人值守权限', 503);
    ctx.get('approval').setPolicy(resolved.agent, 'never');
    return resolved.agent;
  }
  async function snapshot(sessionId, beforeSeq) {
    const projection = await controller.projections({ sessionId }, new AbortController().signal);
    if (!projection) return { messages: [], status: 'idle', hasMore: false, memoryEnabled, scheduleEnabled: Boolean(ctx.get('schedule')) };
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw fail('ASSISTANT_CURSOR_INVALID', '历史游标无效');
    const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq,
      maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, new AbortController().signal);
    const events = (page.records || []).filter(row => row.type === 'event').map(row => row.event);
    const messages = events.flatMap(event => {
      const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
      if (!role) return [];
      const message = role === 'assistant' ? event.data?.message : event.data;
      if (role === 'user' && !['user', 'schedule'].includes(message?.source?.kind)) return [];
      return [{ source: message?.source?.kind, id: `${sessionId}:${event.seq}`, seq: event.seq, role, text: text(message?.content), requestId: message?.source?.rpcId || '' }];
    });
    const end = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    const status = end?.type === 'turn/start' ? 'running' : end?.data?.reason?.kind === 'completed' ? 'completed'
      : end?.data?.reason?.kind === 'aborted' ? 'cancelled' : end ? 'failed' : 'idle';
    return { messages, status, hasMore: page.hasMore === true, beforeSeq: events[0]?.seq,
      memoryEnabled, scheduleEnabled: Boolean(ctx.get('schedule')) };
  }
  return async (operation, payload = {}) => {
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
}
