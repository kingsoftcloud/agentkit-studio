import test from 'node:test';
import assert from 'node:assert/strict';
import { managedNativeInputParts, admitManagedNativeInput, STUDIO_MANAGED_NATIVE_INPUT } from '../src/host/services/native-managed-input.mjs';
const receiptId = '08719d71-2117-40f9-9a74-b59ca0337194';
const wire = parts => ({ format: STUDIO_MANAGED_NATIVE_INPUT, parts });

test('managed input explicitly versions public prompt parts and never admits caller-supplied Host references', () => {
  assert.deepEqual(managedNativeInputParts('plain text'), [{ type: 'text', text: 'plain text' }]);
  const value = wire([{ type: 'text', text: 'Inspect' }, { type: 'file', receiptId },
    { type: 'image', mediaType: 'image/png', data: 'AQI=', name: 'input.png' }]);
  const parts = managedNativeInputParts(value); parts[0].text = 'changed';
  assert.equal(value.parts[0].text, 'Inspect');
  for (const content of [
    { ...value, format: 'unknown/v1' }, { ...value, role: 'system' },
    wire([{ type: 'file', attachment: { attachmentId: 'arbitrary' }, receiptId }]),
    wire([{ type: 'file', receiptId: 'not-a-receipt' }]),
    wire([{ type: 'image', url: 'https://example.invalid/input.png' }]),
    wire([{ type: 'image', mediaType: 'image/png', data: 'AQI=', attachment: { path: '/etc/passwd' } }]),
    wire([{ type: 'text', text: 'text', source: { kind: 'tool' } }]),
    wire([{ type: 'audio', data: 'unknown' }]), wire([]),
    wire(Array.from({ length: 65 }, () => ({ type: 'text', text: 'x' }))),
    wire(Array.from({ length: 9 }, () => ({ type: 'file', receiptId }))),
    wire([{ type: 'text', text: 'x'.repeat(2 * 1024 ** 2) }]),
  ]) assert.throws(() => managedNativeInputParts(content), { code: 'NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED' });
});

test('file receipts resolve against the receiving Agent and foreign receipts cannot reach attachment admission', async () => {
  const agent = { session: { id: 'receiver' } }, signal = new AbortController().signal;
  let admission = 0;
  const services = { fileUploads: { resolve(receiver, id) { assert.equal(receiver, agent); assert.equal(id, receiptId); return undefined; } },
    attachments: { admitPromptContent() { admission++; assert.fail('foreign receipt'); } } };
  await assert.rejects(admitManagedNativeInput({ ctx: { get: id => services[id] }, agent,
    parts: managedNativeInputParts(wire([{ type: 'file', receiptId }])), signal }), { code: 'NATIVE_MANAGED_STUDIO_ATTACHMENT_EXPIRED' });
  assert.equal(admission, 0);
});

test('late image admission cannot survive cancellation or a changed receiving Session', async () => {
  for (const mode of ['abort', 'session']) {
    const controller = new AbortController(), agent = { session: { id: 'receiver' } };
    const ctx = { get: id => id === 'attachments' ? { async admitPromptContent() {
      if (mode === 'abort') controller.abort(new Error('Host retired'));
      else agent.session = { id: 'other' };
      return [{ type: 'image', attachment: { attachmentId: 'admitted' } }];
    } } : undefined };
    await assert.rejects(admitManagedNativeInput({ ctx, agent, signal: controller.signal,
      parts: managedNativeInputParts(wire([{ type: 'image', mediaType: 'image/png', data: 'AQI=' }])) }),
    mode === 'abort' ? /Host retired/ : { code: 'NATIVE_MANAGED_OWNER_SESSION_CHANGED' });
  }
});

test('missing attachment services and invalid Host admission remain explicit', async () => {
  const request = { agent: { session: { id: 'session' } }, signal: new AbortController().signal,
    parts: managedNativeInputParts(wire([{ type: 'image', mediaType: 'image/png', data: 'AQI=' }])) };
  await assert.rejects(admitManagedNativeInput({ ...request, ctx: { get: () => undefined } }),
    { code: 'NATIVE_MANAGED_STUDIO_ATTACHMENT_UNAVAILABLE' });
  await assert.rejects(admitManagedNativeInput({ ...request, ctx: { get: () => ({ admitPromptContent: async () => [] }) } }),
    { code: 'NATIVE_MANAGED_STUDIO_ATTACHMENT_INVALID' });
});

test('caller-correctable image admission errors are distinct from unavailable storage', async () => {
  const request = { agent: { session: { id: 'session' } }, signal: new AbortController().signal,
    parts: managedNativeInputParts(wire([{ type: 'image', mediaType: 'image/png', data: 'invalid' }])) };
  for (const code of ['INVALID_IMAGE_BASE64', 'IMAGE_TOO_LARGE', 'ATTACHMENT_WRITE_FAILED']) {
    const original = Object.assign(new Error('Host image admission failed'), { code });
    await assert.rejects(admitManagedNativeInput({ ...request, ctx: { get: () => ({
      isAttachmentError: () => true, admitPromptContent: async () => { throw original; },
    }) } }), error => code === 'ATTACHMENT_WRITE_FAILED' ? error === original : error.code === 'NATIVE_MANAGED_STUDIO_IMAGE_INVALID');
  }
});
