import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { buildNativeModelRequest } from '../src/native/model-request.mjs';
import { projectRequestMedia } from '../src/native/model-media.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-workspace-media-'));
  const root = join(directory, 'workspace'); mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = createNativeWorkspaceTools({ workspaceRoot: root, stateDir: join(directory, 'state'), sessionId: 'session', authorize: async () => 'allow' });
  let index = 0;
  return { directory, root, read: (path, { media = true } = {}) => tools.execute({ sessionId: 'session', operationKey: `read-${++index}`,
    call: { callId: `call-${index}`, name: 'read_workspace_file', arguments: { path } },
    definition: { ...tools.definitions.find(tool => tool.name === 'read_workspace_file'),
      ...(media ? { workspaceMediaPolicy: 'bounded-image-read/v1' } : {}) }, signal: new AbortController().signal }) };
}
function png() {
  const image = new PNG({ width: 64, height: 32 }); image.data.fill(180);
  return PNG.sync.write(image);
}

test('workspace image read has a binary model observation and a small receipt, without treating it as a text edit read', async t => {
  const run = setup(t), bytes = png(); writeFileSync(join(run.root, 'sample.png'), bytes);
  const result = await run.read('sample.png');
  assert.equal(result.status, 'ok'); assert.equal(result.content.observation_kind, 'image');
  assert.equal(result.content.width, 64); assert.equal(result.content.height, 32);
  assert.equal(result.context.media.length, 1); assert.ok(!JSON.stringify(result.content).includes('base64'));
  assert.deepEqual(Buffer.from(result.context.media[0].image_url.url.split(',')[1], 'base64'), bytes);
  assert.equal(result.metadata?.nativeWorkspaceReads, undefined);
  assert.deepEqual(readFileSync(join(run.root, 'sample.png')), bytes);
  const legacy = await run.read('sample.png', { media: false }); assert.equal(legacy.status, 'error');
});

test('images retain workspace path authorization, dimensions and byte bounds', async t => {
  const run = setup(t); writeFileSync(join(run.directory, 'outside.png'), png());
  symlinkSync(join(run.directory, 'outside.png'), join(run.root, 'escape.png'));
  const escaped = await run.read('escape.png'); assert.notEqual(escaped.status, 'ok');
  writeFileSync(join(run.root, 'invalid.png'), 'not image data');
  assert.equal((await run.read('invalid.png')).content.error_type, 'workspace_image_invalid');
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1); png().copy(oversized);
  writeFileSync(join(run.root, 'large.png'), oversized);
  assert.equal((await run.read('large.png')).content.error_type, 'workspace_image_too_large');
  const huge = png(); huge.writeUInt32BE(10000000, 16);
  writeFileSync(join(run.root, 'huge.png'), huge);
  assert.equal((await run.read('huge.png')).content.error_type, 'workspace_image_dimensions_exceeded');
  writeFileSync(join(run.root, 'notes.txt'), 'ordinary text');
  const text = await run.read('notes.txt'); assert.equal(text.status, 'ok'); assert.match(text.content.content, /ordinary text/);
});

test('all three provider projections carry image observations, while nonvision profiles disclose omitted pixels', async t => {
  const run = setup(t); writeFileSync(join(run.root, 'sample.png'), png());
  const observation = await run.read('sample.png');
  const request = { profile: { profileId: 'test', profileVersion: '1', maxOutputTokens: 1024, supportsImages: true },
    messages: [{ role: 'user', content: 'inspect' }, { role: 'assistant', content: '',
      toolCalls: [{ callId: 'read', name: 'read_workspace_file', arguments: { path: 'sample.png' } }] },
    { role: 'tool', callId: 'read', name: 'read_workspace_file', ...observation.context }], tools: [],
    maxInlineImageBytes: 1024 * 1024, finalizationOnly: false };
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    const binding = { protocol, model: 'test', baseUrl: 'https://model.example.invalid', apiKey: 'fixture-only', parameters: {} };
    const wire = buildNativeModelRequest(binding, request);
    assert.match(JSON.stringify(wire), /image\/png|image_url/);
    const nonvision = buildNativeModelRequest(binding,
      { ...request, profile: { ...request.profile, supportsImages: false } });
    assert.ok(!JSON.stringify(nonvision).includes('data:image/'));
    assert.match(JSON.stringify(nonvision), /model_does_not_support_images/);
  }
  assert.equal(projectRequestMedia(request).messages.at(-1).media.length, 1);
  assert.equal(request.messages.at(-1).media.length, 1);
});
