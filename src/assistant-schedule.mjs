/** Receipt-scoped management over native DSH Schedule storage and delivery history. */
import { isAssistantScheduleOperation } from './contracts/assistant-schedule.mjs';
const fail = message => Object.assign(new Error(message), { code: 'ASSISTANT_SCHEDULE_INPUT_INVALID', status: 400 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const fields = { after: ['afterSeconds'], at: [], every: ['everySeconds'], daily: ['time', 'timeZone'], weekly: ['time', 'timeZone', 'weekdays'], cron: ['expression', 'timeZone'] };

/** Require the complete observed native record; never fabricate a fresh comparison target. */
export function assistantScheduleExpected(value, taskId) {
  if (!object(value) || !Object.hasOwn(fields, value.kind)) throw fail('请刷新任务详情后再修改');
  const keys = ['id', 'kind', 'title', 'prompt', 'scheduledAt', ...fields[value.kind]];
  if (!exact(value, keys) || Object.keys(value).length !== keys.length || value.id !== taskId
    || !['id', 'title', 'prompt', 'scheduledAt'].every(key => typeof value[key] === 'string' && value[key].length)
    || fields[value.kind].some(key => key === 'weekdays' ? !Array.isArray(value[key]) || !value[key].length || value[key].some(day => !Number.isInteger(day))
      : ['afterSeconds', 'everySeconds'].includes(key) ? !Number.isSafeInteger(value[key]) || value[key] < 1 : typeof value[key] !== 'string' || !value[key])) throw fail('请刷新任务详情后再修改');
  return value;
}

/** Execute only for the server-derived Session, retaining native CAS and cancellation semantics. */
export async function executeAssistantSchedule({ schedule, operation, payload, sessionId, ensure, serialize, signal }) {
  if (!isAssistantScheduleOperation(operation)) throw fail('不支持的定时任务操作');
  if (!schedule) throw Object.assign(new Error('请在云端镜像启用 DSH 官方定时任务插件'), { code: 'ASSISTANT_SCHEDULE_UNAVAILABLE', status: 503 });
  const allowed = operation === 'schedule-create' ? ['spec'] : operation === 'schedule-update' ? ['id', 'expected', 'change', 'title', 'prompt']
    : operation === 'schedule-history' ? ['id', 'limit', 'before'] : ['schedule-get', 'schedule-delete'].includes(operation) ? ['id'] : [];
  if (!exact(payload, ['conversation', ...allowed]) || allowed.includes('id') && !id(payload.id)) throw fail('任务操作只接受当前助理会话的任务标识');
  signal?.throwIfAborted();
  if (['schedule-catalog', 'schedule-list', 'schedule-get'].includes(operation)) {
    const items = (await schedule.catalog()).filter(item => item.sessionId === sessionId);
    signal?.throwIfAborted();
    if (operation === 'schedule-get') return { item: items.find(item => item.id === payload.id) ?? null };
    // Preserve schedule-list's original retained-catalog behavior for existing clients.
    return { sessionId, items };
  }
  if (operation === 'schedule-history') {
    if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100 || payload.before !== undefined && !id(payload.before)) throw fail('请选择有效的投递记录页');
    const result = await schedule.history({ sessionId, id: payload.id, limit: payload.limit, ...(payload.before === undefined ? {} : { before: payload.before }) });
    signal?.throwIfAborted(); return result;
  }
  if (operation === 'schedule-delete') return schedule.delete({ sessionId, id: payload.id }, signal);
  if (operation === 'schedule-update') {
    const expected = assistantScheduleExpected(payload.expected, payload.id);
    return schedule.update({ sessionId, id: payload.id, expected,
      ...(payload.change === undefined ? {} : { change: payload.change }), ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }) }, signal);
  }
  if (!exact(payload.spec, ['title', 'prompt', 'after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'])) throw fail('请输入原生定时任务规则');
  return serialize(sessionId, async () => {
    signal?.throwIfAborted();
    await ensure(sessionId);
    signal?.throwIfAborted();
    // Once native persistence starts, a lost response is an unknown outcome.
    // Callers must inspect the catalog instead of retrying a create automatically.
    return schedule.create(sessionId, payload.spec, signal);
  });
}
