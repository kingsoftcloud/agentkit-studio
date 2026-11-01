import { createRequire } from 'node:module';
/** Packed Studio + maintained DSH SDK, actual partial write and authenticated cold repair. */
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';

const sessionId = 'native-studio-session';
const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await delay(25);
  }
  assert.fail(`${description}: ${JSON.stringify(last)}`);
}

export function createWorkspaceRepairProof() {
  let proofRoot;
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(raw); requests.push(body);
    const count = requests.length;
    assert.ok(count <= 2, 'Original mutation must never be replayed');
    assert.ok(body.tools.some(tool => tool.function.name === 'apply_workspace_patch'));
    assert.equal(body.tools.some(tool => tool.function.name === 'native_repair_workspace_operation'), false);
    if (count === 2) {
      assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content, /workspace_operation_compensated/);
      assert.equal(existsSync(join(proofRoot, 'workspace/first.txt')), false, 'Compensation precedes model continuation');
      assert.equal(existsSync(join(proofRoot, 'workspace/second.txt')), false);
    }
    const delta = count === 1 ? { tool_calls: [{ index: 0, id: 'partial-write', type: 'function', function: {
      name: 'apply_workspace_patch', arguments: JSON.stringify({ patch_text: '*** Begin Patch\n*** Add File: first.txt\n+First publication\n*** Add File: second.txt\n+Never published\n*** End Patch' }) } }] }
      : { content: 'Original unconfirmed operation was undone.' };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `repair-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: count === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures }) {
    proofRoot = root;
    let harness = initial, stoppedPid;
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const load = (scope, runId) => {
      const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId); } finally { store.close(); }
    };
    let crash, settled;
    try {
      const running = harness.session(sessionId).run('Apply the two-file patch, then report completion.');
      // Attach immediately so a genuine early Host failure is never unhandled.
      const exit = running.then(value => ({ value }), error => ({ error }));
      const filename = join(root, 'workspace-repair-crash.json');
      await until(async () => existsSync(filename), Boolean, 'No durable partial-write crash marker');
      crash = JSON.parse(await readFile(filename, 'utf8')); stoppedPid = crash.pid;
      assert.equal(crash.record.snapshot.phase, 'awaiting_reconciliation');
      assert.equal(await readFile(join(root, 'workspace/first.txt'), 'utf8'), 'First publication\n');
      assert.equal(existsSync(join(root, 'workspace/second.txt')), false);
      assert.equal(requests.length, 1);
      process.kill(stoppedPid, 0); process.kill(stoppedPid, 'SIGKILL'); stoppedPid = null;
      assert.ok((await exit).error, 'Killed actual Host must terminate original SDK request');
      await harness.close();
      await rm(crash.readState, { recursive: true }); // Remove only the injected persistence fault.
      const leaseWait = Math.max(0, (crash.record.lease?.expiresAt ?? 0) - Date.now() + 30);
      assert.ok(leaseWait < 60000); if (leaseWait) await delay(leaseWait);
      harness = new DeepSeekHarness(options); await harness.start();
      const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
      const rpc = async (method, payload, authenticated = true) => {
        const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
          body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
        if (!authenticated) { await response.text(); return response.status; }
        assert.equal(response.status, 200); return (await response.json()).result;
      };
      const { scope, runId } = crash.admission.identity;
      const identity = { agentId: scope.agentId, sessionId, runId };
      const operationKey = crash.record.snapshot.toolReconciliation.operationKey;
      const command = { ...identity, operationKey, commandId: 'actual-studio-cold-file-compensation' };
      assert.equal(await rpc('sessions/native-workspace-repair', command, false), 401);
      const before = load(scope, runId);
      const status = await rpc('sessions/native-recovery-status', identity);
      assert.equal(status.ok, true, JSON.stringify(status)); assert.equal(status.value.canRepairWorkspace, true);
      assert.equal(status.value.phase, 'awaiting_reconciliation'); assert.equal(requests.length, 1);
      assert.equal(canonical(load(scope, runId)), canonical(before), 'Status is read-only');
      const injected = await rpc('sessions/native-workspace-repair', { ...command, result: { compensated: true } });
      assert.equal(injected.ok, false); assert.equal(requests.length, 1);
      const repaired = await rpc('sessions/native-workspace-repair', command);
      assert.equal(repaired.ok, true, JSON.stringify(repaired));
      settled = await until(() => rpc('sessions/native-recovery-status', identity), value => value.ok && value.value.state === 'closed', 'Original Run did not close');
      assert.equal(existsSync(join(root, 'workspace/first.txt')), false);
      assert.equal(existsSync(join(root, 'workspace/second.txt')), false);
      assert.equal(requests.length, 2); assert.deepEqual(failures, []);
      const record = load(scope, runId), original = crash.record.intents.find(row => row.kind === 'tool');
      assert.deepEqual(record.configuration, crash.record.configuration);
      assert.equal(record.snapshot.configDigest, crash.record.snapshot.configDigest);
      assert.deepEqual(record.intents.find(row => row.operationKey === original.operationKey), original);
      assert.deepEqual(record.receipts.find(row => row.operationKey === original.operationKey), crash.record.receipts.find(row => row.operationKey === original.operationKey));
      assert.equal(record.intents.filter(row => row.kind === 'tool').length, 1);
      assert.equal(record.intents.filter(row => row.kind === 'workspace_repair').length, 1);
      assert.equal(record.snapshot.usage.toolCalls, 1); assert.equal(record.snapshot.phase, 'completed');
      assert.equal(record.events.filter(event => event.kind === 'workspace.repair_completed').length, 1);
      const duplicate = await rpc('sessions/native-workspace-repair', command);
      assert.equal(duplicate.ok, true, JSON.stringify(duplicate)); assert.equal(requests.length, 2);
      assert.equal(canonical(load(scope, runId)), canonical(record), 'Repeated operator command cannot redispatch');
      await harness.close();
      const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith('.jsonl'));
      const events = (await Promise.all(paths.map(path => rows(join(sessions, path))))).flat()
        .filter(event => !['header', 'session'].includes(event.type));
      assert.deepEqual(events.slice(0, crash.events.length), crash.events, 'Cold continuation preserves durable Session prefix');
      for (const type of ['turn/start', 'turn/owner', 'turn/end']) assert.equal(events.filter(event => event.type === type).length, 1, type);
      const final = events.findLast(event => event.type === 'assistant/message');
      assert.equal(final.data.message.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'Original unconfirmed operation was undone.');
      const admissions = await rows(join(root, 'tool-admissions.jsonl'));
      assert.deepEqual(admissions.map(row => row.name), ['apply_workspace_patch', 'native_repair_workspace_operation']);
      await writeFile(join(root, 'workspace-repair-proof.json'), JSON.stringify({ passed: true, runId, configDigest: record.snapshot.configDigest,
        buildId: record.snapshot.buildId, hostKilled: crash.pid, status: settled.value, modelRequests: requests.length, toolCalls: record.snapshot.usage.toolCalls,
        scope: 'Packed Studio + maintained standard Host and SDK; actual partial publication, SIGKILL, authenticated original-Run compensation and SessionController recovery. Controlled model; root local Session only; no browser UI/managed server/child repair/performance claim.' }, null, 2));
      console.log('Studio Native workspace repair PASS: actual partial publication, SIGKILL, authenticated cold compensation, same frozen Run, one original tool attempt and one final Session turn.');
    } finally {
      if (stoppedPid) { try { process.kill(stoppedPid, 'SIGKILL'); } catch {} }
      await harness.close();
    }
  }
  return { respond, run };
}
