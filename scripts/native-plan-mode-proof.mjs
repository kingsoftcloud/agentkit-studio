/** Real packed Studio/standard Host/SDK. Controlled model and human responses. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createPlanModeProof() {
  const plans = ['Inspect and implement.', 'Inspect, implement, and preserve a rollback path.', 'Continue the approved implementation after checking current state.'];
  const tasks = [{ content: 'Prepare implementation and rollback plan', status: 'in_progress', priority: 'high' }];
  const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const wrapped = (name, input) => ({ name: 'DeferredToolCall', arguments: { name, input } });
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 11);
    const state = body.messages.filter(message => typeof message.content === 'string')
      .map(message => { try { return JSON.parse(message.content); } catch { return null; } }).find(value => value?.planMode);
    assert.ok(state, 'Native mode must enter the actually counted request');
    assert.equal(state.planMode.active, [3, 4, 5, 8, 9].includes(count));
    assert.equal(body.messages.some(message => typeof message.content === 'string' && message.content.includes('Do not use TodoWrite')), false,
      'DSH plan guidance must not contradict Native session Todo support');
    if (count === 4) assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('plan_mode_write_denied')));
    if (count === 5) assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('Include rollback steps.')));
    if (count === 8) assert.equal(state.planMode.approvedPlan.plan, plans[1]);
    const calls = count === 1 ? [{ name: 'ToolSearch', arguments: { query: 'select:EnterPlanMode,ExitPlanMode,TodoWrite' } }]
      : count === 2 ? [wrapped('EnterPlanMode', {})]
      : count === 3 ? [{ name: 'write_workspace_file', arguments: { path: 'forbidden.txt', content: 'must not be written' } }, wrapped('TodoWrite', { todos: tasks })]
      : count === 4 ? [wrapped('ExitPlanMode', { plan: plans[0] })]
      : count === 5 ? [wrapped('ExitPlanMode', { plan: plans[1] })]
      : count === 6 ? [{ name: 'write_workspace_file', arguments: { path: 'approved-1.txt', content: 'approved first turn' } }]
      : count === 8 ? [{ name: 'write_workspace_file', arguments: { path: 'forbidden-cold.txt', content: 'must not be written' } }]
      : count === 9 ? [{ name: 'ExitPlanMode', arguments: { plan: plans[2] } }]
      : count === 10 ? [{ name: 'write_workspace_file', arguments: { path: 'approved-2.txt', content: 'approved second turn' } }] : [];
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `plan-${count}-${index}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
      : { content: count === 7 ? 'First plan implemented.' : 'Second plan implemented.' };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `plan-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures }) {
    let harness = initial;
    try {
      const first = await harness.session('native-studio-session').run('Plan and implement the first task after explicit plan approval.');
      await writeFile(join(root, 'plan-first-turn.json'), JSON.stringify(first, null, 2));
      assert.equal(first.finalResponse, 'First plan implemented.', `Native first plan failed: ${first.finalResponse}`);
      await harness.close(); harness = new DeepSeekHarness(options);
      const session = await harness.resumeSession('native-studio-session');
      const second = await session.run('Continue planning and implement the second task after approval.');
      await writeFile(join(root, 'plan-second-turn.json'), JSON.stringify(second, null, 2));
      assert.equal(second.finalResponse, 'Second plan implemented.', `Native second plan failed: ${second.finalResponse}`);
    } finally { await harness.close(); }
    assert.deepEqual(failures, []); assert.equal(requests.length, 11);
    for (const filename of ['forbidden.txt', 'forbidden-cold.txt']) await assert.rejects(access(join(root, 'workspace', filename)), { code: 'ENOENT' });
    for (const turn of [1, 2]) assert.equal(await readFile(join(root, 'workspace', `approved-${turn}.txt`), 'utf8'), `approved ${turn === 1 ? 'first' : 'second'} turn`);
    const reviews = await rows(join(root, 'plan-reviews.jsonl'));
    assert.deepEqual(reviews.map(row => row.question.detail), plans); assert.deepEqual(reviews.map(row => row.approved), [false, true, true]);
    assert.ok(reviews.every(row => row.question.intent.kind === 'plan-review' && row.question.intent.callId.startsWith('ak-native-')));
    const projections = await rows(join(root, 'todos-projections.jsonl'));
    assert.equal(projections.length, 2); assert.ok(projections.every(row => row.plan.active === false));
    assert.equal(new Set(projections.map(row => row.hostPid)).size, 2);
    const admissions = await rows(join(root, 'tool-admissions.jsonl'));
    assert.deepEqual(admissions.map(row => row.name), ['write_workspace_file', 'write_workspace_file']);
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const records = store.list(scope, 'native-studio-session').map(run => store.load(scope, run.runId));
      assert.equal(records.length, 2);
      assert.deepEqual(records.map(record => record.configuration.planModeInitialActive).sort(), [false, true]);
      for (const record of records) {
        assert.equal(record.configuration.planModePolicy, 'session-plan/v1'); assert.equal(record.snapshot.planMode.active, false);
        assert.equal(record.snapshot.phase, 'completed'); assert.ok(plans.slice(1).includes(record.snapshot.planMode.approvedPlan.plan));
      }
    } finally { store.close(); }
    const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith('.jsonl'));
    const events = (await Promise.all(paths.map(path => rows(join(sessions, path))))).flat();
    const modes = events.filter(event => event.type === 'plan/mode' && event.data.nativeId);
    assert.deepEqual(modes.map(event => event.data.active), [false, true, false, true, false]);
    assert.equal(new Set(modes.map(event => event.data.nativeId)).size, modes.length);
    await writeFile(join(root, 'plan-mode-proof.json'), JSON.stringify({ passed: true, modelRequests: requests.length,
      reviews: reviews.length, hostPids: projections.map(row => row.hostPid), approvedWrites: 2,
      scope: 'Packed Studio + standard maintained Host + SDK, actual plan-review service, denied/approved plans, real write restriction/effects, Todo in planning, persisted mode projection, cold Host user re-entry and approved-plan continuity. Controlled model/human; no live quality/performance claim.' }, null, 2));
    console.log('Studio Native Plan PASS: actual review, feedback, mode restrictions, approved writes, cold Host user re-entry.');
  }
  return { respond, run };
}
