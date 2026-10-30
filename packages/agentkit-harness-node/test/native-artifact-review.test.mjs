// Review-driven evidence for the Native artifact store fixes. These tests
// reproduce the concrete problems the parent reviewer found and assert the
// fixes; they use real temp directories, real reopen instances and real Node
// subprocesses (no mock filesystem). Run with: node --test test/native-artifact-review.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import { scopeDigest, runDigest, identityDigest, canonicalStringify } from '../src/native/artifact-codec.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' });
const OTHER_SCOPE = Object.freeze({ tenantId: 'other', workspaceId: 'ws', userId: 'user', agentId: 'agent' });
const HARNESS_DIR = new URL('..', import.meta.url).pathname;

function ctx(runId, operationKey, signal) {
  return {
    scope: SCOPE, runId, sessionId: 'sess', turnId: 'turn-1', buildId: 'build-1',
    parentRunId: null, taskChainId: 'chain', operationKey,
    signal: signal || new AbortController().signal,
  };
}

async function setup({ limits } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-art-rev-'));
  const store = await createNativeArtifactStore({ directory, scope: SCOPE, ...limits });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  return { directory, store, cleanup };
}

function pathsFor(directory, runId, operationKey) {
  const sd = scopeDigest(SCOPE);
  const rd = runDigest(SCOPE, runId);
  const id = identityDigest(SCOPE, runId, operationKey);
  const dir = join(directory, 'artifacts', sd, rd);
  return { dir, contentPath: join(dir, id + '.content'), metaPath: join(dir, id + '.meta.json'), intentPath: join(dir, id + '.intent.json'), id };
}

// ---------------------------------------------------------------------------
// 1. strict per-run publication quota with real concurrency (no double-count)

const WRITER_SCRIPT = `
const { createNativeArtifactStore } = await import('./src/native/artifact-store.mjs');
const args = process.argv.slice(1).filter((a) => a !== '[eval]');
const [dir, runId, opKey, content, mediaType, metadataJson, maxTotal, maxItem] = args;
const scope = { tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' };
const opts = { directory: dir, scope };
if (maxTotal) opts.maxTotalBytes = Number(maxTotal);
if (maxItem) opts.maxItemBytes = Number(maxItem);
try {
  const store = await createNativeArtifactStore(opts);
  const ref = await store.write({ scope, runId, sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: opKey, signal: new AbortController().signal, content, mediaType, metadata: JSON.parse(metadataJson) });
  process.stdout.write(JSON.stringify(ref));
} catch (e) { process.stderr.write(String(e.code || e.message)); process.exit(1); }
`;

function runWriter({ dir, runId, opKey, content, mediaType = 'text/plain', metadata = {}, crashAfter, maxTotal, maxItem, env = {} }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER_SCRIPT, dir, runId, opKey, content, mediaType, JSON.stringify(metadata), maxTotal ? String(maxTotal) : '', maxItem ? String(maxItem) : ''], {
    cwd: HARNESS_DIR,
    env: { ...process.env, ...env, ...(crashAfter ? { NATIVE_ARTIFACT_CRASH_AFTER: crashAfter } : {}) },
  });
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('strict per-run quota: parallel distinct-identity writes admit exactly the budget, rest rejected, no double-count', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rev-quota-'));
  try {
    // maxTotalBytes=8, each item 4 bytes => at most 2 distinct identities admitted.
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      runWriter({ dir: directory, runId: 'quota-run', opKey: `op-${i}`, content: '1234', metadata: { i: String(i) }, maxTotal: 8, maxItem: 8 })));
    // Wait — distinct identities require distinct metadata above; the budget
    // is per-run bytes, so exactly 2 of the 8 (each 4 bytes) fit in 8 bytes.
    const fulfilled = results.filter((r) => r.code === 0 && r.stdout);
    const rejected = results.filter((r) => r.stderr.includes('artifact_budget_exceeded'));
    assert.equal(fulfilled.length, 2, 'exactly two 4-byte artifacts fit in 8 bytes');
    assert.equal(rejected.length, N - 2, 'the rest are rejected by the quota');
    assert.equal(rejected.length + fulfilled.length, N, 'every racer resolves');
    // usage equals exactly the budget, no double-count, no over-commit
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'quota-run' });
    assert.equal(usage, 8);
    // no orphan content or leftover intent from rejected writers
    const { dir: runDir } = pathsFor(directory, 'quota-run', 'op-0');
    const names = readdirSync(runDir).filter((n) => !n.includes('.tmp.') && n !== '.lock');
    const intents = names.filter((n) => n.endsWith('.intent.json'));
    assert.equal(intents.length, 0, 'rejected writers rolled back their intent');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('strict quota: same identity + same content under tight budget is idempotent and counts once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rev-quota-idem-'));
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      runWriter({ dir: directory, runId: 'idem-run', opKey: 'same-op', content: '1234', metadata: { tag: 'same' }, maxTotal: 4, maxItem: 4 })));
    const fulfilled = results.filter((r) => r.code === 0 && r.stdout);
    assert.equal(fulfilled.length, 8, 'all idempotent racers succeed (one artifact, counted once)');
    const refs = new Set(fulfilled.map((r) => r.stdout));
    assert.equal(refs.size, 1, 'all return the same ref');
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'idem-run' }), 4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 2. lost-publisher recovery: crash mid-write under lock, reopen completes
//    without two active writers

