// Deterministic boundary-scheduling and real independent-process successor
// tests for the SQLite-backed per-run artifact lock. These tests pin down the
// properties the parent reviewer's split-brain repro invalidated:
//
//   * two takers of one run can never both own the lock (no stale-takeover
//     split brain) — proven under a strict quota that would be over-committed
//     if exclusion failed;
//   * release is owner-bound and a crash releases the lock via the OS, so a
//     successor never waits on a stale lock and a crashed owner row is rolled
//     back by SQLite journal recovery (no stale owner);
//   * a holder deterministically blocks a concurrent taker at the publish
//     boundary (the taker retries SQLITE_BUSY, then is rejected by quota once
//     the holder releases) — never two active writers;
//   * orphan identity (intent sidecar) survives a crash and pins the original
//     request, so a differing successor conflicts instead of re-sealing.
//
// Run with: node --test test/native-artifact-lock.test.mjs
// (also run on the Node22 binary; see artifact-lock-review-evidence.txt)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import { scopeDigest, runDigest, identityDigest } from '../src/native/artifact-codec.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' });
const HARNESS_DIR = new URL('..', import.meta.url).pathname;

// Subprocess writer: a real, separate Node process with its own store instance
// against the same directory. Supports crash-after (exit at a publish position,
// holding the lock), hold-at (pause at a position while holding the lock), and
// tight quota.
const WRITER_SCRIPT = `
const { createNativeArtifactStore } = await import('./src/native/artifact-store.mjs');
const args = process.argv.slice(1).filter((a) => a !== '[eval]');
const [dir, runId, opKey, content, mediaType, metadataJson, maxTotal, maxItem] = args;
const scope = { tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' };
const opts = { directory: dir, scope };
if (maxTotal) opts.maxTotalBytes = Number(maxTotal);
if (maxItem) opts.maxItemBytes = Number(maxItem);
const t0 = Date.now();
try {
  const store = await createNativeArtifactStore(opts);
  const ref = await store.write({
    scope, runId, sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
    operationKey: opKey, signal: new AbortController().signal,
    content, mediaType, metadata: JSON.parse(metadataJson),
  });
  process.stdout.write(JSON.stringify({ ref, ms: Date.now() - t0 }));
} catch (e) {
  process.stderr.write(String(e.code || e.message) + '@' + (Date.now() - t0));
  process.exit(1);
}
`;

function runWriter({ dir, runId, opKey, content, mediaType = 'text/plain', metadata = {}, crashAfter, holdAt, holdMs, maxTotal, maxItem, signalFile, env = {} }) {
  const childEnv = { ...process.env, ...env };
  if (crashAfter) childEnv.NATIVE_ARTIFACT_CRASH_AFTER = crashAfter;
  if (holdAt) childEnv.NATIVE_ARTIFACT_HOLD_AT = holdAt;
  if (holdMs) childEnv.NATIVE_ARTIFACT_HOLD_MS = String(holdMs);
  if (signalFile) childEnv.NATIVE_ARTIFACT_SIGNAL_LOCK_FILE = signalFile;
  const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER_SCRIPT, dir, runId, opKey, content, mediaType, JSON.stringify(metadata), maxTotal ? String(maxTotal) : '', maxItem ? String(maxItem) : ''], {
    cwd: HARNESS_DIR,
    env: childEnv,
  });
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function pathsFor(directory, runId, opKey) {
  const sd = scopeDigest(SCOPE);
  const rd = runDigest(SCOPE, runId);
  const id = identityDigest(SCOPE, runId, opKey);
  const dir = join(directory, 'artifacts', sd, rd);
  return {
    dir, contentPath: join(dir, id + '.content'), metaPath: join(dir, id + '.meta.json'),
    intentPath: join(dir, id + '.intent.json'), id,
    lockDir: join(directory, 'artifacts', '.locks', sd),
    lockDb: join(directory, 'artifacts', '.locks', sd, rd + '.sqlite'),
  };
}

