import { createRequire } from 'node:module';
/** Actual packed Studio + mounted Host + SDK review/source/repair and cold replay. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sessionId = 'native-studio-session';
const rows = async filename => (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
export function createDeliveryReviewProof() {
  async function respond({ request, response, raw, requests, frozen }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length, turn = Math.ceil(count / 7), step = (count - 1) % 7 + 1;
    assert.ok(turn <= 2); assert.equal(body.model, 'pinned');
    const reviewing = [3, 4, 7].includes(step), names = body.tools.map(tool => tool.function.name);
    if (reviewing) { assert.ok(names.includes('submit_delivery_review')); assert.equal(names.includes('write_workspace_file'), false); }
    else assert.deepEqual(new Set(names), new Set(['write_workspace_file', 'read_workspace_file']));
    if (frozen) { assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
      assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false); }
    if (turn === 2 && step === 1) assert.equal(JSON.stringify(body.messages).includes('PRIVATE_REVIEW'), false);
    let delta;
    const call = (name, args) => ({ tool_calls: [{ index: 0, id: `review-proof-${count}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    if ([1, 5].includes(step)) delta = call('write_workspace_file', { path: `ledger-${turn}.ts`, content: `${step === 1 ? 'broken' : 'fixed'}-${turn}` });
    else if (step === 3) { assert.ok(names.includes('read_workspace_file')); delta = { content: 'PRIVATE_REVIEW_SOURCE_STREAM', ...call('read_workspace_file', { path: `ledger-${turn}.ts` }) }; }
    else if ([4, 7].includes(step)) {
      if (step === 4) assert.ok(JSON.stringify(body.messages.filter(message => message.role === 'tool')).includes(`broken-${turn}`));
      delta = { content: 'PRIVATE_REVIEW_CONTROL_STREAM', ...call('submit_delivery_review', {
        requirements: [{ requirement: 'PRIVATE_REVIEW_REQUIREMENT', implementation_evidence: `ledger-${turn}.ts`, verification_evidence: 'No independent semantic verifier.' }],
        findings: step === 4 ? [{ issue: 'PRIVATE_REVIEW_FINDING', recommended_check: 'Inspect and repair the source.' }] : [],
      }) };
    } else delta = { content: step === 2 ? `Candidate ${turn}.` : `Repaired delivery ${turn}.` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.write(`data: ${JSON.stringify({ id: `response-${count}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: `response-${count}`, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures, frozen }) {
    let harness = initial;
    try {
      let session = harness.session(sessionId);
      for (let turn = 1; turn <= 2; turn++) {
        const result = await session.run(`Delivery review proof ${turn}: implement the zero case and check the source.`);
        await writeFile(join(root, `review-sdk-turn-${turn}.json`), JSON.stringify(result));
        assert.equal(result.finalResponse, `Repaired delivery ${turn}.`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
        assert.equal(result.events.filter(event => event.type === 'tool/result').length, 3);
        assert.ok(result.events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError));
        assert.equal(JSON.stringify(result.events).includes('PRIVATE_REVIEW'), false);
        assert.equal(await readFile(join(root, 'workspace', `ledger-${turn}.ts`), 'utf8'), `fixed-${turn}`);
        if (turn === 1) { await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession(sessionId); }
      }
      const delegated = await harness.session('default-session').run('Use the default engine.');
      assert.equal(delegated.finalResponse, 'Default engine completed.'); assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
    } finally {
      await harness.close(); await writeFile(join(root, 'review-model-requests.json'), JSON.stringify(requests));
      await writeFile(join(root, 'review-model-failures.json'), JSON.stringify(failures.map(error => ({ message: error.message, stack: error.stack }))));
    }
    assert.deepEqual(failures, []); assert.equal(requests.length, 14);
    const { id: agentId, buildId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite')); const evidence = [];
    try {
      const runs = store.list(scope, sessionId); assert.equal(runs.length, 2);
      for (const run of runs) {
        const record = store.load(scope, run.runId), snapshot = record.snapshot;
        assert.equal(snapshot.phase, 'completed'); assert.equal(snapshot.outcome, 'unverified'); assert.equal(snapshot.deliveryReview.rounds, 2);
        assert.equal(snapshot.usage.modelCalls, 7); assert.equal(snapshot.usage.toolCalls, 3); assert.equal(snapshot.repairs, 1);
        assert.equal(snapshot.usage.inputTokens, 35); assert.equal(snapshot.usage.outputTokens, 49);
        if (frozen) assert.equal(snapshot.buildId, buildId);
        const intents = record.intents.filter(intent => intent.kind === 'tool'); assert.equal(intents.length, 3);
        assert.equal(record.events.filter(event => event.kind === 'completion.delivery_review_completed').length, 3);
        evidence.push({ runId: run.runId, buildId: snapshot.buildId, models: snapshot.usage.modelCalls, tools: snapshot.usage.toolCalls, rounds: snapshot.deliveryReview.rounds });
      }
    } finally { store.close(); }
    const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    const events = (await Promise.all(files.map(file => rows(join(sessions, file))))).flat();
    assert.equal(JSON.stringify(events).includes('PRIVATE_REVIEW'), false);
    const streams = await rows(join(root, 'assistant-stream.jsonl'));
    assert.equal(JSON.stringify(streams).includes('PRIVATE_REVIEW'), false);
    const probes = await rows(join(root, 'mounted-host-http.jsonl')); assert.equal(probes.length, 2);
    assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
    assert.ok(probes.some(probe => probe.source === 'resume'));
    const admissions = await rows(join(root, 'tool-admissions.jsonl')); assert.equal(admissions.length, 6);
    await writeFile(join(root, 'delivery-review-proof.json'), JSON.stringify({ passed: true, node: process.version, frozen, evidence, modelHttpRequests: requests.length,
      scope: 'Actual packed maintained mounted Host, controlled model HTTP, real tools and SDK restart; not online/all-product/fresh-install acceptance.' }, null, 2));
    console.log(`Studio Native delivery review PASS: ${frozen ? 'Frozen Build' : 'Revision'}, two actual SDK turns across process restart, 14 model HTTP calls, 6 real file tools, private review streams/control/diagnosis, original usage and unverified semantics, authenticated Host/default DSH, Node-only PATH.`);
  }
  return { respond, run };
}
