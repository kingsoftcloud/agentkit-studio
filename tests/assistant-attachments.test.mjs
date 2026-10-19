import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantAttachmentName, assistantAttachmentReceipt, assistantStoredRequest, assistantSubmitInput, readAssistantAttachment } from '../src/client/state/assistant-attachments.mjs';

const receipt = { kind: 'image', receiptId: 'receipt-1', mediaType: 'image/png', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'image.png', bytes: 4 } };
test('durable attachment metadata drops bytes, paths, and extra server fields', () => {
  assert.deepEqual(assistantAttachmentReceipt({ ...receipt, data: 'encoded-secret', path: '/private/image.png', attachment: { ...receipt.attachment, url: 'file:///private', data: 'encoded-secret' } }), receipt);
  assert.equal(assistantAttachmentName('C:\\Users\\private\\name\u0000.png'), 'name.png');
  for (const patch of [{ receiptId: '/private/file' }, { receiptId: 'https://example.com/file' }, { mediaType: 'image/svg+xml' }, { attachment: { ...receipt.attachment, attachmentId: '/private/image.png' } }, { attachment: { ...receipt.attachment, bytes: 21 * 1024 * 1024 } }]) assert.equal(assistantAttachmentReceipt({ ...receipt, ...patch }), null);
});

test('recovery journal parses only safe receipt content and strips UI fields from transport', () => {
  const request = { requestId: 'request-1', timezone: 'Etc/UTC', content: [{ type: 'image', receiptId: receipt.receiptId, mediaType: 'image/png', name: 'image.png' }], attachments: [receipt], observed: true, raw: 'encoded-secret' };
  const parsed = assistantStoredRequest(request);
  assert.deepEqual(parsed, { requestId: request.requestId, timezone: request.timezone, content: request.content, attachments: [receipt] });
  assert.deepEqual(assistantSubmitInput(parsed), { requestId: request.requestId, timezone: request.timezone, content: request.content });
  for (const content of [[{ type: 'image', data: 'encoded-secret', mediaType: 'image/png' }], [{ type: 'image', receiptId: 'receipt-1', mediaType: 'image/png', data: 'secret' }], [{ type: 'file', attachment: receipt.attachment }], [{ type: 'file', receiptId: 'file:///private' }], [], [{ type: 'text', text: ' '.repeat(20) }]]) assert.equal(assistantStoredRequest({ requestId: 'request-1', content }), null);
  assert.equal(assistantStoredRequest({ requestId: 'request-1', text: 'text', content: request.content }), null);
});

function readerFixture() {
  const readers = [];
  class Reader {
    constructor() { readers.push(this); }
    readAsDataURL(file) { this.file = file; }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  return { readers, Reader };
}
test('browser read reports local progress and returns base64 without writing storage', async () => {
  const f = readerFixture(), controller = new AbortController(), progress = [];
  const result = readAssistantAttachment({ name: 'image.png' }, { FileReader: f.Reader, signal: controller.signal, onProgress: value => progress.push(value) });
  const reader = f.readers[0]; reader.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
  reader.result = 'data:image/png;base64,YWJjZA=='; reader.onload();
  assert.equal(await result, 'YWJjZA=='); assert.deepEqual(progress, [50]);
  controller.abort(); assert.equal(reader.aborted, undefined);
});

test('browser read cancellation aborts once and rejects delayed completion', async () => {
  const f = readerFixture(), controller = new AbortController();
  const result = readAssistantAttachment({}, { FileReader: f.Reader, signal: controller.signal });
  controller.abort(); assert.equal(f.readers[0].aborted, true);
  f.readers[0].result = 'data:image/png;base64,YWJjZA=='; f.readers[0].onload();
  await assert.rejects(result, /取消/);
  const before = readerFixture(), preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(readAssistantAttachment({}, { FileReader: before.Reader, signal: preAborted.signal }), /取消/);
  assert.equal(before.readers[0].file, undefined);
});

test('invalid and failed browser reads expose a retryable error', async () => {
  for (const mode of ['error', 'invalid']) {
    const f = readerFixture(), result = readAssistantAttachment({}, { FileReader: f.Reader });
    if (mode === 'error') f.readers[0].onerror();
    else { f.readers[0].result = 'file:///private'; f.readers[0].onload(); }
    await assert.rejects(result, /重新选择/);
  }
  await assert.rejects(readAssistantAttachment({}, { FileReader: class { readAsDataURL() { throw Error('failure'); } } }), /重新选择/);
});
