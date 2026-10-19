/** Keyless smoke of built DSH attachment storage and Session-scoped upload receipts. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { prepareAssistantPrompt, uploadAssistantAttachment } from '../../src/assistant-attachment-runtime.mjs';

if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set AGENTKIT_DSH_ROOT to the isolated, built DSH checkout');
const root = resolve(process.env.AGENTKIT_DSH_ROOT);
const cliRequire = createRequire(join(root, 'apps/cli/package.json'));
const controllerRequire = createRequire(join(root, 'packages/api/session-controller/package.json'));
const { Context } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/cordis')));
const { LocalAttachmentStore } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-attachment-local')));
const { FileUploads } = await import(pathToFileURL(controllerRequire.resolve('@deepseek-ai/dsh-client-file-upload')));
const home = await mkdtemp(join(tmpdir(), 'assistant-native-receipts-'));
const ctx = new Context();
const report = { evidence: 'real-DSH-LocalAttachmentStore-and-FileUploads-public-API', passed: false, checks: [],
  limits: ['Synthetic Agent and Session event fixture; full SessionController, HTTP, model input and restart are verified separately.'] };
const check = name => report.checks.push({ name, passed: true });
try {
  const agent = { id: 'synthetic-assistant', session: { id: 'synthetic-assistant', header: {} } };
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined });
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} });
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  const store = new LocalAttachmentStore(ctx, { dshHome: home });
  const uploads = new FileUploads(ctx);
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
  const receipt = await uploadAssistantAttachment(ctx, agent, { kind: 'image', name: 'pixel.png', mediaType: 'image/png', data });
  assert.equal(uploads.resolve(agent, receipt.receiptId).bytes, Buffer.from(data, 'base64').length);
  check('native raster validation and cloud receipt');
  const prepared = await prepareAssistantPrompt(ctx, agent, [{ type: 'image', receiptId: receipt.receiptId, mediaType: 'image/png', name: receipt.attachment.name }]);
  const admitted = await store.admitPromptContent(prepared.content);
  assert.equal(admitted[0].type, 'image'); assert.equal(admitted[0].attachment.width, 1);
  assert.equal((await store.readImage(admitted[0].attachment)).ref.width, 1);
  check('native image admission and durable image read');
  const binding = uploads.bindPrompt(agent, prepared.imageReceipts, 'synthetic-request');
  binding.commit(); binding[Symbol.dispose]();
  ctx.emit('session/event', agent.session, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'synthetic-request' } } });
  assert.equal(uploads.resolve(agent, receipt.receiptId), undefined);
  check('native receipt binding and retirement');
  const file = await uploadAssistantAttachment(ctx, agent, { kind: 'file', name: 'notes.txt', data: Buffer.from('synthetic only').toString('base64') });
  const filePrompt = await prepareAssistantPrompt(ctx, agent, [{ type: 'file', receiptId: file.receiptId }]);
  assert.equal(filePrompt.content[0].type, 'file');
  const chunks = [];
  for await (const chunk of store.readFileStream(uploads.resolve(agent, file.receiptId))) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'synthetic only');
  check('native file receipt and exact stored bytes');
  await assert.rejects(prepareAssistantPrompt(ctx, { ...agent, session: { id: 'other', header: {} } }, [{ type: 'file', receiptId: file.receiptId }]), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  check('native exact Session ownership');
  await assert.rejects(uploadAssistantAttachment(ctx, agent, { kind: 'image', name: 'fake.png', mediaType: 'image/png', data: Buffer.from('not a raster').toString('base64') }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  check('invalid raster rejected before receipt');
  report.passed = true;
} finally {
  await ctx.fiber.dispose();
  await rm(home, { recursive: true, force: true });
  if (process.argv[2]) {
    const output = resolve(process.argv[2]); await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
}
