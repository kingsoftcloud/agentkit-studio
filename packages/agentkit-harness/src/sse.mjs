/** Incremental UTF-8 SSE parser shared by model transports. */
export async function* readSse(body, { onDone, onChunk } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    if (bytes.length) onChunk?.();
    buffer += decoder.decode(bytes, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const lines = frame.split(/\r?\n/);
      const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '';
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { onDone?.(); return; }
      if (data) {
        const parsed = JSON.parse(data);
        // Some AgentEngine responses carry the SSE event type on the
        // `event:` line and omit it from the JSON payload. Preserve that
        // transport metadata so cloud completion/error events remain
        // distinguishable after parsing.
        if (eventName && parsed && typeof parsed === 'object' && !parsed.event) {
          yield { ...parsed, event: eventName };
        } else {
          yield parsed;
        }
      }
    }
    if (buffer.length > 4 * 1024 * 1024) throw Object.assign(new Error('模型事件超出大小限制'), { code: 'UPSTREAM_EVENT_TOO_LARGE' });
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw Object.assign(new Error('模型流在事件结束前断开'), { code: 'UPSTREAM_STREAM_TRUNCATED' });
}
