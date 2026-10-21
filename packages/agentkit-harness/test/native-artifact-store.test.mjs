import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import {
  scopeDigest, runDigest, identityDigest, canonicalStringify, sha256HexOfString,
} from '../src/native/artifact-codec.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' });
const OTHER_SCOPE = Object.freeze({ tenantId: 'other', workspaceId: 'ws', userId: 'user', agentId: 'agent' });

function ctx(runId, operationKey, signal) {
  return {
    scope: SCOPE, runId, sessionId: 'sess', turnId: 'turn-1', buildId: 'build-1',
    parentRunId: null, taskChainId: 'chain', operationKey,
    signal: signal || new AbortController().signal,
  };
}

async function setup({ limits } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-art-'));
  const store = await createNativeArtifactStore({ directory, scope: SCOPE, ...limits });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  return { directory, store, cleanup };
}

function pathsFor(store, runId, operationKey) {
  const sd = scopeDigest(SCOPE);
  const rd = runDigest(SCOPE, runId);
  const id = identityDigest(SCOPE, runId, operationKey);
  const dir = join(store.directory, 'artifacts', sd, rd);
  return { dir, contentPath: join(dir, id + '.content'), metaPath: join(dir, id + '.meta.json'), id };
}

function abortNow() {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

test('artifact metadata exact integers survive disk reopen and search', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const integer = 9007199254740993n;
    const ref = await store.write({ ...ctx('numeric', 'write'), content: 'exact', mediaType: 'text/plain', metadata: { id: integer } });
    assert.equal(ref.metadata.id, integer);
    const reopened = await createNativeArtifactStore({ directory, scope: SCOPE });
    const read = await reopened.read({ ...ctx('numeric', 'read'), ref, offset: 0, limit: 100 });
    assert.equal(read.content, 'exact');
    const matches = await reopened.search({ ...ctx('numeric', 'search'), query: 'exact', limit: 10 });
    assert.equal(matches[0].metadata.id, integer);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// write / read / paging

test('write returns a typed ref and read round-trips exact UTF-8 content', async () => {
  const { store, cleanup } = await setup();
  try {
    const content = '完整内容😀abc\né́x'; // mixed CJK, emoji (4-byte), combining
    const ref = await store.write({ ...ctx('r1', 'op-1'), content, mediaType: 'text/plain', metadata: { seq: 1, tag: 'a' } });
    assert.equal(ref.digest, 'sha256:' + sha256HexOfString(content));
    assert.equal(ref.sizeBytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(ref.mediaType, 'text/plain');
    assert.deepEqual(ref.metadata, { seq: 1, tag: 'a' });
    assert.match(ref.uri, /^artifact:\/\/[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9a-f]{64}$/);

    const page = await store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 32000 });
    assert.equal(page.content, content);
    assert.equal(page.nextOffset, null);
  } finally { cleanup(); }
});

test('read pages by Unicode code point, not UTF-16 code units', async () => {
  const { store, cleanup } = await setup();
  try {
    // code points: 完 整 😀 a b c  => 6 code points, 3+3+4+1+1+1 = 13 bytes
    const content = '完整😀abc';
    const ref = await store.write({ ...ctx('r1', 'op-1'), content, mediaType: 'text/plain', metadata: {} });
    const p0 = await store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 2 });
    assert.equal(p0.content, '完整');
    assert.equal(p0.nextOffset, 2);
    const p1 = await store.read({ ...ctx('r1', 'op-1'), ref, offset: 2, limit: 2 });
    assert.equal(p1.content, '😀a');
    assert.equal(p1.nextOffset, 4);
    const p2 = await store.read({ ...ctx('r1', 'op-1'), ref, offset: 4, limit: 10 });
    assert.equal(p2.content, 'bc');
    assert.equal(p2.nextOffset, null);
    // combining sequence: e + combining acute is two code points, not one
    const comb = await store.write({ ...ctx('r1', 'op-2'), content: 'éx', mediaType: 'text/plain', metadata: {} });
    const pc = await store.read({ ...ctx('r1', 'op-2'), ref: comb, offset: 0, limit: 2 });
    assert.equal(pc.content, 'é');
    assert.equal(pc.nextOffset, 2);
    const pc2 = await store.read({ ...ctx('r1', 'op-2'), ref: comb, offset: 2, limit: 1 });
    assert.equal(pc2.content, 'x');
    assert.equal(pc2.nextOffset, null);
  } finally { cleanup(); }
});

