import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Run the packaged Studio Host and real SDK in two processes. Only model
// responses and the human answer are controlled; tool bodies and SQLite are real.
export async function verifyMountedChildApprovalRestart({ root, installed, makeHarness,
  initial, approvals, failures, requests, control }) {
  const sessionId = 'native-child-parent';
  let next, store;
  const json = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
  const jsonl = async name => (await readFile(join(root, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const until = async (label, predicate) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (failures.length) throw failures[0];
      const result = await predicate();
      if (result) return result;
      await delay(25);
    }
    assert.fail(`Timed out: ${label}`);
  };
  try {
    const running = initial.session(sessionId).run('Use the writer. Read the evidence, then write approved.txt once after permission.');
    void running.then(result => {
      if (!approvals.length) failures.push(Error(JSON.stringify(result.events.filter(row => row.type === 'turn/end'))));
    }, error => { if (!approvals.length) failures.push(error); });
    const firstOffer = await until('first Host approval', () => approvals[0]);
    assert.equal(firstOffer.pid, initial.client.child.pid);
    const { agentId } = await json('identity.json');
    const workspace = join(root, 'workspace');
    const scope = { tenantId: 'local', userId: 'local-user', agentId,
      workspaceId: createHash('sha256').update(JSON.stringify(workspace)).digest('hex') };
    const sqlite = createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store');
    const { SqliteRunStore } = await import(pathToFileURL(sqlite).href);
    store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    const { runId } = store.sessionHead(scope, sessionId);
    const parent = () => store.load(scope, runId);
    const { childRunId, childScope } = parent().snapshot.childBudgetReservations[0];
    const child = () => store.load(childScope, childRunId);
    const first = { parent: parent(), child: child(), models: requests.length };
    const identity = { agentId, sessionId, runId };
    assert.equal(first.parent.snapshot.phase, 'awaiting_interaction');
    assert.equal(first.child.snapshot.phase, 'awaiting_interaction');
    assert.equal(first.parent.snapshot.childApproval.childRunId, childRunId);
    const read = first.child.intents.find(intent => intent.kind === 'tool'
      && intent.payload.calls[0].name === 'read_workspace_file');
    const readReceipt = first.child.receipts.find(row => row.operationKey === read?.operationKey);
    assert.equal(readReceipt?.status, 'committed');
    assert.deepEqual((await jsonl('approval-tool-dispatches.jsonl')).map(row => row.name), ['read_workspace_file']);
    await initial.close();
    await running.catch(() => {});
    assert.equal((await jsonl('approval-host-disposals.jsonl'))[0].pid, firstOffer.pid);
    for (const [actual, before] of [[parent(), first.parent], [child(), first.child]]) {
      assert.equal(actual.snapshot.phase, 'awaiting_interaction');
      assert.deepEqual(actual.snapshot.pendingInteraction, before.snapshot.pendingInteraction);
      assert.equal(actual.commands.some(row => row.command.kind === 'cancel'), false);
    }
    next = makeHarness();
    assert.equal((await next.resumeSession(sessionId)).id, sessionId);
    assert.notEqual(next.client.child.pid, firstOffer.pid);
    const status = await control('sessions/native-recovery-status', identity);
    assert.equal(status.canResume, true, JSON.stringify(status));
    await control('sessions/native-recovery-resume', identity);
    const resumedOffer = await until('reoffered original approval', () => approvals[1]);
    assert.equal(resumedOffer.pid, next.client.child.pid);
    assert.equal(resumedOffer.callId, firstOffer.callId);
    assert.equal(requests.length, first.models);
    assert.deepEqual((await jsonl('approval-tool-dispatches.jsonl')).map(row => row.name), ['read_workspace_file']);
    resumedOffer.response.writeHead(200, { 'content-type': 'application/json' });
    resumedOffer.response.end(JSON.stringify({ outcome: 'allowed-once' }));
    await until('original parent completed', () => parent().snapshot.phase === 'completed');
    assert.equal(child().snapshot.phase, 'completed');
    assert.equal(store.list(scope, sessionId).length, 1);
    assert.deepEqual(parent().snapshot.childRunIds, [childRunId]);
    assert.deepEqual(child().receipts.find(row => row.operationKey === read.operationKey), readReceipt);
    const dispatches = await jsonl('approval-tool-dispatches.jsonl');
    assert.deepEqual(dispatches.map(row => [row.name, row.pid]),
      [['read_workspace_file', firstOffer.pid], ['write_workspace_file', resumedOffer.pid]]);
    const state = join(root, 'studio/native-harness');
    const files = (await readdir(state, { recursive: true })).filter(path => path.endsWith('/approved.txt'));
    assert.equal(files.length, 1);
    assert.equal(await readFile(join(state, files[0]), 'utf8'), 'Approved exactly once.\n');
    assert.equal(approvals.length, 2);
    assert.deepEqual(failures, []);
    await writeFile(join(root, 'approval-restart-evidence.json'), JSON.stringify({
      runId, childRunId, sessionId, approvalCallId: firstOffer.callId,
      beforePid: firstOffer.pid, afterPid: resumedOffer.pid, readReceipt: readReceipt.operationKey,
      dispatches, parentPhase: parent().snapshot.phase, childPhase: child().snapshot.phase,
    }, null, 2));
    console.log(`PASS: packaged Studio preserved the original parent and child through shutdown and reoffered approval; read and write dispatched once. Evidence: ${root}`);
  } finally {
    await next?.close();
    store?.close();
  }
}
