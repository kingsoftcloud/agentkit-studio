import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantConversation, createAssistantImageCache } from '../src/client/dsh/assistant-conversation.mjs';
import { createAssistantRoutes } from '../src/host/routes/assistant.mjs';

const image = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'result.png' };
function cacheFixture(execute) {
  const created = [], revoked = [];
  const cache = createAssistantImageCache({ agentId: 'cloud-a', hostRemote: { assistantExecute: execute },
    URL: { createObjectURL: blob => { created.push(blob); return `blob:test-${created.length}`; }, revokeObjectURL: url => revoked.push(url) },
    Blob, decode: text => Buffer.from(text, 'base64').toString('binary') });
  return { cache, created, revoked };
}

test('native assembly deduplicates complete windows without retaining a local session', () => {
  const calls = [];
  const registry = { events: {}, views: {}, groups: {} };
  class Assembler {
    constructor(...args) { assert.deepEqual(args, [registry.events, registry.views, registry.groups]); }
    replaceWindow(entries, hasMore) { calls.push({ entries, hasMore }); }
    activateTarget(target) { assert.equal(target, 'chat'); }
    snapshot(target) { assert.equal(target, 'chat'); return { nodes: new Map([['one', { visibility: 'visible', kind: 'tool-call' }], ['two', { visibility: 'hidden' }]]) }; }
  }
  const owner = createAssistantConversation({ ConversationNodeAssembler: Assembler });
  assert.equal(owner.assemble([]), null);
  const dispose = owner.bind(registry);
  assert.equal(owner.assemble([{ seq: 3 }, { seq: 1 }, { seq: 3, latest: true }, { seq: 'invalid' }], true).length, 1);
  assert.deepEqual(calls[0], { entries: [{ type: 'event', event: { seq: 1 } }, { type: 'event', event: { seq: 3, latest: true } }], hasMore: true });
  dispose();
  assert.equal(owner.assemble([]), null);
});

test('native assembly supplies only an empty provider stream without mutating published events', () => {
  const inputs = [];
  class Assembler {
    replaceWindow(entries) { inputs.push(...entries); }
    activateTarget() {}
    snapshot() { return { nodes: new Map() }; }
  }
  const owner = createAssistantConversation({ ConversationNodeAssembler: Assembler });
  owner.bind({ events: {}, views: {}, groups: {} });
  const missing = { seq: 1, type: 'assistant/message', data: { message: { content: [] } } };
  const raw = { seq: 2, type: 'assistant/message', data: { stream: [{ privateProviderObject: 'never-display' }] } };
  owner.assemble([missing, raw]);
  assert.deepEqual(inputs.map(entry => entry.event.data.stream), [[], []]);
  assert.equal(missing.data.stream, undefined);
  assert.equal(raw.data.stream[0].privateProviderObject, 'never-display');
  assert.ok(!JSON.stringify(inputs).includes('never-display'));
});

test('image reads use cloud assistant receipts, share one request and release object URLs', async () => {
  const calls = [];
  const f = cacheFixture(async (...args) => { calls.push(args); return { attachment: image, data: 'YWJj' }; });
  assert.deepEqual(await Promise.all([f.cache.read(image), f.cache.read(image)]), ['blob:test-1', 'blob:test-1']);
  assert.deepEqual(calls, [['cloud-a', 'image-read', { attachmentId: image.attachmentId }]]);
  assert.equal(f.created[0].type, 'image/png');
  assert.equal(await f.created[0].text(), 'abc');
  f.cache.dispose();
  assert.deepEqual(f.revoked, ['blob:test-1']);
  await assert.rejects(f.cache.read(image), /已关闭/);
});

test('image cache rejects foreign receipts and active content and retries failed reads', async () => {
  let response = { attachment: { ...image, attachmentId: 'foreign' }, data: 'YWJj' }, calls = 0;
  const f = cacheFixture(async () => { calls++; return response; });
  await assert.rejects(f.cache.read(image), /无法识别/);
  response = { attachment: { ...image, mediaType: 'image/svg+xml' }, data: 'YWJj' };
  await assert.rejects(f.cache.read(image), /无法识别/);
  response = { attachment: image, data: 'YWJj' };
  assert.equal(await f.cache.read(image), 'blob:test-1');
  assert.equal(calls, 3);
  f.cache.dispose();
});

test('late image completion after leaving the view creates no retained blob URL', async () => {
  let resolve;
  const f = cacheFixture(() => new Promise(done => { resolve = done; }));
  const pending = f.cache.read(image);
  f.cache.dispose();
  resolve({ attachment: image, data: 'YWJj' });
  await assert.rejects(pending, /已关闭/);
  assert.equal(f.created.length, 0);
});

test('old cloud images cannot receive unsupported image requests or fall back to local files', async () => {
  let calls = 0;
  const route = createAssistantRoutes({ deployments: async () => ({ agents: { connect: async () => ({
    agent: { spec: { runtime: { type: 'dsh-native' } } }, endpoint: 'https://owned.invalid', token: 'hidden', capabilities: ['personal-assistant/v1'],
  }) } }), fetchImpl: async () => { calls++; } });
  await assert.rejects(route('assistant/execute', { agentId: 'cloud-a', operation: 'image-read', input: { attachmentId: image.attachmentId } }), { code: 'ASSISTANT_IMAGE_UPGRADE_REQUIRED' });
  assert.equal(calls, 0);
});

