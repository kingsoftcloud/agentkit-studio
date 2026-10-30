// Strict SSE byte framing for the native model transport.
//
// Ports ksadk._model_sse: UTF-8 is deliberately strict (replacing corrupt bytes
// inside JSON changes model facts), a byte budget bounds the whole body, and a
// blank line is the only frame dispatch. A discarded terminal fragment at EOF
// is an unfinished frame, never a complete response. Idle silence is bounded.
//
// This framer yields { data, event } frames and never parses JSON: the protocol
// handlers own envelope validation. [DONE] is yielded as a data frame for the
// handler to seal termination.

export class SseFramingError extends Error {
  constructor(message, code = 'framing_invalid') { super(message); this.name = 'SseFramingError'; this.code = code; }
}

// No nonempty model data arrived within the host's read interval.
export class IdleTimeout extends Error {
  constructor(message = 'model stream idle timeout') { super(message); this.name = 'IdleTimeout'; }
}

// Normalize a fetch body (web ReadableStream or async iterable) to an async
// iterator of Uint8Array chunks. Fetch's response.body is a web ReadableStream
// in Node; both shapes are accepted so tests can feed a plain async iterable.
function toAsyncIterator(body) {
  if (body && typeof body[Symbol.asyncIterator] === 'function') return body[Symbol.asyncIterator]();
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const next = () => reader.read();
    const return_ = async () => {
      try { await reader.cancel(); } catch { /* already closed or released */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
    };
    return { next, return: return_, [Symbol.asyncIterator]() { return this; } };
  }
  throw new SseFramingError('model SSE requires a byte stream');
}

// Stateful line framer mirroring ksadk._model_sse._Framer. CRLF/CR/LF all
// terminate lines; a blank line dispatches a frame from accumulated data lines.
class SseFramer {
  constructor() {
    this.lineParts = [];
    this.dataLines = [];
    this.eventName = '';
    this.afterCr = false;
  }

  feed(text, frames) {
    if (!text) return;
    if (this.afterCr) {
      if (text.startsWith('\n')) text = text.slice(1);
      this.afterCr = false;
    }
    let start = 0;
    for (const m of text.matchAll(/\r\n|\r|\n/g)) {
      this.lineParts.push(text.slice(start, m.index));
      const line = this.lineParts.join('');
      this.lineParts = [];
      start = m.index + m[0].length;
      this.afterCr = m[0] === '\r' && start === text.length;
      const frame = this.handleLine(line);
      if (frame) frames.push(frame);
    }
    if (start < text.length) this.lineParts.push(text.slice(start));
  }

  handleLine(line) {
    if (line === '') {
      if (this.dataLines.length === 0) { this.eventName = ''; return null; }
      const frame = { data: this.dataLines.join('\n'), event: this.eventName || '' };
      this.dataLines = [];
      this.eventName = '';
      return frame;
    }
    if (line.startsWith(':')) return null; // comment / heartbeat
    const sep = line.indexOf(':');
    const name = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? '' : line.slice(sep + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') this.dataLines.push(value);
    else if (name === 'event') this.eventName = value;
    // `id` and `retry` are transport controls, not model payloads; ignore them.
    return null;
  }

  finish() {
    const pending = this.lineParts.join('');
    // A trailing data fragment without a blank-line dispatch is unfinished.
    if (this.dataLines.length || pending === 'data' || pending.startsWith('data:')) {
      throw new SseFramingError('unfinished model SSE data');
    }
  }
}

/**
 * Yield { data, event } SSE frames from a byte stream with strict framing.
 *
 * @param body fetch response body (ReadableStream or async iterable of bytes)
 * @param {maxBytes, idleTimeoutMs, abort} bounds. maxBytes bounds total bytes;
 *   idleTimeoutMs bounds silence between nonempty frames: when it fires, abort
 *   is called with an IdleTimeout so the underlying fetch aborts and the
 *   pending read rejects cleanly (no orphaned read to cancel). Throws
 *   SseFramingError (terminal) or propagates transport/abort errors.
 */
export async function* readModelSse(body, { maxBytes = 8 * 1024 * 1024, idleTimeoutMs, abort, observeBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SseFramingError('model SSE needs a positive byte budget');
  }
  const iter = toAsyncIterator(body);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const framer = new SseFramer();
  let total = 0;
  const idleEnabled = typeof idleTimeoutMs === 'number' && idleTimeoutMs > 0 && typeof abort === 'function';
  let idleTimer = null;
  const armIdle = () => {
    if (!idleEnabled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort(new IdleTimeout()), idleTimeoutMs);
    idleTimer.unref?.();
  };
  const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  armIdle();
  const frames = [];
  try {
    while (true) {
      let result;
      result = await iter.next();
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)) {
        throw new SseFramingError('model SSE requires byte chunks');
      }
      total += chunk.byteLength;
      observeBytes?.(chunk.byteLength);
      if (total > maxBytes) throw new SseFramingError('model SSE byte budget exceeded', 'body_limit');
      let text;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        throw new SseFramingError('invalid utf-8 in model stream', 'body_encoding');
      }
      frames.length = 0;
      framer.feed(text, frames);
      for (const frame of frames) {
        yield frame;
        // Time spent by the consumer is not provider idle time. Comments and
        // blank data do not reset the deadline; only nonempty data does.
        if (frame.data && frame.data.trim()) armIdle();
      }
    }
    let tail;
    try {
      tail = decoder.decode();
    } catch {
      throw new SseFramingError('invalid utf-8 in model stream', 'body_encoding');
    }
    if (tail) {
      frames.length = 0;
      framer.feed(tail, frames);
      for (const frame of frames) yield frame;
    }
    framer.finish();
  } finally {
    disarmIdle();
    // Fire-and-forget: the fetch abort already errored the body stream, and
    // awaiting cancel here must not block propagating the IdleTimeout/abort.
    if (typeof iter.return === 'function') {
      try { Promise.resolve(iter.return()).catch(() => {}); } catch { /* already closed */ }
    }
  }
}
