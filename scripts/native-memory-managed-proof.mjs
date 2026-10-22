/** Mounted, packed Host proof. Model replies and human decisions are fixed;
 * the DSH gateway, ApprovalService, Native ledger and Memory database are real. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const readRows = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const messages = body => body.messages.filter(message => message.role === 'tool');
const names = body => (body.tools ?? []).map(tool => tool.function.name);
const responses = { candidate: 'Memory preference noted.', remember: 'Memory durably remembered.',
  read: 'Current memory read.', denied: 'Memory write was denied.', correct: 'Memory durably corrected.',
  forget: 'Memory durably forgotten.', policy: 'Memory pipeline denied the write.' };

export function createManagedMemoryProof() {
  let stage, step = 0, editor, project;
  const call = (id, name, args) => ({ index: id, id: `memory-${stage}-${id}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } });
  const calls = () => {
    if (stage === 'remember') return [call(0, 'manage_memory', { action: 'remember', scope: 'user', content: '我的项目语言是 TypeScript' })];
    if (stage === 'read') return [call(0, 'read_memory', { memory_id: project.memoryId }), call(1, 'search_memory', { query: 'TypeScript' })];
    if (stage === 'denied') return [call(0, 'manage_memory', { action: 'remember', scope: 'user', content: '我的主题是深色' })];
    if (stage === 'correct') return [call(0, 'manage_memory', { action: 'correct', scope: 'user', memory_id: editor.memoryId,
      expected_version: editor.version, content: '我喜欢用Emacs' })];
    if (stage === 'forget') return [call(0, 'manage_memory', { action: 'forget', scope: 'user', memory_id: project.memoryId,
      expected_version: project.version })];
    if (stage === 'policy') return [call(0, 'manage_memory', { action: 'remember', scope: 'user', content: 'Memory pipeline forbidden' })];
    throw Error(`Unexpected Memory stage ${stage}`);
  };
  async function respond({ request, response, body, requests, frozen }) {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
    assert.deepEqual(names(body), ['read_memory', 'search_memory', 'manage_memory']);
    if (frozen) {
      assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
      assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false);
    }
    assert.ok(step < (stage === 'candidate' ? 1 : 2), `Unexpected repair/model loop at ${stage}`);
    requests.push(body);
    const dispatch = stage !== 'candidate' && step === 0;
    if (!dispatch && stage !== 'candidate') {
      const results = messages(body).slice(stage === 'read' ? -2 : -1);
      assert.equal(results.length, stage === 'read' ? 2 : 1);
      const output = JSON.stringify(results);
      if (stage === 'read') {
        const [read, search] = results.map(result => JSON.parse(result.content));
        assert.equal(read.trustLevel, 'untrusted'); assert.equal(read.record.memoryId, project.memoryId);
        assert.equal(read.record.content, '我的项目语言是 TypeScript');
        assert.equal(search.format, 'ksadk.memory-search/v1'); assert.equal(search.trustLevel, 'untrusted');
        assert.ok(search.records.some(record => record.memoryId === project.memoryId
          && record.content === '我的项目语言是 TypeScript'), 'Actual search must independently return the project fact');
      } else if (stage === 'denied' || stage === 'policy') assert.match(output, /denied|permission|拒绝/i);
      else assert.match(output, /committed/);
    }
    const delta = dispatch ? { tool_calls: calls() } : { content: responses[stage] };
    step++;
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `managed-memory-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: dispatch ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures, frozen }) {
    let harness = initial, scope, filename;
    const facts = () => {
      const db = new DatabaseSync(filename, { readOnly: true });
      try { return db.prepare('SELECT data FROM memory_records').all().map(row => JSON.parse(row.data)); }
      finally { db.close(); }
    };
    try {
      let session = harness.session('native-studio-session');
      const turn = async (kind, input, number) => {
        stage = kind; step = 0;
        const result = await session.run(input);
        await writeFile(join(root, `managed-memory-turn-${number}.json`), JSON.stringify(result));
        assert.equal(result.finalResponse, responses[kind], JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
        for (const type of ['turn/start', 'turn/owner', 'turn/end']) assert.equal(result.events.filter(event => event.type === type).length, 1, type);
        assert.equal(step, kind === 'candidate' ? 1 : 2);
        assert.equal(result.events.filter(event => event.type === 'tool/call').length, kind === 'candidate' ? 0 : kind === 'read' ? 2 : 1);
        if (kind === 'read') {
          const results = result.events.filter(event => event.type === 'tool/result');
          assert.equal(results.length, 2);
          assert.ok(results.every(event => event.data.message.isError === false), 'Both parallel read and search must succeed');
        }
      };
      await turn('candidate', '我喜欢用Vim', 1);
      const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
      const workspaceId = createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex');
      scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId };
      filename = join(root, 'studio/native-harness/memory-v1', createHash('sha256').update('local').digest('hex'), 'memory.sqlite');
      assert.deepEqual(facts(), [], 'One implicit source is only an observation');
      await turn('candidate', '我喜欢用Vim', 2);
      [editor] = facts(); assert.equal(facts().length, 1); assert.equal(editor.content, '我喜欢用Vim');
      assert.equal(editor.version, 1); assert.equal(editor.sourceEventIds.length, 2);
      await harness.close(); harness = new DeepSeekHarness(options);
      session = await harness.resumeSession('native-studio-session');
      await turn('remember', '记住：我的项目语言是 TypeScript', 3);
      project = facts().find(fact => fact.content === '我的项目语言是 TypeScript');
      assert.ok(project); assert.equal(project.version, 1); assert.equal(facts().length, 2);
      await turn('read', 'Read and search my current project memory.', 4);
      await turn('denied', 'Suggest a theme without storing it.', 5);
      assert.equal(facts().length, 2); assert.equal(facts().some(fact => fact.content === '我的主题是深色'), false);
      await turn('correct', '我喜欢用Emacs，不是Vim', 6);
      editor = facts().find(fact => fact.memoryId === editor.memoryId);
      assert.equal(editor.content, '我喜欢用Emacs'); assert.equal(editor.version, 2);
      await turn('forget', 'Forget the saved project language.', 7);
      const forgotten = facts().find(fact => fact.memoryId === project.memoryId);
      assert.equal(forgotten.status, 'deleted'); assert.equal(forgotten.version, 2); assert.equal(forgotten.content, '');
      await turn('policy', 'Check the standing tool pipeline.', 8);
      assert.equal(facts().length, 2); assert.equal(facts().some(fact => fact.content === 'Memory pipeline forbidden'), false);
      const delegated = await harness.session('default-session').run('Use the default engine.');
      assert.equal(delegated.finalResponse, 'Default engine completed.');
      assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
    } finally { await harness.close(); }
    assert.deepEqual(failures, []); assert.equal(requests.length, 14);
    await writeFile(join(root, 'managed-memory-model-requests.json'), JSON.stringify(requests));
    const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    const events = (await Promise.all(files.map(file => readRows(join(sessions, file))))).flat();
    const asked = events.filter(event => event.type === 'approval/asked');
    const decided = events.filter(event => event.type === 'approval/decided');
    assert.equal(asked.length, 2); assert.equal(decided.length, 2);
    for (const [index, event] of asked.entries()) {
      assert.equal(event.data.toolName, 'manage_memory');
      assert.equal(decided.find(item => item.data.id === event.data.id)?.data.outcome, index ? 'allowed-once' : 'rejected');
    }
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    const db = new DatabaseSync(filename, { readOnly: true });
    const { buildId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    try {
      const records = store.list(scope, 'native-studio-session').map(snapshot => store.load(scope, snapshot.runId));
      assert.equal(records.length, 8);
      for (const record of records) {
        assert.equal(record.snapshot.phase, 'completed');
        assert.equal(record.configuration.hostRecoveryBinding.agentRevision, 1);
        if (frozen) assert.equal(record.snapshot.buildId, buildId);
        assert.equal(record.receipts.some(receipt => receipt.result.event === 'PreCompact'), false);
        const explicit = ['记住：我的项目语言是 TypeScript', '我喜欢用Emacs，不是Vim'].includes(record.snapshot.goal);
        if (explicit) assert.equal(record.snapshot.outcome, 'verified', JSON.stringify(record.snapshot.verification));
        for (const intent of record.intents.filter(intent => intent.kind === 'tool')) {
          const receipt = record.receipts.find(receipt => receipt.operationKey === intent.operationKey);
          for (const [index, call] of intent.payload.calls.entries()) {
            const result = receipt?.result.results[index];
            if (call.name !== 'manage_memory' || result?.status !== 'ok' || result.content.committed !== true) continue;
            const operationKey = intent.payload.calls.length > 1 ? `${intent.operationKey}:call:${index + 1}` : intent.operationKey;
            const owner = db.prepare('SELECT result FROM memory_operation_receipts WHERE operation_key=?').get(operationKey);
            assert.ok(owner); assert.deepEqual(JSON.parse(owner.result), result.content, 'Actual owner receipt must equal the committed tool result');
          }
        }
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_operation_receipts').get().count, 5,
        'Two original-source observations and exactly three approved management writes');
    } finally { db.close(); store.close(); }
    const { SqliteNativeMemoryProvider } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/memory-store.mjs')).href);
    const foreign = new SqliteNativeMemoryProvider(filename, { principal: { ...scope, agentId: 'other-agent' } });
    try { assert.deepEqual(foreign.list(), []); } finally { foreign.close(); }
    const frames = (await readRows(join(root, 'assistant-stream.jsonl'))).filter(row => row.session === 'native-studio-session');
    const starts = frames.filter(row => row.frame.type === 'start'); assert.equal(starts.length, requests.length);
    for (const { frame: start } of starts) {
      const stream = frames.filter(row => row.frame.attemptId === start.attemptId).map(row => row.frame);
      const end = stream.at(-1), chunks = stream.filter(frame => frame.type === 'chunk');
      assert.equal(end.type, 'end'); assert.equal(end.outcome.kind, 'committed');
      assert.equal(end.index, chunks.length);
      assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index));
      const settled = events.filter(event => event.type === end.outcome.eventType && event.seq === end.outcome.seq
        && event.data.turn === start.turn && event.data.step === start.step
        && JSON.stringify(event.data.stream) === JSON.stringify(chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk }))));
      assert.equal(settled.length, 1, 'Every public Memory model stream must settle to the exact durable Session bytes');
    }
    const admissions = await readRows(join(root, 'tool-admissions.jsonl'));
    assert.deepEqual(admissions.map(row => row.name), ['manage_memory', 'read_memory', 'search_memory',
      'manage_memory', 'manage_memory', 'manage_memory', 'manage_memory']);
    const probes = await readRows(join(root, 'mounted-host-http.jsonl'));
    assert.equal(probes.length, 2); assert.ok(probes.some(probe => probe.source === 'resume'));
    assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
    assert.equal(JSON.stringify(events).includes('sk-studio-fixture-secret'), false);
    console.log(`Studio Native managed Memory PASS: packed mounted Host, ${frozen ? 'Frozen Build' : 'Revision'}, eight SDK turns and Host restart, real post-turn sources, explicit remember/correct with actual owner receipts and verified facts, parallel read/search, real ApprovalService rejection and forget grant, actual DSH pre-policy refusal, SQLite reopen, foreign Agent isolation and default DSH. Node-only PATH; fixed local dependency graph, deterministic model and human replies; full browser and fresh Host installation remain separate.`);
  }
  return { respond, run };
}
