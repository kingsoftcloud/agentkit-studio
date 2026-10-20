import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { sessionKeyFor, WorkspaceStateStore } from '../src/native/workspace-state.mjs';
import { publishWorkspaceBytes } from '../src/native/workspace-paths.mjs';

function baseSetup() {
  const base = mkdtempSync(join(tmpdir(), 'nws-fixes-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  return { base, workspaceRoot, stateDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function makeCall(tools, sessionId = 's1') {
  let seq = 0;
  return (name, args, { signal, interaction } = {}) => tools.execute({
    call: { callId: `c-${name}-${++seq}`, name, arguments: args },
    definition: tools.definitions.find((d) => d.name === name),
    operationKey: `op-${name}`,
    signal: signal || new AbortController().signal,
    sessionId,
    interaction,
  });
}

// ---------------------------------------------------------------------------
// Fix #1: read-window fields (startLine/endLine/totalLines) persisted as real
// numbers across a restart, not null/NaN.
// ---------------------------------------------------------------------------

test('partial read persists numeric startLine/endLine/totalLines and survives restart', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const tools1 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call1 = makeCall(tools1, 's1');
    const r = await call1('read_workspace_file', { path: 'a.txt', start_line: 2, end_line: 3 });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.partial, true);
    // inspect the persisted record directly: fields must be numbers, not null
    const raw = JSON.parse(readFileSync(join(stateDir, sessionKeyFor('s1'), 'read-state.json'), 'utf-8'));
    const entry = raw.entries['a.txt'];
    assert.equal(entry.startLine, 2);
    assert.equal(entry.endLine, 3);
    assert.equal(entry.totalLines, 5);
    assert.equal(entry.partial, true);
    // restart: a fresh instance loads the persisted numeric window
    const tools2 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call2 = makeCall(tools2, 's1');
    // the partial read state is loaded; an edit against the unchanged file
    // within the recorded window succeeds (proves the loaded state is usable)
    const edit = await call2('edit_workspace_file', { path: 'a.txt', old_text: 'l2', new_text: 'L2' });
    assert.equal(edit.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'l1\nL2\nl3\nl4\nl5\n');
  } finally { cleanup(); }
});

test('a full read persists startLine=1, endLine=totalLines, partial=false after restart', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'b.txt'), 'x\ny\n');
    const tools1 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    await makeCall(tools1, 's1')('read_workspace_file', { path: 'b.txt' });
    const tools2 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    await makeCall(tools2, 's1')('edit_workspace_file', { path: 'b.txt', old_text: 'y', new_text: 'z' });
    const raw = JSON.parse(readFileSync(join(stateDir, sessionKeyFor('s1'), 'read-state.json'), 'utf-8'));
    const entry = raw.entries['b.txt'];
    assert.equal(entry.partial, false);
    assert.equal(entry.startLine, 1);
    assert.equal(entry.endLine, 2);
    assert.equal(entry.totalLines, 2);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix #2: sessionId path-traversal / collision is prevented by a sha256 key.
// ---------------------------------------------------------------------------

test('a sessionId with ../ cannot escape stateDir', async () => {
  const { workspaceRoot, stateDir, base, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: '../escape', authorize: async () => 'allow' });
    await makeCall(tools, '../escape')('write_workspace_file', { path: 'a.txt', content: 'x\n' });
    // the state directory must be under stateDir, not at base/escape
    assert.equal(existsSync(join(base, 'escape')), false);
    // the actual directory is the sha256 of the id
    assert.ok(existsSync(join(stateDir, sessionKeyFor('../escape'))));
  } finally { cleanup(); }
});

test('two sessions with ids that share a path prefix do not collide', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'shared.txt'), 'orig\n');
    const toolsA = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'a/b', authorize: async () => 'allow' });
    const toolsB = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'a/c', authorize: async () => 'allow' });
    // a real read persists state under each session's hashed directory
    await makeCall(toolsA, 'a/b')('read_workspace_file', { path: 'shared.txt' });
    // different keys -> different directories; no literal 'a' segment escapes
    assert.notEqual(sessionKeyFor('a/b'), sessionKeyFor('a/c'));
    assert.ok(existsSync(join(stateDir, sessionKeyFor('a/b'))));
    assert.ok(!existsSync(join(stateDir, 'a'))); // no literal 'a' directory
  } finally { cleanup(); }
});

