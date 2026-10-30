import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { StudioNativeMemoryExtractionStore } from '../src/host/services/native-memory-extraction-store.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

function makeScope(tag) {
  return { tenantId: 'tenant-a', workspaceId: `ws-${tag}`, userId: 'user-1', agentId: 'agent-1' };
}

// Realistic prepared Native auxiliary-run payload. The prepared identity/config,
// the captured source, and the Memory manifest are persisted exactly once at
// enqueue; a later divergent manifest under the same jobId must not overwrite them.
function makeFixture({ jobId, scope, sessionId, expectedCursor = null, boundaryId, manifest }) {
  return {
    jobId,
    scope,
    sessionId,
    expectedCursor,
    boundaryId,
    sourceDigest: sha(`source-${jobId}`),
    policyDigest: sha(`policy-${jobId}`),
    source: {
      parent: { sessionId, scope },
      manifestDigest: sha(`manifest-${jobId}`),
      capturedAt: 1_700_000_000_000,
    },
    prepared: {
      contract: 'agentkit.native-auxiliary-run/v1',
      identity: { runId: jobId, scope, sessionId: `child-${jobId}` },
      configuration: { modelProfileId: 'glm-5.3', maxTokens: 1024, temperature: 0.2 },
    },
    manifest: manifest ?? { records: [{ name: `memory.v1.${jobId}`, digest: sha(`rec-${jobId}`) }] },
  };
}

