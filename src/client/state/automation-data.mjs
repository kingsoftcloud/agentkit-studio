export function localDateTimeValue(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleLabel(task) {
  const schedule = task?.schedule || {};
  if (schedule.kind === 'cron') return `Cron · ${schedule.expression || '—'}`;
  if (schedule.kind === 'interval' || schedule.kind === 'every') {
    const seconds = Number(schedule.everySeconds || schedule.every_seconds || 0);
    if (seconds >= 86400 && seconds % 86400 === 0) return `每 ${seconds / 86400} 天`;
    if (seconds >= 3600 && seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
    if (seconds >= 60 && seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
    return `每 ${seconds || '—'} 秒`;
  }
  if (schedule.kind === 'after') return `延迟 ${schedule.afterSeconds || schedule.after_seconds || '—'} 秒`;
  if (schedule.kind === 'daily') return `每天 ${schedule.time || '—'}`;
  if (schedule.kind === 'weekly') return `每周 ${schedule.time || '—'}`;
  if (schedule.kind === 'at') return schedule.scheduledAt ? `一次 · ${new Date(schedule.scheduledAt).toLocaleString()}` : '一次性任务';
  return schedule.at ? `一次 · ${new Date(schedule.at).toLocaleString()}` : '一次性任务';
}

export function scheduleNeedsRefresh(task, latest) {
  if (['claimed', 'accepted', 'running', 'admitting'].includes(latest?.state)
    || ['waiting_result', 'pending', 'queued', 'sending', 'retrying'].includes(latest?.deliveryState)) return true;
  return task.enabled !== false && Boolean(task.nextRunAt) && new Date(task.nextRunAt).getTime() <= Date.now();
}