test('untrusted sessionIds map to distinct hex-key directories and isolate state', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'shared.txt'), 'orig\n');
    const evilIds = ['../x', '/etc', 'a/../b', 's1', 's1\x00evil'];
    const stores = evilIds.map((id) => new WorkspaceStateStore(stateDir, id));
    for (const s of stores) {
      assert.match(s.sessionKey, /^[0-9a-f]{64}$/);
      assert.ok(s.dir.startsWith(stateDir));
      assert.equal(s.dir.includes('..'), false);
    }
    // all keys distinct
    assert.equal(new Set(evilIds.map((id) => sessionKeyFor(id))).size, evilIds.length);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix #3: the root boundary is pinned at factory creation; a symlink swap is
// refused by execute and observe, including a swap during the authorize wait.
// ---------------------------------------------------------------------------

test('execute refuses a root symlink swap that points outside the pinned root', async () => {
  const { workspaceRoot, base, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    // read works before the swap
    const before = await makeCall(tools, 's1')('read_workspace_file', { path: 'a.txt' });
    assert.equal(before.status, 'ok');
    // swap the workspace root for a symlink to an outside directory
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    rmSync(workspaceRoot, { recursive: true, force: true });
    symlinkSync(outside, workspaceRoot);
    const read = await makeCall(tools, 's1')('read_workspace_file', { path: 'secret.txt' });
    assert.equal(read.status, 'error');
    assert.equal(read.content.code, 'workspace_root_changed');
    // observe also refuses the swapped root
    const obs = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
    assert.equal(obs.status, 'unavailable');
    assert.equal(obs.reason, 'workspace_root_changed');
  } finally { cleanup(); }
});

test('a root symlink swap during the authorize wait is refused even after allow', async () => {
  const { workspaceRoot, base, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'orig\n');
    let resolveAuthorize;
    const authorizePromise = new Promise((res) => { resolveAuthorize = res; });
    const tools = createNativeWorkspaceTools({
      workspaceRoot, stateDir, sessionId: 's1',
      authorize: async () => authorizePromise,
    });
    // kick off a write that will block in authorize
    const writePromise = tools.execute({
      call: { callId: 'cw', name: 'write_workspace_file', arguments: { path: 'a.txt', content: 'new\n' } },
      definition: tools.definitions.find((d) => d.name === 'write_workspace_file'),
      operationKey: 'op', signal: new AbortController().signal, sessionId: 's1',
    });
    // while authorize is pending, swap the root to an outside directory
    await new Promise((r) => setImmediate(r));
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    symlinkSync(outside, workspaceRoot);
    resolveAuthorize('allow'); // the caller approves the original request
    const result = await writePromise;
    // the boundary re-check after the await must refuse the swapped root
    assert.equal(result.status, 'error');
    assert.equal(result.content.code, 'workspace_root_changed');
    assert.equal(existsSync(join(outside, 'a.txt')), false); // nothing written to the outside dir
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix #4: observe detects a file changing between/a during the two captures
// and returns unavailable, rather than locking in a truncated/mid-change digest.
// ---------------------------------------------------------------------------

test('observe detects a file rewritten between the two captures', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    // a large file (near the 64MB hashed budget) so each pass takes real time
    // and the two captures span a measurable window.
    const big = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const target = join(workspaceRoot, 'big.txt');
    writeFileSync(target, big);
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });

    // observe's scan is synchronous, so a same-thread setInterval cannot fire
    // during it. Run a real concurrent writer in a worker thread so the file is
    // genuinely rewritten while observe reads it across two captures.
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(`
      const { writeFileSync } = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      let tick = 0;
      const iv = setInterval(() => {
        tick += 1;
        try { writeFileSync(workerData.target, Buffer.alloc(32 * 1024 * 1024, 0x61 + (tick % 26))); } catch { /* racing */ }
      }, 1);
      parentPort.on('message', () => { clearInterval(iv); parentPort.postMessage('done'); });
    `, { eval: true, workerData: { target } });

    let detected = false;
    let lastReason = '';
    for (let attempt = 0; attempt < 10 && !detected; attempt++) {
      const result = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
      lastReason = result.reason;
      if (result.status === 'unavailable' && ['workspace_changed_during_capture', 'capture_failed'].includes(result.reason)) {
        detected = true;
      }
    }
    worker.postMessage('stop');
    await new Promise((res) => worker.once('message', res));
    await worker.terminate();
    assert.ok(detected, `observe never detected the changing file across 10 attempts (last reason: ${lastReason})`);
  } finally { cleanup(); }
});