test('cloud files download only by native receipt into an inert binary blob', async () => {
  const { createAssistantFileCache, downloadAssistantFile } = await import('../src/client/dsh/assistant-conversation.mjs');
  const file = { attachmentId: `sha256:${'f'.repeat(64)}`, name: 'report.html', bytes: 3 }, calls = [], blobs = [], revoked = [];
  const cache = createAssistantFileCache({ agentId: 'cloud-owned', hostRemote: { assistantExecute: async (...args) => { calls.push(args); return { attachment: file, data: 'YWJj' }; } },
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:download'; }, revokeObjectURL: url => revoked.push(url) }, Blob });
  const result = await cache.read(file); assert.deepEqual(await cache.read(file), result);
  assert.deepEqual(calls[0].slice(0, 3), ['cloud-owned', 'file-read', { attachmentId: file.attachmentId }]);
  assert.equal(calls.length, 1); assert.equal(blobs[0].type, 'application/octet-stream'); assert.equal(await blobs[0].text(), 'abc');
  const links = [];
  const document = { createElement: tag => { assert.equal(tag, 'a'); const link = { click() { this.clicked = true; }, remove() { this.removed = true; } }; links.push(link); return link; }, body: { appendChild() {} } };
  downloadAssistantFile(result, document); assert.equal(links[0].download, 'report.html'); assert.equal(links[0].href, 'blob:download'); assert.equal(links[0].clicked, true); assert.equal(links[0].removed, true);
  assert.throws(() => downloadAssistantFile({ url: 'file:///private/report.html', name: 'report.html' }, document), /无法识别/);
  cache.dispose(); assert.deepEqual(revoked, ['blob:download']); assert.equal(calls[0][3].aborted, true);
  await assert.rejects(cache.read(file), /已关闭/);
});

test('file cache rejects paths, foreign metadata, active URLs, and mismatched bytes', async () => {
  const { createAssistantFileCache, assistantFileReference } = await import('../src/client/dsh/assistant-conversation.mjs');
  const file = { attachmentId: `sha256:${'f'.repeat(64)}`, name: '/cloud/private/report.txt', bytes: 3 };
  let calls = 0, response = { attachment: { ...file, attachmentId: `sha256:${'b'.repeat(64)}` }, data: 'YWJj' };
  const cache = createAssistantFileCache({ agentId: 'cloud-owned', hostRemote: { assistantExecute: async () => { calls++; return response; } },
    URL: { createObjectURL: () => 'blob:download', revokeObjectURL() {} }, Blob });
  assert.equal(assistantFileReference({ path: '/cloud/private/report.txt' }), null);
  await assert.rejects(cache.read({ path: '/cloud/private/report.txt' }), /凭据/); assert.equal(calls, 0);
  for (const invalid of [response, { attachment: file, data: 'YWJjZA==' }, { attachment: file, data: 'https://example.com' }, { attachment: file, data: 'file:///private' }]) {
    response = invalid; await assert.rejects(cache.read(file), /无法识别/);
  }
  response = { attachment: file, data: 'YWJj' }; assert.deepEqual(await cache.read(file), { url: 'blob:download', name: 'report.txt' });
  cache.dispose();
});

test('leaving cancels pending cloud downloads and late results create no blob URL', async () => {
  const { createAssistantFileCache } = await import('../src/client/dsh/assistant-conversation.mjs');
  let resolve, signal, created = 0;
  const file = { attachmentId: `sha256:${'f'.repeat(64)}`, name: 'report.txt', bytes: 3 };
  const cache = createAssistantFileCache({ agentId: 'cloud-owned', hostRemote: { assistantExecute: (_agent, _operation, _input, value) => { signal = value; return new Promise(done => { resolve = done; }); } },
    URL: { createObjectURL: () => { created++; return 'blob:download'; }, revokeObjectURL() {} }, Blob });
  const request = cache.read(file); cache.dispose(); assert.equal(signal.aborted, true);
  resolve({ attachment: file, data: 'YWJj' }); await assert.rejects(request, /已关闭/); assert.equal(created, 0);
});

test('identical cloud file bytes share one blob but retain each native filename', async () => {
  const { createAssistantFileCache } = await import('../src/client/dsh/assistant-conversation.mjs');
  const first = { attachmentId: `sha256:${'d'.repeat(64)}`, name: 'one.txt', bytes: 3 };
  let calls = 0;
  const cache = createAssistantFileCache({ agentId: 'cloud-owned', hostRemote: { assistantExecute: async () => { calls++; return { attachment: first, data: 'YWJj' }; } },
    URL: { createObjectURL: () => 'blob:shared', revokeObjectURL() {} }, Blob });
  assert.deepEqual(await cache.read(first), { url: 'blob:shared', name: 'one.txt' });
  assert.deepEqual(await cache.read({ ...first, name: '/cloud/two.csv' }), { url: 'blob:shared', name: 'two.csv' });
  assert.equal(calls, 1);
  await assert.rejects(cache.read({ ...first, bytes: 4 }), /大小/);
  cache.dispose();
});
