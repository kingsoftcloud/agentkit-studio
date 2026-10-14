import { randomUUID } from 'node:crypto';

export const CODEX_TOOL_EVENT = 'agentkit/codex-tool';

/**
 * Codex 0.159.2 may return an exec startup error without commandExecution items.
 * Reconcile only command calls from its opt-in raw Responses events. Never expose
 * message/reasoning items; native lifecycle items remain authoritative when present.
 */
export function createCodexCommandFallback() {
  const calls = new Map(), native = new Map();
  return {
    observeRaw(item) {
      if (!item?.call_id) return;
      if (item.type === 'function_call' && item.name === 'exec_command' && (!item.namespace || item.namespace === 'functions')) {
        if (!calls.has(item.call_id)) calls.set(item.call_id, { arguments: item.arguments });
      } else if (item.type === 'function_call_output' && calls.has(item.call_id)) {
        calls.get(item.call_id).output = item.output;
      }
    },
    observeNative(chunk) {
      if (chunk?.type === 'tool') native.set(chunk.id, chunk.phase);
    },
    *flush() {
      for (const [id, call] of calls) {
        const phase = native.get(id);
        if (phase === 'completed' || phase === 'failed') continue;
        const text = typeof call.output === 'string' ? call.output : '';
        // Parse only the executor's leading metadata, not command stdout which
        // may itself contain text such as "Process exited with code 1".
        const match = /^(?:Chunk ID: [^\n]+\n)?Wall time: [^\n]+\nProcess exited with code (-?\d+)\n/.exec(text);
        const exitCode = match ? Number(match[1]) : null;
        const rejected = /^exec_command failed:|^Error parsing function call:/.test(text);
        const known = exitCode !== null || rejected;
        const failed = !known || rejected || exitCode !== 0;
        const tool = { type: 'tool', id, name: 'codex/command', arguments: call.arguments ?? {} };
        if (!phase) yield { ...tool, phase: 'started' };
        yield { ...tool, phase: failed ? 'failed' : 'completed', result: {
          content: [{ type: 'text', text }],
          structuredContent: { status: known ? failed ? 'failed' : 'completed' : 'unknown', exitCode, source: 'codex-raw-command-result' },
        }, ...(failed ? { error: {
          code: known ? 'CODEX_TOOL_FAILED' : 'CODEX_TOOL_OUTCOME_UNKNOWN',
          message: known ? `Codex 命令执行失败${exitCode !== null ? `（exit ${exitCode}）` : ''}` : '未收到 Codex 命令的确定执行状态；请查看返回结果。',
        } } : {}) };
      }
      calls.clear(); native.clear();
    },
  };
}

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

/** Informational facts: presentation and read-only context, never executable DSH tool messages. */
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
          ...(chunk.phase === 'failed' ? { error: { name: 'ToolError', code: chunk.error?.code === 'CODEX_TOOL_OUTCOME_UNKNOWN' ? `${code}_TOOL_OUTCOME_UNKNOWN` : `${code}_TOOL_FAILED`, reason: String(chunk.error?.message || `${label} 工具执行失败`) } } : {}),
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
