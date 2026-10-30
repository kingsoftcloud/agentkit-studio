import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import { scopeDigest, runDigest, identityDigest } from '../src/native/artifact-codec.mjs';

const SCOPE = Object.freeze({ tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' });
const HARNESS_DIR = new URL('..', import.meta.url).pathname; // packages/agentkit-harness/

// Subprocess writer: a real, separate Node process that opens its own store
// instance against the same directory. Inert unless NATIVE_ARTIFACT_CRASH_AFTER
// is set, in which case the store exits at a controlled publish position.
const WRITER_SCRIPT = `
const { createNativeArtifactStore } = await import('./src/native/artifact-store.mjs');
const args = process.argv.slice(1).filter((a) => a !== '[eval]');
const [dir, runId, opKey, content, mediaType, metadataJson] = args;
const scope = { tenantId: 'tenant', workspaceId: 'ws', userId: 'user', agentId: 'agent' };
try {
  const store = await createNativeArtifactStore({ directory: dir, scope });
  const ref = await store.write({
    scope, runId, sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
    operationKey: opKey, signal: new AbortController().signal,
    content, mediaType, metadata: JSON.parse(metadataJson),
  });
  process.stdout.write(JSON.stringify(ref));
} catch (e) {
  process.stderr.write(String(e.code || e.message));
  process.exit(1);
}
`;

function runWriter({ dir, runId, opKey, content, mediaType = 'text/plain', metadata = {}, crashAfter, env = {} }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER_SCRIPT, dir, runId, opKey, content, mediaType, JSON.stringify(metadata)], {
    cwd: HARNESS_DIR,
    env: { ...process.env, ...env, ...(crashAfter ? { NATIVE_ARTIFACT_CRASH_AFTER: crashAfter } : {}) },
  });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
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
  return { dir, contentPath: join(dir, id + '.content'), metaPath: join(dir, id + '.meta.json') };
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'native-art-conc-'));
}

// ---------------------------------------------------------------------------
// real multiprocess same-identity race