test('enqueue persists frozen prepared/source/manifest and survives cold reopen via two independent handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-reopen-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope1 = makeScope('reopen-1');
    const scope2 = makeScope('reopen-2');
    const fx = makeFixture({ jobId: 'job-1', scope: scope1, sessionId: 'sess-parent-1', boundaryId: 'b-1' });
    const rec = store.enqueue(fx);

    assert.equal(rec.status, 'queued');
    assert.equal(rec.lease, null);
    assert.equal(rec.fence, 0);
    assert.equal(rec.usage, null);
    assert.equal(rec.errorCode, null);
    assert.equal(rec.expectedCursor, null);
    assert.equal(rec.boundaryId, 'b-1');
    assert.match(rec.sourceDigest, HEX64);
    assert.match(rec.policyDigest, HEX64);
    assert.deepEqual(rec.prepared, fx.prepared);
    assert.deepEqual(rec.source, fx.source);
    assert.deepEqual(rec.manifest, fx.manifest);
    assert.equal(store.getCursor({ scope: scope1, sessionId: 'sess-parent-1' }), null);
    assert.equal(store.get('nope'), null);

    // A second independent handle on the same file reads the committed row (WAL)
    // and writes its own row in a different stream; both handles see each other.
    const reader = new StudioNativeMemoryExtractionStore(dbPath);
    assert.deepEqual(reader.get('job-1').prepared, fx.prepared);
    const fxB = makeFixture({ jobId: 'job-1b', scope: scope2, sessionId: 'sess-parent-1b', boundaryId: 'b-1b' });
    reader.enqueue(fxB);
    assert.deepEqual(store.get('job-1b').prepared, fxB.prepared);
    reader.close();
    store.close();

    // Cold reopen: a brand-new handle re-derives payload digests and sees the same
    // frozen payloads (prepared/source/manifest byte-identical, createdAt unchanged).
    const reopened = new StudioNativeMemoryExtractionStore(dbPath);
    const cold1 = reopened.get('job-1');
    const cold1b = reopened.get('job-1b');
    assert.deepEqual(cold1.prepared, fx.prepared);
    assert.deepEqual(cold1.source, fx.source);
    assert.deepEqual(cold1.manifest, fx.manifest);
    assert.equal(cold1.createdAt, rec.createdAt);
    assert.deepEqual(cold1b.manifest, fxB.manifest);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an identical duplicate returns the existing record; a divergent later manifest is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-dup-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('dup');
    const fx = makeFixture({ jobId: 'job-2', scope, sessionId: 'sess-parent-2', boundaryId: 'b-2' });
    const first = store.enqueue(fx);

    const dup = store.enqueue(fx);
    assert.equal(dup.createdAt, first.createdAt);
    assert.equal(dup.boundaryId, first.boundaryId);
    assert.deepEqual(dup.manifest, first.manifest);

    // A "later Memory manifest" under the same jobId must never overwrite the
    // frozen payload: the divergent duplicate is rejected and the original stays.
    const later = makeFixture({
      jobId: 'job-2', scope, sessionId: 'sess-parent-2', boundaryId: 'b-2',
      manifest: { records: [{ name: 'memory.v1.later', digest: sha('later-rec') }] },
    });
    assert.throws(() => store.enqueue(later), { code: 'native_memory_job_conflict' });
    assert.deepEqual(store.get('job-2').manifest, fx.manifest);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enqueue rejects when the stream cursor differs from expectedCursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-cursor-enq-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('cenq');
    const sid = 'sess-3';
    store.enqueue(makeFixture({ jobId: 'job-3a', scope, sessionId: sid, boundaryId: 'cur-A' }));
    const leaseA = store.claim('job-3a', { owner: 'own-3', now: 1000, leaseMs: 5000 });
    store.finish('job-3a', { lease: leaseA.lease, now: 1100, status: 'success' });
    assert.equal(store.getCursor({ scope, sessionId: sid }), 'cur-A');

    const stale = makeFixture({ jobId: 'job-3b', scope, sessionId: sid, expectedCursor: null, boundaryId: 'cur-B' });
    assert.throws(() => store.enqueue(stale), { code: 'native_memory_job_cursor_conflict' });

    const ok = makeFixture({ jobId: 'job-3b', scope, sessionId: sid, expectedCursor: 'cur-A', boundaryId: 'cur-B' });
    store.enqueue(ok);
    assert.equal(store.get('job-3b').status, 'queued');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scope and session isolation: cursors and jobs do not leak across streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-iso-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scopeA = makeScope('iso-a');
    const scopeB = makeScope('iso-b');
    store.enqueue(makeFixture({ jobId: 'jA', scope: scopeA, sessionId: 'sA', boundaryId: 'cA' }));
    store.enqueue(makeFixture({ jobId: 'jB', scope: scopeB, sessionId: 'sB', boundaryId: 'cB' }));
    const la = store.claim('jA', { owner: 'oa', now: 1000, leaseMs: 5000 });
    store.finish('jA', { lease: la.lease, now: 1100, status: 'success' });

    assert.equal(store.getCursor({ scope: scopeA, sessionId: 'sA' }), 'cA');
    assert.equal(store.getCursor({ scope: scopeB, sessionId: 'sB' }), null);
    assert.deepEqual(store.list({ scope: scopeA, sessionId: 'sA' }).map(r => r.jobId), ['jA']);
    assert.deepEqual(store.list({ scope: scopeB, sessionId: 'sB' }).map(r => r.jobId), ['jB']);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a new queued job supersedes older queued jobs but never an active running job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-supersede-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('sup');
    const sid = 'sSup';
    store.enqueue(makeFixture({ jobId: 'qA', scope, sessionId: sid, boundaryId: 'bA' }));
    store.enqueue(makeFixture({ jobId: 'qB', scope, sessionId: sid, boundaryId: 'bB' }));
    assert.equal(store.get('qA').status, 'superseded');
    assert.equal(store.get('qB').status, 'queued');

    const lb = store.claim('qB', { owner: 'ob', now: 1000, leaseMs: 5000 });
    assert.equal(store.get('qB').status, 'running');
    // A new queued enqueue must not supersede the active running job.
    store.enqueue(makeFixture({ jobId: 'qC', scope, sessionId: sid, boundaryId: 'bC' }));
    assert.equal(store.get('qB').status, 'running');
    assert.equal(lb.lease.owner, 'ob');
    assert.equal(store.get('qC').status, 'queued');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claim blocks a second live owner in the same stream and reclaims an expired running lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-claim-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('claim');
    const sid = 'sC';
    store.enqueue(makeFixture({ jobId: 'cA', scope, sessionId: sid, boundaryId: 'bA' }));
    const la = store.claim('cA', { owner: 'owner-1', now: 1000, leaseMs: 5000 });
    assert.equal(la.status, 'running');
    assert.equal(la.lease.owner, 'owner-1');
    assert.equal(la.lease.fence, 1);
    assert.equal(la.lease.expiresAt, 6000);

    store.enqueue(makeFixture({ jobId: 'cB', scope, sessionId: sid, boundaryId: 'bB' }));
    // A second live owner is blocked while owner-1's lease is live.
    assert.equal(store.claim('cB', { owner: 'owner-2', now: 2000, leaseMs: 5000 }), null);
    assert.equal(store.get('cB').status, 'queued');
    // After owner-1's lease expires, owner-2 can claim the queued job.
    const got = store.claim('cB', { owner: 'owner-2', now: 7000, leaseMs: 5000 });
    assert.equal(got.status, 'running');
    assert.equal(got.lease.owner, 'owner-2');
    assert.equal(got.lease.fence, 1);
    assert.equal(got.lease.expiresAt, 12000);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired lease and prior fence reject the previous owner; renewal requires the exact live owner/fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-lease-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('lease');
    const sid = 'sL';
    store.enqueue(makeFixture({ jobId: 'lA', scope, sessionId: sid, boundaryId: 'bL' }));
    const l1 = store.claim('lA', { owner: 'owner-1', now: 1000, leaseMs: 5000 });

    // Renewal with the exact live lease extends the expiry without changing fence.
    const renewed = store.renew('lA', { lease: l1.lease, now: 3000, leaseMs: 5000 });
    assert.equal(renewed.lease.fence, 1);
    assert.equal(renewed.lease.expiresAt, 8000);

    // Once expired, the original owner cannot renew or finish.
    assert.throws(() => store.renew('lA', { lease: l1.lease, now: 9000, leaseMs: 5000 }), { code: 'native_memory_job_lease_lost' });
    assert.throws(() => store.finish('lA', { lease: l1.lease, now: 9000, status: 'success' }), { code: 'native_memory_job_lease_lost' });

    // A new claimant reclaims the expired running lease; the fence increments.
    const l2 = store.claim('lA', { owner: 'owner-2', now: 9000, leaseMs: 5000 });
    assert.equal(l2.lease.owner, 'owner-2');
    assert.equal(l2.lease.fence, 2);
    assert.equal(l2.lease.expiresAt, 14000);

    // The prior owner's old fence is rejected on both renew and finish.
    assert.throws(() => store.renew('lA', { lease: l1.lease, now: 9500, leaseMs: 5000 }), { code: 'native_memory_job_lease_lost' });
    assert.throws(() => store.finish('lA', { lease: l1.lease, now: 9500, status: 'success' }), { code: 'native_memory_job_lease_lost' });

    // The new live owner can still renew with the exact live fence.
    const l2b = store.renew('lA', { lease: l2.lease, now: 10000, leaseMs: 5000 });
    assert.equal(l2b.lease.owner, 'owner-2');
    assert.equal(l2b.lease.fence, 2);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('success finish advances the cursor to boundaryId; error and aborted never advance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-finish-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('fin');
    const sid = 'sF';

    store.enqueue(makeFixture({ jobId: 'f1', scope, sessionId: sid, boundaryId: 'b1' }));
    const l1 = store.claim('f1', { owner: 'o', now: 1000, leaseMs: 5000 });
    store.finish('f1', { lease: l1.lease, now: 1100, status: 'success', usage: { tokens: 42 } });
    assert.equal(store.getCursor({ scope, sessionId: sid }), 'b1');
    const r1 = store.get('f1');
    assert.equal(r1.status, 'success');
    assert.equal(r1.lease, null);
    assert.deepEqual(r1.usage, { tokens: 42 });

    // error must not advance the cursor; the next enqueue still expects b1.
    store.enqueue(makeFixture({ jobId: 'f2', scope, sessionId: sid, expectedCursor: 'b1', boundaryId: 'b2' }));
    const l2 = store.claim('f2', { owner: 'o', now: 2000, leaseMs: 5000 });
    store.finish('f2', { lease: l2.lease, now: 2100, status: 'error', errorCode: 'extract_failed' });
    assert.equal(store.getCursor({ scope, sessionId: sid }), 'b1');
    const r2 = store.get('f2');
    assert.equal(r2.status, 'error');
    assert.equal(r2.errorCode, 'extract_failed');
    assert.equal(r2.lease, null);
    assert.equal(r2.usage, null);

    // aborted must not advance the cursor either; a re-enqueue at b1 still succeeds.
    store.enqueue(makeFixture({ jobId: 'f3', scope, sessionId: sid, expectedCursor: 'b1', boundaryId: 'b3' }));
    const l3 = store.claim('f3', { owner: 'o', now: 3000, leaseMs: 5000 });
    store.finish('f3', { lease: l3.lease, now: 3100, status: 'aborted' });
    assert.equal(store.getCursor({ scope, sessionId: sid }), 'b1');

    store.enqueue(makeFixture({ jobId: 'f4', scope, sessionId: sid, expectedCursor: 'b1', boundaryId: 'b4' }));
    assert.equal(store.get('f4').status, 'queued');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claim marks a job superseded when its expectedCursor is stale and returns null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-staleclaim-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('stale');
    const sid = 'sStale';

    // job1 enqueued with expectedCursor null, claimed (running).
    store.enqueue(makeFixture({ jobId: 's1', scope, sessionId: sid, boundaryId: 'b1' }));
    const l1 = store.claim('s1', { owner: 'o', now: 1000, leaseMs: 5000 });
    // While job1 is running, job2 is enqueued against the still-null cursor.
    store.enqueue(makeFixture({ jobId: 's2', scope, sessionId: sid, boundaryId: 'b2' }));
    assert.equal(store.get('s2').expectedCursor, null);
    // job1 finishes and advances the cursor out from under the queued job2.
    store.finish('s1', { lease: l1.lease, now: 1100, status: 'success' });
    assert.equal(store.getCursor({ scope, sessionId: sid }), 'b1');

    // claim now sees job2.expectedCursor (null) != current cursor (b1) -> superseded, null.
    assert.equal(store.claim('s2', { owner: 'o', now: 2000, leaseMs: 5000 }), null);
    assert.equal(store.get('s2').status, 'superseded');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-op finish advances the cursor; list filters by status and orders deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nm-extract-noop-'));
  try {
    const dbPath = join(root, 'store.db');
    const store = new StudioNativeMemoryExtractionStore(dbPath);
    const scope = makeScope('noop');
    const sid = 'sNoop';

    store.enqueue(makeFixture({ jobId: 'n1', scope, sessionId: sid, boundaryId: 'n1b' }));
    const l1 = store.claim('n1', { owner: 'o', now: 1000, leaseMs: 5000 });
    store.finish('n1', { lease: l1.lease, now: 1100, status: 'no-op' });
    assert.equal(store.getCursor({ scope, sessionId: sid }), 'n1b');

    // no-op advanced the cursor, so an enqueue at expectedCursor 'n1b' succeeds.
    store.enqueue(makeFixture({ jobId: 'n2', scope, sessionId: sid, expectedCursor: 'n1b', boundaryId: 'n2b' }));
    assert.equal(store.get('n2').status, 'queued');
    store.enqueue(makeFixture({ jobId: 'n3', scope, sessionId: sid, expectedCursor: 'n1b', boundaryId: 'n3b' }));
    // n3 supersedes the queued n2; both remain in history, deterministically ordered.
    assert.equal(store.get('n2').status, 'superseded');
    assert.equal(store.get('n3').status, 'queued');

    assert.deepEqual(store.list({ scope, sessionId: sid, statuses: ['queued'] }).map(r => r.jobId), ['n3']);
    assert.deepEqual(store.list({ scope, sessionId: sid }).map(r => r.jobId), ['n1', 'n2', 'n3']);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
