import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createPersonalAssistantRuntime } from '../src/personal-assistant-runtime.mjs';
import { normalizeAssistantInput } from '../src/assistant-attachment-runtime.mjs';
import { ASSISTANT_ATTACHMENT_LIMITS as limits } from '../src/contracts/assistant-attachments.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64');
const idOf = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture() {
  const sessions = new Map(), stored = new Map(), staged = new Map(), prompts = [], bindings = [], reads = [], pageCalls = [];
  let flush = true, rejectPrompt = false, uploads = 0;
  const append = (sessionId, type, data) => { const rows = sessions.get(sessionId).events; rows.push({ seq: rows.length, type, data }); };
  const save = (bytes, name) => { const ref = { attachmentId: idOf(bytes), bytes: bytes.length, name }; stored.set(ref.attachmentId, bytes); return ref; };
  const services = {
    agents: { withoutInitiator: work => work() }, commands: { execute: async (_agent, command) => { assert.equal(command, '/permission read-only'); return {}; } },
    approval: { setPolicy: (_agent, policy) => assert.equal(policy, 'never') }, sessions: { flush: async () => flush },
    attachments: {
      imageLimits: { maxImageBytes: limits.maxAttachmentBytes },
      validateImage: async ({ data, mediaType }) => { assert.equal(mediaType, 'image/png'); assert.deepEqual(Buffer.from(data), png); },
      async *readFileStream(ref) { reads.push(ref); yield stored.get(ref.attachmentId); },
    },
    fileUploads: {
      upload: async (agent, { name, data }) => {
        uploads++; const file = save(Buffer.from(data, 'base64'), name), receiptId = randomUUID();
        staged.set(receiptId, { session: agent.session, file }); return { receiptId, file };
      },
      resolve: (agent, receipt) => { const value = staged.get(receipt); return value?.session === agent.session ? value.file : undefined; },
      bindPrompt: (agent, receipts, requestId) => {
        const rows = receipts.map(receipt => { const row = staged.get(receipt); assert.equal(row?.session, agent.session); return { row, previous: row.requestId }; });
        for (const { row } of rows) row.requestId = requestId;
        const binding = { receipts, committed: false, disposed: false,
          commit() { this.committed = true; }, [Symbol.dispose]() { this.disposed = true; if (!this.committed) for (const { row, previous } of rows) row.requestId = previous; } };
        bindings.push(binding); return binding;
      },
    },
  };
  const controller = services.sessionController = {
    projections: async ({ sessionId }) => { const session = sessions.get(sessionId); return session ? { asOfSeq: session.events.length - 1, values: { inbox: session.inbox } } : null; },
    create: async ({ sessionId }) => sessions.set(sessionId, { session: { id: sessionId }, events: [], inbox: { 'next-turn': [], 'next-step': [] } }),
    resolveAgent: async sessionId => ({ agent: sessions.get(sessionId) }),
    page: async request => { pageCalls.push(request); const rows = sessions.get(request.address.sessionId).events, end = Math.min(request.beforeSeq ?? rows.length, request.throughSeq + 1), start = Math.max(0, end - 3);
      return { records: rows.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 }; },
    prompt: async request => {
      assert.equal(request.mode, 'queue');
      if (rejectPrompt) throw Object.assign(new Error('model refused image'), { code: 'session/attachment-invalid' });
      const session = sessions.get(request.sessionId);
      const previous = session.events.flatMap(event => event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted || [] : [])
        .find(message => message.source?.kind === 'user' && message.source.rpcId === request.requestId);
      if (previous) {
        if (previous.source.requestFingerprint !== request.requestFingerprint) throw Object.assign(new Error('request conflict'), { code: 'session/request-conflict' });
        return { accepted: true };
      }
      const content = request.content.map(part => {
        if (part.type === 'text') return part;
        if (part.type === 'image') {
          const ref = save(Buffer.from(part.data, 'base64'), part.name);
          return { type: 'image', attachment: { ...ref, mediaType: part.mediaType, width: 1, height: 1 } };
        }
        const attachment = services.fileUploads.resolve(session, part.receiptId); assert.ok(attachment);
        const row = staged.get(part.receiptId); row.requestId = request.requestId;
        return { type: 'file', attachment };
      });
      prompts.push(request);
      const message = { id: `message-${request.requestId}`, source: { kind: 'user', rpcId: request.requestId, requestFingerprint: request.requestFingerprint }, content };
      append(request.sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
      append(request.sessionId, 'user/message', message);
      for (const [receipt, row] of staged) if (row.session === session.session && row.requestId === request.requestId) staged.delete(receipt);
      return { accepted: true };
    },
  };
  const create = (buildId = 'b') => createPersonalAssistantRuntime({ ctx: { get: name => services[name] }, agentId: 'a', buildId,
    frozen: { spec: { runtime: { type: 'dsh-native' } } }, admit: async () => ({ presetId: 'assistant' }) });
  return { create, sessions, stored, staged, prompts, bindings, reads, pageCalls, services, controller, append,
    setFlush: value => { flush = value; }, setRejectPrompt: value => { rejectPrompt = value; }, get uploads() { return uploads; } };
}
const upload = (api, kind = 'file', extra = {}) => api('attachment-upload', { kind, name: kind === 'image' ? 'pixel.png' : 'notes.txt',
  ...(kind === 'image' ? { mediaType: 'image/png' } : {}), data: (kind === 'image' ? png : Buffer.from('file bytes')).toString('base64'), ...extra });
const part = receipt => receipt.kind === 'image' ? { type: 'image', receiptId: receipt.receiptId, mediaType: receipt.mediaType, name: receipt.attachment.name }
  : { type: 'file', receiptId: receipt.receiptId };

test('cloud upload returns native receipt only after storage and session persistence, without running a prompt', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api);
  assert.ok(f.staged.has(receipt.receiptId)); assert.equal(f.prompts.length, 0);
  assert.deepEqual(receipt.attachment, { attachmentId: idOf(Buffer.from('file bytes')), bytes: 10, name: 'notes.txt' });
  assert.equal(JSON.stringify(receipt).includes('ZmlsZSBieXRlcw=='), false);
  f.setFlush(false); await assert.rejects(upload(api), { code: 'ASSISTANT_PERSISTENCE_UNAVAILABLE' });
});

