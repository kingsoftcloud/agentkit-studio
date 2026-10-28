import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNativeSkillE2BFiles } from '../src/providers/native-skill-e2b-files.mjs';
const root = '/private-skill', hash = bytes => createHash('sha256').update(bytes).digest('hex');
function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function req(fields = {}) { return { future: { integer: 9007199254740993n }, ...fields, signal: new AbortController().signal, assertCurrent: () => true }; }
function setup() {
  const entries = new Map([[root, { type: 'dir', mode: 0o700, size: 0 }]]), calls = [];
  const info = path => { const value = entries.get(path); if (!value) throw new Error('unexpected missing target');
    return { path, name: path.split('/').at(-1), size: value.bytes?.length ?? value.size, mode: value.mode, type: value.type, modifiedTime: new Date(100) }; };
  const sandbox = { sandboxId: 'original-sandbox', files: {
    async getInfo(path, opts) { calls.push({ method: 'info', path, opts }); return info(path); },
    async list(path, opts) { calls.push({ method: 'list', path, opts }); return [...entries.keys()].filter(key => key.startsWith(path + '/')
      && !key.slice(path.length + 1).includes('/')).map(info); },
    async write(path, bytes, opts) { calls.push({ method: 'write', path, opts }); entries.set(path, { type: 'file', mode: 0o600, bytes: Buffer.from(bytes) }); return info(path); },
    async read(path, opts) { calls.push({ method: 'read', path, opts }); return new ReadableStream({ start(controller) { controller.enqueue(entries.get(path).bytes); controller.close(); } }); },
  } };
  const port = createNativeSkillE2BFiles({ sandbox, remoteRoot: root });
  const file = (path, bytes = Buffer.from('bytes')) => ({ path, base64: bytes.toString('base64'), sha256: hash(bytes) });
  return { entries, calls, sandbox, port, file };
}

test('uploads prove the actual remote bytes, preserve empty files and read/list with original signal and exact SDK options', async () => {
  const h = setup(), request = req({ files: [h.file(root + '/binary', Buffer.from([0, 255, 1])), h.file(root + '/empty', Buffer.alloc(0))] });
  const uploaded = await h.port.upload(request); assert.equal(uploaded.files.length, 2); assert.equal(uploaded.files[1].size, 0);
  const read = await h.port.read(req({ path: root + '/binary' })); assert.deepEqual(read.bytes, Buffer.from([0, 255, 1])); assert.equal(read.sha256, hash(read.bytes));
  const listed = await h.port.list(req({ path: root })); assert.equal(listed.entries.length, 2);
  for (const call of h.calls.slice(0, h.calls.findIndex(call => call.method === 'write') + 1)) assert.equal(call.opts.signal, request.signal);
  assert.ok(h.calls.filter(call => call.method === 'read').every(call => call.opts.format === 'stream'));
  assert.ok(h.calls.filter(call => call.method === 'list').every(call => call.opts.depth === 1));
});

test('an invalid member, digest, noncanonical base64, duplicate or huge encoded value invalidates the entire batch before any SDK call', async () => {
  const h = setup();
  for (const bad of [ { ...h.file(root + '/b'), sha256: '0'.repeat(64) }, { ...h.file(root + '/b'), base64: 'Ynl0ZXM=\n' },
    { ...h.file(root + '/b'), base64: '_-==' }, { ...h.file(root + '/b'), path: root + '/a' },
    { ...h.file(root + '/b'), base64: 'a'.repeat(28 * 1024 ** 2) } ]) {
    await assert.rejects(h.port.upload(req({ files: [h.file(root + '/a'), bad] })), /SKILL_E2B_UPLOAD_INVALID/);
    assert.equal(h.calls.length, 0);
  }
});

