/** Actual Host proof: active owned child must settle before a conversation cut. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createChildRewindProof() {
  const parentReady = Promise.withResolvers(), childReady = Promise.withResolvers();
  let parentCalls = 0, childCalls = 0, continued = false;
  function respond({ body, response }) {
    if (body.model === 'child-proof') {
      assert.equal(++childCalls, 1, 'Canceled child is never replayed');
      childReady.resolve(); return; // Held provider request, canceled by its original executor.
    }
    assert.equal(body.model, 'parent-proof'); parentCalls++;
    if (parentCalls === 2) { parentReady.resolve(); return; }
    let delta;
    if (parentCalls === 1) {
      delta = { tool_calls: [{ index: 0, id: 'start-owned-rewind-child', type: 'function', function: {
        name: 'native_start_child', arguments: JSON.stringify({ role: 'reader', task: 'Removed owned child task', background: true }),
      } }] };
    } else {
      assert.equal(parentCalls, 3); assert.equal(continued, true);
      assert.doesNotMatch(JSON.stringify(body.messages), /Remove owned child turn|Removed owned child task|native-child-[a-f0-9]{64}/);
      delta = { content: 'Continued after owned child rewind' };
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `child-rewind-${parentCalls}`, choices: [{ index: 0, delta,
      finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, control, failures, requests }) {
    let harness = initial;
    const sessionId = 'native-child-parent';
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const read = job => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return job(store); } finally { store.close(); } };
    let running;
    try {
      running = harness.session(sessionId).run('Remove owned child turn');
      running.catch(() => {});
      let timer;
      try { await Promise.race([Promise.all([parentReady.promise, childReady.promise]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('active parent/child not observed')), 20000); })]); }
      finally { clearTimeout(timer); }
      assert.deepEqual(failures, []);
      const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
      const identity = { agentId, sessionId };
      const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(join(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
      const parent = read(store => store.load(scope, store.sessionHead(scope, sessionId).runId));
      assert.equal(parent.configuration.childLifecyclePolicy, 'owned-background/v2');
      const reservation = parent.snapshot.childBudgetReservations[0]; assert.ok(reservation); assert.equal(reservation.settledUsageDigest, null);
      const child = read(store => store.load(reservation.childScope, reservation.childRunId));
      assert.equal(child.snapshot.phase, 'requesting_model');
      const status = await control('sessions/native-conversation-status', identity);
      assert.equal(status.canRewind, true); assert.equal(status.requiresStop, true);
      const cutRequest = { ...identity, expectedHeadRunId: status.headRunId, expectedGeneration: status.generation,
        targetMessageId: status.inputs.find(input => input.text === 'Remove owned child turn').messageId, commandId: 'active-owned-child-rewind' };
      assert.equal((await control('sessions/native-conversation-rewind', cutRequest)).state, 'applied');
      const atCommit = JSON.parse(await readFile(join(root, 'child-rewind-commit-observation.json'), 'utf8'));
      assert.equal(atCommit.parentPhase, 'canceled'); assert.equal(atCommit.childPhase, 'canceled');
      assert.ok(atCommit.settledUsageDigest); assert.equal(atCommit.generation, 1);
      await running;
      const canceledParent = read(store => store.load(scope, parent.snapshot.runId));
      const canceledChild = read(store => store.load(reservation.childScope, reservation.childRunId));
      assert.equal(canceledParent.snapshot.phase, 'canceled'); assert.equal(canceledChild.snapshot.phase, 'canceled');
      assert.ok(canceledParent.snapshot.childBudgetReservations[0].settledUsageDigest);
      assert.equal(canceledParent.snapshot.children[0].state, 'canceled');
      assert.ok(canceledChild.receipts.some(row => row.status === 'uncertain'), 'Canceled model usage stays unknown');
      assert.equal(canceledChild.snapshot.usage.toolCalls, 0);
      const settlements = canceledParent.events.filter(event => event.kind === 'child.lifecycle_observed'
        && event.payload.settledChildRunIds.includes(reservation.childRunId));
      assert.equal(settlements.length, 1, 'Child budget settles once before the cut');
      await harness.close(); harness = new DeepSeekHarness(options); continued = true;
      const result = await (await harness.resumeSession(sessionId)).run('Continue after child rewind');
      assert.equal(result.finalResponse, 'Continued after owned child rewind');
      const rebased = read(store => store.load(scope, store.sessionHead(scope, sessionId).runId));
      assert.equal(rebased.snapshot.conversationBranch.generation, 1);
      assert.deepEqual(rebased.snapshot.children, []); assert.deepEqual(rebased.snapshot.childBudgetReservations, []);
      assert.deepEqual(read(store => store.load(scope, parent.snapshot.runId)), canceledParent);
      assert.deepEqual(read(store => store.load(reservation.childScope, reservation.childRunId)), canceledChild);
      assert.equal(parentCalls, 3); assert.equal(childCalls, 1); assert.equal(requests.length, 4); assert.deepEqual(failures, []);
      const hosts = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(new Set(hosts.map(host => host.pid)).size, 2);
      await writeFile(join(root, 'child-rewind-proof.json'), JSON.stringify({ passed: true, parentRunId: parent.snapshot.runId,
        childRunId: reservation.childRunId, rebasedRunId: rebased.snapshot.runId, modelCalls: requests.length, hosts, atCommit,
        scope: 'Actual packed Host; active original parent and child model requests canceled; child budget settled once before authenticated branch cut; cold continuation without replay. Controlled model, local runtime only.' }, null, 2));
      console.log('Studio Native child rewind PASS: original active child canceled and settled before cut; cold continuation without replay.');
    } finally { await harness.close(); await running?.catch(() => {}); }
  }
  return { respond, run };
}