test('image-only and mixed file messages enter native queue with genuine image semantics and consumed receipts', async () => {
  const f = fixture(), api = f.create(), picture = await upload(api, 'image'), file = await upload(api);
  const request = { requestId: 'mixed', content: [part(picture), { type: 'text', text: 'Read both' }, part(file)] };
  const accepted = await api('submit', request);
  assert.equal(accepted.accepted, true); assert.equal(f.prompts[0].content[0].data, png.toString('base64'));
  assert.deepEqual(f.prompts[0].content.map(item => item.type), ['image', 'text', 'file']);
  assert.equal(f.staged.size, 0); assert.equal(f.bindings[0].committed, true); assert.equal(f.bindings[0].disposed, true);
  const snap = await api('snapshot'); assert.equal(snap.events.find(event => event.type === 'user/message').data.content[0].attachment.mediaType, 'image/png');
  assert.equal(snap.capabilities.input.images, true); assert.equal(snap.capabilities.display.files, true);
  assert.deepEqual(await api('file-read', { attachmentId: file.attachment.attachmentId }), { attachment: file.attachment, data: Buffer.from('file bytes').toString('base64') });
  const second = await upload(api, 'image'); await api('submit', { requestId: 'image-only', content: [part(second)] });
  assert.equal(f.prompts[1].content.length, 1);
});