test('read at the exact end returns empty content and null next offset', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'abc', mediaType: 'text/plain', metadata: {} });
    const end = await store.read({ ...ctx('r1', 'op-1'), ref, offset: 3, limit: 5 });
    assert.equal(end.content, '');
    assert.equal(end.nextOffset, null);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// range checks

test('read rejects negative, fractional and out-of-bounds offsets and bad limits', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'abc', mediaType: 'text/plain', metadata: {} });
    const bad = [
      { offset: -1, limit: 1 },
      { offset: 1.5, limit: 1 },
      { offset: 0, limit: 0 },
      { offset: 0, limit: -1 },
      { offset: 0, limit: 1.5 },
      { offset: 99, limit: 1 }, // beyond content
      { offset: 0, limit: 1000000 }, // over the 32000 default cap
    ];
    for (const { offset, limit } of bad) {
      await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset, limit }), /artifact_/);
    }
  } finally { cleanup(); }
});

test('read default limit cap is 32000 and can be configured', async () => {
  const { store, cleanup } = await setup({ limits: { maxReadChars: 5 } });
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'abcdefgh', mediaType: 'text/plain', metadata: {} });
    const page = await store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 5 });
    assert.equal(page.content, 'abcde');
    assert.equal(page.nextOffset, 5);
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 6 }), /invalid_artifact_limit/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// same-identity idempotency and conflict

test('same identity + same content/type/metadata returns the same ref with one on-disk artifact', async () => {
  const { store, cleanup } = await setup();
  try {
    const args = { ...ctx('r1', 'op-1'), content: 'same', mediaType: 'text/plain', metadata: { a: 1 } };
    const a = await store.write(args);
    const b = await store.write(args);
    const c = await store.write(args);
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    const { dir } = pathsFor(store, 'r1', 'op-1');
    // exactly one content + one meta file for this identity (no temp leftovers)
    const names = readdirSync(dir).filter((n) => !n.includes('.tmp.'));
    assert.equal(names.length, 2);
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'r1' });
    assert.equal(usage, a.sizeBytes); // counted once
  } finally { cleanup(); }
});

test('same identity with different content, type or metadata is an explicit conflict', async () => {
  const { store, cleanup } = await setup();
  try {
    const base = await store.write({ ...ctx('r1', 'op-1'), content: 'c1', mediaType: 'text/plain', metadata: { x: 1 } });
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'c2', mediaType: 'text/plain', metadata: { x: 1 } }),
      /artifact_identity_conflict/,
    );
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'c1', mediaType: 'text/markdown', metadata: { x: 1 } }),
      /artifact_identity_conflict/,
    );
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'c1', mediaType: 'text/plain', metadata: { x: 2 } }),
      /artifact_identity_conflict/,
    );
    // the original sealed artifact is unchanged and still readable
    const page = await store.read({ ...ctx('r1', 'op-1'), ref: base, offset: 0, limit: 10 });
    assert.equal(page.content, 'c1');
  } finally { cleanup(); }
});

test('operationKey with path-like or traversal characters is hashed, never reaches the path', async () => {
  const { store, cleanup } = await setup();
  try {
    const evil = '../../etc/passwd\0call-1';
    const ref = await store.write({ ...ctx('r1', evil), content: 'safe', mediaType: 'text/plain', metadata: {} });
    const { dir } = pathsFor(store, 'r1', evil);
    // directory contains only hex-named files, no traversal
    for (const name of readdirSync(dir)) {
      assert.match(name, /^[0-9a-f]{64}\.(content|meta\.json)(\.tmp\.[0-9a-z]+)?$/);
    }
    const page = await store.read({ ...ctx('r1', evil), ref, offset: 0, limit: 10 });
    assert.equal(page.content, 'safe');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// cross scope / run isolation

test('cross-scope write, read and search are all rejected', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: {} });
    const otherCtx = { ...ctx('r1', 'op-1'), scope: OTHER_SCOPE };
    await assert.rejects(() => store.write({ ...otherCtx, content: 'y', mediaType: 'text/plain', metadata: {} }), /artifact_scope_mismatch/);
    await assert.rejects(() => store.read({ ...otherCtx, ref, offset: 0, limit: 1 }), /artifact_scope_mismatch/);
    await assert.rejects(() => store.search({ ...otherCtx, query: 'x', limit: 1 }), /artifact_scope_mismatch/);
  } finally { cleanup(); }
});