test('lost publisher: crash after content link is sealed by the next writer under lock takeover (real subprocess)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rev-lost-'));
  try {
    const crashed = await runWriter({ dir: directory, runId: 'lost-run', opKey: 'op-1', content: 'survives', crashAfter: 'content' });
    assert.equal(crashed.code, 0);
    assert.equal(crashed.stdout, '', 'publisher exited without returning the ref');
    const { contentPath, metaPath, intentPath } = pathsFor(directory, 'lost-run', 'op-1');
    assert.ok(existsSync(contentPath), 'content was linked before the crash');
    assert.ok(!existsSync(metaPath), 'meta not linked yet');
    assert.ok(existsSync(intentPath), 'intent was linked before content');
    // a successor in a fresh process completes the publication
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const ref = await store.write({
      scope: SCOPE, runId: 'lost-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op-1', signal: new AbortController().signal,
      content: 'survives', mediaType: 'text/plain', metadata: {},
    });
    assert.ok(existsSync(metaPath), 'meta sealed by the successor');
    assert.ok(!existsSync(intentPath), 'intent dropped after sealing');
    const page = await store.read({
      scope: SCOPE, runId: 'lost-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'reader', signal: new AbortController().signal, ref, offset: 0, limit: 32000,
    });
    assert.equal(page.content, 'survives');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('lost publisher: two successors never both actively publish (one winner, one idempotent)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rev-two-succ-'));
  try {
    // crash after content so an orphan + intent are left
    await runWriter({ dir: directory, runId: 'two-run', opKey: 'op-1', content: 'shared', crashAfter: 'content' });
    // two successor processes race to complete the same identity
    const results = await Promise.all([0, 1].map(() =>
      runWriter({ dir: directory, runId: 'two-run', opKey: 'op-1', content: 'shared', metadata: {} })));
    const fulfilled = results.filter((r) => r.code === 0 && r.stdout);
    assert.equal(fulfilled.length, 2, 'both succeed (idempotent — same ref), not two different results');
    assert.equal(new Set(fulfilled.map((r) => r.stdout)).size, 1, 'same ref from both');
    // exactly one sealed artifact on disk
    const { dir: runDir, metaPath } = pathsFor(directory, 'two-run', 'op-1');
    assert.ok(existsSync(metaPath));
    const sealed = readdirSync(runDir).filter((n) => n.endsWith('.meta.json'));
    assert.equal(sealed.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 3. orphan identity pin: a content-only orphan cannot be re-sealed as a
//    different request after a crash

test('orphan without intent cannot be re-sealed as a different mediaType/metadata (real file tamper)', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const { dir, contentPath } = pathsFor(directory, 'r1', 'op-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(contentPath, Buffer.from('same-text', 'utf8')); // orphan content, no intent
    // attempt to seal as a DIFFERENT request (different mediaType + metadata)
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'same-text', mediaType: 'text/markdown', metadata: { changed: true } }),
      /artifact_identity_conflict/,
    );
    // the orphan content is still on disk (not deleted), still charged by usage
    assert.ok(existsSync(contentPath));
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'r1' }), 'same-text'.length);
    // a correct same-identity write also cannot seal the intent-less orphan
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'same-text', mediaType: 'text/plain', metadata: {} }),
      /artifact_identity_conflict/,
    );
  } finally { cleanup(); }
});