test('accepted content survives facade restart and consumed receipt loss; changed content conflicts before resolution', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api, 'image');
  const request = { requestId: 'retry', content: [part(receipt), { type: 'text', text: 'Study' }] };
  f.setFlush(false); await assert.rejects(api('submit', request), { code: 'ASSISTANT_PERSISTENCE_UNAVAILABLE' });
  assert.equal(f.prompts.length, 1); assert.equal(f.staged.size, 0);
  f.setFlush(true); const reopened = f.create(); assert.equal((await reopened('submit', request)).accepted, true);
  assert.equal(f.prompts.length, 1);
  for (const content of [request.content.toReversed(), [{ ...part(receipt), name: 'other.png' }], [{ ...part(receipt), mediaType: 'image/jpeg' }],
    [{ ...part(receipt), receiptId: randomUUID() }], [part(receipt), { type: 'text', text: 'Changed' }]]) {
    await assert.rejects(reopened('submit', { ...request, content }), { code: 'ASSISTANT_REQUEST_CONFLICT' });
  }
  await assert.rejects(reopened('submit', { ...request, timezone: 'Europe/London' }), { code: 'ASSISTANT_REQUEST_CONFLICT' });
  assert.equal(f.prompts.length, 1);
});

test('pending foreign and restarted receipts fail without accepting a prompt; concurrent replay submits once', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api);
  await assert.rejects(api('submit', { conversation: 'other', requestId: 'foreign', content: [part(receipt)] }), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  await assert.rejects(f.create('other-build')('submit', { requestId: 'foreign-build', content: [part(receipt)] }), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  assert.equal(f.sessions.size, 1, 'foreign receipts cannot create or activate a new conversation');
  const request = { requestId: 'once', content: [part(receipt)] };
  await Promise.all([api('submit', request), api('submit', request)]); assert.equal(f.prompts.length, 1);
  const stale = await upload(api); f.staged.clear();
  await assert.rejects(f.create()('submit', { requestId: 'new', content: [part(stale)] }), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  assert.equal(f.prompts.length, 1);
});

test('rejected native image admission rolls back receipt binding and permits correction', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api, 'image');
  f.setRejectPrompt(true); await assert.rejects(api('submit', { requestId: 'refused', content: [part(receipt)] }), { code: 'session/attachment-invalid' });
  assert.equal(f.prompts.length, 0); assert.equal(f.staged.get(receipt.receiptId).requestId, undefined);
  assert.equal(f.bindings[0].committed, false); assert.equal(f.bindings[0].disposed, true);
  f.setRejectPrompt(false); assert.equal((await api('submit', { requestId: 'refused', content: [part(receipt)] })).accepted, true);
});

test('upload validates canonical bytes, raster kind, names and exact fields before any storage', async () => {
  const f = fixture(), api = f.create();
  for (const bad of [{ data: 'YQ' }, { data: 'YR==' }, { data: 'Y Q==' }, { name: '../a' }, { name: 'C:\\a.txt' }, { name: 'a\nb' },
    { name: '' }, { name: 'a'.repeat(256) }, { mediaType: 'application/pdf' }, { path: '/private/file' }, { kind: 'unknown' }]) {
    await assert.rejects(upload(api, 'file', bad), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  }
  for (const bad of [{ mediaType: 'image/svg+xml' }, { data: '' }, { data: Buffer.from('not an image').toString('base64') }]) {
    await assert.rejects(upload(api, 'image', bad), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  }
  assert.equal(f.uploads, 0);
  const empty = await upload(api, 'file', { data: '' }); assert.equal(empty.attachment.bytes, 0);
  await assert.rejects(upload(api, 'file', { data: Buffer.alloc(limits.maxAttachmentBytes + 1).toString('base64') }), { code: 'ASSISTANT_ATTACHMENT_TOO_LARGE' });
});

test('submit rejects inline bytes, forged refs, mixed text API, unsupported fields and complete-message bounds', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api);
  for (const input of [{ text: 'hello', content: [part(receipt)] }, { content: [] }, { content: [{ type: 'image', data: png.toString('base64'), mediaType: 'image/png' }] },
    { content: [{ type: 'file', attachment: receipt.attachment }] }, { content: [{ ...part(receipt), attachment: receipt.attachment }] },
    { content: [{ type: 'text', text: 'a'.repeat(32001) }] }]) {
    await assert.rejects(api('submit', { requestId: 'invalid', ...input }));
  }
  await assert.rejects(api('submit', { requestId: 'too-many', content: Array.from({ length: 9 }, () => part(receipt)) }), { code: 'ASSISTANT_ATTACHMENT_TOO_LARGE' });
  f.staged.get(receipt.receiptId).file.bytes = 17 * 1024 * 1024;
  await assert.rejects(api('submit', { requestId: 'aggregate', content: [part(receipt), part(receipt)] }), { code: 'ASSISTANT_ATTACHMENT_TOO_LARGE' });
  assert.equal(f.prompts.length, 0);
});

