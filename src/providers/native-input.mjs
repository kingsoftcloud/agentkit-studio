const fail = code => Object.assign(new Error(code), { code });
import { NATIVE_DSH_CONTENT_FORMAT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';

/** Resolve a Host-admitted content block list without consulting message paths or URLs. */
export async function projectNativeDshContent(content, { attachments, fileRequestText, signal } = {}, images = new Map()) {
  if (!Array.isArray(content)) throw fail('STUDIO_NATIVE_INPUT_INVALID');
  const text = [], media = [], blocks = structuredClone(content);
  for (const block of content) {
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
  return { content: text.join('\n'), ...(media.length ? { media } : {}),
    presentation: { format: NATIVE_DSH_CONTENT_FORMAT, content: blocks } };
}

/** Project admitted DSH input through trusted Host attachment services. */
export async function projectNativeDshInput(messages, options = {}) {
  const { signal } = options;
  if (!Array.isArray(messages) || !messages.length) throw fail('STUDIO_NATIVE_INPUT_MISSING');
  const projected = [], images = new Map();
  for (const message of messages) {
    signal?.throwIfAborted();
    if (message?.role !== 'user' || !Array.isArray(message.content)) throw fail('STUDIO_NATIVE_INPUT_INVALID');
    const { content, media } = await projectNativeDshContent(message.content, options, images);
    const kind = ['user', 'schedule'].includes(message.source?.kind) || !message.source ? 'user_input' : 'dsh_context';
    projected.push({ role: 'user', content, kind, ...(media ? { media } : {}) });
  }
  if (!projected.some(message => message.content.trim() || message.media?.length)) throw fail('STUDIO_NATIVE_INPUT_EMPTY');
  const goal = projected.findLast(message => message.kind === 'user_input');
  return { messages: projected, objective: goal?.content.trim() || 'Inspect the attached input and respond to the user.' };
}