test('search is confined to the current run', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.write({ ...ctx('r1', 'a'), content: 'needle here', mediaType: 'text/plain', metadata: {} });
    await store.write({ ...ctx('r2', 'a'), content: 'needle elsewhere', mediaType: 'text/plain', metadata: {} });
    const onlyR1 = await store.search({ ...ctx('r1', 'q'), query: 'needle', limit: 10 });
    const onlyR2 = await store.search({ ...ctx('r2', 'q'), query: 'needle', limit: 10 });
    assert.equal(onlyR1.length, 1);
    assert.equal(onlyR2.length, 1);
    assert.notEqual(onlyR1[0].uri, onlyR2[0].uri);
  } finally { cleanup(); }
});

test('read is allowed across runs within the same scope (inheritance precondition)', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'shared', mediaType: 'text/plain', metadata: {} });
    // a different run in the same scope can read the sealed ref (exact match)
    const page = await store.read({ ...ctx('r2', 'reader-op'), ref, offset: 0, limit: 10 });
    assert.equal(page.content, 'shared');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// malicious URI / ref

test('read rejects a ref whose URI is malformed or escapes the scope', async () => {
  const { store, cleanup } = await setup();
  try {
    const sealed = await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: {} });
    const malformed = [
      { ...sealed, uri: 'artifact://not-hex/r/x' },
      { ...sealed, uri: 'artifact://../../etc/passwd' },
      { ...sealed, uri: 'artifact://abc/abc/abc' }, // too short / non-hex
    ];
    for (const ref of malformed) {
      await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 1 }), /artifact_/);
    }
    // a ref with a wrong scope digest (still hex) is rejected as outside scope
    const wrongScope = { ...sealed, uri: 'artifact://' + '0'.repeat(64) + '/' + '0'.repeat(64) + '/' + '0'.repeat(64) };
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref: wrongScope, offset: 0, limit: 1 }), /artifact_ref_outside_scope/);
    // a ref pointing at a non-existent identity in this scope is unknown
    const ghost = { ...sealed, uri: sealed.uri.replace(/\/[0-9a-f]{64}$/, '/' + '0'.repeat(64)) };
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref: ghost, offset: 0, limit: 1 }), /artifact_ref_unknown/);
  } finally { cleanup(); }
});

test('read rejects a ref whose digest, size or metadata were tampered (exact match)', async () => {
  const { store, cleanup } = await setup();
  try {
    const sealed = await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: { k: 1 } });
    const tamperedDigest = { ...sealed, digest: 'sha256:' + '0'.repeat(64) };
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref: tamperedDigest, offset: 0, limit: 1 }), /artifact_ref_changed/);
    const tamperedSize = { ...sealed, sizeBytes: sealed.sizeBytes + 1 };
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref: tamperedSize, offset: 0, limit: 1 }), /artifact_ref_changed/);
    const tamperedMeta = { ...sealed, metadata: { k: 2 } };
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref: tamperedMeta, offset: 0, limit: 1 }), /artifact_ref_changed/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// corruption: fail closed

test('corrupted content (digest mismatch) fails closed on read, search and usage', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'original', mediaType: 'text/plain', metadata: {} });
    const { contentPath } = pathsFor(store, 'r1', 'op-1');
    writeFileSync(contentPath, 'TAMPERED!'); // same length, different bytes
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 10 }), /artifact_content_integrity_mismatch/);
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: 'r1' }), /artifact_record_corrupt/);
    // search over the run must also fail closed, not return an empty list
    await assert.rejects(() => store.search({ ...ctx('r1', 'q'), query: 'original', limit: 10 }), /artifact_record_corrupt|artifact_/);
  } finally { cleanup(); }
});

