/** User tasks include reminders delivered by the official cloud scheduler. */
export function isDshUserInput(message) {
  return message?.role === 'user' && (!message.source || ['user', 'schedule'].includes(message.source.kind));
}

/** Resolve DSH's durable image receipts only at the model transport boundary. */
export async function gatewayHistory(messages, { attachments, signal, includeNotices = false } = {}) {
  const images = new Map();
  const contentOf = async message => {
    if (typeof message.content === 'string') return message.content;
    const parts = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' || block?.kind === 'text') {
        parts.push({ type: 'text', text: String(block.text || block.value || '') });
      } else if (block?.type === 'image') {
        if (block.offloaded === true) {
          parts.push({ type: 'text', text: `[Image ${block.attachment?.name || block.attachment?.attachmentId || ''} omitted from this request]` });
          continue;
        }
        const ref = block.attachment;
        const store = typeof attachments === 'function' ? attachments() : attachments;
        if (!ref?.attachmentId || !store?.readImageRequest) {
          throw Object.assign(new Error('无法读取会话图片，请确认 DSH 附件服务已启用'), { code: 'STUDIO_IMAGE_ATTACHMENT_UNAVAILABLE' });
        }
        if (!images.has(ref.attachmentId)) {
          // Admission, integrity verification, encoding and caching belong to
          // DSH. Never treat an attachment identifier as a filesystem path.
          const version = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: 2 * 1024 * 1024 }, signal);
          images.set(ref.attachmentId, { type: 'image_url', image_url: {
            url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
          } });
        }
        parts.push(images.get(ref.attachmentId));
      }
    }
    return parts.some(part => part.type === 'image_url') ? parts : parts.map(part => part.text).join('');
  };
  const history = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (isDshUserInput(message) || (includeNotices && message?.role === 'user' && ['team-message', 'subagent-result'].includes(message.source?.kind))) {
      const content = await contentOf(message);
      if (content?.length) history.push({ role: 'user', content });
    } else if (message?.role === 'assistant') {
      const calls = Array.isArray(message.content) ? message.content.filter(block => block?.type === 'tool-call')
        .map(block => ({ id: String(block.id || ''), type: 'function', function: { name: String(block.name || ''), arguments: String(block.arguments || '{}') } }))
        .filter(call => call.id && call.function.name) : [];
      const content = await contentOf(message);
      if (content || calls.length) history.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (message?.role === 'tool' && message.toolCallId) {
      const content = await contentOf(message);
      if (content?.length) history.push({ role: 'tool', tool_call_id: String(message.toolCallId), content });
    }
  }
  return history;
}