test('aliased, traversal, outside-root and root-file paths never reach the SDK', async () => {
  const h = setup();
  for (const path of [root + '/a/../b', root + '//b', root + '/./b', root + '/b/', root + '/b\\c', root + '/b\0', '/other/a', root]) {
    await assert.rejects(h.port.upload(req({ files: [h.file(path)] })));
  }
  for (const remoteRoot of ['/', '/root/', '/root/../other', '/root//x']) assert.throws(() => createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot }));
  assert.equal(h.calls.length, 0);
});

test('missing, false, asynchronous and reentrant authority are rejected before SDK effects', async () => {
  const h = setup();
  for (const authority of [undefined, () => false, () => Promise.reject(new Error('late invalid authority'))]) {
    const request = req({ path: root }); request.assertCurrent = authority;
    await assert.rejects(h.port.list(request));
  }
  const request = req({ path: root }); request.assertCurrent = () => { request.future.integer = 9007199254740992n; return true; };
  await assert.rejects(h.port.list(request), /SKILL_E2B_REQUEST_CHANGED/); assert.equal(h.calls.length, 0);
});

test('changing authority function, complete future fields, original signal or SDK target during an await fails before write', async () => {
  for (const mutate of [ request => { request.future.integer = 9007199254740992n; }, request => { request.assertCurrent = () => true; },
    request => { request.signal = new AbortController().signal; }, (_, h) => { h.sandbox.sandboxId = 'foreign'; },
    (_, h) => { h.sandbox.files = { ...h.sandbox.files }; }, (_, h) => { h.sandbox.files.write = () => assert.fail('retargeted write'); } ]) {
    const h = setup(), entered = gate(), released = gate(), original = h.sandbox.files.getInfo;
    h.sandbox.files.getInfo = async (...args) => { entered.resolve(); await released.promise; return original(...args); };
    const port = createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root }), request = req({ files: [h.file(root + '/a')] });
    const pending = port.upload(request), rejected = assert.rejects(pending, /SKILL_E2B_(?:REQUEST|SANDBOX)_CHANGED/);
    await entered.promise; mutate(request, h); released.resolve(); await rejected;
    assert.equal(h.calls.filter(call => call.method === 'write').length, 0);
  }
});

test('root/ancestor links, writable directories, swapped metadata and existing upload destinations fail closed', async () => {
  for (const value of [{ type: 'symlink', mode: 0o700, size: 0 }, { type: 'dir', mode: 0o777, size: 0 }, { type: 'dir', size: 0 }]) {
    const h = setup(); h.entries.set(root, value);
    await assert.rejects(h.port.upload(req({ files: [h.file(root + '/a')] })));
    assert.equal(h.calls.filter(call => call.method === 'write').length, 0);
  }
  const h = setup(); h.entries.set(root + '/a', { type: 'file', bytes: Buffer.from('existing'), mode: 0o600 });
  await assert.rejects(h.port.upload(req({ files: [h.file(root + '/a')] })), /SKILL_E2B_UPLOAD_EXISTS/);
});

test('list rejects every forged outside/direct-child path, name, type, size and duplicate rather than silently dropping entries', async () => {
  for (const item of [ { path: '/other/a', name: 'a', type: 'file', size: 1, mode: 0o600 },
    { path: root + '/a/b', name: 'b', type: 'file', size: 1, mode: 0o600 },
    { path: root + '/a', name: 'different', type: 'file', size: 1, mode: 0o600 },
    { path: root + '/a', name: 'a', type: 'symlink', size: 1, mode: 0o600 },
    { path: root + '/a', name: 'a', type: 'file', size: -1, mode: 0o600 } ]) {
    const h = setup(); h.sandbox.files.list = async () => [item];
    await assert.rejects(createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root }).list(req({ path: root })));
  }
  const h = setup(), item = { path: root + '/a', name: 'a', type: 'file', size: 1, mode: 0o600 };
  h.sandbox.files.list = async () => [item, item];
  await assert.rejects(createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root }).list(req({ path: root })), /SKILL_E2B_LIST_INVALID/);
});

