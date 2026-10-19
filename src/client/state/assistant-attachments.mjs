/** Browser attachment inputs retain cloud receipts only; bytes never enter durable drafts. */
import { ASSISTANT_ATTACHMENT_LIMITS } from '../../contracts/assistant-attachments.mjs';
export { ASSISTANT_ATTACHMENT_LIMITS };
const imageType = value => /^image\/(png|jpeg|webp|gif)$/.test(value || '');
const receiptId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export const assistantAttachmentName = value => String(value || '附件').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || '附件';
export const assistantRequestText = request => typeof request?.text === 'string' ? request.text : (request?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');

/** Copy the supported cloud metadata fields, rejecting inline bytes and path identities. */
export function assistantAttachmentReceipt(value) {
  const ref = value?.attachment;
  if (!['image', 'file'].includes(value?.kind) || !receiptId(value.receiptId) || !/^sha256:[a-f0-9]{64}$/.test(ref?.attachmentId || '')
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > ASSISTANT_ATTACHMENT_LIMITS.maxAttachmentBytes
    || typeof ref.name !== 'string' || !ref.name || value.kind === 'image' && (!imageType(value.mediaType) || !ref.bytes)) return null;
  return { receiptId: value.receiptId, kind: value.kind, attachment: { attachmentId: ref.attachmentId, name: assistantAttachmentName(ref.name), bytes: ref.bytes },
    ...(value.kind === 'image' ? { mediaType: value.mediaType } : {}) };
}

/** Stable wire parts are replayed with the same request ID after an unknown ACK. */
export function assistantAttachmentContent(receipts) {
  return receipts.map(value => ({ type: value.kind, receiptId: value.receiptId,
    ...(value.kind === 'image' ? { mediaType: value.mediaType, name: value.attachment.name } : {}) }));
}

/** Parse local recovery records without retaining unrecognized or encoded fields. */
export function assistantStoredRequest(value) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value.requestId || '')) return null;
  const common = { requestId: value.requestId, ...(typeof value.timezone === 'string' && value.timezone.length <= 128 ? { timezone: value.timezone } : {}) };
  if (typeof value.text === 'string' && value.text.trim() && value.text.length <= 32000 && value.content === undefined) return { ...common, text: value.text };
  if (value.text !== undefined || !Array.isArray(value.content) || !value.content.length || value.content.length > ASSISTANT_ATTACHMENT_LIMITS.maxAttachments + 1) return null;
  const content = [];
  let chars = 0, count = 0;
  for (const part of value.content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      chars += part.text.length;
      if (chars > 32000) return null;
      content.push({ type: 'text', text: part.text });
    } else if (['image', 'file'].includes(part?.type) && receiptId(part.receiptId) && part.data === undefined && part.attachment === undefined) {
      if (++count > ASSISTANT_ATTACHMENT_LIMITS.maxAttachments || part.type === 'image' && !imageType(part.mediaType)) return null;
      content.push({ type: part.type, receiptId: part.receiptId, ...(part.type === 'image' ? { mediaType: part.mediaType, ...(typeof part.name === 'string' ? { name: assistantAttachmentName(part.name) } : {}) } : {}) });
    } else return null;
  }
  const attachments = (Array.isArray(value.attachments) ? value.attachments : []).map(assistantAttachmentReceipt).filter(Boolean)
    .filter(ref => content.some(part => part.type === ref.kind && part.receiptId === ref.receiptId));
  return { ...common, content, ...(attachments.length ? { attachments } : {}) };
}

/** Product transport accepts only request fields, never UI metadata or observation flags. */
export function assistantSubmitInput(request) {
  return { requestId: request.requestId, ...(request.timezone ? { timezone: request.timezone } : {}),
    ...(request.content ? { content: request.content } : { text: request.text }) };
}

/** Read selected browser bytes with cancellation and truthful local-read progress. */
export function readAssistantAttachment(file, { FileReader, signal, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const aborted = () => { reader.abort(); reject(new Error('上传已取消')); };
    const clear = () => signal?.removeEventListener('abort', aborted);
    if (signal?.aborted) { reject(new Error('上传已取消')); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    reader.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.min(100, Math.floor(event.loaded / event.total * 100))); };
    reader.onerror = () => { clear(); reject(new Error('无法读取附件，请重新选择')); };
    reader.onabort = () => { clear(); reject(new Error('上传已取消')); };
    reader.onload = () => {
      clear();
      if (signal?.aborted) { reject(new Error('上传已取消')); return; }
      const result = reader.result;
      if (typeof result !== 'string' || !/^data:[^,]*;base64,/.test(result)) { reject(new Error('无法读取附件，请重新选择')); return; }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    try { reader.readAsDataURL(file); } catch { clear(); reject(new Error('无法读取附件，请重新选择')); }
  });
}
