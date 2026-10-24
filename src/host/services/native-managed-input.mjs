import { copy, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';

export const STUDIO_MANAGED_NATIVE_INPUT = 'agentkit.managed-studio-input/v1';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const receipt = value => typeof value === 'string'
  && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value);
const check = condition => invariant(condition, 'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED');
// Public DSH image admission errors, distinct from storage/provider failures.
const imageInputErrors = new Set(['TOO_MANY_IMAGES', 'IMAGES_TOO_LARGE', 'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64', 'INVALID_IMAGE', 'IMAGE_TYPE_MISMATCH', 'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE']);

/** Validate the wire shape even on recovery, without consulting mutable upload
 * receipts. The versioned parts use the public Session prompt contract, never
 * Host-admitted attachment references, message roles, paths or remote URLs. */
export function managedNativeInputParts(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  check(fields(value, ['format', 'parts']) && value.format === STUDIO_MANAGED_NATIVE_INPUT
    && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.length <= 64);
  let attachments = 0;
  for (const part of value.parts) {
    if (part?.type === 'text') check(fields(part, ['type', 'text']) && typeof part.text === 'string');
    else if (part?.type === 'file') {
      check(fields(part, ['type', 'receiptId']) && receipt(part.receiptId)); attachments++;
    } else if (part?.type === 'image') {
      check(fields(part, ['type', 'mediaType', 'data', 'name'])
        && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mediaType)
        && typeof part.data === 'string' && part.data.length > 0
        && (part.name === undefined || typeof part.name === 'string' && part.name.length <= 255));
      attachments++;
    } else check(false);
  }
  check(attachments <= 8 && Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 ** 2);
  return copy(value.parts);
}

/** Promote new command input through the same public Host services as ordinary
 * Session prompts. Admission bytes and presentation refs subsequently live in
 * the Native configuration/capsule; recovery must not call this function. */
export async function admitManagedNativeInput({ ctx, agent, parts, signal }) {
  const session = agent.session, sessionId = session.id;
  const guard = () => {
    signal.throwIfAborted();
    invariant(agent.session === session && session.id === sessionId, 'NATIVE_MANAGED_OWNER_SESSION_CHANGED');
  };
  guard();
  if (parts.every(part => part.type === 'text')) return copy(parts);
  const uploads = ctx.get('fileUploads'), attachments = ctx.get('attachments');
  invariant(typeof attachments?.admitPromptContent === 'function', 'NATIVE_MANAGED_STUDIO_ATTACHMENT_UNAVAILABLE');
  const content = parts.map(part => {
    if (part.type !== 'file') return copy(part);
    invariant(typeof uploads?.resolve === 'function', 'NATIVE_MANAGED_STUDIO_ATTACHMENT_UNAVAILABLE');
    const ref = uploads.resolve(agent, part.receiptId);
    guard();
    invariant(record(ref) && typeof ref.attachmentId === 'string', 'NATIVE_MANAGED_STUDIO_ATTACHMENT_EXPIRED');
    return { type: 'file', attachment: copy(ref) };
  });
  let admitted;
  try { admitted = await attachments.admitPromptContent(content); }
  catch (error) {
    guard();
    if (attachments.isAttachmentError?.(error) && imageInputErrors.has(error.code))
      invariant(false, 'NATIVE_MANAGED_STUDIO_IMAGE_INVALID');
    throw error;
  }
  guard();
  invariant(Array.isArray(admitted) && admitted.length === parts.length
    && admitted.every((part, index) => part?.type === parts[index].type
      && (part.type === 'text' ? part.text === parts[index].text : record(part.attachment))),
  'NATIVE_MANAGED_STUDIO_ATTACHMENT_INVALID');
  return copy(admitted);
}