test('fingerprints cover ordered rich content and normalize key insertion order', () => {
  const id = randomUUID(), a = normalizeAssistantInput({ content: [{ type: 'file', receiptId: id }, { type: 'text', text: 'hello' }] });
  const b = normalizeAssistantInput({ content: [{ receiptId: id, type: 'file' }, { text: 'hello', type: 'text' }] });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, normalizeAssistantInput({ content: a.content.toReversed() }).fingerprint);
  assert.equal(a.fingerprint, normalizeAssistantInput({ content: a.content, timezone: 'Asia/Chongqing' }).fingerprint);
  assert.notEqual(a.fingerprint, normalizeAssistantInput({ content: a.content, timezone: 'UTC' }).fingerprint);
  for (const timezone of ['', 'UTC ', 'GMT', 'Not/A_Zone', null, 8]) assert.throws(() => normalizeAssistantInput({ content: a.content, timezone }), { code: 'ASSISTANT_INPUT_INVALID' });
  assert.throws(() => normalizeAssistantInput({ content: a.content, injected: 'unknown' }), { code: 'ASSISTANT_INPUT_INVALID' });
  assert.equal(normalizeAssistantInput({ text: 'legacy', timezone: 'UTC' }).fingerprint, normalizeAssistantInput({ text: 'legacy', timezone: 'Asia/Shanghai' }).fingerprint);
});

test('new staged content and native text replay never rescan historical pages', async () => {
  const f = fixture(), api = f.create(), file = await upload(api), sessionId = [...f.sessions.keys()][0];
  for (let i = 0; i < 120; i++) f.append(sessionId, 'turn/start', { turn: i });
  await api('submit', { requestId: 'fresh-file', content: [part(file)] });
  const text = { requestId: 'rich-text', content: [{ type: 'text', text: 'Only text' }] };
  await api('submit', text); await api('submit', text);
  await assert.rejects(api('submit', { ...text, timezone: 'Europe/London' }), { code: 'ASSISTANT_REQUEST_CONFLICT' });
  assert.equal(f.pageCalls.length, 0); assert.equal(f.prompts.length, 2);
  await api('submit', { requestId: 'fresh-file', content: [part(file)] });
  assert.equal(f.prompts.length, 2); assert.ok(f.pageCalls.length > 0);
});

