// Thin host-side client for agentkit.engine/v1.
//
// Vendored from @kingsoftcloud/agentkit-harness-node (native/engine-client.mjs).
// Studio keeps its own copy on purpose: this file is the whole of Studio's
// compile-time knowledge of the engine. It is updated only for a new protocol
// major version, never for an engine release.
//
// This file contains no engine logic and imports none: it frames JSON-RPC over
// a child process's stdio. A host may vendor it, or reimplement it in another
// language from the protocol alone. It needs to change only when the protocol
// major version changes.
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

export const ENGINE_PROTOCOL = 'agentkit.engine/v1';

/** Connect to an engine over a pair of streams (a spawned process, a socket, or an in-memory pair in tests). */
export function connectEngine({ input, output, onApproveTool, onCallTool, hostName = 'host' }) {
  let next = 1, closed = false;
  const pending = new Map();
  const send = frame => output.write(`${JSON.stringify(frame)}\n`);
  const frames = readline.createInterface({ input, crlfDelay: Infinity });
  const finished = (async () => {
    for await (const line of frames) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.method !== undefined) {
        // Engine -> host request. Unknown methods are refused, never guessed.
        if (frame.method === 'host/approveTool' && typeof onApproveTool === 'function') {
          Promise.resolve().then(() => onApproveTool(frame.params ?? {}))
            .then(decision => send({ jsonrpc: '2.0', id: frame.id, result: { decision: decision === 'allow' ? 'allow' : 'deny' } }),
              () => send({ jsonrpc: '2.0', id: frame.id, result: { decision: 'deny' } }));
        } else if (frame.method === 'host/callTool' && typeof onCallTool === 'function') {
          Promise.resolve().then(() => onCallTool(frame.params ?? {}))
            .then(reply => send({ jsonrpc: '2.0', id: frame.id, result: { status: reply?.status === 'error' ? 'error' : 'ok', content: reply?.content ?? null } }),
              error => send({ jsonrpc: '2.0', id: frame.id, result: { status: 'error', content: { code: 'host_tool_failed', message: String(error?.message ?? error).slice(0, 2000) } } }));
        } else if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code, data: frame.error.data }));
      else waiter.resolve(frame.result);
    }
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error('engine connection closed'));
    pending.clear();
  })();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('engine connection closed')); return; }
    const id = next++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return {
    call, finished,
    initialize: () => call('initialize', { protocolVersions: [ENGINE_PROTOCOL], host: { name: hostName },
      services: { approvals: typeof onApproveTool === 'function', tools: typeof onCallTool === 'function' } }),
    startRun: params => call('run/start', params),
    status: runId => call('run/status', { runId }),
    events: (runId, cursor = 0, waitMs = 0, thinkingCursor, toolDraftCursor) =>
      call('run/events', { runId, cursor, waitMs, thinkingCursor, toolDraftCursor }),
    resume: runId => call('run/resume', { runId }),
    cancel: runId => call('run/cancel', { runId }),
    view: () => call('ui/view'),
    shutdown: () => call('shutdown'),
    /** Follow a Run to rest, handing each projected event to `onEvent`. */
    async follow(runId, onEvent = () => {}, { waitMs = 5000 } = {}) {
      for (let cursor = 0; ;) {
        const page = await call('run/events', { runId, cursor, waitMs });
        for (const event of page.events) onEvent(event);
        cursor = page.cursor;
        if (!page.running && page.events.length === 0) return call('run/status', { runId });
      }
    },
  };
}

/** Start an engine executable and connect to it. `command` is host configuration, not host code. */
export function spawnEngine({ command, args = [], env, onApproveTool, onCallTool, hostName, onLog = () => {} }) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8').on('data', chunk => onLog(chunk));
  const client = connectEngine({ input: child.stdout, output: child.stdin, onApproveTool, onCallTool, hostName });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { ...client, child, exited,
    async close() { try { await client.shutdown(); } catch { /* already gone */ } child.stdin.end(); return exited; } };
}