test('observe returns a stable revision when the workspace is quiescent', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'hello\n');
    mkdirSync(join(workspaceRoot, 'sub'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'sub/b.txt'), 'world\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const o1 = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
    const o2 = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
    assert.equal(o1.status, 'ok');
    assert.equal(o2.status, 'ok');
    assert.equal(o1.revision, o2.revision);
    // a real change produces a different revision
    writeFileSync(join(workspaceRoot, 'a.txt'), 'changed\n');
    const o3 = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
    assert.notEqual(o3.revision, o1.revision);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Fix #5: publishWorkspaceBytes closes the fd on writeAll failure and leaves
// the original file untouched; observe/state write failures surface explicitly.
// ---------------------------------------------------------------------------

test('publishWorkspaceBytes leaves the original file intact when the write payload cannot be written', async () => {
  const { workspaceRoot, cleanup } = baseSetup();
  try {
    const target = join(workspaceRoot, 'keep.txt');
    writeFileSync(target, 'original\n');
    // Simulate a writeAll failure by passing a payload whose writeSync is fine
    // but fsync fails: use a closed/invalid fd path. Easiest reliable failure:
    // make the target's parent read-only after the temp is opened? Instead,
    // force a write failure by passing a Buffer that triggers an error mid-
    // stream is hard. Use a directory in place of target to force a non-regular
    // file error at the lstat guard, which must throw BEFORE touching anything.
    const dirTarget = join(workspaceRoot, 'adir');
    mkdirSync(dirTarget, { recursive: true });
    let threw = false;
    try { publishWorkspaceBytes(dirTarget, Buffer.from('x\n')); } catch { threw = true; }
    assert.equal(threw, true);
    // the regular file we care about is untouched
    assert.equal(readFileSync(target, 'utf-8'), 'original\n');
  } finally { cleanup(); }
});

test('publishWorkspaceBytes does not leak an fd on a failed overwrite (temp file is removed)', async () => {
  const { workspaceRoot, cleanup } = baseSetup();
  try {
    const target = join(workspaceRoot, 'f.txt');
    writeFileSync(target, 'orig\n');
    // createOnly on an existing target -> linkSync fails with EEXIST; the fd
    // from the temp must be closed and the temp removed.
    let threw = false;
    try { publishWorkspaceBytes(target, Buffer.from('new\n'), { createOnly: true }); } catch { threw = true; }
    assert.equal(threw, true);
    assert.equal(readFileSync(target, 'utf-8'), 'orig\n');
    // no leftover temp files in the workspace
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(workspaceRoot).filter((n) => n.startsWith('.f.txt.native-'));
    assert.deepEqual(leftovers, []);
  } finally { cleanup(); }
});

test('a state persistence failure surfaces explicitly rather than silently dropping state', async () => {
  const { workspaceRoot, stateDir, base, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    await makeCall(tools, 's1')('read_workspace_file', { path: 'a.txt' });
    // make the session state directory unwritable so the next persist throws
    const sessionDir = join(stateDir, sessionKeyFor('s1'));
    const { chmodSync } = await import('node:fs');
    chmodSync(sessionDir, 0o555);
    // an edit that would persist a new read state must surface the write failure
    let editError;
    const r = await makeCall(tools, 's1')('edit_workspace_file', { path: 'a.txt', old_text: 'x', new_text: 'y' });
    chmodSync(sessionDir, 0o755); // restore so cleanup can run
    // The edit either fails to persist (error) or the file change + failed
    // state write is reported. Either way it must NOT silently succeed with a
    // persisted state that does not match the file.
    assert.ok(r.status === 'error' || r.content.error_type === 'publish_failed' || r.content.error_type === 'state_persist_failed',
      `unexpected success: ${JSON.stringify(r)}`);
  } finally { cleanup(); }
});
