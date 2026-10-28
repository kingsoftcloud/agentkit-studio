import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_DSH_OUTPUT_SCHEMA = { type: 'object', properties: {
  result: { type: 'string' }, images: { type: 'array', items: { type: 'object', properties: {
    attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'integer' },
    width: { type: 'integer' }, height: { type: 'integer' },
  }, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], additionalProperties: true } },
}, required: ['result'], additionalProperties: false };

/** Only Host-native media can enter here. Public DSH blocks always carry durable attachment refs. */
export async function nativeDshBuiltinOutput(outcome, { attachments, signal } = {}) {
  signal?.throwIfAborted();
  const result = typeof outcome.content === 'string' ? outcome.content : canonical(outcome.content);
  const media = outcome.context?.media ?? [];
  invariant(Array.isArray(media), 'studio_native_output_media_invalid');
  if (!media.length) return { result };
  const store = typeof attachments === 'function' ? attachments() : attachments, limits = store?.imageLimits;
  invariant(typeof store?.saveImages === 'function' && limits
    && ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes'].every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)
    && Array.isArray(limits.mediaTypes), 'studio_native_output_attachments_unavailable');
  invariant(media.length <= limits.maxImagesPerMessage, 'studio_native_output_images_too_large');
  let total = 0;
  // Validate the entire batch, including encoding and limits, before asking the
  // attachment store to decode and publish it. No URL or path is ever fetched.
  const images = Array.from(media, (block, index) => {
    invariant(block?.type === 'image_url' && typeof block.image_url?.url === 'string', 'studio_native_output_media_invalid');
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(block.image_url.url);
    invariant(match && match[2].length > 0 && limits.mediaTypes.includes(match[1]), 'studio_native_output_media_invalid');
    invariant(match[2].length <= 4 * Math.ceil(limits.maxImageBytes / 3), 'studio_native_output_images_too_large');
    const data = Buffer.from(match[2], 'base64');
    invariant(data.length > 0 && data.toString('base64') === match[2], 'studio_native_output_media_invalid');
    total += data.length;
    invariant(data.length <= limits.maxImageBytes && total <= limits.maxMessageImageBytes, 'studio_native_output_images_too_large');
    const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].slice('image/'.length);
    return { data, mediaType: match[1], name: `native-observation-${index + 1}.${extension}` };
  });
  signal?.throwIfAborted();
  const refs = await store.saveImages(images);
  signal?.throwIfAborted();
  invariant(Array.isArray(refs) && refs.length === images.length && Array.from(refs).every(ref =>
    ref && typeof ref.attachmentId === 'string' && ref.attachmentId
    && limits.mediaTypes.includes(ref.mediaType) && ['bytes', 'width', 'height'].every(key => Number.isSafeInteger(ref[key]) && ref[key] > 0)),
  'studio_native_output_attachment_invalid');
  return { result, images: structuredClone(refs) };
}

export function renderNativeDshBuiltinOutput(_args, value) {
  return [{ type: 'text', text: value.result }, ...(value.images ?? []).map(attachment => ({
    type: 'image', attachment: structuredClone(attachment),
  }))];
}
