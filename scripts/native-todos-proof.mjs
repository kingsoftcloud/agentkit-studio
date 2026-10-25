/** Packed Studio, maintained standard Host and SDK; real Session/projection persistence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';

export function createTodosProof() {
  const pending = [{ content: 'Inspect task state', status: 'in_progress', priority: 'high' },
    { content: 'Report progress', status: 'pending', priority: 'low' }];
  const completed = pending.map(todo => ({ ...todo, status: 'completed' }));
  const rows = async filename => (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length, names = body.tools.map(tool => tool.function.name);
    assert.ok(count <= 7); assert.ok(names.includes('ToolSearch'));
    if (count < 5) assert.equal(names.includes('TodoWrite'), false, 'Todo schemas are loaded on demand');
    else {
      assert.ok(names.includes('TodoWrite')); assert.ok(names.includes('TodoRead'));
      const revision = count === 7 ? 2 : 1;
      assert.ok(body.messages.some(message => typeof message.content === 'string' && message.content.includes(`"todoRevision":${revision}`)));
    }
    if ([4, 6].includes(count)) assert.deepEqual(JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content).todos, pending);
    if (count === 7) assert.deepEqual(JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content).todos, completed);
    const call = count === 1 ? { name: 'ToolSearch', arguments: { query: 'select:TodoRead,TodoWrite' } }
      : count === 2 ? { name: 'DeferredToolCall', arguments: { name: 'TodoWrite', input: { todos: pending } } }
      : count === 3 ? { name: 'DeferredToolCall', arguments: { name: 'TodoRead', input: {} } }
      : count === 5 ? { name: 'TodoRead', arguments: {} }
      : count === 6 ? { name: 'TodoWrite', arguments: { todos: completed } } : null;
    const delta = call ? { tool_calls: [{ index: 0, id: `todos-${count}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: count === 4 ? 'Task list saved.' : 'Tasks completed.' };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `todos-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures }) {
    let harness = initial;
    try {
      const first = await harness.session('native-studio-session').run('Track two tasks in the session task list and report completion.');
      await writeFile(join(root, 'todos-first-turn.json'), JSON.stringify(first, null, 2));
      assert.equal(first.finalResponse, 'Task list saved.', JSON.stringify(first));
      await harness.close(); harness = new DeepSeekHarness(options);
      const session = await harness.resumeSession('native-studio-session');
      const second = await session.run('Read the saved task list, mark both tasks completed, and report completion.');
      await writeFile(join(root, 'todos-second-turn.json'), JSON.stringify(second, null, 2));
      assert.equal(second.finalResponse, 'Tasks completed.', JSON.stringify(second));
    } finally { await harness.close(); }
    assert.deepEqual(failures, []); assert.equal(requests.length, 7);
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const records = store.list(scope, 'native-studio-session').map(run => store.load(scope, run.runId));
      assert.equal(records.length, 2);
      for (const record of records) {
        assert.equal(record.configuration.todoPolicy, 'session-todos/v1'); assert.equal(record.snapshot.phase, 'completed');
        assert.equal(record.configuration.toolDiscoveryPolicy, 'local-tool-search/v1');
      }
      assert.deepEqual(records.find(record => record.snapshot.todos.revision === 1).snapshot.todos.items, pending);
      assert.deepEqual(records.find(record => record.snapshot.todos.revision === 2).snapshot.todos.items, completed);
      assert.equal(records.flatMap(record => record.events).filter(event => event.kind === 'todo.initialized').length, 1);
      assert.equal(records.flatMap(record => record.events).filter(event => event.kind === 'todo.updated').length, 2);
    } finally { store.close(); }
    const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith('.jsonl'));
    const events = (await Promise.all(paths.map(path => rows(join(sessions, path))))).flat();
    const writes = events.filter(event => event.type === 'todo/write');
    assert.deepEqual(writes.map(event => event.data.todos), [pending, pending, completed]);
    assert.equal(new Set(writes.map(event => event.data.nativeId)).size, 3);
    const projections = await rows(join(root, 'todos-projections.jsonl'));
    assert.equal(projections.length, 2); assert.equal(new Set(projections.map(row => row.hostPid)).size, 2);
    const visible = todos => todos.map(({ content, status }) => ({ content, status }));
    assert.deepEqual(projections.map(row => visible(row.todos)), [visible(pending), visible(completed)]);
    await writeFile(join(root, 'todos-proof.json'), JSON.stringify({ passed: true, modelRequests: requests.length,
      hostPids: projections.map(row => row.hostPid), sessionWrites: writes.length,
      scope: 'Packed Studio + standard maintained Host + SDK; default Todo discovery, real priority-preserving kernel receipts, Session todos projection, cold Host next-turn inheritance. Controlled model; no quality or performance claim.' }, null, 2));
    console.log('Studio Native Todo PASS: default discovery, durable priorities, actual Session todos projection, cold Host inheritance.');
  }
  return { respond, run };
}
