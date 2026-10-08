import { randomUUID } from 'node:crypto';

export const CODEX_TOOL_EVENT = 'agentkit/codex-tool';

/** Public App Server ThreadItem facts; Codex remains the executor. */
export function codexItemToolChunk(item, phase) {
  if (!item?.id || !['mcpToolCall', 'commandExecution', 'fileChange'].includes(item.type)) return null;
  const command = item.type === 'commandExecution', files = item.type === 'fileChange';
  const failed = item.status !== 'completed' || Boolean(item.error || item.result?.isError)
    || (command && typeof item.exitCode === 'number' && item.exitCode !== 0);
  const result = command ? {
    content: [{ type: 'text', text: String(item.aggregatedOutput || '') }],
    structuredContent: { status: item.status, exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null },
  } : files ? { structuredContent: { status: item.status, changes: item.changes || [] } } : item.result ?? null;
  return { type: 'tool', phase: phase === 'started' ? 'started' : failed ? 'failed' : 'completed',
    id: String(item.id), name: command ? 'codex/command' : files ? 'codex/file-change' : `${item.server}/${item.tool}`,
    arguments: command ? { command: item.command, cwd: item.cwd } : files ? { changes: item.changes || [] } : item.arguments ?? {},
    ...(phase === 'started' ? {} : { result, ...(failed ? { error: item.error || { message: `Codex ${item.type}: ${item.status}${command && item.exitCode != null ? ` (exit ${item.exitCode})` : ''}` } } : {}) }),
  };
}

/** Presentation facts only: never append model-facing tool messages or dispatch tools. */
export function createCodexToolRecorder(session, { label = 'Codex', code = 'CODEX' } = {}) {
  if (typeof session?.append !== 'function') return null;
  const runId = randomUUID();
  const calls = new Map();
  return {
    record(chunk) {
      if (chunk?.type !== 'tool' || !chunk.id || !chunk.name) return false;
      const key = String(chunk.id);
      const previous = calls.get(key);
      if (previous?.settled || (previous && chunk.phase === 'started')) return true;
      if (!['started', 'completed', 'failed'].includes(chunk.phase)) return false;
      const args = chunk.arguments ?? previous?.arguments ?? {};
      const data = {
        callId: `${runId}:${key}`, name: String(chunk.name), phase: chunk.phase,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
        ...(chunk.phase === 'started' ? {} : {
          content: toolContent(chunk.result),
          ...(chunk.phase === 'failed' ? { error: { name: 'ToolError', code: `${code}_TOOL_FAILED`, reason: String(chunk.error?.message || `${label} 工具执行失败`) } } : {}),
        }),
      };
      session.append(CODEX_TOOL_EVENT, data, { ignorable: true });
      calls.set(key, { ...data, settled: chunk.phase !== 'started' });
      return true;
    },
    close() {
      for (const call of calls.values()) {
        if (call.settled) continue;
        session.append(CODEX_TOOL_EVENT, {
          callId: call.callId, name: call.name, arguments: call.arguments,
          phase: 'failed', content: [{ type: 'text', text: `运行已结束，未收到 ${label} 的工具完成结果；实际执行结果尚未确认。` }],
          error: { name: 'Interrupted', code: `${code}_TOOL_OUTCOME_UNKNOWN` },
        }, { ignorable: true });
        call.settled = true;
      }
    },
  };
}

function toolContent(result) {
  const content = result?.content || result?.contentItems;
  const blocks = Array.isArray(content) ? content.map(item => ({ type: 'text', text: typeof item?.text === 'string' ? item.text : JSON.stringify(item) })) : [];
  if (result?.structuredContent != null) blocks.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) });
  if (!blocks.length && result != null) blocks.push({ type: 'text', text: JSON.stringify(result, null, 2) });
  return blocks.map(block => ({ ...block, text: block.text.length > 100_000 ? `${block.text.slice(0, 100_000)}\n[展示内容已截断]` : block.text }));
}
