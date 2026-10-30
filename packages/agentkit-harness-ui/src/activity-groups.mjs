import { toolIdentity } from './tool-identity.mjs';
import { isExploreToolCall, isExecuteToolCall, isShellToolCallAwaitingCommand } from './explore-tool-call.mjs';
import { extractCommand } from './terminal.mjs';
import { browserResponseGroups } from './browser-response-groups.mjs';

const changes = new Set(['edit', 'write', 'delete']);
function family(item, enableChangesGrouping) {
  if (!['tool', 'tool-preview'].includes(item.kind) || item.child) return null;
  const call = { kind: item.name, input: item.input };
  return isExploreToolCall(call) ? 'explore' : isExecuteToolCall(call) ? 'terminal'
    : enableChangesGrouping && changes.has(toolIdentity(item.name).family) ? 'changes' : null;
}

/** Match ZCode's Explore summary buckets; this is display, not a file-read receipt. */
function explorationBucket(item) {
  const kind = toolIdentity(item.name).family;
  if (kind === 'web-fetch') return 'web-fetch';
  if (['search', 'web-search'].includes(kind)) return 'search';
  if (kind === 'list') return 'list';
  const command = extractCommand(item.input).toLowerCase();
  if (/(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(command)) return 'search';
  if (/(^|\s)(ls|find|tree|dir)(\s|$)/i.test(command)) return 'list';
  return 'file';
}

function awaitingCommand(item) {
  return (item.kind === 'tool' && ['scheduled', 'running'].includes(item.status)
      || item.kind === 'tool-preview' && item.streaming)
    && isShellToolCallAwaitingCommand({kind: item.name, input: item.input});
}

/** A group represents a visible work stage, not a tool execution. Like ZCode's
 * buildAssistantWorkRenderItems, only the true tail of a running segment keeps
 * its parent active between model calls. Child outcomes remain independent.
 * Narrative, visible reasoning, context markers and child tasks are boundaries.
 */
export function activityGroups(items, { stageTailIsRunning = false, enableChangesGrouping = false, enableBrowserGrouping = true } = {}) {
  // A Shell input draft without a command is transparent to stage boundaries.
  // Filter before counting/tail detection; keep the original event state intact.
  items = items.filter(item => !awaitingCommand(item));
  if (enableBrowserGrouping) items = browserResponseGroups(items, { stageTailIsRunning });
  const result = [];
  for (let index = 0; index < items.length;) {
    const first = items[index++], group = family(first, enableChangesGrouping), children = [first];
    if (group) while (index < items.length && family(items[index], enableChangesGrouping) === group) children.push(items[index++]);
    if (children.length === 1) { result.push(first); continue; }
    const counts = {};
    for (const item of children) {
      const kind = group === 'explore' ? explorationBucket(item) : toolIdentity(item.name).family;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    result.push({ kind: 'activity-group', id: `activity:${group}:${first.callId ?? first.id}`, family: group, children, counts,
      active: stageTailIsRunning && index === items.length,
      failed: children.filter(item => item.status === 'failed').length,
      uncertain: children.filter(item => ['uncertain', 'interrupted', 'waiting'].includes(item.status)).length });
  }
  return result;
}

export function activityGroupSummary(group, locale) {
  const zh = String(locale ?? '').startsWith('zh');
  const units = zh ? { 'web-fetch': '次网页抓取', search: '搜索', list: '列表', file: '文件' }
    : { 'web-fetch': 'fetch', search: 'search', list: 'list', file: 'file' };
  const title = (zh ? { explore: '查阅', terminal: '终端', changes: '更改', browser: '浏览器' }
    : { explore: 'Explore', terminal: 'Terminal', changes: 'Changes', browser: 'Browser' })[group.family];
  const parts = group.family === 'explore'
    ? Object.entries(units).filter(([key]) => group.counts[key])
      .map(([key, unit]) => `${group.counts[key]} ${unit}${!zh && group.counts[key] !== 1 ? key === 'search' || key === 'web-fetch' ? 'es' : 's' : ''}`)
    : [`${group.children.length} ${group.family === 'terminal' ? zh ? '个命令' : 'commands'
      : group.family === 'browser' ? zh ? '次调用' : 'calls' : zh ? '次文件操作' : 'file operations'}`];
  if (group.failed) parts.push(`${group.failed} ${zh ? '失败' : 'failed'}`);
  if (group.uncertain) parts.push(`${group.uncertain} ${zh ? '待核对' : 'unconfirmed'}`);
  return { title, detail: parts.join(', ') };
}
