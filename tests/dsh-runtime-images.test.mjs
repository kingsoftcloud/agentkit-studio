import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshRuntimeAdapter, bindDshAgentRoute, unbindDshAgentRoutes } from '../src/providers/dsh-runtime.mjs';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';
import { gatewayHistory } from '../src/providers/dsh-messages.mjs';

const image = { type: 'image', attachment: { attachmentId: 'image-receipt', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } };
const wireImage = { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } };

for (const runtime of ['dsh-native', 'harness']) {
  for (const text of ['', '这张图片是什么？']) {
    test(`bound ${runtime} preserves ${text ? 'text and image' : 'image-only'} input through the actual local transport`, async t => {
      const agentId = `${runtime}-image-agent`, sessionId = `${runtime}-${Boolean(text)}`;
      t.after(() => unbindDshAgentRoutes(agentId));
      bindDshAgentRoute(sessionId, { agentId, runtime, local: true, agentRevision: 1, nativeTools: true });
      const reads = [], requests = [];
      const handler = createLocalConversationHandler({
        agentStore: async () => ({ getRevision: async (id, revision) => {
          assert.equal(id, agentId); assert.equal(revision, 1);
          return { spec: { instructions: { system: '财务分析师' }, bindings: {} } };
        } }),
        modelService: { profile: async () => ({ modelName: 'vision', baseUrl: 'https://model.test/v1', apiKey: 'test' }) },
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return new Response('data: {"choices":[{"delta":{"content":"看到了图片"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        },
      });
      const adapter = createDshRuntimeAdapter({ localHandler: async () => handler,
        attachments: { readImageRequest: async (ref, _target, signal) => {
          reads.push(ref); assert.equal(signal, undefined);
          return { data: Uint8Array.of(1, 2, 3), mediaType: ref.mediaType };
        } },
      });
      const content = [...(text ? [{ type: 'text', text }] : []), image];
      const frames = [];
      for await (const chunk of adapter.stream({ sessionId, messages: [{ role: 'user', source: { kind: 'user' }, content }] })) frames.push(chunk);
      assert.deepEqual(reads, [image.attachment], 'the official DSH attachment receipt must be read once');
      assert.deepEqual(requests[0].messages.filter(message => message.role === 'user'), [
        { role: 'user', content: [...(text ? [{ type: 'text', text }] : []), wireImage] },
      ], 'the selected model must receive one canonical user turn including actual image bytes');
      assert.ok(frames.some(chunk => chunk.type === 'text-delta' && chunk.text === '看到了图片'));
      assert.equal(frames.at(-1).reason.kind, 'stop');
    });
  }
}

test('DSH continuation preserves prior images, assistant calls and image tool results without rereading receipts', async () => {
  let reads = 0;
  const history = await gatewayHistory([
    { role: 'user', content: [image] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read_image', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [image] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'generated context' }] },
  ], { attachments: { readImageRequest: async () => { reads += 1; return { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }; } } });
  assert.equal(reads, 1);
  assert.deepEqual(history, [
    { role: 'user', content: [wireImage] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_image', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: [wireImage] },
  ]);
});

test('missing or canceled DSH image reads fail before a model call; offloaded images stay offloaded', async () => {
  await assert.rejects(() => gatewayHistory([{ role: 'user', content: [image] }]), { code: 'STUDIO_IMAGE_ATTACHMENT_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => gatewayHistory([{ role: 'user', content: [image] }], {
    signal: controller.signal,
    attachments: { readImageRequest: async (_ref, _target, signal) => { signal.throwIfAborted(); } },
  }), { name: 'AbortError' });
  const history = await gatewayHistory([{ role: 'user', content: [{ ...image, offloaded: true }] }]);
  assert.match(history[0].content, /omitted/);
});

test('a bound Codex image-only turn receives image bytes while empty turns keep a typed error', async t => {
  const agentId = 'codex-image-agent', sessionId = 'codex-image-session';
  t.after(() => unbindDshAgentRoutes(agentId));
  bindDshAgentRoute(sessionId, { agentId, runtime: 'codex', local: true });
  let call;
  const adapter = createDshRuntimeAdapter({
    attachments: { readImageRequest: async () => ({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }) },
    codexRuntime: { async *stream(options) { call = options; yield { type: 'text', text: 'image received' }; } },
  });
  for await (const _chunk of adapter.stream({ sessionId, messages: [{ role: 'user', content: [image] }] })) {}
  assert.equal(call.input, ''); assert.deepEqual(call.imageInputs, [wireImage.image_url.url]);
  await assert.rejects(async () => { for await (const _chunk of adapter.stream({ sessionId, messages: [{ role: 'user', content: [] }] })) {} }, { code: 'STUDIO_INPUT_REQUIRED' });
});
