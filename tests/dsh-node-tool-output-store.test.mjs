import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { nativeWebToolDefinitions } from '../packages/agentkit-harness/src/native/web-tools.mjs';
import { createDshNodeToolOutputStore } from '../src/providers/dsh-node-tool-output-store.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const text = '完整正文 😀 中文\n'.repeat(100);
const metadata = () => ({ toolName: 'web_fetch', mediaType: 'text/plain', fullBytes: Buffer.byteLength(text), reachedByteCeiling: false });
const request = (agentId = 'agent', sessionId = 'session', callId = 'call') => ({ agentId, sessionId,
  call: { callId, name: 'web_fetch', arguments: { url: 'https://example.com/page' } },
  definition: nativeWebToolDefinitions().find(definition => definition.name === 'web_fetch'), signal: new AbortController().signal });
const moduleUrl = new URL('../src/providers/dsh-node-tool-output-store.mjs', import.meta.url).href;
function setup(t, options = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'state');
  const store = createDshNodeToolOutputStore({ directory, agentId: 'agent', ...options });
  t.after(() => store.close());
  return { root, directory, store, persist: (req = request(), meta = metadata()) => store.persistOutput(req, text, meta) };
}

test('full UTF-8 file, complete identity and hashes persist outside the workspace, then reopen idempotently', t => {
  const h = setup(t), req = request(), meta = metadata(), saved = h.persist(req, meta);
  assert.equal(h.store.contract, 'agentkit.dsh-node-tool-output/v1');
  assert.equal(saved.uri, saved.path); assert.equal(saved.sha256, sha(Buffer.from(text)));
  assert.equal(saved.sizeBytes, Buffer.byteLength(text)); assert.equal(readFileSync(saved.path, 'utf8'), text);
  assert.equal(lstatSync(saved.path).nlink, 1); assert.equal(lstatSync(saved.path).mode & 0o077, 0);
  const facts = JSON.parse(readFileSync(join(dirname(saved.path), 'metadata.json')));
  const { signal, ...json } = req;
  assert.deepEqual(facts.request, json); assert.deepEqual(facts.metadata, meta);
  assert.equal(facts.sha256, saved.sha256); assert.equal(facts.sizeBytes, saved.sizeBytes);
  const original = readFileSync(join(dirname(saved.path), 'metadata.json'));
  h.store.close();
  const cold = createDshNodeToolOutputStore({ directory: h.directory, agentId: 'agent' }); t.after(() => cold.close());
  assert.deepEqual(cold.persistOutput(request(), text, metadata()), saved);
  assert.ok(readFileSync(join(dirname(saved.path), 'metadata.json')).equals(original));
  assert.equal(readdirSync(dirname(dirname(saved.path))).filter(name => !name.startsWith('.')).length, 1);
});

test('full arguments, definitions, arbitrary JSON context and metadata determine identity', t => {
  const h = setup(t), baseline = h.persist();
  for (const change of [req => { req.call.arguments.url += '?page=2'; }, req => { req.futureContext = { version: 2 }; },
    req => { req.sessionId += '-2'; }, req => { req.call.callId += '-2'; }]) {
    const req = request(); change(req); assert.notEqual(h.persist(req).path, baseline.path);
  }
  const meta = metadata(); meta.reachedByteCeiling = true;
  assert.notEqual(h.persist(request(), meta).path, baseline.path);
  const forged = request(); forged.definition.description += ' changed';
  assert.throws(() => h.persist(forged), /output_definition_invalid/);
  assert.throws(() => h.persist(request('foreign')), /output_request_unbound/);
});

test('formerly colliding Agent/Session/call path components remain isolated', t => {
  const h = setup(t), paths = [];
  for (const agentId of ['a/b', 'a_b']) {
    const port = createDshNodeToolOutputStore({ directory: h.directory, agentId }); t.after(() => port.close());
    for (const session of ['s/a', 's_a']) for (const call of ['c/a', 'c_a'])
      paths.push(port.persistOutput(request(agentId, session, call), text, metadata()).path);
  }
  assert.equal(new Set(paths).size, 8);
});

