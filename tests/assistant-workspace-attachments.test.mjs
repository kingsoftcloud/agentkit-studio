import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantPermissionModel } from '../src/assistant-permission-model.mjs';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, managed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-workspace-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agentkit')); await mkdir(join(root, 'dsh'));
  const bundleSha256 = 'a'.repeat(64);
  await writeFile(join(root, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256 }));
  const sessions = new Map(), staged = new Map(), objects = new Map(), prompts = [], sections = new Map();
  const definitions = new Map([['read', { name: 'read', execute() {} }]]), guards = new Set();
  let permission = 'read-only', policy = 'never', copiesRead = 0;
  const services = {
    agents: { withoutInitiator: work => work() }, sessions: { flush: async () => true },
    tools: { get: name => definitions.get(name), register: definition => definitions.set(definition.name, definition),
      guard(callback) { guards.add(callback); return () => guards.delete(callback); } },
    fs: { sandboxMode: 'read-only' }, workingDirectory: { get: session => session.header.cwd },
    approval: { effectivePolicy: () => policy, request: async () => 'unavailable', setPolicy(_agent, value) { policy = value; } },
    sandboxPolicy: { resolve: () => ({ mode: permission }) },
    permissionPresets: { set(_session, value) { permission = value; policy = value === 'workspace-write' ? 'ask' : 'never'; } },
    systemPrompt: { section(value) { sections.set(value.name, value); return () => sections.delete(value.name); } },
    attachments: { async *readFileStream(ref) { copiesRead++; yield objects.get(ref.attachmentId); } },
    fileUploads: {
      async upload(agent, { name, data }) {
        const bytes = Buffer.from(data, 'base64'), file = { attachmentId: `sha256:${digest(bytes)}`, name, bytes: bytes.length }, receiptId = randomUUID();
        objects.set(file.attachmentId, bytes); staged.set(receiptId, { session: agent.session, file }); return { receiptId, file };
      },
      resolve(agent, receiptId) { const row = staged.get(receiptId); return row?.session === agent.session ? row.file : undefined; },
      bindPrompt() { return { commit() {}, [Symbol.dispose]() {} }; },
    },
  };
  const ctx = { get: name => services[name], on: () => () => {}, effect: work => work() };
  const controller = services.sessionController = {
    async projections({ sessionId }) { return sessions.has(sessionId) ? { asOfSeq: -1, values: {} } : null; },
    async create({ sessionId, cwd }) { sessions.set(sessionId, { ctx, session: { id: sessionId, header: { cwd: cwd || root } } }); },
    async resolveAgent(sessionId) { return { agent: sessions.get(sessionId) }; },
    async page() { return { records: [], hasMore: false }; },
    async prompt(request) { prompts.push(request); return { accepted: true }; },
  };
  const model = await createAssistantPermissionModel({ ctx, env: { AGENTKIT_HOME: join(root, 'agentkit'), DSH_HOME: join(root, 'dsh'), AGENTKIT_BUNDLE_SHA256: bundleSha256 },
    profile: managed ? 'workspace-managed/v1' : undefined, agentId: 'agent' });
  t.after(() => model.dispose());
  const api = createPersonalAssistantRuntime({ ctx, agentId: 'agent', buildId: 'build', frozen: { spec: { runtime: { type: 'dsh-native' } } },
    admit: async () => ({ presetId: 'assistant' }), permissionModel: model });
  const upload = (bytes = Buffer.from('invoice total: 125'), extra = {}) => api('attachment-upload', { kind: 'file', name: 'invoice.txt', data: bytes.toString('base64'), ...extra });
  const submit = (receipt, extra = {}) => api('submit', { requestId: 'read-file', content: [{ type: 'file', receiptId: receipt.receiptId }], ...extra });
  const denied = (agent, file_path) => [...guards].map(guard => guard({ agent, name: 'read', arguments: { file_path }, signal: new AbortController().signal })).find(Boolean);
  return { root, api, model, sessions, staged, objects, prompts, sections, upload, submit, denied, controller, services, reads: () => copiesRead };
}

