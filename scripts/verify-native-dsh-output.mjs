/** Exercise Native image output with the built, maintained DSH attachment backend. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NativeKernel, MemoryRunStore, canonical, configure, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { nativeDshBuiltinOutput, renderNativeDshBuiltinOutput } from '../src/providers/native-output.mjs';
import { projectNativeDshContent } from '../src/providers/native-input.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' } } });
assert.ok(values.source, 'Use --source <built maintained DSH checkout>');
const packageRoot = join(resolve(values.source), 'packages/attachment/attachment-local');
const require = createRequire(join(packageRoot, 'package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { LocalAttachmentStore } = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);
const root = await mkdtemp(join(tmpdir(), 'native-dsh-output-'));
const context = new Context();
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64');
const outcome = { status: 'ok', content: { ok: true, entry_path: 'index.html' }, context: { content: 'Observed',
  media: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] } };
try {
  const attachments = new LocalAttachmentStore(context, { dshHome: root });
  const output = await nativeDshBuiltinOutput(outcome, { attachments });
  const [ref] = output.images;
  assert.equal(ref.width, 1); assert.equal(ref.height, 1); assert.match(ref.attachmentId, /^sha256:/);
  assert.deepEqual(Buffer.from((await attachments.readImage(ref)).data), bytes);
  const blocks = renderNativeDshBuiltinOutput({}, output);
  assert.equal(blocks[1].type, 'image'); assert.equal(JSON.stringify(blocks).includes('base64'), false);
  const reopened = new LocalAttachmentStore(new Context(), { dshHome: root });
  const projected = await projectNativeDshContent(blocks, { attachments: reopened });
  assert.equal(projected.media.length, 1);
  assert.deepEqual(Buffer.from(projected.media[0].image_url.url.split(',')[1], 'base64'), bytes);
  const redacted = await projectNativeDshContent(blocks.filter(block => block.type === 'text'), { attachments: reopened });
  assert.equal(redacted.media, undefined);
  await assert.rejects(nativeDshBuiltinOutput({ ...outcome, context: { media: [outcome.context.media[0],
    { type: 'image_url', image_url: { url: 'data:image/png;base64,bm90LWEtaW1hZ2U=' } }] } }, { attachments }));

  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  const config = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'image/v1' },
    contract: { objective: 'Inspect the Host screenshot' }, hostBindingDigest: 'dsh-attachment-output/v1', tools: [{
      name: 'observe', description: 'Observe the Host image', parameters: { type: 'object', properties: {} },
      readOnly: false, concurrentSafe: false, observationRole: 'browser', permissions: [], timeoutMs: 10000,
      contextRole: 'none', progressObservation: true, contextRetention: 'normal',
    }] });
  const scope = { tenantId: 'test', workspaceId: 'test', userId: 'test', agentId: 'test' };
  const store = new MemoryRunStore(); let models = 0, tools = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'image-output', ports: {
    tools: { execute: async () => { tools++;
      const value = await nativeDshBuiltinOutput(outcome, { attachments: reopened });
      return { ...outcome, context: await projectNativeDshContent(renderNativeDshBuiltinOutput({}, value), { attachments: reopened }) };
    } }, model: { generate: async request => {
      models++;
      if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'observe', name: 'observe', arguments: {} }] };
      const message = request.messages.find(message => message.role === 'tool');
      assert.deepEqual(message.media, projected.media); assert.deepEqual(message.presentation, projected.presentation);
      return { kind: 'final_candidate', text: 'Image received; acceptance unverified.', toolCalls: [], usage: emptyUsage() };
    } },
  } });
  kernel.start({ scope, runId: 'image', sessionId: 'image', turnId: '1', buildId: 'fixture', taskChainId: 'image', parentRunId: null }, config);
  const done = await kernel.runUntilIdle(scope, 'image');
  assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified'); assert.equal(models, 2); assert.equal(tools, 1);
  process.stdout.write('PASS: actual DSH image validation/storage/reopen, policy omission, and Native model image delivery\n');
} finally { await rm(root, { recursive: true, force: true }); }
