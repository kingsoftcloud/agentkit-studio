import { createRequire } from 'node:module';
/** Mounted child question/approval services and actual parent/child crash recovery.
 * HTTP model, remote peer and human answerer are deterministic fixtures. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function until(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(30); }
}
export async function verifyMountedChildA2aRecovery({ root, installed, repository, source, archiveSha, harness: initial,
  makeHarness, childPeer, requests, counts, a2aReply }) {
  let harness = initial, running, store, scope, runId, reservation;
  const pids = [], kills = [], checkpoints = [];
  const save = (name, value) => writeFile(join(root, name + '.json'), JSON.stringify(value, null, 2));
  const parent = () => store.load(scope, runId);
  const child = () => store.load(reservation.childScope, reservation.childRunId);
  const questionRecord = async () => {
    const base = join(root, 'studio/native-harness/workspace-state');
    const files = (await readdir(base, { recursive: true })).filter(path => path.includes('a2a-calls/') && path.endsWith('.json'));
    assert.equal(files.length, 1); const record = JSON.parse(await readFile(join(base, files[0]), 'utf8'));
    const entries = Object.values(record.managed.questions.entries); assert.equal(entries.length, 1); return entries[0];
  };
  const rpc = async (method, payload) => {
    const auth = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
    assert.equal(auth.pid, harness.client.child.pid);
    const response = await fetch(auth.origin + '/agentkit', { method: 'POST',
      headers: { cookie: auth.cookie, origin: auth.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); const result = (await response.json()).result;
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.value;
  };
  const kill = async label => {
    const dead = harness.client.child, exited = once(dead, 'exit'); assert.equal(dead.kill('SIGKILL'), true);
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    kills.push({ label, pid: dead.pid, signal }); assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });
    await running.catch(() => {}); await harness.close();
    await until(() => [parent(), child()].every(record => !record.lease || record.lease.expiresAt < Date.now()), 'actual original parent/child lease expiry');
  };
  const restart = async () => {
    harness = makeHarness(); assert.equal((await harness.resumeSession('a2a-session')).id, 'a2a-session');
    const pid = harness.client.child.pid; assert.ok(!pids.includes(pid)); pids.push(pid);
    await until(async () => { try { return JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8')).pid === pid; }
      catch (error) { if (error.code !== 'ENOENT') throw error; } }, 'fresh mounted control auth');
    return pid;
  };
  try {
    running = harness.session('a2a-session').run('Delegate the remote research to the researcher child.'); running.catch(() => {});
    await until(() => childPeer.questions.length === 1, 'original mounted child question');
    pids.push(harness.client.child.pid);
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    scope = { tenantId: 'local', workspaceId: sha(JSON.stringify(resolve(root, 'workspace'))), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    assert.equal(store.list(scope, 'a2a-session').length, 1); runId = store.list(scope, 'a2a-session')[0].runId;
    await until(() => { reservation = parent().snapshot.childBudgetReservations[0];
      return reservation && parent().intents.some(row => row.operationKey === parent().snapshot.pendingIntent && row.kind === 'child'
        && row.status === 'running' && row.payload.action === 'wait'); }, 'original parent child-collection wait');
    const before = { parent: parent(), child: child(), counts: counts() };
    assert.equal(before.child.snapshot.phase, 'awaiting_reconciliation');
    assert.equal(before.parent.snapshot.phase, 'verifying'); assert.equal(before.counts.send, 1);
    assert.equal(before.counts.cancel, 0); assert.equal(childPeer.approvals.length, 0);
    await save('mounted-child-before-kill', before);
    await kill('original-child-question'); await restart();
    const identity = { agentId, sessionId: 'a2a-session', runId };
    await until(() => childPeer.questions.some(row => row.body.pid === pids[1]), 'automatic same child question after original parent reattachment');
    const status = await rpc('sessions/native-recovery-status', identity);
    assert.equal(status.canResume, false); assert.equal(status.state, 'recovering');
    assert.deepEqual(counts(), before.counts, 'reattachment performs no model, discovery, Send, Get or Cancel');
    assert.equal(childPeer.questions.length, 2); assert.equal(childPeer.approvals.length, 0);
    assert.equal(childPeer.questions[1].body.questions[0].id, childPeer.questions[0].body.questions[0].id);
    assert.equal(childPeer.questions[1].body.sessionId, 'a2a-session');
    assert.equal(child().snapshot.runId, before.child.snapshot.runId);
    assert.equal(canonical(child().snapshot), canonical(before.child.snapshot), 'same immutable child idle checkpoint');
    checkpoints.push({ name: 'original-parent-child-reattached', counts: counts(), parentRunId: runId, childRunId: reservation.childRunId,
      automaticReattachment: true, resumeRpcBeforeAttachment: false });
    childPeer.releaseAnswers = true;
    const pending = childPeer.questions[1]; pending.response.setHeader('Content-Type', 'application/json');
    pending.response.end(JSON.stringify({ answers: [{ id: pending.body.questions[0].id,
      ...(childPeer.remoteApproval ? { selected: ['批准远端操作'] } : { selected: [], custom: childPeer.answer }) }] }));
    if (childPeer.answerCrash) {
      await until(() => childPeer.approvals.length === 1, 'first independent permission request after durable answer');
      const answered = await questionRecord(); assert.equal(answered.stage, 'awaiting_permission');
      assert.equal(answered.status, childPeer.remoteApproval ? 'approved' : 'submitted');
      assert.deepEqual(counts(), before.counts, 'answer alone is not permission and sends nothing');
      await until(async () => {
        const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
        assert.equal(logs.length, 1); const history = await lines(join(root, 'sessions', logs[0]));
        return history.filter(row => row.type === 'approval/asked').length === 1;
      }, 'first actual permission audit durable before SIGKILL');
      await kill('durable-answer-before-permission'); await restart();
      await until(() => childPeer.approvals.length === 2, 'fresh original-operation permission without repeating the question');
      assert.equal(childPeer.questions.length, 2, 'durable answer survives without asking it again');
      const restored = await questionRecord(); assert.deepEqual(restored, answered);
      assert.deepEqual(counts(), before.counts, 'permission reattachment makes no remote or model requests');
      checkpoints.push({ name: 'answer-restored-with-fresh-permission', counts: counts(), automaticReattachment: true,
        resumeRpcBeforeAttachment: false, questionCount: childPeer.questions.length, status: restored.status, stage: restored.stage });
      childPeer.releaseApprovals = true; const consent = childPeer.approvals[1];
      consent.response.setHeader('Content-Type', 'application/json'); consent.response.end(JSON.stringify({ outcome: 'allowed-once' }));
    }
    await until(() => parent().snapshot.phase === 'completed', 'original parent completes with original child result');
    assert.equal(child().snapshot.phase, 'completed'); assert.equal(childPeer.approvals.length, childPeer.answerCrash ? 2 : 1);
    assert.equal(store.list(scope, 'a2a-session').length, 1); assert.equal(parent().snapshot.childRunIds.length, 1);
    assert.ok(parent().snapshot.childBudgetReservations[0].settledUsageDigest);
    assert.equal(counts().send, 2); assert.equal(counts().cancel, 0);
    assert.equal(requests.modelRequests.filter(row => row.model === 'child').length, 2);
    assert.equal(requests.modelRequests.filter(row => row.model === 'main').length, 3);
    assert.deepEqual(requests.serverFailures, []);
    assert.deepEqual(child().intents.find(row => row.kind === 'tool'), before.child.intents.find(row => row.kind === 'tool'));
    assert.deepEqual(child().receipts.find(row => row.operationKey === before.child.snapshot.toolReconciliation.operationKey),
      before.child.receipts.find(row => row.operationKey === before.child.snapshot.toolReconciliation.operationKey));
    await until(async () => { const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
      assert.equal(logs.length, 1); const history = await lines(join(root, 'sessions', logs[0]));
      return history.some(row => row.type === 'turn/end') ? history : false; }, 'real durable DSH turn/end');
    const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
    const history = await lines(join(root, 'sessions', logs[0]));
    assert.equal(history.filter(row => row.type === 'turn/start').length, 1);
    assert.equal(history.filter(row => row.type === 'turn/end').length, 1);
    assert.equal(history.filter(row => row.type === 'approval/asked').length, childPeer.answerCrash ? 2 : 1);
    assert.equal(history.filter(row => row.type === 'approval/decided').length, 1);
    assert.ok(JSON.stringify(history).includes(a2aReply));
    await save('mounted-child-a2a-recovery-evidence', { node: process.version, pids, kills, checkpoints, counts: counts(),
      archiveSha256: archiveSha, remoteApproval: childPeer.remoteApproval, answerCrash: childPeer.answerCrash,
      sourceCommit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      fixtureSha256: sha(await readFile(join(repository, 'tests/fixtures/studio-native-a2a.mjs'))),
      verifierSha256: sha(await readFile(new URL(import.meta.url))), parent: parent(), child: child(), history,
      limitation: 'Actual mounted Host/DSH/preset/Session/question/approval/Kernel/SQLite, actual SIGKILL, automatic original-parent recovery without resume RPC, Node-only PATH. Controlled HTTP model/peer/human answerer and linked dependency graph. Not browser/human, online provider, fresh install or Frozen Build.' });
    console.log(`PASS: mounted child A2A ${childPeer.remoteApproval ? 'approval' : 'input'}, automatic parent/child SIGKILL recovery${childPeer.answerCrash ? ' including durable answer before fresh permission' : ''}. Evidence ${root}`);
  } catch (error) {
    await save('mounted-child-recovery-failure', { message: error.message, stack: error.stack, pids, kills, counts: counts(),
      parent: store && parent(), child: reservation && child() }).catch(() => {}); throw error;
  } finally { await harness.close().catch(() => {}); store?.close(); }
}
