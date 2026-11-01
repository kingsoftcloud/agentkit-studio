import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeDshBuiltinOutput, renderNativeDshBuiltinOutput } from '../src/providers/native-output.mjs';
import { projectNativeDshContent } from '../src/providers/native-input.mjs';

const image = (data = 'cG5n') => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } });
const outcome = media => ({ status: 'ok', content: { ok: true, entry_path: 'index.html' }, context: { content: 'Observed', media } });
function attachments(overrides = {}) {
  const saved = [], ref = { attachmentId: 'sha256:host-image', mediaType: 'image/png', bytes: 3, width: 1280, height: 720 };
  return { saved, ref, imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4,
    maxMessageImageBytes: 2048, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    saveImages: async images => { saved.push(...images); return images.map(() => ({ ...ref })); },
    ...overrides };
}

test('text-only Native output needs no attachment service', async () => {
  assert.deepEqual(await nativeDshBuiltinOutput({ content: 'Plain output' }), { result: 'Plain output' });
  assert.deepEqual(await nativeDshBuiltinOutput(outcome([])), { result: '{"entry_path":"index.html","ok":true}' });
});
test('Native images become durable Host refs before DSH rendering and model projection', async () => {
  const store = attachments(), value = await nativeDshBuiltinOutput(outcome([image()]), { attachments: () => store });
  assert.equal(store.saved.length, 1); assert.equal(store.saved[0].data.toString(), 'png');
  assert.equal(store.saved[0].mediaType, 'image/png'); assert.equal(store.saved[0].name, 'native-observation-1.png');
  const blocks = renderNativeDshBuiltinOutput({}, value);
  assert.deepEqual(blocks[1], { type: 'image', attachment: store.ref });
  assert.equal(JSON.stringify(blocks).includes('base64'), false);
  // The post-policy DSH view is authoritative: removal by a policy also
  // removes image bytes from the next model request.
  const redacted = await projectNativeDshContent(blocks.filter(block => block.type === 'text'));
  assert.equal(redacted.media, undefined);
  let reads = 0;
  store.readImageRequest = async ref => { assert.deepEqual(ref, store.ref); reads++;
    return { mediaType: 'image/png', data: new Uint8Array([112, 110, 103]) }; };
  const projected = await projectNativeDshContent(blocks, { attachments: store });
  assert.equal(reads, 1); assert.deepEqual(projected.media, [image()]);
  assert.deepEqual(projected.presentation.content, blocks);
  value.images[0].attachmentId = 'mutated'; assert.equal(blocks[1].attachment.attachmentId, store.ref.attachmentId);
});
for (const [label, block] of [
  ['remote URL', { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }],
  ['local path', { type: 'image_url', image_url: { url: '/tmp/secret.png' } }],
  ['file URL', { type: 'image_url', image_url: { url: 'file:///tmp/secret.png' } }],
  ['non-image data', { type: 'image_url', image_url: { url: 'data:text/html;base64,aGk=' } }],
  ['noncanonical base64', image('cG5n==')], ['empty image', image('')],
  ['wrong block', { type: 'text', text: 'image' }], ['sparse entry', undefined],
]) test(`${label} rejects the whole image batch before storage`, async () => {
  const store = attachments();
  await assert.rejects(nativeDshBuiltinOutput(outcome([image(), block]), { attachments: store }),
    { code: 'studio_native_output_media_invalid' });
  assert.equal(store.saved.length, 0);
});
test('image count, byte and aggregate limits are taken from the Host deployment', async () => {
  for (const [key, value, media] of [
    ['maxImagesPerMessage', 1, [image(), image()]], ['maxImageBytes', 2, [image()]],
    ['maxMessageImageBytes', 5, [image(), image()]],
  ]) {
    const store = attachments(); store.imageLimits[key] = value;
    await assert.rejects(nativeDshBuiltinOutput(outcome(media), { attachments: store }), { code: 'studio_native_output_images_too_large' });
    assert.equal(store.saved.length, 0);
  }
});
test('missing attachment service or invalid references cannot publish raw media', async () => {
  await assert.rejects(nativeDshBuiltinOutput(outcome([image()])), { code: 'studio_native_output_attachments_unavailable' });
  for (const refs of [[], [{ attachmentId: '/path' }], [{ attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 0, height: 2 }]]) {
    await assert.rejects(nativeDshBuiltinOutput(outcome([image()]), { attachments: attachments({ saveImages: async () => refs }) }),
      { code: 'studio_native_output_attachment_invalid' });
  }
});
test('cancellation before or during attachment storage cannot publish a late image ref', async () => {
  const c = new AbortController(); c.abort(); const store = attachments();
  await assert.rejects(nativeDshBuiltinOutput(outcome([image()]), { signal: c.signal, attachments: store }));
  assert.equal(store.saved.length, 0);
  let release, entered; const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }), signal = new AbortController();
  const pending = nativeDshBuiltinOutput(outcome([image()]), { signal: signal.signal,
    attachments: attachments({ saveImages: async () => { entered(); await gate; return [store.ref]; } }) });
  await started; signal.abort(); release(); await assert.rejects(pending, { name: 'AbortError' });
});