test('managed upload submits a native file and makes its verified bytes readable inside the same Session workspace', async t => {
  const f = await fixture(t), receipt = await f.upload();
  await f.submit(receipt);
  const agent = [...f.sessions.values()][0], path = join(agent.session.header.cwd, '.assistant-inputs', receipt.attachment.attachmentId.slice(7), 'invoice.txt');
  assert.equal(f.prompts[0].content[0].type, 'file', 'native attachment history and download reference must be preserved');
  assert.equal(f.denied(agent, path), undefined);
  assert.equal(await readFile(path, 'utf8'), 'invoice total: 125');
  const guidance = [...f.sections.values()].map(section => typeof section.text === 'function' ? section.text() : section.text).join('\n');
  assert.match(guidance, /\.assistant-inputs/);
  assert.equal(f.reads(), 1, 'file bytes come from the native attachment stream');
  assert.ok(f.denied(agent, join(f.root, 'dsh', 'attachments', 'invoice.txt')), 'the original global store remains outside read authority');
});

test('managed staging rejects corrupted native bytes, forged receipts and cross-session reuse before prompt admission', async t => {
  const f = await fixture(t), receipt = await f.upload();
  await assert.rejects(f.submit({ receiptId: randomUUID() }), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  await assert.rejects(f.submit(receipt, { conversation: 'other' }), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  assert.equal(f.reads(), 0); assert.equal(f.sessions.size, 1);
  f.objects.set(receipt.attachment.attachmentId, Buffer.from('invoice total: 999'));
  await assert.rejects(f.submit(receipt), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  assert.equal(f.prompts.length, 0);
});

test('managed copies reject aliased destination directories and never accept an external input path', async t => {
  const f = await fixture(t), receipt = await f.upload(), agent = [...f.sessions.values()][0];
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(agent.session.header.cwd, '.assistant-inputs'));
  await assert.rejects(f.submit(receipt)); assert.equal(f.prompts.length, 0);
  await assert.rejects(f.api('submit', { requestId: 'path', content: [{ type: 'file', receiptId: receipt.receiptId, path: outside }] }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
});

test('legacy assistants keep native file submission without new workspace copies or permission changes', async t => {
  const f = await fixture(t, false), receipt = await f.upload(); await f.submit(receipt);
  assert.equal(f.prompts[0].content[0].type, 'file'); assert.equal(f.reads(), 0); assert.equal(f.sections.size, 0);
  assert.equal(f.model.snapshot([...f.sessions.values()][0]).permission, 'read-only');
});

test('repeated receipts reuse unchanged copies and cannot overwrite edits, symlinks or hard links', async t => {
  const f = await fixture(t), receipt = await f.upload(); await f.submit(receipt);
  const agent = [...f.sessions.values()][0], path = join(agent.session.header.cwd, '.assistant-inputs', receipt.attachment.attachmentId.slice(7), 'invoice.txt');
  await f.submit(receipt, { requestId: 'same-copy' }); assert.equal(f.prompts.length, 2);
  await writeFile(path, 'edited by the user');
  await assert.rejects(f.submit(receipt, { requestId: 'edited-copy' }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  assert.equal(await readFile(path, 'utf8'), 'edited by the user');
  await rm(path); const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'invoice total: 125');
  await symlink(outside, path); await assert.rejects(f.submit(receipt, { requestId: 'symlink-copy' }));
  await rm(path); await link(outside, path); await assert.rejects(f.submit(receipt, { requestId: 'hardlink-copy' }));
  assert.equal(f.prompts.length, 2);
});

test('disposal while native bytes are being verified cannot create a later workspace copy', async t => {
  const f = await fixture(t), receipt = await f.upload();
  let entered, release;
  const reading = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  f.services.attachments.readFileStream = async function* () { entered(); await wait; yield f.objects.get(receipt.attachment.attachmentId); };
  const submitting = f.submit(receipt); await reading; f.model.dispose(); release();
  await assert.rejects(submitting, { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' }); assert.equal(f.prompts.length, 0);
  const agent = [...f.sessions.values()][0];
  await assert.rejects(readFile(join(agent.session.header.cwd, '.assistant-inputs', receipt.attachment.attachmentId.slice(7), 'invoice.txt')), { code: 'ENOENT' });
});
