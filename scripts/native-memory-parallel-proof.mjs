/** Real shared-preset concurrency, with a deterministic model and human reply. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const first = 'native-studio-session', peer = 'native-studio-peer';
const aGoal = 'Store my coffee preference after approval. PARALLEL_SESSION_A';
const bGoal = '记住：我的项目语言是 TypeScript';
const bRead = 'Read both saved preferences. PARALLEL_SESSION_B_READ';
const coffee = '我的咖啡是flat white', project = '我的项目语言是 TypeScript';
const rows = async filename => (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

export function createParallelMemoryProof() {
  const steps = new Map(), answers = { a: 'Memory session A completed.', b: 'Memory session B completed.', read: 'Both preferences read.' };
  let projectId;
  const call = (id, name, args) => ({ index: id, id: `parallel-${name}-${id}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } });
  const decode = message => JSON.parse(message.content);
  async function respond({ request, response, body, requests, frozen }) {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['read_memory', 'search_memory', 'manage_memory']);
    if (frozen) assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
    const has = text => body.messages.some(message => message.role === 'user' && message.content === text);
    const stage = has(bRead) ? 'read' : has(aGoal) ? 'a' : has(bGoal) ? 'b' : null;
    assert.ok(stage, 'Model request must contain an original proof goal');
    const step = steps.get(stage) ?? 0;
    assert.ok(step < (stage === 'a' ? 3 : 2), `Unexpected ${stage} model repair loop`);
    steps.set(stage, step + 1); requests.push(body);
    let toolCalls;
    if (!step) {
      toolCalls = stage === 'read' ? [call(0, 'read_memory', { memory_id: projectId }), call(1, 'search_memory', { query: '咖啡' })]
        : [call(0, 'manage_memory', { action: 'remember', scope: 'user', content: stage === 'a' ? coffee : project })];
    } else {
      const outputs = body.messages.filter(message => message.role === 'tool').slice(stage === 'read' ? -2 : -1).map(decode);
      if (stage === 'read') {
        assert.equal(outputs[0].record.memoryId, projectId); assert.equal(outputs[0].record.content, project);
        assert.ok(outputs[1].records.some(record => record.content === coffee));
        assert.ok(outputs.every(output => output.trustLevel === 'untrusted'));
      } else if (step === 1) {
        assert.equal(outputs[0].committed, true, JSON.stringify(outputs));
        if (stage === 'b') projectId = outputs[0].memoryId;
        else toolCalls = [call(0, 'search_memory', { query: '咖啡' })];
      } else {
        assert.equal(outputs[0].format, 'ksadk.memory-search/v1');
        assert.ok(outputs[0].records.some(record => record.content === coffee));
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `parallel-memory-${requests.length}`, choices: [{ index: 0,
      delta: toolCalls ? { tool_calls: toolCalls } : { content: answers[stage] }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness, root, installed, sessions, requests, failures, frozen }) {
    const pending = harness.session(first).run(aGoal);
    // Attach rejection handling while a separately admitted Session advances.
    let earlyFailure; pending.catch(error => { earlyFailure = error; });
    let a, b, read;
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        if (earlyFailure) throw earlyFailure;
        try { await readFile(join(root, 'memory-approval-waiting')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        assert.ok(Date.now() < deadline, 'Session A must reach actual ApprovalService before starting B');
        await pause();
      }
      const second = harness.session(peer);
      b = await second.run(bGoal);
      await writeFile(join(root, 'parallel-memory-peer-write.json'), JSON.stringify(b));
      assert.equal(b.finalResponse, answers.b);
      // B reached terminal and released its own provider before A resumes.
      await writeFile(join(root, 'memory-approval-release'), 'allow exact pending A call');
      a = await pending;
      await writeFile(join(root, 'parallel-memory-first.json'), JSON.stringify(a));
      assert.equal(a.finalResponse, answers.a);
      read = await second.run(bRead);
      await writeFile(join(root, 'parallel-memory-peer-read.json'), JSON.stringify(read));
      assert.equal(read.finalResponse, answers.read);
      const delegated = await harness.session('default-session').run('Use the default engine.');
      assert.equal(delegated.finalResponse, 'Default engine completed.');
      assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
    } finally {
      await harness.close(); await pending.catch(() => {});
      await writeFile(join(root, 'parallel-memory-model-requests.json'), JSON.stringify(requests));
    }
    assert.deepEqual(failures, []); assert.equal(requests.length, 7);
    await writeFile(join(root, 'parallel-memory-results.json'), JSON.stringify({ a, b, read, requests }));
    for (const result of [a, b, read]) {
      for (const type of ['turn/start', 'turn/owner', 'turn/end']) assert.equal(result.events.filter(event => event.type === type).length, 1);
      assert.ok(result.events.filter(event => event.type === 'tool/result').every(event => event.data.message.isError === false));
    }
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'),
      userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    const db = new DatabaseSync(join(root, 'studio/native-harness/memory-v1',
      createHash('sha256').update('local').digest('hex'), 'memory.sqlite'), { readOnly: true });
    try {
      assert.equal(store.list(scope, first).length, 1); assert.equal(store.list(scope, peer).length, 2);
      const loaded = [first, peer].flatMap(id => store.list(scope, id).map(snapshot => store.load(scope, snapshot.runId)));
      for (const record of loaded) {
        assert.equal(record.snapshot.phase, 'completed');
        assert.equal(record.intents.filter(intent => intent.kind === 'tool').flatMap(intent => intent.payload.calls).length,
          record.snapshot.sessionId === first ? 2 : record.snapshot.goal === bGoal ? 1 : 2);
        assert.ok(record.receipts.flatMap(receipt => receipt.result.results ?? []).every(result => result.status === 'ok'));
        for (const intent of record.intents.filter(intent => intent.kind === 'tool')) {
          const receipt = record.receipts.find(receipt => receipt.operationKey === intent.operationKey);
          for (const [index, call] of intent.payload.calls.entries()) {
            if (call.name !== 'manage_memory') continue;
            const key = intent.payload.calls.length === 1 ? intent.operationKey : `${intent.operationKey}:call:${index + 1}`;
            const owner = db.prepare('SELECT result FROM memory_operation_receipts WHERE operation_key=?').get(key);
            assert.ok(owner); assert.deepEqual(JSON.parse(owner.result), receipt.result.results[index].content);
          }
        }
      }
      // Same preset must have an identical non-Memory bundle across Sessions.
      const policies = loaded.map(record => record.configuration.tools[0].executionPolicyDigest);
      assert.ok(policies.every(digest => typeof digest === 'string' && digest));
      assert.equal(new Set(policies).size, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_operation_receipts').get().count, 2);
      assert.deepEqual(db.prepare('SELECT data FROM memory_records').all().map(row => JSON.parse(row.data).content).sort(),
        [coffee, project].sort());
    } finally { db.close(); store.close(); }
    const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    const logs = await Promise.all(files.map(file => rows(join(sessions, file))));
    const bySession = new Map(logs.map(log => [log.find(event => event.type === 'session').id, log]));
    const events = logs.flat();
    assert.equal(events.filter(event => event.type === 'approval/asked').length, 1);
    assert.deepEqual(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome), ['allowed-once']);
    const admissions = await rows(join(root, 'tool-admissions.jsonl'));
    assert.equal(admissions.filter(row => row.sessionId === first).length, 2);
    assert.equal(admissions.filter(row => row.sessionId === peer).length, 3);
    const probes = await rows(join(root, 'mounted-host-http.jsonl'));
    assert.equal(probes.length, 2); assert.equal(new Set(probes.map(probe => probe.presetId)).size, 1);
    assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
    const streams = (await rows(join(root, 'assistant-stream.jsonl'))).filter(row => [first, peer].includes(row.session));
    const starts = streams.filter(row => row.frame.type === 'start'); assert.equal(starts.length, 7);
    for (const { session, frame: start } of starts) {
      const frames = streams.filter(row => row.session === session && row.frame.attemptId === start.attemptId).map(row => row.frame);
      const end = frames.at(-1), chunks = frames.filter(frame => frame.type === 'chunk');
      assert.equal(end.type, 'end'); assert.equal(end.outcome.kind, 'committed'); assert.equal(end.index, chunks.length);
      assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index));
      const settled = bySession.get(session).filter(event => event.type === end.outcome.eventType && event.seq === end.outcome.seq
        && event.data.turn === start.turn && event.data.step === start.step
        && JSON.stringify(event.data.stream) === JSON.stringify(chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk }))));
      assert.equal(settled.length, 1, 'A concurrent stream must settle to bytes in its own Session');
    }
    console.log(`Studio Native parallel Memory PASS: packed mounted Host ${frozen ? 'Frozen Build' : 'Revision'}, same preset and two actual SDK Sessions, A deferred approval while B writes and releases, A then writes/searches, B continues with parallel read/search, 3 durable completed Runs, 5 successful pipeline calls, one real approval and default DSH. Node-only PATH with fixed local dependencies; not a browser or fresh-install proof.`);
  }
  return { respond, run };
}
