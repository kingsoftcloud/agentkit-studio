import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrowserWorkspaceServer } from '../src/native/browser-workspace-server.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-browser-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'app'));
  writeFileSync(join(root, 'app', 'index.html'), '<script src="app.js"></script>');
  writeFileSync(join(root, 'app', 'app.js'), 'document.title="local app";');
  writeFileSync(join(root, 'private.txt'), 'outside served directory');
  return root;
}
const raw = (server, path, options = {}) => new Promise((resolve, reject) => {
  const req = request(server.origin, { path, ...options }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end();
});
async function open(t, options = {}) {
  const root = workspace(t), server = await createBrowserWorkspaceServer({ root, path: 'app', ...options });
  t.after(() => server.close());
  return { root, server, prefix: new URL('.', server.url).pathname };
}

test('a real loopback server serves the bound HTML and assets with correct types and read-only HEAD', async t => {
  const { server } = await open(t);
  const html = await fetch(server.url);
  assert.equal(html.status, 200); assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.equal(await html.text(), '<script src="app.js"></script>');
  const asset = await fetch(new URL('app.js?version=1', server.url));
  assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(await asset.text(), 'document.title="local app";');
  const head = await fetch(server.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(html.headers.get('cache-control'), 'no-store');
});

test('each page owns a distinct local URL grant; credentials, other pages, and outside origins fail policy', async t => {
  const { root, server } = await open(t);
  const other = await createBrowserWorkspaceServer({ root, path: 'app' }); t.after(() => other.close());
  assert.equal(server.allows(server.url), true);
  assert.equal(server.allows(new URL('app.js', server.url).href), true);
  for (const url of [other.url, server.origin + '/index.html', server.url.replace('127.0.0.1', 'localhost'),
    server.url.replace('http:', 'https:'), server.url.replace('http://', 'http://user:secret@'), 'file:///private.txt', 'not a URL']) {
    assert.equal(server.allows(url), false, url);
  }
  assert.equal((await fetch(other.origin + new URL(server.url).pathname)).status, 403);
});

test('raw and encoded traversal, outside symlinks, invalid hosts, malformed URLs and writes cannot expose files', async t => {
  const { root, server, prefix } = await open(t);
  symlinkSync(join(root, 'private.txt'), join(root, 'app', 'escape.txt'));
  for (const suffix of ['../private.txt', '%2e%2e/private.txt', '%2e%2e%2fprivate.txt', '%2Fprivate.txt',
    'escape.txt', '%5c..%5cprivate.txt', '%00.txt', '%invalid']) {
    const response = await raw(server, prefix + suffix);
    assert.equal(response.status, 403, suffix); assert.doesNotMatch(response.text, /outside served directory|\/Users\//);
  }
  assert.equal((await raw(server, new URL(server.url).pathname, { headers: { host: 'attacker.invalid' } })).status, 403);
  assert.equal((await raw(server, new URL(server.url).pathname, { method: 'POST' })).status, 405);
  assert.equal((await raw(server, prefix + 'missing.js')).status, 404);
  assert.equal((await raw(server, '/index.html')).status, 403);
});

test('directory indexes are checked after resolution and a missing index never lists the workspace', async t => {
  const { root, server, prefix } = await open(t);
  mkdirSync(join(root, 'app', 'nested')); symlinkSync(join(root, 'private.txt'), join(root, 'app', 'nested', 'index.html'));
  assert.equal((await raw(server, prefix + 'nested/')).status, 403);
  mkdirSync(join(root, 'app', 'empty')); writeFileSync(join(root, 'app', 'empty', 'secret.txt'), 'not a listing');
  const empty = await raw(server, prefix + 'empty/');
  assert.equal(empty.status, 403); assert.doesNotMatch(empty.text, /secret.txt/);
  symlinkSync(join(root, 'app', 'app.js'), join(root, 'app', 'inside.js'));
  assert.equal((await raw(server, prefix + 'inside.js')).status, 200);
  mkdirSync(join(root, 'app', 'safe')); writeFileSync(join(root, 'app', 'safe', 'index.html'), 'nested app');
  const redirect = await raw(server, prefix + 'safe?version=1');
  assert.equal(redirect.status, 301); assert.equal(redirect.headers.location, prefix + 'safe/?version=1');
  assert.equal(await (await fetch(server.origin + redirect.headers.location)).text(), 'nested app');
  writeFileSync(join(root, 'app', 'literal#name.txt'), 'encoded name');
  assert.equal((await raw(server, prefix + 'literal%23name.txt')).text, 'encoded name');
});

test('source revisions change for edits, ignore excluded trees, and ignore only the exact generated capture', async t => {
  const { root, server } = await open(t);
  const initial = server.revision(); assert.equal(initial, server.initialRevision);
  for (const directory of ['.artifacts', '.git', 'node_modules', '__pycache__']) {
    mkdirSync(join(root, 'app', directory)); writeFileSync(join(root, 'app', directory, 'ignored.txt'), 'ignored');
  }
  symlinkSync(join(root, 'private.txt'), join(root, 'app', 'ignored-symlink'));
  assert.equal(server.revision(), initial);
  const capture = join(root, 'app', 'capture.png'); writeFileSync(capture, 'generated'); server.markGenerated(capture);
  assert.equal(server.revision(), initial);
  writeFileSync(capture, 'user replacement with different bytes'); assert.notEqual(server.revision(), initial);
  rmSync(capture); assert.equal(server.revision(), initial);
  writeFileSync(join(root, 'app', 'app.js'), 'new source'); assert.notEqual(server.revision(), initial);
});

test('file size and served tree limits are enforced before publication or startup', async t => {
  const { root, server, prefix } = await open(t, { maxFileBytes: 64 });
  writeFileSync(join(root, 'app', 'large.bin'), Buffer.alloc(65));
  const large = await raw(server, prefix + 'large.bin'); assert.equal(large.status, 413); assert.ok(large.text.length < 64);
  await assert.rejects(createBrowserWorkspaceServer({ root, path: 'app', maxFiles: 1 }), { code: 'browser_served_file_limit_exceeded' });
  for (const value of [0, -1, 1.5, null, Infinity]) {
    await assert.rejects(createBrowserWorkspaceServer({ root, path: 'app', maxFileBytes: value }), { code: 'browser_server_limits_invalid' });
  }
});

test('invalid entries and outside entry symlinks never start a server', async t => {
  const root = workspace(t), outside = mkdtempSync(join(tmpdir(), 'native-browser-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'index.html'), 'outside'); symlinkSync(outside, join(root, 'escape'));
  for (const path of ['', '/app/index.html', '../index.html', 'app\\index.html', 'escape', 'app/app.js']) {
    await assert.rejects(createBrowserWorkspaceServer({ root, path }));
  }
  const controller = new AbortController(); controller.abort(new Error('canceled before open'));
  await assert.rejects(createBrowserWorkspaceServer({ root, path: 'app', signal: controller.signal }), /canceled before open/);
});

test('owner close and abort release sockets and invalidate the local grant idempotently', async t => {
  const controller = new AbortController(), { server } = await open(t, { signal: controller.signal });
  assert.equal((await fetch(server.url)).status, 200);
  controller.abort(); const closing = server.close(); assert.equal(server.close(), closing); await closing;
  assert.equal(server.allows(server.url), false); assert.throws(() => server.revision(), { code: 'browser_server_closed' });
  await assert.rejects(fetch(server.url));
});
