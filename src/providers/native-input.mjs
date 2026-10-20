/** Project admitted DSH input through trusted Host attachment services. */
export async function projectNativeDshInput(messages, { attachments, fileRequestText, signal } = {}) {
  const fail = code => Object.assign(new Error(code), { code });
  if (!Array.isArray(messages) || !messages.length) throw fail('STUDIO_NATIVE_INPUT_MISSING');
  const images = new Map(), projected = [];
  for (const message of messages) {
    signal?.throwIfAborted();
    if (message?.role !== 'user' || !Array.isArray(message.content)) throw fail('STUDIO_NATIVE_INPUT_INVALID');
    const text = [], media = [];
    for (const block of message.content) {
      signal?.throwIfAborted();
      if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
      else if (block?.type === 'image') {
        const ref = block.attachment;
        if (block.offloaded === true) {
          text.push(`[Image ${ref?.name || ref?.attachmentId || ''} omitted by the Host from this request]`);
          continue;
        }
        const store = typeof attachments === 'function' ? attachments() : attachments;
        if (!ref?.attachmentId || typeof store?.readImageRequest !== 'function') throw fail('STUDIO_IMAGE_ATTACHMENT_UNAVAILABLE');
        // The receipt is validated by the Host. Never accept a filesystem path
        // from message blocks, and never fetch a user-supplied URL here.
        const key = JSON.stringify(ref);
        if (!images.has(key)) {
          const image = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: 2 * 1024 * 1024 }, signal);
          signal?.throwIfAborted();
          if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)
            || !(image.data instanceof Uint8Array)) throw fail('STUDIO_IMAGE_ATTACHMENT_INVALID');
          images.set(key, { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` } });
        }
        media.push(structuredClone(images.get(key)));
      } else if (block?.type === 'file') {
        if (typeof fileRequestText !== 'function') throw fail('STUDIO_FILE_ATTACHMENT_UNAVAILABLE');
        const handle = await fileRequestText(block.attachment);
        signal?.throwIfAborted();
        if (typeof handle !== 'string' || !handle) throw fail('STUDIO_FILE_ATTACHMENT_INVALID');
        text.push(handle);
      } else throw fail('STUDIO_NATIVE_INPUT_BLOCK_UNSUPPORTED');
    }
    const kind = ['user', 'schedule'].includes(message.source?.kind) || !message.source ? 'user_input' : 'dsh_context';
    projected.push({ role: 'user', content: text.join('\n'), kind, ...(media.length ? { media } : {}) });
  }
  if (!projected.some(message => message.content.trim() || message.media?.length)) throw fail('STUDIO_NATIVE_INPUT_EMPTY');
  const goal = projected.findLast(message => message.kind === 'user_input');
  return { messages: projected, objective: goal?.content.trim() || 'Inspect the attached input and respond to the user.' };
}
