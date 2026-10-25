/** Packed Host product-policy binding and exact-content refusal, with real SDK restart. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sessionId = 'native-studio-session';
export function createDeadlinePolicyProof() {
  let directory;
  async function respond({ request, response, raw, requests, frozen }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length, turn = Math.ceil(count / 4), step = (count - 1) % 4 + 1;
    const path = `report-${turn}.txt`;
    assert.ok(turn <= 2); assert.equal(body.model, 'pinned');
    assert.deepEqual(new Set(body.tools.map(tool => tool.function.name)),
      new Set(['write_workspace_file', 'read_workspace_file', 'edit_workspace_file']));
    if (frozen) {
      assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
      assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false);
    }
    if (step === 2 || step === 3) {
      const receipt = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(receipt.code, step === 2 ? 'workspace_content_contract_mismatch' : 'workspace_exact_content_requires_write');
      if (step === 2) assert.equal(receipt.difference.firstMismatchByte, 8);
      await assert.rejects(readFile(join(directory, 'workspace', path)), { code: 'ENOENT' });
    }
    if (step === 4) assert.equal(await readFile(join(directory, 'workspace', path), 'utf8'), 'hello😀');
    const delta = step === 4 ? { content: path } : { tool_calls: [{ index: 0, id: `deadline-policy-${count}`, type: 'function',
      function: { name: step === 2 ? 'edit_workspace_file' : 'write_workspace_file', arguments: JSON.stringify(step === 2
        ? { path, old_text: 'hello', new_text: 'hello😀' } : { path, content: step === 1 ? 'hello😃' : 'hello😀' }) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `response-${count}`, choices: [{ index: 0, delta, finish_reason: step === 4 ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures, frozen }) {
    directory = root; let harness = initial;
    try {
      let session = harness.session(sessionId);
      for (let turn = 1; turn <= 2; turn++) {
        const result = await session.run(`在工作区创建 report-${turn}.txt，内容恰好是 hello😀。完成后回复路径。`);
        await writeFile(join(root, `deadline-sdk-turn-${turn}.json`), JSON.stringify(result));
        assert.equal(result.finalResponse, `report-${turn}.txt`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
        assert.equal(await readFile(join(root, 'workspace', `report-${turn}.txt`), 'utf8'), 'hello😀');
        if (turn === 1) { await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession(sessionId); }
      }
      const delegated = await harness.session('default-session').run('Use the default engine.');
      assert.equal(delegated.finalResponse, 'Default engine completed.');
      assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
    } finally {
      await harness.close(); await writeFile(join(root, 'deadline-model-requests.json'), JSON.stringify(requests));
      await writeFile(join(root, 'deadline-model-failures.json'), JSON.stringify(failures.map(error => ({ message: error.message, stack: error.stack }))));
    }
    assert.deepEqual(failures, []); assert.equal(requests.length, 8);
    const { id: agentId, buildId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite')), evidence = [];
    try {
      const runs = store.list(scope, sessionId); assert.equal(runs.length, 2);
      for (const run of runs) {
        const record = store.load(scope, run.runId), { configuration: config, snapshot } = record;
        assert.equal(snapshot.phase, 'completed'); assert.equal(config.wallDeliveryPolicy, 'deadline-delivery/v7');
        assert.equal(config.limits.maxWallMs, 600000); assert.equal(config.limits.finalizationReserveWallMs, 240000);
        assert.equal(config.limits.deliveryContextRecoveryPolicy, 'delivery-window-summary/v2');
        assert.equal(config.tools.find(tool => tool.name === 'read_workspace_file').deliveryArtifactRole, 'read');
        assert.equal(config.tools.find(tool => tool.name === 'write_workspace_file').exactContentPolicy, 'current-goal-utf8/v1');
        assert.equal(config.tools.find(tool => tool.name === 'edit_workspace_file').exactContentPolicy, 'complete-write-only/v1');
        assert.equal(snapshot.usage.modelCalls, 4); assert.equal(snapshot.usage.toolCalls, 3);
        assert.equal(snapshot.usage.inputTokens, 20); assert.equal(snapshot.usage.outputTokens, 28);
        if (frozen) assert.equal(snapshot.buildId, buildId);
        const results = record.receipts.flatMap(receipt => receipt.result.results ?? []);
        assert.deepEqual(results.map(result => result.status), ['error', 'error', 'ok']);
        evidence.push({ runId: run.runId, buildId: snapshot.buildId, models: snapshot.usage.modelCalls,
          admittedToolCalls: snapshot.usage.toolCalls, actualFilesystemWrites: 1, outcome: snapshot.outcome });
      }
    } finally { store.close(); }
    const rows = async name => (await readFile(join(root, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const admissions = await rows('tool-admissions.jsonl');
    assert.deepEqual(admissions.map(item => item.name), ['write_workspace_file', 'write_workspace_file']);
    const probes = await rows('mounted-host-http.jsonl'); assert.equal(probes.length, 2);
    assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
    assert.ok(probes.some(probe => probe.source === 'resume'));
    await writeFile(join(root, 'deadline-policy-proof.json'), JSON.stringify({ passed: true, node: process.version, frozen,
      evidence, modelHttpRequests: requests.length,
      scope: 'Packed mounted Host/SDK with controlled model HTTP and exact-content filesystem effects. Window crossing is covered by separate monotonic-clock shared Host tests; no online/all-entry/default-switch claim.' }, null, 2));
    console.log(`Studio Native deadline policy PASS: ${frozen ? 'Frozen Build' : 'Revision'}, two SDK turns with cold history, eight model HTTP calls, two actual writes, four pre-effect refusals, original usage, authenticated Host/default DSH, Node-only PATH.`);
  }
  return { respond, run };
}
