import { LOCAL_COMMAND_PROGRESS_CONTRACT } from './local-command-tools.mjs';

export const COMMAND_PREVIEW_CONTRACT = 'agentkit.command-preview/v1';

/** One invocation owns this observation channel. Raw process output reaches
 * only the Host's required projector, never the UI/model or a durable receipt.
 * A projector may hold data or return null; final-result policies alone do not
 * authorize previews. The Host must provide equivalent streaming governance.
 */
export function createCommandProgressObserver({ signal, isCurrent, project, publish, maxBytes = 65536 } = {}) {
  if (!(signal instanceof AbortSignal) || typeof isCurrent !== 'function' || typeof project !== 'function'
    || typeof publish !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 1048576)
    throw new TypeError('command_progress_host_capabilities_required');
  let closed = false, draining = false, pending = null, sequence = 0, retained = 0;
  let stdout = '', stderr = '', truncated = false;
  const current = () => {
    if (closed || signal.aborted) return false;
    try {
      const value = isCurrent();
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
      return value === true;
    } catch { return false; }
  };
  const close = () => { closed = true; pending = null; stdout = ''; stderr = ''; signal.removeEventListener('abort', close); };
  signal.addEventListener('abort', close, { once: true });
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending && current()) {
        const snapshot = pending; pending = null;
        try {
          const output = await project(snapshot, { signal });
          if (!current() || !output || typeof output !== 'object' || Array.isArray(output) || output.kind !== 'command_preview'
            || Object.keys(output).some(key => !['kind', 'stdout', 'stderr'].includes(key))
            || typeof output.stdout !== 'string' || typeof output.stderr !== 'string'
            || Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > maxBytes) continue;
          const frame = Object.freeze({ contract: COMMAND_PREVIEW_CONTRACT, sequence: snapshot.sequence,
            display: Object.freeze({ kind: 'command_preview', stdout: output.stdout, stderr: output.stderr }),
            truncated: snapshot.truncated });
          Promise.resolve(publish(frame)).catch(() => {});
        } catch { /* projection, malformed output and publication cannot fail execution */ }
      }
    } finally { draining = false; }
  }
  return Object.freeze({
    observe(frame) {
      if (!current() || frame?.contract !== LOCAL_COMMAND_PROGRESS_CONTRACT
        || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence
        || !['stdout', 'stderr'].includes(frame.channel) || typeof frame.text !== 'string') return;
      sequence = frame.sequence;
      const bytes = Buffer.from(frame.text), available = Math.max(0, maxBytes - retained);
      const text = new TextDecoder('utf8', { ignoreBOM: true }).decode(bytes.subarray(0, available), { stream: true });
      retained += Math.min(available, bytes.length); truncated ||= bytes.length > available;
      if (frame.channel === 'stdout') stdout += text; else stderr += text;
      // One bounded pending snapshot coalesces a fast producer behind a slow
      // governor. No per-chunk promise queue or unbounded output buffer.
      pending = Object.freeze({ contract: LOCAL_COMMAND_PROGRESS_CONTRACT, sequence,
        stdout, stderr, truncated });
      void drain();
    },
    close,
  });
}
