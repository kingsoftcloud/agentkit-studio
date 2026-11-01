import { createRequire } from 'node:module';
/** Actual authenticated Studio controls, same Session, cold Native continuation. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

const tasks = [{ content: 'Kept branch task', status: 'in_progress', priority: 'high' }];
export function createConversationRewindProof({ active = false } = {}) {
  const activeRequest = Promise.withResolvers();
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= (active ? 15 : 13), 'No source write replay or extra rewind summary');
    const text = JSON.stringify(body.messages);
    assert.doesNotMatch(text, /nativeWorkspaceReads|native-workspace-read-observation/);
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
    if (active && count === 14) {
      assert.match(text, /Active discarded input/);
      // An actual HTTP model request remains open until the original Native
      // executor cancels it. No substitute driver or successful model reply.
      activeRequest.resolve(); return;
    }
    if (active && count === 15) {
      assert.match(text, /Root input/); assert.match(text, /Follow-up answer/);
      assert.doesNotMatch(text, /Active discarded input/);
    }
    const lastTool = () => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
    if (count === 7) {
      assert.equal(lastTool().ok, false); assert.equal(lastTool().error_type, 'file_not_read');
      const edits = body.messages.filter(message => message.role === 'tool').slice(-4).map(message => JSON.parse(message.content));
      assert.equal(edits[0].ok, true, 'Kept successful Write restores its own known bytes');
      assert.equal(edits[1].ok, true, 'Kept full Read permits editing without another Read');
      assert.equal(edits[2].ok, false); assert.equal(edits[2].error_type, 'file_modified_since_read', 'A removed newer Read cannot replace retained freshness');
    }
    if (count === 9 || count === 13) {
      assert.equal(lastTool().ok, true); assert.equal(lastTool().replacements, 1);
    }
    if (count === 11) assert.match(body.messages.filter(message => message.role === 'tool').at(-1).content, /New branch bytes/);
    const edit = content => ({ name: 'edit_workspace_file', arguments: { path: 'rewind.txt', old_text: content === 'Final bytes' ? 'New branch bytes' : 'Original bytes', new_text: content } });
    const read = { name: 'read_workspace_file', arguments: { path: 'rewind.txt' } };
    const otherEdit = (path, old_text, new_text) => ({ name: 'edit_workspace_file', arguments: { path, old_text, new_text } });
    const calls = ({ 1: [{ name: 'ToolSearch', arguments: { query: 'select:TodoRead,TodoWrite' } },
      { name: 'write_workspace_file', arguments: { path: 'kept-write.txt', content: 'Kept original' } },
      { name: 'read_workspace_file', arguments: { path: 'retained.txt' } },
      { name: 'read_workspace_file', arguments: { path: 'stale.txt' } }],
      2: [{ name: 'DeferredToolCall', arguments: { name: 'TodoWrite', input: { todos: tasks } } }],
      4: [{ name: 'write_workspace_file', arguments: { path: 'rewind.txt', content: 'Original bytes' } },
        { name: 'read_workspace_file', arguments: { path: 'stale.txt' } }],
      6: [otherEdit('kept-write.txt', 'Kept original', 'Kept edited'), otherEdit('retained.txt', 'Retained original', 'Retained edited'),
        otherEdit('stale.txt', 'Stale changed', 'Wrong'), edit('New branch bytes')],
      7: [read], 8: [edit('New branch bytes')], 10: [read], 12: [edit('Final bytes')] })[count] ?? [];
    const answers = { 3: 'Kept first answer', 5: 'Discard second answer', 9: 'Replacement answer', 11: 'Root answer', 13: 'Follow-up answer', 15: 'After active rewind answer' };
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `rewind-${count}-${index}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { content: answers[count] };
    assert.ok(calls.length || delta.content);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `rewind-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = initial; const sessionId = 'native-studio-session';
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
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
      await mkdir(join(root, 'workspace'), { recursive: true });
      await writeFile(join(root, 'workspace/retained.txt'), 'Retained original');
      await writeFile(join(root, 'workspace/stale.txt'), 'Stale original');
      const first = await harness.session(sessionId).run('Kept first input'); assert.equal(first.finalResponse, 'Kept first answer');
      const owner = first.events.find(event => event.type === 'turn/owner'); const admission = parseNativeJson(owner.data.binding);
      const scope = admission.identity.scope, identity = { agentId: scope.agentId, sessionId }, firstRecord = load(scope);
      await writeFile(join(root, 'workspace/stale.txt'), 'Stale changed');
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
      assert.equal(await readFile(join(root, 'workspace/kept-write.txt'), 'utf8'), 'Kept edited');
      assert.equal(await readFile(join(root, 'workspace/retained.txt'), 'utf8'), 'Retained edited');
      assert.equal(await readFile(join(root, 'workspace/stale.txt'), 'utf8'), 'Stale changed');
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
      let canceledRunId = null, continuedRunId = null;
      if (active) {
        const running = harness.session(sessionId).run('Active discarded input');
        // Keep both fulfillment and rejection observed while the HTTP control
        // waits for the same actual Agent to close its owned turn.
        const ended = running.then(value => ({ value }), error => ({ error: String(error) }));
        await Promise.race([activeRequest.promise, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Error('Active model did not start')), 15000); timer.unref();
          activeRequest.promise.finally(() => clearTimeout(timer));
        })]);
        const live = await rpc('sessions/native-conversation-status', identity);
        assert.equal(live.ok, true, JSON.stringify(live)); assert.equal(live.value.canRewind, true); assert.equal(live.value.requiresStop, true);
        canceledRunId = live.value.headRunId;
        const activeCommand = { ...identity, expectedHeadRunId: canceledRunId, expectedGeneration: live.value.generation,
          targetMessageId: live.value.inputs.find(input => input.text === 'Active discarded input')?.messageId,
          commandId: 'actual-rewind-active-model' };
        assert.ok(activeCommand.targetMessageId);
        const cut = await rpc('sessions/native-conversation-rewind', activeCommand); assert.equal(cut.ok, true, JSON.stringify(cut));
        assert.equal(cut.value.generation, 3);
        const closure = await ended; assert.equal(closure.error, undefined, JSON.stringify(closure));
        assert.ok(closure.value.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
        const canceled = load(scope, canceledRunId);
        assert.equal(canceled.snapshot.phase, 'canceled');
        assert.ok(canceled.commands.some(row => row.consumed && row.command.kind === 'cancel'
          && row.command.payload.nativeConversationRewindRequestDigest));
        assert.equal(canceled.receipts.at(-1).status, 'uncertain', 'Unknown model usage is preserved, never forged committed');
        assert.deepEqual(await rpc('sessions/native-conversation-rewind', activeCommand), cut);
        await harness.close(); harness = new DeepSeekHarness(options);
        const continued = await (await harness.resumeSession(sessionId)).run('After active rewind input');
        answer(continued, 'After active rewind answer');
        const record = load(scope); continuedRunId = record.snapshot.runId;
        assert.equal(record.snapshot.parentRunId, canceledRunId); assert.equal(record.snapshot.conversationBranch.generation, 3);
        assert.deepEqual(load(scope, canceledRunId), canceled, 'Cold continuation leaves canceled ledger immutable');
      }
      assert.deepEqual(load(scope, firstRecord.snapshot.runId), firstRecord); assert.deepEqual(load(scope, secondRecord.snapshot.runId), secondRecord);
      assert.deepEqual(load(scope, replaced.snapshot.runId), replaced); assert.deepEqual(failures, []); assert.equal(requests.length, active ? 15 : 13);
      const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const hostPids = [...new Set(probes.map(row => row.hostPid))]; assert.equal(hostPids.length, active ? 5 : 4);
      await writeFile(join(root, 'conversation-rewind-proof.json'), JSON.stringify({ passed: true, hostPids, modelCalls: requests.length,
        firstRunId: firstRecord.snapshot.runId, removedRunId: secondRecord.snapshot.runId, replacementRunId: replaced.snapshot.runId,
        rootRunId: rooted.snapshot.runId, followRunId: follow.snapshot.runId, canceledRunId, continuedRunId,
        scope: 'Actual authenticated Studio routes + same SDK Session, idle rewind, cold replacement/root/follow-up, retained Read/Write state, stale/removed read refusal, immutable source Runs.'
          + (active ? ' Also actual in-flight HTTP model cancellation before branch commit and cold continuation. No active side-effect/child/background cleanup claim.' : '')
          + ' Controlled model; full historical selection remains separate.' }, null, 2));
      console.log('Studio Native conversation rewind PASS: authenticated same-Session branch cut, retained Read/Write hydration, removed/stale read refusal, repeated root rewind, cold continuation, no source replay.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