test('oversized metadata prevents opening a stream and dishonest oversized chunks are canceled rather than returned as truncated success', async () => {
  const h = setup(); h.entries.set(root + '/a', { type: 'file', bytes: Buffer.from('12345'), mode: 0o600 });
  await assert.rejects(h.port.read(req({ path: root + '/a', maxBytes: 4 })), /SKILL_E2B_FILE_LIMIT/);
  assert.equal(h.calls.filter(call => call.method === 'read').length, 0);
  let canceled = 0;
  h.sandbox.files.read = async () => new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(100)); }, cancel() { canceled++; } });
  const port = createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root });
  await assert.rejects(port.read(req({ path: root + '/a', maxBytes: 5 })), /SKILL_E2B_FILE_LIMIT/); assert.equal(canceled, 1);
});

test('cancellation promptly escapes a noncooperative SDK read and closes its late stream', async () => {
  const h = setup(), entered = gate(), returned = gate(), controller = new AbortController(); let canceled = 0;
  h.entries.set(root + '/a', { type: 'file', bytes: Buffer.from('a'), mode: 0o600 });
  h.sandbox.files.read = () => { entered.resolve(); return returned.promise; };
  const port = createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root }), request = req({ path: root + '/a' }); request.signal = controller.signal;
  const pending = port.read(request); await entered.promise; controller.abort(new Error('cancel original read'));
  await assert.rejects(pending, /cancel original read/);
  returned.resolve(new ReadableStream({ cancel() { canceled++; } })); await new Promise(resolve => setImmediate(resolve)); assert.equal(canceled, 1);
});

test('a noncooperative stream read/cancel cannot hold an aborted call or produce a late result', async () => {
  const h = setup(), entered = gate(), controller = new AbortController(); let canceled = 0;
  h.entries.set(root + '/a', { type: 'file', bytes: Buffer.from('a'), mode: 0o600 });
  h.sandbox.files.read = async () => ({ getReader: () => ({ read() { entered.resolve(); return new Promise(() => {}); },
    cancel() { canceled++; return new Promise(() => {}); }, releaseLock() {} }) });
  const port = createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root }), request = req({ path: root + '/a' }); request.signal = controller.signal;
  const pending = port.read(request); await entered.promise; controller.abort(new Error('cancel original stream'));
  await assert.rejects(pending, /cancel original stream/); assert.equal(canceled, 1);
});

test('changed metadata at EOF and corrupted upload bytes cannot be claimed as exact transfers', async () => {
  const h = setup(); h.entries.set(root + '/a', { type: 'file', bytes: Buffer.from('a'), mode: 0o600 });
  h.sandbox.files.read = async () => new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('a')); h.entries.get(root + '/a').mode = 0o644; controller.close(); } });
  await assert.rejects(createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root }).read(req({ path: root + '/a' })), /SKILL_E2B_FILE_CHANGED/);
  const other = setup(), write = other.sandbox.files.write;
  other.sandbox.files.write = async (path, bytes, opts) => write(path, Buffer.alloc(bytes.byteLength), opts);
  await assert.rejects(createNativeSkillE2BFiles({ sandbox: other.sandbox, remoteRoot: root }).upload(req({ files: [other.file(root + '/a')] })), /SKILL_E2B_UPLOAD_CHANGED/);
});

test('a substituted SDK upload acknowledgement is refused even when the original file happens to contain the expected bytes', async () => {
  const h = setup(), original = h.sandbox.files.write;
  h.sandbox.files.write = async (...args) => { const ack = await original(...args); return { ...ack, path: '/foreign/a' }; };
  const port = createNativeSkillE2BFiles({ sandbox: h.sandbox, remoteRoot: root });
  await assert.rejects(port.upload(req({ files: [h.file(root + '/a')] })), /SKILL_E2B_UPLOAD_ACK_INVALID/);
  assert.equal(h.calls.filter(call => call.method === 'read').length, 0);
});