function freshDir() { return mkdtempSync(join(tmpdir(), 'native-art-lock-')); }

// Read the owner row from the lock database (white-box). Returns null when free
// (no row), or { token, pid, host, born_at } when held. Opening the database
// after a crash triggers journal recovery, so a stale owner is rolled back.
function ownerRow(lockDb) {
  let db;
  try { db = new DatabaseSync(lockDb, { timeout: 0 }); }
  catch { return { missing: true }; }
  try {
    const row = db.prepare('SELECT token, pid, host, born_at FROM lock_owner WHERE id = 1').get();
    return row || null;
  } catch (e) {
    return { err: String(e.errstr || e.message) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 1. deterministic same-process boundary: strict quota never double-owns

test('same-process: two concurrent distinct-identity writes under strict quota admit exactly one (no split brain)', async () => {
  const directory = freshDir();
  try {
    const store = await createNativeArtifactStore({ directory, scope: SCOPE, maxTotalBytes: 4, maxItemBytes: 4 });
    // Two DIFFERENT identities, each 4 bytes, under a 4-byte budget. Without
    // exclusion both pass the quota check (each sees usage 0) and over-commit to
    // 8 bytes — exactly the parent repro's split brain. With the SQLite lock
    // they serialize: one is admitted, the other is rejected by quota.
    const results = await Promise.allSettled([
      store.write({ scope: SCOPE, runId: 'sp-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: 'a', signal: new AbortController().signal, content: '1234', mediaType: 'text/plain', metadata: {} }),
      store.write({ scope: SCOPE, runId: 'sp-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: 'b', signal: new AbortController().signal, content: '1234', mediaType: 'text/plain', metadata: {} }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected' && String(r.reason?.code || r.reason).includes('artifact_budget_exceeded'));
    assert.equal(fulfilled.length, 1, 'exactly one write admitted');
    assert.equal(rejected.length, 1, 'exactly one write rejected by quota');
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'sp-run' }), 4, 'usage equals the budget, never 8');
    // the rejected writer rolled back its intent; the run dir holds exactly one
    // content + one meta for the winner, no orphan intent.
    const { dir } = pathsFor(directory, 'sp-run', 'a');
    const names = readdirSync(dir).filter((n) => !n.includes('.tmp.'));
    const contentMeta = names.filter((n) => n.endsWith('.content') || n.endsWith('.meta.json'));
    assert.equal(contentMeta.length, 2, 'one content + one meta');
    assert.equal(names.filter((n) => n.endsWith('.intent.json')).length, 0, 'no leftover intent');
    assert.ok(!names.includes('.lock') && !names.some((n) => n.endsWith('.sqlite')), 'no lock file in the run dir');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 2. deterministic cross-process boundary: a holder blocks a taker at the
//    publish boundary; the taker is rejected by quota AFTER the holder releases

test('cross-process: a holder holding the lock at the content boundary blocks a taker; taker rejected by quota after release', async () => {
  const directory = freshDir();
  try {
    // Holder A: admitted (passes quota), then HOLDs the lock at before-content
    // for 500ms before publishing content. A concurrent taker B cannot acquire
    // (SQLITE_BUSY retry) and cannot pass quota until A releases. A signals
    // via a sentinel file once it holds the lock, so B is started only AFTER A
    // has acquired — no spawn-timing race, fully deterministic.
    const sentinel = join(directory, 'holder-acquired');
    const aStarted = runWriter({ dir: directory, runId: 'hold-run', opKey: 'A', content: '1234', metadata: {}, holdAt: 'before-content', holdMs: 500, maxTotal: 4, maxItem: 4, signalFile: sentinel });
    // wait until A has actually acquired the lock (sentinel appears)
    const sig0 = Date.now();
    while (!existsSync(sentinel) && Date.now() - sig0 < 5000) await new Promise((r) => setTimeout(r, 5));
    assert.ok(existsSync(sentinel), 'holder A signaled it acquired the lock');
    const bStart = Date.now();
    const b = await runWriter({ dir: directory, runId: 'hold-run', opKey: 'B', content: '1234', metadata: {}, maxTotal: 4, maxItem: 4 });
    const a = await aStarted;
    const bElapsed = Date.now() - bStart;
    assert.equal(a.code, 0, 'holder A fulfilled');
    assert.equal(b.code, 1, 'taker B rejected');
    assert.match(b.stderr, /artifact_budget_exceeded/, 'B rejected by quota, not admitted');
    // B had to WAIT for A to release (the lock was held for ~500ms), proving B
    // never split-brained past the quota check while A held the lock.
    assert.ok(bElapsed >= 400, `B waited for the lock (elapsed=${bElapsed}ms), no split brain`);
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'hold-run' }), 4, 'usage equals the budget');
    // exactly one artifact (A's) on disk
    const { dir } = pathsFor(directory, 'hold-run', 'A');
    const sealed = readdirSync(dir).filter((n) => n.endsWith('.meta.json'));
    assert.equal(sealed.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 3. crash at the content boundary releases the lock via the OS; a successor
//    acquires immediately (no stale lock) and completes the publication

test('crash at before-content: the lock is released by the OS; a successor acquires without waiting on a stale lock', async () => {
  const directory = freshDir();
  try {
    // Crash A at before-content: it published the intent, passed quota, holds
    // the SQLite lock, then process.exit(0) WITHOUT committing. The OS reclaims
    // A's file descriptors and SQLite releases the write lock.
    const crashed = await runWriter({ dir: directory, runId: 'crashbc-run', opKey: 'op-1', content: 'survives', crashAfter: 'before-content' });
    assert.equal(crashed.code, 0);
    assert.equal(crashed.stdout, '', 'crashed before returning the ref');
    const { contentPath, metaPath, intentPath } = pathsFor(directory, 'crashbc-run', 'op-1');
    assert.ok(existsSync(intentPath), 'intent was linked before the crash');
    assert.ok(!existsSync(contentPath), 'content was not linked yet');
    assert.ok(!existsSync(metaPath));
    // A successor in a fresh process must acquire immediately — there is no
    // stale lock to take over. Time it to prove it did not stall on a stale lock.
    const t0 = Date.now();
    const succ = await runWriter({ dir: directory, runId: 'crashbc-run', opKey: 'op-1', content: 'survives', metadata: {} });
    const succMs = Date.now() - t0;
    assert.equal(succ.code, 0, 'successor fulfilled (idempotent completion of the pinned publication)');
    assert.ok(succMs < 2000, `successor acquired fast, no stale lock (ms=${succMs})`);
    assert.ok(existsSync(contentPath));
    assert.ok(existsSync(metaPath), 'meta sealed by the successor');
    assert.ok(!existsSync(intentPath), 'intent dropped after sealing');
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'crashbc-run' }), 'survives'.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 4. orphan identity after a crash pins the original request; two successors
//    never produce two results and the quota holds

test('crash leaves an orphan+intent; two successors: one completes the pinned publication, a differing one conflicts; quota holds', async () => {
  const directory = freshDir();
  try {
    // Crash after content: orphan content + intent pinning 'shared', no meta.
    await runWriter({ dir: directory, runId: 'orphan-run', opKey: 'op-1', content: 'shared', crashAfter: 'content' });
    const { intentPath, metaPath } = pathsFor(directory, 'orphan-run', 'op-1');
    assert.ok(existsSync(intentPath), 'intent pins the original request');
    // Two independent-process successors race.
    const [b, c] = await Promise.all([
      runWriter({ dir: directory, runId: 'orphan-run', opKey: 'op-1', content: 'shared', metadata: {} }),
      runWriter({ dir: directory, runId: 'orphan-run', opKey: 'op-1', content: 'shared', metadata: { different: true } }),
    ]);
    // The same-content successor (B or C) completes the pinned publication
    // (idempotent); the differing-metadata successor conflicts with the now-
    // sealed record. Exactly one fulfilled, exactly one conflict.
    const ok = [b, c].filter((r) => r.code === 0);
    const conflict = [b, c].filter((r) => /artifact_identity_conflict/.test(r.stderr));
    assert.equal(ok.length, 1, 'exactly one successor fulfilled');
    assert.equal(conflict.length, 1, 'exactly one successor conflicted with the pinned identity');
    assert.ok(existsSync(metaPath), 'the pinned publication was sealed');
    // the sealed record carries the ORIGINAL pinned metadata, not the conflict's
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const found = await store.search({ scope: SCOPE, runId: 'orphan-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: 'q', signal: new AbortController().signal, query: 'shared', limit: 10 });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].metadata, {}, 'sealed metadata is the original pinned metadata');
    assert.equal(await store.usageBytes({ scope: SCOPE, runId: 'orphan-run' }), 'shared'.length, 'quota counts the artifact exactly once');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 5. owner-bound release and crash rollback leave no stale owner row

test('owner-bound release deletes the owner row; a crashed owner row is rolled back by journal recovery', async () => {
  const directory = freshDir();
  try {
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    await store.write({ scope: SCOPE, runId: 'own-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: 'op-1', signal: new AbortController().signal, content: 'x', mediaType: 'text/plain', metadata: {} });
    const { lockDb } = pathsFor(directory, 'own-run', 'op-1');
    assert.ok(existsSync(lockDb), 'lock database exists outside the run dir');
    // After a clean acquire+release the owner row is gone (release deletes it).
    assert.equal(ownerRow(lockDb), null, 'no owner row when free (owner-bound release)');
    // A crash mid-transaction leaves an uncommitted owner row; opening the
    // database triggers journal recovery that rolls it back.
    await runWriter({ dir: directory, runId: 'own-run', opKey: 'op-2', content: 'crashed', crashAfter: 'before-content' });
    const { lockDb: lockDb2 } = pathsFor(directory, 'own-run', 'op-2');
    const row = ownerRow(lockDb2);
    assert.ok(row === null || (row && row.token !== 'crashed' && !row.missing), `crashed owner rolled back, no stale owner: ${JSON.stringify(row)}`);
    // A successor acquires cleanly (the crashed owner did not permanently block).
    const succ = await runWriter({ dir: directory, runId: 'own-run', opKey: 'op-2', content: 'crashed', metadata: {} });
    assert.equal(succ.code, 0, 'successor acquired despite the crashed predecessor');
    assert.equal(ownerRow(lockDb2), null, 'no owner row after the successor released');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 6. structural: the lock database lives outside the run dir; run-dir file
//    names stay hex64 content/meta/intent only (no lock file in the run dir)

test('the lock database is a sibling under artifacts/.locks; the run dir never contains a lock file', async () => {
  const directory = freshDir();
  try {
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    await store.write({ scope: SCOPE, runId: 'struct-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: 'op-1', signal: new AbortController().signal, content: 'x', mediaType: 'text/plain', metadata: {} });
    const { dir, lockDir, lockDb } = pathsFor(directory, 'struct-run', 'op-1');
    assert.ok(existsSync(lockDir), '.locks/{scopeDigest} exists under artifacts');
    assert.ok(existsSync(lockDb), 'per-run lock database exists under .locks');
    const names = readdirSync(dir).filter((n) => !n.includes('.tmp.'));
    for (const n of names) assert.match(n, /^[0-9a-f]{64}\.(content|meta\.json|intent\.json)$/, `run dir has only content/meta/intent, not ${n}`);
    assert.ok(!names.includes('.lock'), 'no file-based .lock in the run dir');
    assert.ok(!names.some((n) => n.endsWith('.sqlite')), 'no sqlite file in the run dir');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
