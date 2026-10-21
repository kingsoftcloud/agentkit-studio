/** Actual authenticated Studio automation routes; no substitute runner or preset. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function respondToAutomationProof(body, response, calls) {
  const userText = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string'
    ? message.content : JSON.stringify(message.content)).join('\n');
  const input = userText.match(/\bAUTOMATION_PROOF_(SCHEDULE|EVALUATION)\b/)?.[0];
  if (!input) return false;
  const evaluation = input.endsWith('EVALUATION'), text = JSON.stringify(body.messages);
  assert.ok(text.includes(evaluation ? 'FROZEN_NATIVE_SYSTEM_A' : 'LATEST_NATIVE_SYSTEM_B'));
  assert.equal(text.includes(evaluation ? 'LATEST_NATIVE_SYSTEM_B' : 'FROZEN_NATIVE_SYSTEM_A'), false);
  assert.equal(body.model, 'pinned');
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['run_command']);
  const result = body.messages.findLast(message => message.role === 'tool');
  if (result) assert.match(result.content, /denied|permission|read.only|not allowed|approval|权限|拒绝/i);
  calls.push({ input, denied: Boolean(result) });
  const delta = result ? { content: `Unattended ${evaluation ? 'evaluation' : 'schedule'} denied the write.` }
    : { tool_calls: [{ index: 0, id: 'unattended-write', type: 'function', function: { name: 'run_command',
      arguments: JSON.stringify({ command: `printf forbidden > automation-${evaluation ? 'evaluation' : 'schedule'}.txt`, timeout: 2 }) } }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: result ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  return true;
}

export async function runAutomationProof(root) {
  const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
  const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  const rpc = async (method, payload = {}) => {
    const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(20000) });
    const { result } = await response.json();
    assert.equal(response.status, 200, method); assert.equal(result?.ok, true, JSON.stringify(result?.error));
    return result.value;
  };
  const waitFor = async read => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail('Studio automation did not publish its terminal record');
  };
  const submitted = await rpc('builds/create', { agentId });
  const operation = await waitFor(async () => {
    const current = (await rpc('operations/list', { resourceId: agentId })).items.find(item => item.id === submitted.operationId);
    return ['succeeded', 'failed', 'cancelled'].includes(current?.status) && current;
  });
  assert.equal(operation.status, 'succeeded', JSON.stringify(operation));
  const buildId = operation.result.buildId, current = await rpc('agents/local-get', { agentId });
  await rpc('agents/update-local', { agentId, spec: { ...current.spec, instructions: { system: 'LATEST_NATIVE_SYSTEM_B' } } });
  const schedule = await rpc('schedules/create', { agentId, spec: { taskId: 'native-proof', kind: 'interval', everySeconds: 86400,
    prompt: 'AUTOMATION_PROOF_SCHEDULE' } });
  const occurrence = await rpc('schedules/run', { taskId: schedule.taskId });
  assert.equal(occurrence.state, 'succeeded', JSON.stringify(occurrence));
  assert.match(occurrence.runId, /^dsh:/);
  const savedOccurrence = (await rpc('schedules/occurrences', { taskId: schedule.taskId })).items;
  assert.equal(savedOccurrence.length, 1); assert.equal(savedOccurrence[0].runId, occurrence.runId);
  const evalset = await rpc('evaluations/import', { fileName: 'native-automation-proof', content: JSON.stringify([{ id: 'frozen-unattended',
    input: 'AUTOMATION_PROOF_EVALUATION', assertions: [
      { type: 'response.equals', value: 'Unattended evaluation denied the write.' }, { type: 'tool.called', value: 'run_command' },
    ] }]) });
  const evaluation = await rpc('evaluations/create', { evalsetId: evalset.id, target: buildId });
  const completed = await waitFor(async () => { const run = await rpc('evaluations/get', { runId: evaluation.id }); return run.completedAt && run; });
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(completed.summary.passed, 1); assert.equal(completed.caseResults[0].toolCalls.length, 1);
  for (const kind of ['schedule', 'evaluation']) await assert.rejects(readFile(join(root, 'workspace', `automation-${kind}.txt`)), { code: 'ENOENT' });
  const proof = { agentId, buildId, scheduleSessionId: occurrence.sessionId, evaluationSessionId: completed.caseResults[0].sessionId };
  await writeFile(join(root, 'automation-proof.json'), JSON.stringify(proof, null, 2));
  return proof;
}

export function verifyAutomationLedger({ store, scope, proof, calls, events }) {
  assert.deepEqual(calls.map(call => call.denied), [false, true, false, true]);
  const asked = events.filter(event => event.type === 'approval/asked'), decided = events.filter(event => event.type === 'approval/decided');
  assert.equal(asked.length, 2); assert.equal(decided.length, 2);
  for (const request of asked) {
    assert.equal(request.data.toolName, 'run_command'); assert.match(request.data.callId, /^ak-native-/);
    assert.deepEqual(decided.filter(event => event.data.id === request.data.id).map(event => event.data.outcome), ['rejected']);
  }
  for (const [sessionId, frozen] of [[proof.scheduleSessionId, false], [proof.evaluationSessionId, true]]) {
    const runs = store.list(scope, sessionId); assert.equal(runs.length, 1);
    const record = store.load(scope, runs[0].runId);
    assert.equal(record.configuration.instructions.includes(frozen ? 'FROZEN_NATIVE_SYSTEM_A' : 'LATEST_NATIVE_SYSTEM_B'), true);
    assert.equal(record.configuration.instructions.includes(frozen ? 'LATEST_NATIVE_SYSTEM_B' : 'FROZEN_NATIVE_SYSTEM_A'), false);
    if (frozen) assert.equal(record.snapshot.buildId, proof.buildId);
    else assert.notEqual(record.snapshot.buildId, proof.buildId);
    const results = record.receipts.flatMap(receipt => receipt.result.results ?? []);
    assert.equal(results.length, 1); assert.equal(results[0].status, 'error');
    assert.equal(results[0].content.code, 'STUDIO_NATIVE_PERMISSION_DENIED'); assert.equal(results[0].content.executed, false);
    assert.equal(record.snapshot.backgroundCommands.length, 0);
  }
}
