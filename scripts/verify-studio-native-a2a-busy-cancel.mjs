import { createRequire } from 'node:module';
/** Full mounted Host + actual ApprovalService with a controlled HTTP answerer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createNativeA2aTaskState } from '../src/client/state/native-a2a.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(check) { const deadline = Date.now() + 30000; for (;;) {
  const result = await check(); if (result) return result;
  assert.ok(Date.now() < deadline, 'mounted busy cancellation checkpoint timeout'); await new Promise(resolve => setTimeout(resolve, 25));
} }
export async function verifyMountedA2aBusyCancel({ root, installed, repository, source, archive, archiveSha, harness, recoveryPeer, counts, requests }) {
  let store, state;
  const running = harness.session('a2a-session').run('Ask the research agent to find documents about A2A.'); running.catch(() => {});
  try {
    const auth = await until(async () => { try { return JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; } });
    const rpc = async (payload, signal) => {
      const response = await fetch(auth.origin + '/agentkit', { method: 'POST', headers: { origin: auth.origin, cookie: auth.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'sessions/native-a2a-control', payload }),
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
      assert.equal(response.status, 200); const result = (await response.json()).result;
      assert.equal(result?.ok, true, JSON.stringify(result)); return result.value;
    };
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: sha(JSON.stringify(resolve(root, 'workspace'))), userId: 'local-user', agentId };
    const db = join(root, 'studio/native-harness/runs.sqlite');
    await until(async () => { try { await stat(db); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; } });
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    store = new SqliteRunStore(db);
    let runId, intent;
    await until(() => {
      const runs = store.list(scope, 'a2a-session'); if (!runs.length || !recoveryPeer.finishStream) return;
      assert.equal(runs.length, 1); runId = runs[0].runId;
      const record = store.load(scope, runId); intent = record.intents.find(row => row.kind === 'tool');
      return intent?.status === 'running' && record.snapshot.phase === 'executing_tools';
    });
    const task = { agentId, sessionId: 'a2a-session', runId, operationKey: intent.operationKey, callId: 'a2a-call-1' };
    const calls = []; let commandSequence = 0;
    state = createNativeA2aTaskState({ task, commandId: () => ['mounted-busy-inspect', 'mounted-busy-subscribe', 'mounted-busy-cancel'][commandSequence++], hostRemote: {
      controlNativeA2aTask: (input, signal) => { calls.push(structuredClone(input)); return rpc(input, signal); },
    } });
    await state.refresh(); assert.equal(state.getSnapshot().error, ''); assert.equal(state.getSnapshot().task.state, 'working');
    await state.watch(); assert.equal(state.getSnapshot().error, ''); assert.equal(state.getSnapshot().task.state, 'working');
    assert.deepEqual(state.getSnapshot().task.subscription, { contract: 'agentkit.studio-a2a-task-subscription/v1', events: 2, ended: 'eof' });
    assert.equal(requests.a2aPeerRequests.filter(row => row.method === 'SubscribeToTask').length, 1);
    await state.cancel(); assert.equal(state.getSnapshot().error, ''); assert.equal(state.getSnapshot().outcome, 'remote_cancelled');
    assert.equal(store.load(scope, runId).snapshot.phase, 'executing_tools', 'original stream still holds its effect lock');
    const command = calls.find(row => row.kind === 'cancel'); assert.ok(command);
    assert.equal((await rpc(command)).outcome, 'remote_cancelled', 'exact duplicate confirms without a second approval or CancelTask');
    assert.deepEqual(counts(), { model: 1, discovery: 1, send: 1, get: 4, cancel: 1 });
    recoveryPeer.finishStream();
    const result = await running; assert.match(result.finalResponse, /Original remote task was cancelled/);
    const record = store.load(scope, runId); assert.equal(record.snapshot.phase, 'completed');
    assert.equal(record.snapshot.usage.modelCalls, 2); assert.equal(record.snapshot.usage.toolCalls, 1);
    const tool = requests.modelRequests[1].messages.find(row => row.role === 'tool');
    assert.equal(tool.tool_call_id, 'a2a-call-1'); assert.equal(JSON.parse(tool.content).state, 'cancelled');
    assert.equal(JSON.parse(tool.content).ok, false, 'remote cancellation is a tool error, not fabricated remote success');
    const files = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl')); assert.equal(files.length, 1);
    const history = (await readFile(join(root, 'sessions', files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
    const asked = history.filter(row => row.type === 'approval/asked'), decided = history.filter(row => row.type === 'approval/decided');
    assert.equal(asked.length, 1); assert.equal(decided.length, 1); assert.equal(decided[0].data.outcome, 'allowed-once');
    assert.equal(asked[0].data.id, decided[0].data.id); assert.equal(asked[0].data.toolName, 'a2a_cancel_task');
    assert.equal(history.filter(row => row.type === 'turn/owner').length, 1); assert.equal(history.filter(row => row.type === 'turn/end').length, 1);
    assert.deepEqual(counts(), { model: 2, discovery: 1, send: 1, get: 4, cancel: 1 }); assert.deepEqual(requests.serverFailures, []);
    const evidence = { node: process.version, pid: harness.client.child.pid, archive: { path: archive, sha256: archiveSha },
      sdk: { source, commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, scope, runId, counts: counts(),
      command, subscription: calls.find(row => row.kind === 'subscribe'),
      approval: { asked, decided, http: JSON.parse(await readFile(join(root, 'approval-http.json'), 'utf8')) },
      fixtureSha256: sha(await readFile(join(repository, 'tests/fixtures/studio-native-a2a.mjs'))),
      verifierSha256: sha(await readFile(new URL(import.meta.url))), requests,
      limitation: 'Full authenticated mounted Host, actual SessionController/ApprovalService and UI state, controlled HTTP human answerer/model/A2A peer; existing linked dependency graph, not live human/browser/Electron, fresh install or online service.' };
    await writeFile(join(root, 'mounted-busy-cancel-evidence.json'), JSON.stringify(evidence, null, 2));
    await writeFile(join(root, 'mounted-busy-cancel-ledger.json'), JSON.stringify(record));
    console.log(`PASS: mounted Host original-task subscription and busy cancellation through actual ApprovalService and authenticated RPC; EOF stays working, original send once, cancellation once, original Run completed. Evidence ${root}`);
  } finally { state?.dispose(); await harness.close().catch(() => {}); store?.close(); }
}