test('trusted root alias is canonicalized; owned child aliases are rejected', t => {
  const h = setup(t), alias = join(h.root, 'state-alias'); symlinkSync(h.directory, alias, 'dir');
  const port = createDshNodeToolOutputStore({ directory: alias, agentId: 'alias-agent' }); t.after(() => port.close());
  assert.ok(port.persistOutput(request('alias-agent'), text, metadata()).path.startsWith(realpathSync(h.directory)));
  const outside = join(h.root, 'outside'); mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(h.directory, sha('trapped')), 'dir');
  assert.throws(() => createDshNodeToolOutputStore({ directory: h.directory, agentId: 'trapped' }), /output_directory_not_private/);
});

for (const trap of ['same-size-content', 'meta-content', 'text-symlink', 'meta-symlink', 'text-hardlink', 'meta-hardlink', 'public-file', 'missing-meta']) {
  test(`existing entry is verified without overwriting a trap: ${trap}`, t => {
    const h = setup(t), saved = h.persist(), metaPath = join(dirname(saved.path), 'metadata.json');
    const victim = join(h.root, 'victim'); writeFileSync(victim, 'victim-original', { mode: 0o600 });
    if (trap === 'same-size-content') writeFileSync(saved.path, Buffer.alloc(saved.sizeBytes, 65));
    if (trap === 'meta-content') writeFileSync(metaPath, '{}');
    if (trap.endsWith('symlink')) { const target = trap.startsWith('text') ? saved.path : metaPath; unlinkSync(target); symlinkSync(victim, target); }
    if (trap.endsWith('hardlink')) { const target = trap.startsWith('text') ? saved.path : metaPath; unlinkSync(target); linkSync(victim, target); }
    if (trap === 'public-file') chmodSync(saved.path, 0o644);
    if (trap === 'missing-meta') unlinkSync(metaPath);
    assert.throws(() => h.persist());
    assert.equal(readFileSync(victim, 'utf8'), 'victim-original');
    if (trap === 'missing-meta') assert.equal(existsSync(metaPath), false, 'partial/corrupt entry is not silently repaired');
  });
}

test('existing public directory and an empty final entry are not silently replaced', t => {
  const h = setup(t), agentPath = join(h.directory, sha('public'));
  mkdirSync(agentPath, { mode: 0o755 }); chmodSync(agentPath, 0o755);
  assert.throws(() => createDshNodeToolOutputStore({ directory: h.directory, agentId: 'public' }), /not_private/);
  const saved = h.persist(), entry = dirname(saved.path);
  unlinkSync(saved.path); unlinkSync(join(entry, 'metadata.json'));
  const before = lstatSync(entry).ino;
  assert.throws(() => h.persist()); assert.equal(lstatSync(entry).ino, before);
  assert.deepEqual(readdirSync(entry), []);
});

test('close, original cancellation, metadata and full request drift fail before publication', async t => {
  let callback = () => false;
  const h = setup(t, { isClosed: () => callback() });
  for (const mutate of [(req) => { req.futureContext = { changed: true }; },
    (_req, meta) => { meta.fullBytes++; }, (req) => { req.signal = new AbortController().signal; }]) {
    const req = request(), meta = metadata(); let checks = 0;
    callback = () => { if (++checks === 4) mutate(req, meta); return false; };
    assert.throws(() => h.persist(req, meta), /drifted/);
  }
  const aborted = request(); const controller = new AbortController(); controller.abort(); aborted.signal = controller.signal;
  callback = () => false; assert.throws(() => h.persist(aborted), /abort/i);
  callback = () => Promise.reject(new Error('async closed must be observed'));
  assert.throws(() => h.persist(), /output_is_closed_invalid/);
  await new Promise(resolve => setImmediate(resolve));
  callback = () => false; h.store.close(); assert.throws(() => h.persist(), /output_closed/);
  const owner = new AbortController();
  const owned = createDshNodeToolOutputStore({ directory: h.directory, agentId: 'agent', signal: owner.signal });
  t.after(() => owned.close()); owner.abort();
  assert.throws(() => owned.persistOutput(request(), text, metadata()), /output_closed/);
});

