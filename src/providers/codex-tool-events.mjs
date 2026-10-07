import { randomUUID } from 'node:crypto';

export const CODEX_TOOL_EVENT = 'agentkit/codex-tool';

/** Presentation facts only: never append model-facing tool messages or dispatch tools. */
export function createCodexToolRecorder(session) {
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
          ...(chunk.phase === 'failed' ? { error: { name: 'CodexToolError', code: 'CODEX_TOOL_FAILED', reason: String(chunk.error?.message || 'Codex 工具执行失败') } } : {}),
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
          phase: 'failed', content: [{ type: 'text', text: '运行已结束，未收到 Codex 的工具完成结果；实际执行结果尚未确认。' }],
          error: { name: 'Interrupted', code: 'CODEX_TOOL_OUTCOME_UNKNOWN' },
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
