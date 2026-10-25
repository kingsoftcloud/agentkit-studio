/** Actual packed Studio + standard Host + SDK and production SessionController forks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';

const tasks = [{ content: 'Preserve the chosen branch', status: 'in_progress', priority: 'high' }];
export function createConversationForkProof() {
  const callIds = [];
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 12, 'No extra source replay or fork-summary model');
    const texts = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    const historicalCalls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
    if (count >= 5 && count <= 8) {
      assert.match(texts, /Source first answer/); assert.match(texts, /First branch input/);
      assert.doesNotMatch(texts, /Future branch input|Source future answer/);
      assert.match(texts, /"todoRevision":1/);
      assert.ok(body.tools.some(tool => tool.function.name === 'TodoRead'), 'Source discovered schema is promoted in child');
      const write = historicalCalls.find(call => call.function.name === 'write_workspace_file'); assert.ok(write);
      assert.match(write.id, /^hist_/); callIds.push(write.id);
      assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === write.id));
    }
    const calls = count === 1 ? [{ name: 'ToolSearch', arguments: { query: 'select:TodoRead,TodoWrite' } },
      { name: 'write_workspace_file', arguments: { path: 'fork-source.txt', content: 'Original source bytes' } }]
      : count === 2 ? [{ name: 'DeferredToolCall', arguments: { name: 'TodoWrite', input: { todos: tasks } } }]
      : count === 5 ? [{ name: 'TodoRead', arguments: {} }] : [];
    if (count === 6) assert.deepEqual(JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content).todos, tasks);
    if (count >= 7 && count <= 8) assert.match(texts, /Child first answer/);
    if (count === 8) assert.doesNotMatch(texts, /Child second input|Child second answer/);
    if (count >= 9) {
      assert.doesNotMatch(texts, /Future branch input|Source future answer|Source first answer|Child first answer|Preserve the chosen branch/);
      if (count === 9) {
        assert.doesNotMatch(texts, /First branch input/); assert.equal(historicalCalls.length, 0);
      } else assert.match(texts, /First branch input/);
      if (count <= 10) assert.equal(historicalCalls.length, 0);
      if (count >= 11) {
        const write = historicalCalls.find(call => call.function.name === 'write_workspace_file'); assert.ok(write);
        const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === write.id); assert.ok(result);
        if (count === 11) {
          assert.equal(JSON.parse(result.content).executionStatus, 'unknown');
          assert.doesNotMatch(result.content, /absolute_path/);
        } else assert.match(result.content, /absolute_path/);
      }
      assert.equal(body.tools.some(tool => tool.function.name === 'TodoRead'), count === 12,
        'Only ToolSearch results before the selected cut may promote schemas');
    }
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `fork-call-${count}-${index}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
      : { content: ({ 3: 'Source first answer', 4: 'Source future answer', 6: 'Child first answer', 7: 'Child second answer', 8: 'Nested child answer',
        9: 'Root branch answer', 10: 'Input branch answer', 11: 'Pending branch answer', 12: 'Settled branch answer' })[count] };
    assert.ok(calls.length || delta.content);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `fork-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = initial;
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const { id: agentId } = await (async () => {
      // Identity is written by the actual Host fixture during first startup.
      await harness.start(); return JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    })();
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const load = sessionId => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    const fork = async (id, payload) => {
      const file = join(root, 'conversation-fork-command.json');
      await writeFile(file + '.tmp', JSON.stringify({ id, payload })); await rename(file + '.tmp', file);
      const result = join(root, `conversation-fork-${id}.json`), deadline = Date.now() + 20000;
      while (!existsSync(result) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(existsSync(result), 'Actual SessionController fork did not answer');
      const value = JSON.parse(await readFile(result, 'utf8')); assert.equal(value.ok, true, JSON.stringify(value)); return value;
    };
    try {
      const sourceId = 'native-studio-session', first = await harness.session(sourceId).run('First branch input');
      assert.equal(first.finalResponse, 'Source first answer');
      const firstRun = load(sourceId), boundary = first.events.findLast(event => event.type === 'turn/end').seq;
      assert.equal(firstRun.snapshot.todos.items[0].priority, 'high');
      assert.equal((await harness.session(sourceId).run('Future branch input')).finalResponse, 'Source future answer');
      const sourceAfter = load(sourceId);
      const child = await fork('first', { sessionId: sourceId, atSeq: boundary });
      // SessionController and the SDK each own their Agent handles. Exercise
      // durable fork publication and a real cold first use instead of opening
      // a second write handle over the controller's live child.
      await harness.close(); harness = new DeepSeekHarness(options);
      const childFirst = await (await harness.resumeSession(child.sessionId)).run('Child first input');
      assert.equal(childFirst.finalResponse, 'Child first answer', JSON.stringify(childFirst));
      const childRun = load(child.sessionId), childBoundary = childFirst.events.findLast(event => event.type === 'turn/end').seq;
      assert.equal(childRun.snapshot.parentRunId, null); assert.equal(childRun.configuration.conversationSeed.source.runId, firstRun.snapshot.runId);
      assert.equal(childRun.configuration.conversationSeed.source.boundarySeq, boundary);
      assert.deepEqual(childRun.snapshot.todos.items, tasks); assert.equal(childRun.snapshot.usage.toolCalls, 1);
      assert.deepEqual(childRun.intents.filter(row => row.kind === 'tool').flatMap(row => row.payload.calls.map(call => call.name)), ['TodoRead']);
      assert.deepEqual(childRun.snapshot.children, []); assert.deepEqual(childRun.snapshot.backgroundCommands, []);
      assert.deepEqual(childRun.snapshot.workspaceModifiedPaths, []); assert.deepEqual(childRun.snapshot.artifactRefs, []);
      assert.equal(canonical(load(sourceId)), canonical(sourceAfter));
      await harness.close(); harness = new DeepSeekHarness(options);
      const resumed = await harness.resumeSession(child.sessionId);
      assert.equal((await resumed.run('Child second input')).finalResponse, 'Child second answer');
      const childSecond = load(child.sessionId);
      assert.equal(childSecond.configuration.conversationSeed, undefined);
      assert.equal(childSecond.snapshot.parentRunId, childRun.snapshot.runId);
      const nested = await fork('nested', { sessionId: child.sessionId, atSeq: childBoundary });
      await harness.close(); harness = new DeepSeekHarness(options);
      assert.equal((await (await harness.resumeSession(nested.sessionId)).run('Nested child input')).finalResponse, 'Nested child answer');
      const nestedRun = load(nested.sessionId);
      assert.equal(nestedRun.configuration.conversationSeed.source.runId, childRun.snapshot.runId);
      assert.equal(nestedRun.snapshot.parentRunId, null); assert.equal(nestedRun.snapshot.usage.toolCalls, 0);
      assert.equal(callIds.length, 4); assert.equal(callIds[0], callIds[1]); assert.equal(callIds[0], callIds[2]);
      assert.notEqual(callIds[0], callIds[3], 'Fork-of-fork allocates new child protocol IDs');
      const admittedInput = first.events.find(event => event.type === 'user/message'
        && event.data.content.some(part => part.type === 'text' && part.text === 'First branch input'));
      const assistantCall = first.events.find(event => event.type === 'assistant/message'
        && event.data.message.content.some(part => part.type === 'tool-call' && part.name === 'write_workspace_file'));
      const writeCall = assistantCall.data.message.content.find(part => part.type === 'tool-call' && part.name === 'write_workspace_file');
      const writeResult = first.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === writeCall.id);
      assert.ok(admittedInput && writeResult);
      const partialRuns = [];
      for (const [name, atSeq, answer] of [['root', admittedInput.seq - 1, 'Root branch answer'],
        ['input', admittedInput.seq, 'Input branch answer'], ['pending', assistantCall.seq, 'Pending branch answer'],
        ['settled', writeResult.seq, 'Settled branch answer']]) {
        const branch = await fork(name, { sessionId: sourceId, atSeq });
        await harness.close(); harness = new DeepSeekHarness(options);
        assert.equal((await (await harness.resumeSession(branch.sessionId)).run(`Continue ${name} boundary`)).finalResponse, answer);
        const record = load(branch.sessionId); partialRuns.push({ boundary: name, atSeq, runId: record.snapshot.runId });
        assert.equal(record.configuration.conversationSeed.source.runId, firstRun.snapshot.runId);
        assert.equal(record.configuration.conversationSeed.source.boundarySeq, atSeq);
        assert.equal(record.snapshot.parentRunId, null); assert.equal(record.snapshot.usage.modelCalls, 1);
        assert.equal(record.snapshot.usage.toolCalls, 0); assert.deepEqual(record.snapshot.todos.items, []);
        assert.equal(record.intents.some(intent => intent.kind === 'tool'), false);
        assert.deepEqual(record.snapshot.workspaceModifiedPaths, []); assert.deepEqual(record.snapshot.children, []);
      }
      assert.equal(await readFile(join(root, 'workspace/fork-source.txt'), 'utf8'), 'Original source bytes');
      assert.equal(canonical(load(sourceId)), canonical(sourceAfter)); assert.equal(canonical(load(child.sessionId)), canonical(childSecond));
      assert.deepEqual(failures, []); assert.equal(requests.length, 12);
      const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const hostPids = [...new Set(probes.map(row => row.hostPid))];
      assert.equal(hostPids.length, 8, 'Every child first use and the continuation run in distinct cold Hosts');
      await writeFile(join(root, 'conversation-fork-proof.json'), JSON.stringify({ passed: true, sourceRunId: firstRun.snapshot.runId,
        laterSourceRunId: sourceAfter.snapshot.runId, childRunId: childRun.snapshot.runId, nestedRunId: nestedRun.snapshot.runId,
        modelCalls: requests.length, hostPids, partialRuns, preservedTodoPriority: 'high',
        scope: 'Packed Studio, actual standard Host/SDK/SessionController; closed-turn and before-input/root, admitted input, pending-call and settled-result cuts after source advanced; fresh Native Runs, paired tools, cutoff-local Todo/discovery, cold continuation/fork-of-fork. Controlled model; in-place rewind/historical model selection remain separate.' }, null, 2));
      console.log('Studio Native conversation fork PASS: exact old and in-turn boundaries, root/input/pending/settled cuts, fresh Run/budget, cutoff-local Todo/discovery, cold continuation and fork-of-fork without source effect replay.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