test('many processes writing the same identity + same content+metadata return one consistent ref', async () => {
  const directory = freshDir();
  try {
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () =>
      runWriter({ dir: directory, runId: 'race-run', opKey: 'same-op', content: 'shared-content', metadata: { tag: 'same' } })));
    const refs = results.filter((r) => r.code === 0).map((r) => r.stdout);
    const conflicts = results.filter((r) => r.code !== 0);
    assert.equal(refs.length, N, 'every racer resolves (idempotent or winner), none errors');
    assert.equal(conflicts.length, 0);
    // all refs are identical
    const first = refs[0];
    assert.ok(first);
    for (const r of refs) assert.equal(r, first);
    // exactly one artifact on disk
    const { dir: runDir, contentPath, metaPath } = pathsFor(directory, 'race-run', 'same-op');
    assert.ok(existsSync(contentPath));
    assert.ok(existsSync(metaPath));
    const names = readdirSync(runDir).filter((n) => !n.includes('.tmp.'));
    assert.equal(names.length, 2);
    // usage counts the artifact exactly once
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'race-run' });
    assert.equal(usage, Buffer.byteLength('shared-content', 'utf8'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('many processes writing the same identity with different content produce exactly one winner; rest conflict', async () => {
  const directory = freshDir();
  try {
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      runWriter({ dir: directory, runId: 'diff-run', opKey: 'same-op', content: `content-${i}`, metadata: {} })));
    const winners = results.filter((r) => r.code === 0 && r.stdout);
    const losers = results.filter((r) => r.stderr.includes('artifact_identity_conflict'));
    assert.equal(winners.length, 1, 'exactly one consistent winner');
    assert.equal(losers.length, N - 1, 'the rest hit an identity conflict');
    // exactly one artifact on disk, usage counts once
    const { dir: runDir, contentPath, metaPath } = pathsFor(directory, 'diff-run', 'same-op');
    assert.ok(existsSync(contentPath));
    assert.ok(existsSync(metaPath));
    const names = readdirSync(runDir).filter((n) => !n.includes('.tmp.'));
    assert.equal(names.length, 2);
    const store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const winnerRef = JSON.parse(winners[0].stdout);
    const winnerContent = (await store.read({
      scope: SCOPE, runId: 'diff-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'reader', signal: new AbortController().signal, ref: winnerRef, offset: 0, limit: 32000,
    })).content;
    assert.match(winnerContent, /^content-[0-9]$/);
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'diff-run' });
    assert.equal(usage, winnerRef.sizeBytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// reopen reconciliation after a real subprocess exit at a critical position

test('crash after content link (before meta) reconciles on reopen and seals the artifact', async () => {
  const directory = freshDir();
  try {
    const crashed = await runWriter({ dir: directory, runId: 'crash-run', opKey: 'op-1', content: 'survives-crash', crashAfter: 'content' });
    assert.equal(crashed.code, 0);
    assert.equal(crashed.stdout, '', 'crashed before printing the ref');
    // orphan content present, meta absent
    const { contentPath, metaPath } = pathsFor(directory, 'crash-run', 'op-1');
    assert.ok(existsSync(contentPath));
    assert.ok(!existsSync(metaPath));
    // usage counts the orphan (published, result not returned)
    let store = await createNativeArtifactStore({ directory, scope: SCOPE });
    let usage = await store.usageBytes({ scope: SCOPE, runId: 'crash-run' });
    assert.equal(usage, Buffer.byteLength('survives-crash', 'utf8'));
    // reopen + re-write same identity completes the publication
    const ref = await store.write({
      scope: SCOPE, runId: 'crash-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op-1', signal: new AbortController().signal,
      content: 'survives-crash', mediaType: 'text/plain', metadata: {},
    });
    assert.ok(existsSync(metaPath));
    const page = await store.read({
      scope: SCOPE, runId: 'crash-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'reader', signal: new AbortController().signal, ref, offset: 0, limit: 32000,
    });
    assert.equal(page.content, 'survives-crash');
    usage = await store.usageBytes({ scope: SCOPE, runId: 'crash-run' });
    assert.equal(usage, Buffer.byteLength('survives-crash', 'utf8'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('crash after content temp (before link) leaves no published content; reopen publishes fresh', async () => {
  const directory = freshDir();
  try {
    const crashed = await runWriter({ dir: directory, runId: 'ctmp-run', opKey: 'op-1', content: 'fresh-after', crashAfter: 'content-tmp' });
    assert.equal(crashed.code, 0);
    assert.equal(crashed.stdout, '');
    const { contentPath, metaPath } = pathsFor(directory, 'ctmp-run', 'op-1');
    assert.ok(!existsSync(contentPath), 'no content linked');
    assert.ok(!existsSync(metaPath));
    // an orphan temp file exists; cleanupStaleTemps removes it
    let store = await createNativeArtifactStore({ directory, scope: SCOPE });
    const removed = await store.cleanupStaleTemps({ maxAgeMs: 0 });
    assert.ok(removed >= 1, 'stale temp removed');
    // reopen publishes fresh
    const ref = await store.write({
      scope: SCOPE, runId: 'ctmp-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op-1', signal: new AbortController().signal,
      content: 'fresh-after', mediaType: 'text/plain', metadata: {},
    });
    assert.ok(existsSync(contentPath));
    assert.ok(existsSync(metaPath));
    const page = await store.read({
      scope: SCOPE, runId: 'ctmp-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'reader', signal: new AbortController().signal, ref, offset: 0, limit: 32000,
    });
    assert.equal(page.content, 'fresh-after');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('crash after meta temp (before meta link) reconciles on reopen and seals', async () => {
  const directory = freshDir();
  try {
    const crashed = await runWriter({ dir: directory, runId: 'mtmp-run', opKey: 'op-1', content: 'meta-crash', crashAfter: 'meta-tmp' });
    assert.equal(crashed.code, 0);
    assert.equal(crashed.stdout, '');
    const { contentPath, metaPath } = pathsFor(directory, 'mtmp-run', 'op-1');
    assert.ok(existsSync(contentPath), 'content was linked before the meta crash');
    assert.ok(!existsSync(metaPath), 'meta not linked yet');
    let store = await createNativeArtifactStore({ directory, scope: SCOPE });
    await store.cleanupStaleTemps({ maxAgeMs: 0 });
    const ref = await store.write({
      scope: SCOPE, runId: 'mtmp-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op-1', signal: new AbortController().signal,
      content: 'meta-crash', mediaType: 'text/plain', metadata: {},
    });
    assert.ok(existsSync(metaPath));
    const page = await store.read({
      scope: SCOPE, runId: 'mtmp-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'reader', signal: new AbortController().signal, ref, offset: 0, limit: 32000,
    });
    assert.equal(page.content, 'meta-crash');
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'mtmp-run' });
    assert.equal(usage, Buffer.byteLength('meta-crash', 'utf8'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a sealed artifact whose result was never received is still counted by usage after reopen', async () => {
  const directory = freshDir();
  try {
    // Crash immediately after the meta sidecar is linked (sealed) but before
    // the write returns / prints the ref: the caller never receives it.
    const crashed = await runWriter({ dir: directory, runId: 'unseen-run', opKey: 'op-1', content: 'never-seen', crashAfter: 'meta' });
    assert.equal(crashed.code, 0);
    assert.equal(crashed.stdout, '', 'sealed but the ref was never returned to the caller');
    const { contentPath, metaPath } = pathsFor(directory, 'unseen-run', 'op-1');
    assert.ok(existsSync(contentPath));
    assert.ok(existsSync(metaPath));
    // a stale meta temp may remain; clean it
    let store = await createNativeArtifactStore({ directory, scope: SCOPE });
    await store.cleanupStaleTemps({ maxAgeMs: 0 });
    // usage counts the published-but-unreceived artifact
    const usage = await store.usageBytes({ scope: SCOPE, runId: 'unseen-run' });
    assert.equal(usage, Buffer.byteLength('never-seen', 'utf8'));
    // a same-identity re-write is idempotent and returns the surviving ref
    const ref = await store.write({
      scope: SCOPE, runId: 'unseen-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'op-1', signal: new AbortController().signal,
      content: 'never-seen', mediaType: 'text/plain', metadata: {},
    });
    const page = await store.read({
      scope: SCOPE, runId: 'unseen-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'reader', signal: new AbortController().signal, ref, offset: 0, limit: 32000,
    });
    assert.equal(page.content, 'never-seen');
    // search also surfaces it
    const found = await store.search({
      scope: SCOPE, runId: 'unseen-run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
      operationKey: 'searcher', signal: new AbortController().signal, query: 'never-seen', limit: 10,
    });
    assert.equal(found.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
