/** Actual packed SDK/Studio ownership crash proof. Commands and status travel
 * through signed HTTP; Native/Session storage, tool registry and recovery are
 * production implementations. Only model replies and fault placement vary. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 65000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check(); if (result) return result;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(50);
  }
}
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }

export async function verifyMountedManagedCrash({ root, harness: initial, makeHarness, boundary, issuer,
  command, modelRequests, archiveSha, source, serverFailures, nodeOnlyBin }) {
  let harness = initial;
  const commandDb = join(root, 'studio/native-harness/managed-kernel/commands.sqlite');
  const nativeDb = join(root, 'studio/native-harness/managed-kernel/runs.sqlite');
  const readCommand = () => {
    const db = new DatabaseSync(commandDb, { readOnly: true });
    try { return db.prepare('SELECT * FROM managed_commands WHERE command_id=?').get(command.command_id); }
    finally { db.close(); }
  };
  const readNative = () => {
    const db = new DatabaseSync(nativeDb, { readOnly: true });
    try {
      const rows = db.prepare('SELECT key,data FROM native_runs').all(); assert.ok(rows.length <= 1, 'cannot admit a replacement Native Run');
      if (!rows.length) return null;
      const record = parseNativeJson(rows[0].data);
      record.events = db.prepare('SELECT data FROM native_events WHERE run_key=? ORDER BY seq').all(rows[0].key).map(row => parseNativeJson(row.data));
      record.items = db.prepare('SELECT collection,data FROM native_items WHERE run_key=? ORDER BY collection,item_key').all(rows[0].key);
      return record;
    } finally { db.close(); }
  };
  const origin = async pid => {
    const rows = (await readFile(join(root, 'mounted-inbound-host.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    return rows.find(row => row.pid === pid)?.origin;
  };
  const writes = async () => (await readFile(join(root, 'managed-tool-dispatches.jsonl'), 'utf8')
    .catch(error => { if (error.code !== 'ENOENT') throw error; return ''; })).trim().split('\n').filter(Boolean).map(JSON.parse);
  const file = join(root, 'workspace/managed-proof.txt');
  const isUnknown = boundary === 'after-tool-effect';
  try {
    await harness.session('a2a-session').getWorkingDirectory();
    const originalPid = harness.client.child.pid;
    const actual = await json(join(root, 'managed-studio-binding.json')); command.agent_instance_id = actual.agentId;
    const send = async endpoint => {
      const response = await fetch(await origin(harness.client.child.pid) + '/_agentkit/native-kernel/v1/' + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: canonical({ command, permit: issuer.issue(command) }),
        signal: AbortSignal.timeout(10000) });
      assert.ok([200, 202].includes(response.status)); return response.json();
    };
    const receipt = await send('commands'); assert.equal(receipt.status, 'accepted');
    const checkpoint = await until(() => json(join(root, 'managed-crash-checkpoint.json')), 'actual SDK fault boundary');
    assert.equal(checkpoint.pid, originalPid); assert.equal(checkpoint.boundary, boundary);
    const before = readNative(), ownerBefore = checkpoint.history.filter(event => event.type === 'turn/owner');
    assert.equal(readCommand().state, 'accepted', 'fault must precede the receiver settlement/ACK');
    const expectedModelsBefore = ['before-owner', 'after-owner-flush', 'after-input-flush'].includes(boundary) ? 0 : isUnknown ? 1 : 2;
    assert.equal(modelRequests.length, expectedModelsBefore);
    assert.equal((await writes()).length, expectedModelsBefore ? 1 : 0);
    assert.equal(ownerBefore.length, boundary === 'before-owner' ? 0 : 1);
    if (boundary === 'after-owner-flush') assert.equal(before, null, 'SDK owner is durable before Native Run creation');
    if (boundary === 'after-input-flush') {
      assert.equal(before.snapshot.phase, 'created');
      assert.equal(checkpoint.history.filter(event => event.type === 'user/message' && event.data.id === command.command_id).length, 1);
      assert.equal(Object.values(before.projections)[0], 0, 'Session flush happened before Native delivery ACK');
    }
    if (isUnknown) {
      assert.equal(before.snapshot.phase, 'executing_tools');
      assert.ok(before.items.some(row => row.collection === 'intents' && parseNativeJson(row.data).status === 'running'));
      assert.equal(await readFile(file, 'utf8'), 'Managed formal binding proof\n');
    }
    const oldMtime = expectedModelsBefore ? (await stat(file, { bigint: true })).mtimeNs : null;
    const exited = once(harness.client.child, 'exit');
    assert.equal(harness.client.child.kill('SIGKILL'), true);
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.throws(() => process.kill(originalPid, 0), { code: 'ESRCH' });
    await harness.close();
    // Restart BEFORE the actual Native lease expires. This must recover on its
    // own; do not submit another command or call drain/native-recovery RPC.
    harness = makeHarness(); await harness.resumeSession('a2a-session');
    const coldPid = harness.client.child.pid; assert.notEqual(coldPid, originalPid);
    const query = { tenant_id: command.tenant_id, agent_instance_id: command.agent_instance_id,
      session_id: command.session_id, authorization_ref: randomUUID() };
    const statusResponse = await fetch(await origin(coldPid) + '/_agentkit/native-kernel/v1/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: canonical({ query, permit: issuer.issue(query, 'get_status') }), signal: AbortSignal.timeout(10000) });
    assert.equal(statusResponse.status, 200);
    let coldStatus = await statusResponse.json();
    if (['after-input-flush', 'after-tool-effect'].includes(boundary) && coldStatus.workerError !== 'lease_busy') {
      coldStatus = await until(async () => {
        const result = await fetch(await origin(coldPid) + '/_agentkit/native-kernel/v1/status', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: canonical({ query, permit: issuer.issue(query, 'get_status') }), signal: AbortSignal.timeout(10000) });
        assert.equal(result.status, 200); const value = await result.json(); return value.workerError === 'lease_busy' && value;
      }, 'cold worker observes the actual unexpired lease', 10000);
    }
    await writeFile(join(root, 'managed-cold-initial-status.json'), JSON.stringify(coldStatus));
    const settled = await until(() => readCommand().state === 'settled' && readNative(), 'automatic original command recovery');
    assert.equal(settled.snapshot.runId, receipt.run_id);
    assert.equal(settled.snapshot.phase, isUnknown ? 'interrupted' : 'completed');
    assert.equal(modelRequests.length, isUnknown ? 1 : 2);
    assert.equal((await writes()).length, 1); assert.equal(await readFile(file, 'utf8'), 'Managed formal binding proof\n');
    if (oldMtime !== null) assert.equal((await stat(file, { bigint: true })).mtimeNs, oldMtime);
    assert.equal(settled.events.filter(event => event.kind === 'tool.completed' && event.payload.status === 'ok').length, isUnknown ? 0 : 1);
    const delivered = await until(async () => {
      const value = await json(join(root, 'managed-session-history.json')); return value?.pid === coldPid && value;
    }, 'cold owner public history flush');
    const history = delivered.history, owners = history.filter(event => event.type === 'turn/owner');
    assert.equal(owners.length, 1); assert.equal(owners[0].data.engine, 'agentkit.native-managed-dsh-turn/v1');
    assert.equal(JSON.parse(owners[0].data.binding).identity.runId, receipt.run_id);
    if (ownerBefore.length) assert.deepEqual(owners[0], ownerBefore[0], 'resume the original SDK owner, never claim a replacement turn');
    const expectedTurns = boundary === 'before-owner' ? 2 : 1;
    assert.equal(history.filter(event => event.type === 'turn/start').length, expectedTurns);
    assert.equal(history.filter(event => event.type === 'turn/end').length, expectedTurns);
    if (boundary === 'before-owner') assert.equal(history.find(event => event.type === 'turn/end').data.reason.kind, 'interrupted');
    assert.equal(history.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1);
    assert.equal(history.filter(event => event.type === 'tool/result').length, 1);
    assert.equal(history.filter(event => event.type === 'assistant/message' && event.data.usage).length, isUnknown ? 1 : 2);
    const duplicate = await send('commands'); assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.run_id, receipt.run_id); assert.equal(duplicate.message_id, receipt.message_id);
    await delay(100); assert.deepEqual(readNative(), settled);
    assert.deepEqual(serverFailures, []);
    const processes = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(processes.map(row => row.pid), [originalPid, coldPid]);
    assert.ok(processes.every(row => row.path === nodeOnlyBin && row.node === process.version));
    const evidence = { archiveSha256: archiveSha, source, node: process.version, boundary, originalPid, coldPid, signal,
      receipt, duplicate, checkpoint, coldStatus, before, final: settled, history, actualSdkOwnership: true, automaticRecovery: true,
      modelHttp: modelRequests.length, fileDispatches: 1, coldFileDispatches: expectedModelsBefore ? 0 : 1,
      limitation: 'Actual maintained SDK/packed Studio/formal preset/SQLite/Node workspace/SIGKILL/Node-only PATH. Controlled Server signing/model; not deployed Server, fresh installation, other resources or all product entries.' };
    await writeFile(join(root, 'managed-crash-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`PASS: managed SDK SIGKILL ${boundary}, original Run ${receipt.run_id}, owner ${owners[0].data.turn}, model ${modelRequests.length}, file dispatch 1. Evidence ${root}`);
  } finally { await harness.close().catch(() => {}); }
}