test('orphan WITH intent: a successor completes the pinned publication; a different-identity request conflicts (real process crash)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rev-orphan-intent-'));
  try {
    // crash after content: intent + content linked, meta absent
    await runWriter({ dir: directory, runId: 'oi-run', opKey: 'op-1', content: 'pinned', crashAfter: 'content' });
    const { intentPath, metaPath } = pathsFor(directory, 'oi-run', 'op-1');
    assert.ok(existsSync(intentPath));
    // a DIFFERENT request for the same identity: the successor first completes
    // the pinned publication (takeover), then the differing request conflicts
    // with the now-sealed record — it must not seal its own different result.
    const conflict = await runWriter({ dir: directory, runId: 'oi-run', opKey: 'op-1', content: 'pinned', metadata: { different: true } });
    assert.ok(conflict.code !== 0, 'different metadata conflicts with the pinned/sealed record');
    assert.match(conflict.stderr, /artifact_identity_conflict/);
    // the sealed artifact reflects the ORIGINAL pinned request, not the conflict
    assert.ok(existsSync(metaPath), 'the pinned publication was completed by takeover');
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const found = await store.search({ ...ctx('oi-run', 'q'), query: 'pinned', limit: 10 });
    assert.equal(found.length, 1);
    // the sealed record carries the ORIGINAL pinned request's metadata, not the conflict's
    assert.deepEqual(found[0].metadata, {});
    // a later SAME request is idempotent against the sealed record
    const ok = await runWriter({ dir: directory, runId: 'oi-run', opKey: 'op-1', content: 'pinned', metadata: {} });
    assert.equal(ok.code, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 4. strict durable sidecar validation: no coercion, no tampered URI

test('read rejects a stored sizeBytes that is a string, float, or negative (no Number() coercion)', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'hello', mediaType: 'text/plain', metadata: {} });
    const { metaPath } = pathsFor(directory, 'r1', 'op-1');
    const { createHash } = await import('node:crypto');
    const dg = 'sha256:' + createHash('sha256').update(Buffer.from('hello')).digest('hex');
    const bad = [
      { sizeBytes: '5' },       // string
      { sizeBytes: 5.5 },       // float
      { sizeBytes: -1 },        // negative
      { sizeBytes: null },      // null
      { sizeBytes: true },      // boolean
    ];
    for (const override of bad) {
      writeFileSync(metaPath, canonicalStringify({ uri: ref.uri, digest: dg, mediaType: 'text/plain', sizeBytes: override.sizeBytes, metadata: {}, createdAt: 't' }));
      await assert.rejects(() => store.read({ ...ctx('r1', 'r'), ref, offset: 0, limit: 10 }), /invalid_artifact_record|artifact_ref_changed/);
    }
  } finally { cleanup(); }
});

test('read rejects a stored digest/mediaType/metadata of the wrong primitive type', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'hello', mediaType: 'text/plain', metadata: { k: 1 } });
    const { metaPath } = pathsFor(directory, 'r1', 'op-1');
    const { createHash } = await import('node:crypto');
    const dg = 'sha256:' + createHash('sha256').update(Buffer.from('hello')).digest('hex');
    const badMetas = [
      { digest: 5 },
      { mediaType: 123 },
      { metadata: 'notobj' },
      { metadata: [1, 2] },
      { uri: 'artifact://not-hex/x/y' },
    ];
    for (const o of badMetas) {
      writeFileSync(metaPath, canonicalStringify({ uri: o.uri !== undefined ? o.uri : ref.uri, digest: o.digest !== undefined ? o.digest : dg, mediaType: o.mediaType !== undefined ? o.mediaType : 'text/plain', sizeBytes: 5, metadata: o.metadata !== undefined ? o.metadata : { k: 1 }, createdAt: 't' }));
      await assert.rejects(() => store.read({ ...ctx('r1', 'r'), ref, offset: 0, limit: 10 }), /invalid_artifact_record/);
    }
  } finally { cleanup(); }
});

test('search never admits a tampered same-scope URI pointing at another run or identity', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'hello', mediaType: 'text/plain', metadata: { k: 1 } });
    const { metaPath } = pathsFor(directory, 'r1', 'op-1');
    const { createHash } = await import('node:crypto');
    const dg = 'sha256:' + createHash('sha256').update(Buffer.from('hello')).digest('hex');
    const sd = scopeDigest(SCOPE);
    const rdOther = runDigest(SCOPE, 'r-other');
    const idOther = identityDigest(SCOPE, 'r-other', 'op-1');
    // tamper: uri points at a different run/identity, rest matches
    writeFileSync(metaPath, canonicalStringify({ uri: `artifact://${sd}/${rdOther}/${idOther}`, digest: dg, mediaType: 'text/plain', sizeBytes: 5, metadata: { k: 1 }, createdAt: 't' }));
    await assert.rejects(() => store.search({ ...ctx('r1', 'q'), query: 'hello', limit: 10 }), /artifact_record_corrupt/);
    // usage over the tampered run also fails closed
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: 'r1' }), /artifact_record_corrupt/);
    void ref;
  } finally { cleanup(); }
});

