/** Actual Host, two real local background commands, selective cut and cold control. */
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

export function createConversationCommandRewindProof() {
  let keptTask, removedTask;
  const command = `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`;
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 8, 'No canceled-task notice or launch replay may invoke the model');
    const last = () => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
    if (count === 2 || count === 4) {
      const output = last(); assert.equal(output.ok, true, JSON.stringify(output)); assert.match(output.task_id, /^[a-f0-9]{64}$/);
      if (count === 2) keptTask = output.task_id; else removedTask = output.task_id;
    }
    if (count >= 5) {
      const text = JSON.stringify(body.messages);
      assert.match(text, /Keep background command/); assert.doesNotMatch(text, /Remove background command|Removed command running/);
      assert.equal(text.includes(removedTask), false, 'Private cleanup metadata is not model context');
      assert.equal(text.includes(keptTask), true);
    }
    if (count === 6) assert.equal(last().status, 'running', 'Kept task is still alive after cold rewind');
    if (count === 8) assert.equal(last().status, 'canceled', 'Original kept task can still be stopped and observed');
    const calls = count === 1 || count === 3 ? [{ name: 'run_command', arguments: { command, background: true } }]
      : count === 5 || count === 7 ? [{ name: 'read_command_output', arguments: { task_id: keptTask, wait_seconds: count === 7 ? 3 : 0 } }]
        : count === 6 ? [{ name: 'stop_command', arguments: { task_id: keptTask } }] : [];
    const answers = { 2: 'Kept command running', 4: 'Removed command running', 8: 'Kept command controlled after rewind' };
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `command-cut-${count}-${index}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { content: answers[count] };
    assert.ok(calls.length || delta.content);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `command-cut-${count}`, choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = initial, commandStore; const sessionId = 'native-studio-session';
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const { LocalCommandStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/local-background.mjs')).href);
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    const rpc = async (method, payload) => {
      const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
      const result = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
      assert.equal(result.status, 200); const value = (await result.json()).result; assert.equal(value.ok, true, JSON.stringify(value)); return value.value;
    };
    try {
      const first = await harness.session(sessionId).run('Keep background command'); assert.equal(first.finalResponse, 'Kept command running');
      const scope = parseNativeJson(first.events.find(event => event.type === 'turn/owner').data.binding).identity.scope;
      const identity = { agentId: scope.agentId, sessionId }, kept = load(scope);
      const privateRoot = await realpath(root);
      commandStore = new LocalCommandStore({ workspaceRoot: join(privateRoot, 'workspace'), sessionId,
        stateRoot: join(privateRoot, 'studio/native-harness/workspace-state', createHash('sha256').update(scope.agentId).digest('hex'), 'background-commands') });
      const second = await harness.session(sessionId).run('Remove background command'); assert.equal(second.finalResponse, 'Removed command running');
      const removed = load(scope), status = await rpc('sessions/native-conversation-status', identity);
      assert.equal(status.canRewind, true); assert.equal(status.requiresStop, true);
      assert.equal(commandStore.connect(keptTask).readOutput().status, 'running'); assert.equal(commandStore.connect(removedTask).readOutput().status, 'running');
      const cutRequest = { ...identity, expectedHeadRunId: status.headRunId, expectedGeneration: status.generation, commandId: 'actual-selective-command-cut',
        targetMessageId: status.inputs.find(input => input.text === 'Remove background command').messageId };
      const cut = await rpc('sessions/native-conversation-rewind', cutRequest); assert.equal(cut.generation, 1);
      assert.equal(commandStore.connect(keptTask).readOutput().status, 'running'); assert.equal(commandStore.connect(removedTask).readOutput().status, 'canceled');
      assert.deepEqual(load(scope, kept.snapshot.runId), kept); assert.deepEqual(load(scope, removed.snapshot.runId), removed);
      assert.deepEqual(await rpc('sessions/native-conversation-rewind', cutRequest), cut);
      await harness.close(); harness = new DeepSeekHarness(options);
      const continued = await (await harness.resumeSession(sessionId)).run('Control retained command');
      assert.equal(continued.finalResponse, 'Kept command controlled after rewind');
      const rebased = load(scope); assert.equal(rebased.snapshot.conversationBranch.generation, 1);
      assert.deepEqual(rebased.configuration.conversationRewind.retainedBackgroundCommands, kept.snapshot.backgroundCommands);
      assert.ok(rebased.snapshot.backgroundCommands.every(row => row.ref.taskId === keptTask));
      assert.deepEqual(load(scope, removed.snapshot.runId), removed); assert.equal(requests.length, 8); assert.deepEqual(failures, []);
      await writeFile(join(root, 'conversation-command-rewind-proof.json'), JSON.stringify({ passed: true, modelCalls: requests.length,
        keptTask, removedTask, sourceRunId: kept.snapshot.runId, removedRunId: removed.snapshot.runId, continuedRunId: rebased.snapshot.runId,
        scope: 'Two actual local background processes through packed Studio tools; authenticated selective rewind; kept task running across Host restart and controlled through original task locator; removed task confirmed canceled; source ledgers immutable. Controlled model, local backend only.' }, null, 2));
      console.log('Studio Native command rewind PASS: removed process stopped, kept process retained and controlled after cold continuation.');
    } finally {
      await harness.close();
      if (commandStore) for (const taskId of [keptTask, removedTask].filter(Boolean)) {
        const handle = commandStore.connect(taskId); handle.requestCancel(); await handle.wait({ timeoutMs: 5000 }).catch(() => {});
      }
    }
  }
  return { respond, run };
}
