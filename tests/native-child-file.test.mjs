import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createNativeChildFileReader } from '../src/host/services/native-child-file.mjs';

const request = (extra = {}) => ({ agentId: 'a', sessionId: 's', runId: 'parent', childRunId: 'child', path: 'same.txt', ...extra });
function fixture(t, options = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cf-'))), root = join(base, 'child'), parent = join(base, 'parent');
  mkdirSync(root); mkdirSync(parent);
  writeFileSync(join(root, 'same.txt'), 'Child bytes'); writeFileSync(join(parent, 'same.txt'), 'Parent bytes');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const reader = createNativeChildFileReader({ resolveChild: async () => ({ root, assertCurrent: () => true }), ...options });
  return { root, parent, reader };
}

test('current file observation reads only the resolved child, never the parent name or an execution result', async t => {
  const f = fixture(t), page = await f.reader.read(request());
  assert.equal(page.text, 'Child bytes'); assert.equal(page.readOnly, true); assert.equal(page.nextOffset, null);
  assert.equal(page.pageDigest, 'sha256:' + createHash('sha256').update('Child bytes').digest('hex'));
  assert.equal(JSON.stringify(page).includes(f.root), false); assert.equal(Object.hasOwn(page, 'outcome'), false);
});

test('real multibyte pages preserve BOM, byte cursors and all source text without overlapping bytes', async t => {
  const f = fixture(t), source = '\uFEFF前😀中\n后🙂末'; writeFileSync(join(f.root, 'same.txt'), source);
  let offset = 0, text = '', pages = 0;
  do {
    const page = await f.reader.read(request({ offset, limit: 4 }));
    assert.equal(page.offset, offset); assert.equal(page.totalBytes, Buffer.byteLength(source));
    assert.ok(Buffer.byteLength(page.text) <= 4); text += page.text; pages++;
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + Buffer.byteLength(page.text)); offset = page.nextOffset;
  } while (pages < 30);
  assert.equal(text, source); assert.ok(pages > 3);
  await assert.rejects(f.reader.read(request({ offset: 1 })), { code: 'native_child_file_text_invalid' });
  writeFileSync(join(f.root, 'empty'), '');
  const empty = await f.reader.read(request({ path: 'empty' }));
  assert.equal(empty.text, ''); assert.equal(empty.nextOffset, null); assert.equal(empty.totalBytes, 0);
});

test('traversal, aliases, symlinks, hardlinks, directories and arbitrary root fields cannot select another file', async t => {
  const f = fixture(t); symlinkSync(f.parent, join(f.root, 'escape')); symlinkSync(join(f.parent, 'same.txt'), join(f.root, 'link'));
  linkSync(join(f.parent, 'same.txt'), join(f.root, 'hard')); mkdirSync(join(f.root, 'dir'));
  for (const path of ['../parent/same.txt', '/etc/passwd', './same.txt', 'a//b', 'a\\b', 'a\0b', 'escape/same.txt', 'link', 'hard', 'dir'])
    await assert.rejects(f.reader.read(request({ path })), error => !error.message.includes(f.root));
  await assert.rejects(f.reader.read(request({ root: f.parent })), { code: 'native_child_file_request_invalid' });
  const socket = createServer(); await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(join(f.root, 's'), resolve); });
  try { await assert.rejects(f.reader.read(request({ path: 's' })), { code: 'native_child_file_path_unsafe' }); }
  finally { await new Promise(resolve => socket.close(resolve)); }
});

test('invalid page boundaries and non-UTF8 bytes cannot fabricate a readable page', async t => {
  const f = fixture(t);
  for (const extra of [{ limit: 3 }, { limit: 65537 }, { offset: -1 }, { offset: 1.5 }, { offset: 1000 }, { surprise: true }])
    await assert.rejects(f.reader.read(request(extra)));
  writeFileSync(join(f.root, 'binary'), Buffer.from([0xff, 0x01]));
  await assert.rejects(f.reader.read(request({ path: 'binary' })), { code: 'native_child_file_text_invalid' });
});

test('async ownership admission cannot be retargeted by request mutation', async t => {
  const f = fixture(t); let admit;
  const reader = createNativeChildFileReader({ resolveChild: async input => {
    assert.equal(input.path, 'same.txt'); await new Promise(resolve => { admit = resolve; });
    assert.equal(input.path, 'same.txt'); return { root: f.root, assertCurrent: () => true };
  } });
  const body = request(), pending = reader.read(body);
  await new Promise(resolve => setImmediate(resolve)); body.path = '../parent/same.txt'; body.childRunId = 'foreign'; admit();
  assert.equal((await pending).text, 'Child bytes');
});

test('cancellation settles an uncooperative resolver and revoked ownership suppresses the observation', async t => {
  const f = fixture(t), controller = new AbortController();
  const reader = createNativeChildFileReader({ resolveChild: () => new Promise(() => {}) });
  const pending = reader.read(request(), controller.signal); controller.abort(Error('private root ' + f.root));
  await assert.rejects(pending, { code: 'native_child_file_canceled' });
  let checks = 0;
  const revoked = createNativeChildFileReader({ resolveChild: async () => ({ root: f.root, assertCurrent: () => ++checks < 2 }) });
  await assert.rejects(revoked.read(request()), { code: 'native_child_file_owner_changed' });
  const asyncGuard = createNativeChildFileReader({ resolveChild: async () => ({ root: f.root, assertCurrent: async () => true }) });
  await assert.rejects(asyncGuard.read(request()), { code: 'native_child_file_binding_invalid' });
  const closed = createNativeChildFileReader({ isClosed: () => true, resolveChild: () => { throw Error('must not resolve'); } });
  await assert.rejects(closed.read(request()), { code: 'native_child_file_closed' });
});