const writer = `
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [jobFile] = process.argv.slice(2), job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
if (job.boundary) {
  const rename = fs.renameSync;
  const hook = (stage, entry) => {
    fs.writeFileSync(job.checkpoint, JSON.stringify({ pid: process.pid, stage, entry }), { mode: 0o600 });
    const fd = fs.openSync(job.checkpoint, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const mutable = (await import('node:module')).default;
  const require = mutable.createRequire(import.meta.url), writableFs = require('node:fs');
  writableFs.renameSync = (stage, entry) => {
    if (job.boundary === 'before-publish') hook(stage, entry);
    const result = rename(stage, entry);
    if (job.boundary === 'after-publish') hook(stage, entry);
    return result;
  };
  syncBuiltinESMExports();
}
const { createDshNodeToolOutputStore } = await import(job.moduleUrl);
const store = createDshNodeToolOutputStore({ directory: job.directory, agentId: job.request.agentId });
const run = () => {
  try { const result = store.persistOutput({ ...job.request, signal: new AbortController().signal }, job.text, job.metadata);
    process.stdout.write(JSON.stringify(result)); store.close(); }
  catch (error) { process.stderr.write(error.stack); process.exitCode = 1; }
};
if (job.ready) {
  fs.writeFileSync(job.ready, 'ready');
  const timer = setInterval(() => { if (fs.existsSync(job.go)) { clearInterval(timer); run(); } }, 5);
} else run();
`;

function child(t, h, options = {}) {
  const name = 'writer-' + Math.random().toString(16).slice(2), script = join(h.root, name + '.mjs');
  writeFileSync(script, writer);
  const { signal, ...json } = request();
  const job = { moduleUrl, directory: h.directory, request: json, text, metadata: metadata(), ...options };
  const jobPath = join(h.root, name + '.json'); writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  const process = spawn(globalThis.process.execPath, [script, jobPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', bytes => { stdout += bytes; }); process.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    process.once('error', reject); process.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await done; });
  return { process, done };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'child process checkpoint timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('eight real processes publish the same complete identity concurrently without deleting each other', async t => {
  const h = setup(t), go = join(h.root, 'go');
  const children = Array.from({ length: 8 }, (_, index) => child(t, h, { ready: join(h.root, 'ready-' + index), go }));
  await waitFor(() => children.every((_child, index) => existsSync(join(h.root, 'ready-' + index))));
  writeFileSync(go, 'start');
  const results = await Promise.all(children.map(child => child.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const saved = results.map(result => JSON.parse(result.stdout));
  assert.equal(new Set(saved.map(result => result.path)).size, 1);
  assert.equal(readFileSync(saved[0].path, 'utf8'), text);
  assert.deepEqual(h.persist(), saved[0]);
  assert.equal(readdirSync(dirname(dirname(saved[0].path))).filter(name => !name.startsWith('.')).length, 1);
});

for (const boundary of ['before-publish', 'after-publish']) test(`real SIGKILL ${boundary} reopens the original complete facts without a partial entry`, async t => {
  const h = setup(t), checkpoint = join(h.root, 'checkpoint'), running = child(t, h, { boundary, checkpoint });
  await waitFor(() => existsSync(checkpoint));
  const observed = JSON.parse(readFileSync(checkpoint));
  assert.equal(observed.pid, running.process.pid);
  assert.equal(existsSync(observed.entry), boundary === 'after-publish');
  const originalText = readFileSync(join(boundary === 'after-publish' ? observed.entry : observed.stage, 'output.txt'));
  const originalMeta = readFileSync(join(boundary === 'after-publish' ? observed.entry : observed.stage, 'metadata.json'));
  running.process.kill('SIGKILL');
  const terminated = await running.done; assert.equal(terminated.signal, 'SIGKILL');
  assert.throws(() => globalThis.process.kill(observed.pid, 0), { code: 'ESRCH' });
  const cold = createDshNodeToolOutputStore({ directory: h.directory, agentId: 'agent' }); t.after(() => cold.close());
  const saved = cold.persistOutput(request(), text, metadata());
  assert.equal(dirname(saved.path), observed.entry);
  assert.ok(readFileSync(saved.path).equals(originalText));
  assert.ok(readFileSync(join(observed.entry, 'metadata.json')).equals(originalMeta));
  assert.deepEqual(cold.persistOutput(request(), text, metadata()), saved);
});