test('missing content with meta present fails closed; orphan content (meta absent) is counted as usage', async () => {
  const { store, cleanup } = await setup();
  try {
    // Isolate the corruption case in its own run so a later write's budget
    // check (which scans the run) is not poisoned by the missing content.
    const sealed = await store.write({ ...ctx('rc', 'op-sealed'), content: 'sealed', mediaType: 'text/plain', metadata: {} });
    const { contentPath: sealedContent } = pathsFor(store, 'rc', 'op-sealed');
    rmSync(sealedContent, { force: true });
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: 'rc' }), /artifact_record_corrupt/);
    await assert.rejects(() => store.read({ ...ctx('rc', 'op-sealed'), ref: sealed, offset: 0, limit: 10 }), /artifact_content_missing/);
    // search over the corrupted run also fails closed rather than returning []
    await assert.rejects(() => store.search({ ...ctx('rc', 'q'), query: 'sealed', limit: 10 }), /artifact_content_missing|artifact_record_corrupt/);

    // Orphan content (published, meta absent) in a separate run counts as
    // usage: the result was published but the caller may not have received it.
    const orphan = await store.write({ ...ctx('ro', 'op-orphan'), content: 'orphan-body', mediaType: 'text/plain', metadata: {} });
    const { metaPath: orphanMeta } = pathsFor(store, 'ro', 'op-orphan');
    rmSync(orphanMeta, { force: true });
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'ro' });
    assert.equal(usage, orphan.sizeBytes);
    // an orphan (not sealed) is excluded from search rather than matched
    const orphanHits = await store.search({ ...ctx('ro', 'q'), query: 'orphan-body', limit: 10 });
    assert.equal(orphanHits.length, 0);
  } finally { cleanup(); }
});

test('meta sidecar with duplicate keys or prototype-polluting keys is rejected across read, search and usage', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: {} });
    const { metaPath } = pathsFor(store, 'r1', 'op-1');
    writeFileSync(metaPath, '{"uri":"u","digest":"sha256:' + '0'.repeat(64) + '","mediaType":"text/plain","sizeBytes":1,"metadata":{},"createdAt":"t","dup":1,"dup":2}');
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 1 }), /invalid_artifact_record/);
    await assert.rejects(() => store.search({ ...ctx('r1', 'q'), query: 'x', limit: 10 }), /invalid_artifact_record/);
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: 'r1' }), /invalid_artifact_record/);
    writeFileSync(metaPath, '{"__proto__":{"x":1},"uri":"u","digest":"sha256:' + '0'.repeat(64) + '","mediaType":"text/plain","sizeBytes":1,"metadata":{},"createdAt":"t"}');
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 1 }), /invalid_artifact_record/);
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: 'r1' }), /invalid_artifact_record/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// symlink rejection

test('a symlink content file is rejected on read', async () => {
  const { store, cleanup } = await setup();
  try {
    const ref = await store.write({ ...ctx('r1', 'op-1'), content: 'real', mediaType: 'text/plain', metadata: {} });
    const { contentPath, dir } = pathsFor(store, 'r1', 'op-1');
    const outside = join(store.directory, 'outside-secret.txt');
    writeFileSync(outside, 'secret');
    rmSync(contentPath, { force: true });
    symlinkSync(outside, contentPath);
    await assert.rejects(() => store.read({ ...ctx('r1', 'op-1'), ref, offset: 0, limit: 10 }), /artifact_symlink_rejected/);
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: 'r1' }), /artifact_symlink_rejected/);
    void dir;
  } finally { cleanup(); }
});