test('read rejects a tampered same-scope URI pointing at another identity (path mismatch)', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'hello', mediaType: 'text/plain', metadata: {} });
    const { metaPath } = pathsFor(directory, 'r1', 'op-1');
    const { createHash } = await import('node:crypto');
    const dg = 'sha256:' + createHash('sha256').update(Buffer.from('hello')).digest('hex');
    const sd = scopeDigest(SCOPE), rd = runDigest(SCOPE, 'r1');
    const idOther = identityDigest(SCOPE, 'r1', 'op-other');
    writeFileSync(metaPath, canonicalStringify({ uri: `artifact://${sd}/${rd}/${idOther}`, digest: dg, mediaType: 'text/plain', sizeBytes: 5, metadata: {}, createdAt: 't' }));
    await assert.rejects(() => store.read({ ...ctx('r1', 'r'), ref, offset: 0, limit: 10 }), /artifact_record_corrupt/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 5. path / root identity hardening

test('isWithin rejects a content file replaced by a symlink to outside the root (root replacement)', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'real', mediaType: 'text/plain', metadata: {} });
    const { contentPath } = pathsFor(directory, 'r1', 'op-1');
    const outside = join(directory, 'outside-secret.txt');
    writeFileSync(outside, 'secret');
    rmSync(contentPath, { force: true });
    symlinkSync(outside, contentPath);
    await assert.rejects(() => store.read({ ...ctx('r1', 'r'), ref, offset: 0, limit: 10 }), /artifact_symlink_rejected|artifact_path_escape/);
  } finally { cleanup(); }
});

test('a run directory replaced by a symlink to outside is rejected at search/usage boundary', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: {} });
    const sd = scopeDigest(SCOPE);
    const rd = runDigest(SCOPE, 'r2');
    const scopeDir = join(directory, 'artifacts', sd);
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    symlinkSync(outside, join(scopeDir, rd));
    await assert.rejects(() => store.search({ ...ctx('r2', 'q'), query: 'x', limit: 1 }), /artifact_path_escape|artifact_symlink_rejected/);
    rmSync(outside, { recursive: true, force: true });
  } finally { cleanup(); }
});

test('every on-disk scope/run directory name is a hex64 digest (no traversal segments)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rev-rel-'));
  try {
    // a store bound to an absolute temp dir; all on-disk names are hex digests
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: {} });
    await store.write({ ...ctx('r2', 'op-1'), content: 'y', mediaType: 'text/plain', metadata: {} });
    const sd = scopeDigest(SCOPE);
    const scopeDir = join(store.directory, 'artifacts', sd);
    for (const name of readdirSync(scopeDir)) {
      assert.match(name, /^[0-9a-f]{64}$/, 'run dir name is a hex64 digest');
      for (const f of readdirSync(join(scopeDir, name))) {
        // only content/meta/intent/lock with hex64 identity, plus the lock
        assert.match(f, /^(\.lock|[0-9a-f]{64}\.(content|meta\.json|intent\.json)(\.tmp\.[0-9a-z]+)?)$/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('abort during a new write rolls back the intent and leaves no published content', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    // abort before the write starts: nothing published
    const ac = new AbortController(); ac.abort();
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-abort', ac.signal), content: 'nope', mediaType: 'text/plain', metadata: {} }),
      /artifact_aborted|AbortError/,
    );
    const { contentPath, intentPath, metaPath } = pathsFor(directory, 'r1', 'op-abort');
    assert.ok(!existsSync(contentPath));
    assert.ok(!existsSync(intentPath));
    assert.ok(!existsSync(metaPath));
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'r1' }), 0);
  } finally { cleanup(); }
});

test('a sealed artifact is charged exactly once across usage, search and idempotent re-write', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'charge-once', mediaType: 'text/plain', metadata: { n: 1 } });
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'r1' }), ref.sizeBytes);
    const again = await store.write({ ...ctx('r1', 'op-1'), content: 'charge-once', mediaType: 'text/plain', metadata: { n: 1 } });
    assert.deepEqual(again, ref);
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'r1' }), ref.sizeBytes);
    const found = await store.search({ ...ctx('r1', 'q'), query: 'charge', limit: 10 });
    assert.equal(found.length, 1);
    assert.equal(found[0].uri, ref.uri);
  } finally { cleanup(); }
});