test('file reads require visible same-session file refs, never injected context, failed tools or deliverable paths', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api), sessionId = [...f.sessions.keys()][0];
  const attachment = receipt.attachment;
  f.append(sessionId, 'user/message', { id: 'hidden', source: { kind: 'skill-catalog' }, content: [{ type: 'file', attachment }] });
  f.append(sessionId, 'tool/result', { message: { toolCallId: 'failed', isError: true, content: [{ type: 'file', attachment }] } });
  f.append(sessionId, 'deliverables/presented', { callId: 'present', files: [{ path: '/private/notes.txt', attachment }] });
  await assert.rejects(api('file-read', { attachmentId: attachment.attachmentId }), { code: 'ASSISTANT_FILE_NOT_FOUND' }); assert.equal(f.reads.length, 0);
  f.append(sessionId, 'tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'sub', name: 'read', content: [{ type: 'file', attachment }] });
  for (let i = 0; i < 12; i++) f.append(sessionId, 'turn/start', { turn: i });
  assert.deepEqual((await api('file-read', { attachmentId: attachment.attachmentId })).attachment, attachment);
  await assert.rejects(api('file-read', { conversation: 'other', attachmentId: attachment.attachmentId }), { code: 'ASSISTANT_FILE_UNAVAILABLE' });
  await assert.rejects(api('file-read', { attachmentId: '/private/notes.txt' }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  await assert.rejects(api('file-read', { attachmentId: attachment.attachmentId, path: '/private/notes.txt' }), { code: 'ASSISTANT_INPUT_INVALID' });
  for (const conversation of ['', null, 0, '../other']) await assert.rejects(api('file-read', { conversation, attachmentId: attachment.attachmentId }), { code: 'ASSISTANT_CONVERSATION_INVALID' });
});

test('file downloads reject altered digest, length, oversized refs and nonadvancing history before returning bytes', async () => {
  const f = fixture(), api = f.create(), receipt = await upload(api), accepted = await api('submit', { requestId: 'read', content: [part(receipt)] });
  f.stored.set(receipt.attachment.attachmentId, Buffer.from('bad bytes!'));
  await assert.rejects(api('file-read', { attachmentId: receipt.attachment.attachmentId }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  f.stored.set(receipt.attachment.attachmentId, Buffer.from('x'));
  await assert.rejects(api('file-read', { attachmentId: receipt.attachment.attachmentId }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  f.stored.set(receipt.attachment.attachmentId, Buffer.alloc(11));
  await assert.rejects(api('file-read', { attachmentId: receipt.attachment.attachmentId }), { code: 'ASSISTANT_ATTACHMENT_INVALID' });
  f.sessions.get(accepted.sessionId).events.find(event => event.type === 'user/message').data.content[0].attachment.bytes = limits.maxAttachmentBytes + 1;
  await assert.rejects(api('file-read', { attachmentId: receipt.attachment.attachmentId }), { code: 'ASSISTANT_ATTACHMENT_TOO_LARGE' });
  f.controller.page = async () => ({ records: [], hasMore: true });
  await assert.rejects(api('file-read', { attachmentId: receipt.attachment.attachmentId }), { code: 'ASSISTANT_HISTORY_INVALID' });
});

test('missing native services advertise no attachment capability and never pretend to upload', async () => {
  const f = fixture(); delete f.services.fileUploads; delete f.services.attachments;
  const api = f.create(), snapshot = await api('snapshot');
  assert.equal(api.attachmentUploadSupported, false); assert.equal(api.fileReadSupported, false);
  assert.equal(api.contentSupported, true); assert.equal(snapshot.capabilities.input.content, true);
  assert.equal(snapshot.capabilities.input.files, false); assert.equal(snapshot.capabilities.input.images, false); assert.equal(snapshot.capabilities.display.files, false);
  await assert.rejects(upload(api), { code: 'ASSISTANT_ATTACHMENT_UNAVAILABLE' });
});

test('advertised content protocol binds text-only requests to timezone while legacy text remains replayable', async () => {
  const f = fixture(); delete f.services.fileUploads; delete f.services.attachments;
  const api = f.create(); assert.equal((await api('snapshot')).capabilities.input.content, true);
  const request = { requestId: 'text-content', content: [{ type: 'text', text: 'Plan tomorrow' }], timezone: 'UTC' };
  await api('submit', request); await api('submit', { ...request, timezone: 'Etc/UTC' });
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].clientTimeZone, 'UTC');
  await assert.rejects(api('submit', { ...request, timezone: 'Asia/Shanghai' }), { code: 'ASSISTANT_REQUEST_CONFLICT' });
  await api('submit', { requestId: 'legacy-text', text: 'Old journal', timezone: 'UTC' });
  await api('submit', { requestId: 'legacy-text', text: 'Old journal', timezone: 'Asia/Shanghai' });
  assert.equal(f.prompts.length, 2); assert.equal(f.pageCalls.length, 0);
});