test('a symlink run directory pointing outside is rejected', async () => {
  const { store, cleanup } = await setup();
  try {
    // write into r1 first to materialize the scope dir
    await store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: {} });
    const sd = scopeDigest(SCOPE);
    const rd = runDigest(SCOPE, 'r2');
    const scopeDir = join(store.directory, 'artifacts', sd);
    const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
    symlinkSync(outsideDir, join(scopeDir, rd));
    await assert.rejects(() => store.search({ ...ctx('r2', 'q'), query: 'x', limit: 1 }), /artifact_path_escape|artifact_symlink_rejected/);
    rmSync(outsideDir, { recursive: true, force: true });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// abort signal

test('abort before write creates no files; abort after publish cannot undo a sealed artifact', async () => {
  const { store, cleanup } = await setup();
  try {
    // aborted before the operation: no side effects, no content/meta files
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-abort', abortNow()), content: 'nope', mediaType: 'text/plain', metadata: {} }),
      /artifact_aborted|AbortError/,
    );
    const { contentPath: abortContent, metaPath: abortMeta } = pathsFor(store, 'r1', 'op-abort');
    assert.ok(!existsSync(abortContent), 'no content file for an aborted write');
    assert.ok(!existsSync(abortMeta), 'no meta file for an aborted write');

    // a sealed artifact survives an aborted idempotent re-write (cancel cannot undo publish)
    const ref = await store.write({ ...ctx('r1', 'op-seal'), content: 'sealed', mediaType: 'text/plain', metadata: {} });
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-seal', abortNow()), content: 'sealed', mediaType: 'text/plain', metadata: {} }),
      /artifact_aborted|AbortError/,
    );
    const page = await store.read({ ...ctx('r1', 'op-seal'), ref, offset: 0, limit: 10 });
    assert.equal(page.content, 'sealed');
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'r1' });
    assert.equal(usage, ref.sizeBytes);
  } finally { cleanup(); }
});

test('abort at the search boundary throws and returns no partial list', async () => {
  const { store, cleanup } = await setup();
  try {
    for (let i = 0; i < 5; i += 1) {
      await store.write({ ...ctx('r1', `op-${i}`), content: `item-${i} needle`, mediaType: 'text/plain', metadata: {} });
    }
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => store.search({ ...ctx('r1', 'q', ac.signal), query: 'needle', limit: 10 }),
      /artifact_aborted|AbortError/,
    );
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// usage

test('usage counts each identity once and includes published-but-unreturned artifacts after reopen', async () => {
  const { directory, store, cleanup } = await setup();
  try {
    const r1 = await store.write({ ...ctx('r1', 'a'), content: 'aaaa', mediaType: 'text/plain', metadata: {} });
    const r2 = await store.write({ ...ctx('r1', 'b'), content: 'bbbbbbbb', mediaType: 'text/plain', metadata: {} });
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'r1' }), r1.sizeBytes + r2.sizeBytes);
    // reopen and count again
    const reopened = await createNativeArtifactStore({ directory, scope: SCOPE });
    assert.equal(await reopened.usageBytes({ scope: SCOPE, runId: 'r1' }), r1.sizeBytes + r2.sizeBytes);
    // different run has its own usage
    assert.equal(await reopened.usageBytes({ scope: SCOPE, runId: 'r2' }), 0);
  } finally { cleanup(); }
});

test('usage rejects a foreign scope and a bad run id', async () => {
  const { store, cleanup } = await setup();
  try {
    await assert.rejects(() => store.usageBytes({ scope: OTHER_SCOPE, runId: 'r1' }), /artifact_scope_mismatch/);
    await assert.rejects(() => store.usageBytes({ scope: SCOPE, runId: '' }), /invalid_run_id/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// budget

test('per-item and total byte budgets are enforced before any file is written', async () => {
  const { store, cleanup } = await setup({ limits: { maxItemBytes: 4, maxTotalBytes: 6 } });
  try {
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'too-big'), content: 'xxxxxx', mediaType: 'text/plain', metadata: {} }),
      /artifact_too_large/,
    );
    const { dir } = pathsFor(store, 'r1', 'too-big');
    assert.ok(!existsSync(dir), 'no directory created for an over-budget write');
    const a = await store.write({ ...ctx('r1', 'a'), content: 'aa', mediaType: 'text/plain', metadata: {} }); // 2 bytes
    await store.write({ ...ctx('r1', 'b'), content: 'bb', mediaType: 'text/plain', metadata: {} }); // 2 bytes -> total 4
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'c'), content: 'ccc', mediaType: 'text/plain', metadata: {} }), // 3 -> 7 > 6
      /artifact_budget_exceeded/,
    );
    // idempotent re-write of an already-sealed artifact is not blocked by budget
    const aAgain = await store.write({ ...ctx('r1', 'a'), content: 'aa', mediaType: 'text/plain', metadata: {} });
    assert.deepEqual(aAgain, a);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// search limits and semantics

