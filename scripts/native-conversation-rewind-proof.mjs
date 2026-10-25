/** Actual authenticated Studio controls, same Session, cold Native continuation. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

const tasks = [{ content: 'Kept branch task', status: 'in_progress', priority: 'high' }];
export function createConversationRewindProof() {
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 13, 'No source write replay or extra rewind summary');
    const text = JSON.stringify(body.messages);
    if (count >= 6 && count <= 9) {
      assert.match(text, /Kept first input/);
      assert.match(text, /Kept first answer/);
      assert.doesNotMatch(text, /Discard second input|Discard second answer/);
      assert.ok(body.tools.some(tool => tool.function.name === 'TodoRead'));
    }
    if (count >= 10) {
      assert.doesNotMatch(text, /Kept first input|Kept first answer|Discard second input|Discard second answer|Replacement input|Replacement answer|Kept branch task/);
      assert.equal(body.tools.some(tool => tool.function.name === 'TodoRead'), false);
    }
    const lastTool = () => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
    if (count === 7) {
      assert.equal(lastTool().ok, false); assert.equal(lastTool().error_type, 'file_not_read');
    }
    if (count === 9 || count === 13) {
      assert.equal(lastTool().ok, true); assert.equal(lastTool().replacements, 1);
    }
    if (count === 11) assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content, /New branch bytes/);
    const edit = content => ({ name: 'edit_workspace_file', arguments: { path: 'rewind.txt', old_text: content === 'Final bytes' ? 'New branch bytes' : 'Original bytes', new_text: content } });
    const read = { name: 'read_workspace_file', arguments: { path: 'rewind.txt' } };
    const calls = ({ 1: [{ name: 'ToolSearch', arguments: { query: 'select:TodoRead,TodoWrite' } },
      { name: 'write_workspace_file', arguments: { path: 'rewind.txt', content: 'Original bytes' } }],
      2: [{ name: 'DeferredToolCall', arguments: { name: 'TodoWrite', input: { todos: tasks } } }],
      4: [read], 6: [edit('New branch bytes')], 7: [read], 8: [edit('New branch bytes')], 10: [read], 12: [edit('Final bytes')] })[count] ?? [];
    const answers = { 3: 'Kept first answer', 5: 'Discard second answer', 9: 'Replacement answer', 11: 'Root answer', 13: 'Follow-up answer' };
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `rewind-${count}-${index}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { content: answers[count] };
    assert.ok(calls.length || delta.content);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `rewind-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = initial; const sessionId = 'native-studio-session';
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    const rpc = async (method, payload, authenticated = true) => {
      const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
      const result = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
        body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
      if (!authenticated) { await result.text(); return result.status; }
      assert.equal(result.status, 200); return (await result.json()).result;
    };
    const ownInput = (events, text) => events.find(event => event.type === 'user/message'
      && event.data.content.some(part => part.type === 'text' && part.text === text)).data.id;
    const answer = (result, expected) => {
      assert.deepEqual(failures.map(error => error.message), [], 'Controlled model assertions failed');
      assert.equal(result.finalResponse, expected, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
    };
    try {
      const first = await harness.session(sessionId).run('Kept first input'); assert.equal(first.finalResponse, 'Kept first answer');
      const owner = first.events.find(event => event.type === 'turn/owner'); const admission = parseNativeJson(owner.data.binding);
      const scope = admission.identity.scope, identity = { agentId: scope.agentId, sessionId }, firstRecord = load(scope);
      const second = await harness.session(sessionId).run('Discard second input'); assert.equal(second.finalResponse, 'Discard second answer');
      const secondRecord = load(scope);
      const status = await rpc('sessions/native-conversation-status', identity);
      assert.equal(status.ok, true, JSON.stringify(status)); assert.equal(status.value.canRewind, true, JSON.stringify(status));
      const command = { ...identity, expectedHeadRunId: status.value.headRunId, expectedGeneration: status.value.generation,
        targetMessageId: ownInput(second.events, 'Discard second input'), commandId: 'actual-rewind-second-input' };
      assert.equal(await rpc('sessions/native-conversation-rewind', command, false), 401);
      const applied = await rpc('sessions/native-conversation-rewind', command); assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.value.generation, 1);
      assert.deepEqual(await rpc('sessions/native-conversation-rewind', command), applied, 'Lost response retries the same accepted operation');
      assert.equal((await rpc('sessions/native-conversation-rewind', { ...command, targetMessageId: ownInput(first.events, 'Kept first input') })).ok, false);
      assert.deepEqual(load(scope, firstRecord.snapshot.runId), firstRecord); assert.deepEqual(load(scope, secondRecord.snapshot.runId), secondRecord);
      await harness.close(); harness = new DeepSeekHarness(options);
      const replacement = await (await harness.resumeSession(sessionId)).run('Replacement input');
      answer(replacement, 'Replacement answer');
      const replaced = load(scope); assert.equal(replaced.snapshot.parentRunId, secondRecord.snapshot.runId);
      assert.equal(replaced.snapshot.conversationBranch.generation, 1); assert.deepEqual(replaced.snapshot.todos.items, tasks);
      assert.equal(await readFile(join(root, 'workspace/rewind.txt'), 'utf8'), 'New branch bytes');
      const active = await rpc('sessions/native-conversation-status', identity); assert.equal(active.ok, true, JSON.stringify(active));
      assert.deepEqual(active.value.inputs.map(input => input.messageId), [ownInput(first.events, 'Kept first input'), ownInput(replacement.events, 'Replacement input')]);
      assert.equal((await rpc('sessions/native-conversation-rewind', { ...identity, expectedHeadRunId: replaced.snapshot.runId, expectedGeneration: 1,
        targetMessageId: command.targetMessageId, commandId: 'removed-target' })).ok, false);
      const rootCommand = { ...identity, expectedHeadRunId: replaced.snapshot.runId, expectedGeneration: 1,
        targetMessageId: ownInput(first.events, 'Kept first input'), commandId: 'actual-rewind-root' };
      const rootResult = await rpc('sessions/native-conversation-rewind', rootCommand); assert.equal(rootResult.ok, true, JSON.stringify(rootResult));
      assert.equal(rootResult.value.generation, 2);
      await harness.close(); harness = new DeepSeekHarness(options);
      assert.equal((await (await harness.resumeSession(sessionId)).run('Root input')).finalResponse, 'Root answer');
      const rooted = load(scope); assert.equal(rooted.snapshot.conversationBranch.generation, 2); assert.deepEqual(rooted.snapshot.todos.items, []);
      await harness.close(); harness = new DeepSeekHarness(options);
      assert.equal((await (await harness.resumeSession(sessionId)).run('Root follow-up')).finalResponse, 'Follow-up answer');
      const follow = load(scope); assert.equal(follow.configuration.conversationRewind, undefined);
      assert.equal(follow.snapshot.conversationBranch.generation, 2); assert.equal(follow.snapshot.parentRunId, rooted.snapshot.runId);
      assert.equal(await readFile(join(root, 'workspace/rewind.txt'), 'utf8'), 'Final bytes');
      assert.deepEqual(load(scope, firstRecord.snapshot.runId), firstRecord); assert.deepEqual(load(scope, secondRecord.snapshot.runId), secondRecord);
      assert.deepEqual(load(scope, replaced.snapshot.runId), replaced); assert.deepEqual(failures, []); assert.equal(requests.length, 13);
      const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const hostPids = [...new Set(probes.map(row => row.hostPid))]; assert.equal(hostPids.length, 4);
      await writeFile(join(root, 'conversation-rewind-proof.json'), JSON.stringify({ passed: true, hostPids, modelCalls: requests.length,
        firstRunId: firstRecord.snapshot.runId, removedRunId: secondRecord.snapshot.runId, replacementRunId: replaced.snapshot.runId,
        rootRunId: rooted.snapshot.runId, followRunId: follow.snapshot.runId,
        scope: 'Actual authenticated Studio routes + same SDK Session, ordinary idle Native rewind, cold replacement/root/follow-up, no old history or read authority, immutable source Runs. Controlled model; active task cancellation, retained-read hydration and full historical selection remain separate.' }, null, 2));
      console.log('Studio Native conversation rewind PASS: authenticated same-Session branch cut, repeated root rewind, cold history/state reset, guarded read authority, no source replay.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
