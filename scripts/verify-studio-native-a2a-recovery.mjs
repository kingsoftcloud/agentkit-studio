/** Full mounted Host acceptance, invoked by verify-studio-native-a2a --reconcile-cold. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { readNativeDshOwnership } from '../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function until(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(25);
  }
}

export async function verifyMountedA2aRecovery(options) {
  const { root, installed, repository, source, archive, archiveSha, makeHarness, recoveryPeer,
    receiptCrash, nodeOnlyBin, counts, requests, a2aReply, remoteTaskId, remoteContextId } = options;
  let harness = options.harness, store, running, runId, scope;
  const pids = [], kills = [], checkpoints = [];
  const save = async (name, value) => writeFile(join(root, name + '.json'), JSON.stringify(value, null, 2));
  const snapshot = async name => { const record = store.load(scope, runId); await save(name, record); return record; };
  const identity = () => ({ agentId: scope.agentId, sessionId: 'a2a-session', runId });
  const rpc = async (method, payload) => {
    const auth = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
    assert.equal(auth.pid, harness.client.child.pid, 'fresh Host authentication, never the crashed process');
    const response = await fetch(auth.origin + '/agentkit', { method: 'POST',
      headers: { cookie: auth.cookie, origin: auth.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const accepted = async (method, payload) => {
    const result = await rpc(method, payload);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.value;
  };
  const count = expected => { assert.deepEqual(counts(), expected); assert.deepEqual(requests.serverFailures, []); };
  const kill = async label => {
    const child = harness.client.child, pid = child.pid;
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const exited = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await running?.catch(() => {}); await harness.close();
    const record = store.load(scope, runId);
    kills.push({ label, pid, code, signal, lease: record.lease, phase: record.snapshot.phase });
    // Wait for the actual committed lease; never edit the database or shorten
    // production's lease for the fault injector. Idle runs normally release it.
    await until(() => !record.lease || Date.now() > record.lease.expiresAt, 'original lease expiry');
  };
  const restart = async () => {
    harness = makeHarness();
    const resumed = await harness.resumeSession('a2a-session'); assert.equal(resumed.id, 'a2a-session');
    const pid = harness.client.child.pid;
    assert.ok(!pids.includes(pid), 'actual new Host process'); pids.push(pid);
    await until(async () => {
      const auth = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
      return auth.pid === pid;
    }, 'authenticated resumed Host with real preset');
    const probe = (await rows(join(root, 'mounted-host-http.jsonl'))).find(row => row.pid === pid);
    assert.equal(probe.source, 'resume'); assert.equal(probe.unauthorizedStatus, 401);
    assert.equal(probe.compatible, true); assert.equal(probe.historyHasCompletedTurn, false);
    return pid;
  };
  try {
    running = harness.session('a2a-session').run('Ask the research agent to find documents about A2A.');
    running.catch(() => {});
    await until(async () => {
      try { return JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, 'mounted Host authentication');
    assert.equal((await stat(join(root, 'control-auth.json'))).mode & 0o777, 0o600);
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    scope = { tenantId: 'local', workspaceId: sha(JSON.stringify(resolve(root, 'workspace'))), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    await until(async () => {
      try { await stat(join(root, 'studio/native-harness/runs.sqlite')); return true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, 'actual Native database');
    store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    await until(() => {
      const runs = store.list(scope, 'a2a-session');
      if (!runs.length) return false;
      assert.equal(runs.length, 1); runId = runs[0].runId;
      return store.load(scope, runId).snapshot.phase === 'awaiting_reconciliation';
    }, 'original uncertain tool waiting');
    pids.push(harness.client.child.pid);
    const original = await snapshot('mounted-run-original');
    const operationKey = original.snapshot.toolReconciliation.operationKey;
    const originalIntent = original.intents.find(row => row.operationKey === operationKey);
    const originalReceipt = original.receipts.find(row => row.operationKey === operationKey);
    assert.equal(originalIntent.kind, 'tool'); assert.equal(originalReceipt.status, 'committed');
    assert.equal(originalReceipt.result.results[0].status, 'uncertain', 'committed tool response explicitly reports an unknown outcome');
    const request = { ...identity(), operationKey };
    const reconcile = commandId => accepted('sessions/native-recovery-reconcile', { ...request, commandId });
    count({ model: 1, discovery: 1, send: 1, get: 0 });

    // A genuine nonterminal remote response cannot be treated as Native success.
    await reconcile('mounted-read-paused');
    await until(() => store.load(scope, runId).intents.some(row => row.kind === 'tool_receipt')
      && store.load(scope, runId).snapshot.phase === 'awaiting_reconciliation', 'nonterminal receipt wait');
    await reconcile('mounted-read-paused');
    count({ model: 1, discovery: 1, send: 1, get: 1 });
    const beforeKill = await snapshot('mounted-run-before-kill');
    await kill('waiting-original-turn');
    await restart();
    const cold = await accepted('sessions/native-recovery-status', identity());
    assert.equal(cold.state, 'reconciliation_required'); assert.equal(cold.canReconcile, true); assert.equal(cold.canResume, true);
    assert.deepEqual(cold.receiptWait, { contract: 'agentkit.native-a2a-receipt-wait/v1', operationKey,
      callId: original.snapshot.toolReconciliation.callId });
    assert.equal(cold.runId, runId);
    assert.equal(canonical(store.load(scope, runId)), canonical(beforeKill), 'history/status alone never drives or mutates Native');
    const attached = await accepted('sessions/native-recovery-resume', identity());
    assert.equal(attached.state, 'recovering'); assert.equal(attached.runId, runId);
    await delay(250);
    count({ model: 1, discovery: 1, send: 1, get: 1 });
    assert.equal(store.load(scope, runId).snapshot.phase, 'awaiting_reconciliation');
    assert.equal(store.load(scope, runId).intents.filter(row => row.kind === 'tool_receipt').length,
      beforeKill.intents.filter(row => row.kind === 'tool_receipt').length,
      'reattachment adds no receipt query: the original waiter resumes locally');
    await reconcile('mounted-read-paused');
    count({ model: 1, discovery: 1, send: 1, get: 1 });
    const forged = await rpc('sessions/native-recovery-reconcile', { ...request, operationKey: 'wrong-original', commandId: 'forged' });
    assert.equal(forged.ok, false); assert.equal(store.load(scope, runId).commands.some(row => row.command.commandId === 'forged'), false);
    checkpoints.push({ name: 'cold-wait-no-replay', counts: counts(), status: cold });

    if (receiptCrash) {
      recoveryPeer.holdNextGet = true;
      await reconcile('mounted-read-lost');
      await until(() => counts().get === 2, 'actual receipt GetTask entered');
      const querying = await snapshot('mounted-run-query-entered');
      assert.equal(querying.snapshot.phase, 'reconciling_tool');
      const intent = querying.intents.filter(row => row.kind === 'tool_receipt').at(-1);
      assert.equal(intent.status, 'running'); assert.ok(intent.claimedFence);
      await kill('receipt-query-entered');
      await restart();
      count({ model: 1, discovery: 1, send: 1, get: 2 });
      // Only this explicit product recovery command classifies the lost read.
      await accepted('sessions/native-recovery-resume', identity());
      await until(() => store.load(scope, runId).snapshot.phase === 'awaiting_reconciliation', 'lost receipt classified');
      await reconcile('mounted-read-lost');
      count({ model: 1, discovery: 1, send: 1, get: 2 });
      checkpoints.push({ name: 'lost-query-confirmation-no-reread', counts: counts(), record: await snapshot('mounted-run-lost-read') });
    }

    // The independent remote service finishes the original task. No new Send,
    // discovery or user prompt is permitted to obtain the final tool receipt.
    recoveryPeer.complete = true;
    const ack = await reconcile('mounted-read-complete'); assert.equal(ack.runId, runId);
    await until(() => store.load(scope, runId).snapshot.phase === 'completed', 'same original Run completed');
    const completed = await snapshot('mounted-run-completed');
    assert.equal(completed.snapshot.runId, original.snapshot.runId);
    assert.equal(completed.snapshot.usage.modelCalls, 2); assert.equal(completed.snapshot.usage.toolCalls, 1);
    assert.deepEqual(completed.intents.find(row => row.operationKey === operationKey), originalIntent);
    assert.deepEqual(completed.receipts.find(row => row.operationKey === operationKey), originalReceipt);
    assert.equal(completed.events.filter(row => row.kind === 'tool.receipt_reconciled').length, 1);
    assert.equal(completed.snapshot.messages.filter(row => row.role === 'tool').length, 1);
    const toolMessage = requests.modelRequests[1].messages.find(row => row.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'a2a-call-1'); assert.match(toolMessage.content, /The remote agent found 3 relevant documents/);
    const expected = { model: 2, discovery: 1, send: 1, get: receiptCrash ? 3 : 2 };
    count(expected);
    await until(async () => {
      const base = join(root, 'sessions'), files = (await readdir(base, { recursive: true })).filter(path => path.endsWith('.jsonl'));
      assert.equal(files.length, 1);
      return (await rows(join(base, files[0]))).some(row => row.type === 'turn/end');
    }, 'original product turn finalized durably');
    const base = join(root, 'sessions'), files = (await readdir(base, { recursive: true })).filter(path => path.endsWith('.jsonl'));
    const history = await rows(join(base, files[0])), owners = history.filter(row => row.type === 'turn/owner');
    assert.equal(owners.length, 1); assert.equal(readNativeDshOwnership(owners[0].data, { sessionId: 'a2a-session', turn: 1 }).identity.runId, runId);
    const ends = history.filter(row => row.type === 'turn/end'); assert.equal(ends.length, 1); assert.equal(ends[0].data.reason.kind, 'completed');
    assert.equal(history.filter(row => row.type === 'turn/start').length, 1);
    const inputs = history.filter(row => row.type === 'user/message');
    assert.equal(inputs.length, 3, 'one human prompt plus the original runtime/time context snapshots');
    assert.deepEqual(inputs.map(row => row.data.source.kind), ['user', 'runtime-context', 'time-context']);
    assert.equal(inputs[0].data.content[0].text, 'Ask the research agent to find documents about A2A.');
    assert.equal(history.filter(row => row.type === 'tool/call').length, 1);
    assert.equal(history.filter(row => row.type === 'tool/result').length, 1);
    assert.ok(JSON.stringify(history).includes(a2aReply));
    const beforeDuplicate = canonical(store.load(scope, runId));
    await reconcile('mounted-read-complete'); count(expected);
    assert.equal(canonical(store.load(scope, runId)), beforeDuplicate, 'completed duplicate confirms without another execution');
    const processes = await rows(join(root, 'host-processes.jsonl'));
    assert.deepEqual(processes.map(row => row.pid), pids);
    assert.ok(processes.every(row => row.node === process.version && row.path === nodeOnlyBin));
    assert.equal(beforeDuplicate.includes('a2a-fixture-token'), false);
    assert.equal(beforeDuplicate.includes('sk-studio-a2a-secret'), false);
    await save('mounted-a2a-recovery-evidence', { node: process.version, pids, kills, checkpoints, counts: counts(),
      proofRoot: root, receiptCrash, runId, scope, remoteTaskId, remoteContextId,
      archive: { path: archive, sha256: archiveSha }, sdk: { source, commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
      fixtureSha256: sha(await readFile(join(repository, 'tests/fixtures/studio-native-a2a.mjs'))),
      verifierSha256: sha(await readFile(new URL(import.meta.url))), originalOperationKey: operationKey,
      historySha256: sha(canonical(history)), completedLedgerSha256: sha(beforeDuplicate), requests,
      limitation: 'Actual authenticated mounted Host, real SessionController, SQLite and SIGKILL with Node-only PATH; controlled HTTP model/peer and existing linked dependency graph. Excludes online service, fresh install, Electron, Frozen deployment and human continuation approval.' });
    console.log(`PASS: mounted Host ${receiptCrash ? 'lost receipt and ' : ''}SIGKILL recovery; same original Run/turn, 1 Send, authenticated receipt read, no implicit replay. Evidence ${root}`);
  } catch (error) {
    await save('mounted-recovery-failure', { message: error.message, stack: error.stack, pids, kills, counts: counts(), runId }).catch(() => {});
    throw error;
  } finally { await harness.close().catch(() => {}); store?.close(); }
}
