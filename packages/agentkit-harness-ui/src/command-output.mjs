import { sanitizeAnsi } from './terminal.mjs';

const states = new Set(['starting', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown', 'unavailable']);
const statusLabels = { starting: '正在启动', running: '执行中', completed: '已结束', failed: '执行失败', canceled: '已停止',
  timed_out: '执行超时', output_limit: '输出达到限制', unknown: '执行结果未知', unavailable: '输出不可用' };
const textWindow = text => { const points = Array.from(text); return { text: points.slice(-131072).join(''), omitted: Math.max(0, points.length - 131072) }; };

/** Cursor values refer to backend bytes, never the redacted display length.
 * This read-only view does not manufacture Harness events or tool receipts.
 */
export function appendCommandOutput(previous, page, request) {
  if (page?.contract !== 'agentkit.studio-command-output/v1' || page.sessionId !== request.sessionId || page.taskId !== request.taskId
    || typeof page.runId !== 'string' || !states.has(page.status)
    || page.command !== undefined && (typeof page.command !== 'string' || page.command.length > 32768)
    || ['stdout', 'stderr'].some(key => typeof page[key] !== 'string' || page[key].length > 65536)
    || ['stdoutCursor', 'stderrCursor'].some(key => !Number.isSafeInteger(page[key]) || page[key] < (request[key] ?? 0))
    || previous && (previous.sessionId !== page.sessionId || previous.taskId !== page.taskId
      || ['stdoutCursor', 'stderrCursor'].some(key => previous[key] !== (request[key] ?? 0)))
    || !previous && ['stdoutCursor', 'stderrCursor'].some(key => (request[key] ?? 0) !== 0))
    throw Error('命令输出窗口或归属已变化');
  const out = textWindow((previous?.stdout ?? '') + (page.stdoutCursor > (request.stdoutCursor ?? 0) ? page.stdout : ''));
  const err = textWindow((previous?.stderr ?? '') + (page.stderrCursor > (request.stderrCursor ?? 0) ? page.stderr : ''));
  return { ...page, stdout: out.text, stderr: err.text,
    omitted: (previous?.omitted ?? 0) + out.omitted + err.omitted,
    exitCode: ['completed', 'failed', 'canceled', 'timed_out', 'output_limit'].includes(page.status)
      && page.evidenceIncomplete !== true && Number.isSafeInteger(page.exitCode) ? page.exitCode : null };
}

/** Peer-injected React; all docking, transport and disclosure stay in the Host. */
export function createCommandOutputComponents(React) {
  const { createElement: h, useEffect, useRef, useState } = React;
  function CommandOutputPane({ output, title = '终端输出', error, onCopy, theme = 'dark' }) {
    const viewport = useRef(null), [following, setFollowing] = useState(true);
    useEffect(() => { if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; },
      [following, output?.stdout, output?.stderr]);
    const stdout = sanitizeAnsi(output?.stdout ?? ''), stderr = sanitizeAnsi(output?.stderr ?? '');
    const muted = theme === 'light' ? '#64666b' : '#96979b';
    return h('section', { 'data-testid': 'native-command-output-pane', style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0,
      color: theme === 'light' ? '#222' : '#e5e5e5', background: theme === 'light' ? '#fff' : '#141414', padding: 16, boxSizing: 'border-box', fontSize: 13 } },
    h('header', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('strong', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: output?.command || title }, output?.command || title),
      onCopy ? h('button', { type: 'button', 'aria-label': '复制终端输出', onClick: () => onCopy(stdout + (stderr ? '\n' + stderr : '')) }, '复制') : null),
    h('p', { 'data-testid': 'command-output-status', style: { color: muted } }, output ? statusLabels[output.status] : '正在读取输出…',
      output?.exitCode !== null && output?.exitCode !== undefined ? ` · 退出码 ${output.exitCode}` : ''),
    error ? h('p', { role: 'alert' }, error) : null,
    output?.withheld ? h('p', { role: 'status' }, '输出等待展示策略处理') : null,
    output?.evidenceIncomplete ? h('p', { role: 'status' }, '执行证据不完整，不能确认最终结果') : null,
    output?.omitted ? h('p', { role: 'status', style: { color: muted } }, `较早的 ${output.omitted} 个字符已从预览省略`) : null,
    h('div', { ref: viewport, style: { overflow: 'auto', flex: 1, minHeight: 0 }, onScroll: () => {
      const node = viewport.current; if (node) setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 12);
    } }, h('pre', { 'data-testid': 'command-output-stdout', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, stdout),
    stderr ? h('pre', { 'data-testid': 'command-output-stderr', 'aria-label': '标准错误输出', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: muted } }, stderr) : null),
    output?.outputMayBeTruncated ? h('p', { style: { color: muted } }, '仍有后续输出，或进程输出已达到保留限制') : null,
    !following ? h('button', { type: 'button', onClick: () => setFollowing(true) }, '回到最新') : null);
  }
  return { CommandOutputPane };
}