test('search is literal, case-sensitive, bounded and deterministically ordered', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.write({ ...ctx('r1', 'a'), content: 'Hello World', mediaType: 'text/plain', metadata: {} });
    await store.write({ ...ctx('r1', 'b'), content: 'hello world', mediaType: 'text/plain', metadata: {} });
    await store.write({ ...ctx('r1', 'c'), content: 'say Hello there', mediaType: 'text/plain', metadata: {} });
    const exact = await store.search({ ...ctx('r1', 'q'), query: 'Hello', limit: 10 });
    assert.equal(exact.length, 2, 'case-sensitive: only capital-H Hello matches');
    const limited = await store.search({ ...ctx('r1', 'q'), query: 'Hello', limit: 1 });
    assert.equal(limited.length, 1);
    // deterministic order by uri means the first limited result is the smallest uri
    const sorted = [...exact].sort((x, y) => (x.uri < y.uri ? -1 : 1));
    assert.equal(limited[0].uri, sorted[0].uri);
    await assert.rejects(() => store.search({ ...ctx('r1', 'q'), query: '', limit: 1 }), /invalid_artifact_search_query/);
    await assert.rejects(() => store.search({ ...ctx('r1', 'q'), query: 'x', limit: 0 }), /invalid_artifact_search_limit/);
    await assert.rejects(() => store.search({ ...ctx('r1', 'q'), query: 'x', limit: 999 }), /invalid_artifact_search_limit/);
  } finally { cleanup(); }
});

test('search skips artifacts larger than the scan budget and returns their refs from other queries', async () => {
  const { store, cleanup } = await setup({ limits: { maxScanBytes: 8 } });
  try {
    const small = await store.write({ ...ctx('r1', 'small'), content: 'hit', mediaType: 'text/plain', metadata: {} });
    await store.write({ ...ctx('r1', 'big'), content: 'x'.repeat(100), mediaType: 'text/plain', metadata: {} });
    const hits = await store.search({ ...ctx('r1', 'q'), query: 'hit', limit: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].uri, small.uri);
    // the too-large artifact is excluded from search (cannot confirm match)
    const none = await store.search({ ...ctx('r1', 'q'), query: 'x', limit: 10 });
    assert.equal(none.length, 0);
  } finally { cleanup(); }
});

test('metadata with nested prototype-polluting keys is rejected on write', async () => {
  const { store, cleanup } = await setup();
  try {
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: { ok: 1, nested: { __proto__: { polluted: true } } } }),
      /invalid_artifact_metadata/,
    );
    await assert.rejects(
      () => store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'text/plain', metadata: { constructor: 1 } }),
      /invalid_artifact_metadata/,
    );
  } finally { cleanup(); }
});

test('invalid mediaType is rejected', async () => {
  const { store, cleanup } = await setup();
  try {
    await assert.rejects(() => store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: '', metadata: {} }), /invalid_artifact_media_type/);
    await assert.rejects(() => store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'a\nb', metadata: {} }), /invalid_artifact_media_type/);
    await assert.rejects(() => store.write({ ...ctx('r1', 'op-1'), content: 'x', mediaType: 'x'.repeat(200), metadata: {} }), /invalid_artifact_media_type/);
  } finally { cleanup(); }
});

test('structurally satisfies the core ArtifactPort surface (write/read/search async functions)', async () => {
  const { store, cleanup } = await setup();
  try {
    assert.equal(typeof store.write, 'function');
    assert.equal(typeof store.read, 'function');
    assert.equal(typeof store.search, 'function');
    assert.equal(typeof store.usageBytes, 'function');
    assert.equal(store.write.constructor.name, 'AsyncFunction');
    assert.equal(store.read.constructor.name, 'AsyncFunction');
    assert.equal(store.search.constructor.name, 'AsyncFunction');
  } finally { cleanup(); }
});
