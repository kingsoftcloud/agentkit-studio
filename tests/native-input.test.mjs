import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNativeDshInput } from '../src/providers/native-input.mjs';
const user = content => ({ role: 'user', source: { kind: 'user' }, content });
test('Native input preserves admitted context and resolves image bytes only through Host receipts', async () => {
  const ref = { attachmentId: 'trusted-receipt', name: 'image', width: 2, height: 3, path: '/untrusted/path' };
  let reads = 0;
  const input = [user([{ type: 'image', attachment: ref }]),
    { ...user([{ type: 'text', text: 'Trusted resource context' }]), source: { kind: 'tool' } },
    user([{ type: 'text', text: 'Describe this' }, { type: 'image', attachment: ref }])];
  const result = await projectNativeDshInput(input, { attachments: { readImageRequest: async (receipt, target) => {
    assert.deepEqual(receipt, ref); assert.equal(target.maxBytes, 2 * 1024 * 1024);
    reads++; return { mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) };
  } } });
  assert.equal(reads, 1); assert.equal(result.objective, 'Describe this');
  assert.deepEqual(result.messages.map(message => message.kind), ['user_input', 'dsh_context', 'user_input']);
  assert.equal(result.messages[0].media[0].image_url.url, 'data:image/png;base64,AQID');
  assert.notEqual(result.messages[0].media, result.messages[2].media);
  assert.equal(JSON.stringify(result).includes('/untrusted/path'), false);
});
test('Native image-only tasks, offloaded images and Host file handles stay explicit', async () => {
  const image = await projectNativeDshInput([user([{ type: 'image', attachment: { attachmentId: 'image' } }])],
    { attachments: { readImageRequest: async () => ({ mediaType: 'image/webp', data: new Uint8Array([4]) }) } });
  assert.equal(image.messages[0].content, ''); assert.equal(image.messages[0].media.length, 1);
  assert.match(image.objective, /attached input/);
  const ref = { attachmentId: 'file' };
  const file = await projectNativeDshInput([user([{ type: 'image', offloaded: true, attachment: { name: 'receipt' } },
    { type: 'file', attachment: ref }])], { fileRequestText: receipt => {
    assert.equal(receipt, ref); return '<Host-validated-file-handle>';
  } });
  assert.match(file.messages[0].content, /omitted by the Host/);
  assert.match(file.messages[0].content, /Host-validated-file-handle/);
});
test('Native input rejects unowned attachment access, unsupported blocks and empty input', async () => {
  for (const [content, code] of [
    [[{ type: 'image', url: 'https://example.invalid/picture' }], 'STUDIO_IMAGE_ATTACHMENT_UNAVAILABLE'],
    [[{ type: 'file', attachment: { path: '/etc/passwd' } }], 'STUDIO_FILE_ATTACHMENT_UNAVAILABLE'],
    [[{ type: 'audio', data: 'unknown' }], 'STUDIO_NATIVE_INPUT_BLOCK_UNSUPPORTED'],
    [[{ type: 'text', text: '   ' }], 'STUDIO_NATIVE_INPUT_EMPTY'],
  ]) await assert.rejects(projectNativeDshInput([user(content)]), { code });
  await assert.rejects(projectNativeDshInput([user([{ type: 'image', attachment: { attachmentId: 'ref' } }])],
    { attachments: { readImageRequest: async () => ({ mediaType: 'text/html', data: new Uint8Array() }) } }),
  { code: 'STUDIO_IMAGE_ATTACHMENT_INVALID' });
});
test('cancelled attachment resolution cannot admit a late input', async () => {
  const controller = new AbortController();
  await assert.rejects(projectNativeDshInput([user([{ type: 'image', attachment: { attachmentId: 'ref' } }])],
    { signal: controller.signal, attachments: { readImageRequest: async () => {
      controller.abort(new Error('Input cancelled')); return { mediaType: 'image/png', data: new Uint8Array([1]) };
    } } }), /Input cancelled/);
});
