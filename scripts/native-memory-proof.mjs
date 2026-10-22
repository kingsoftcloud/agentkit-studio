import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const summary = body => body.messages[0]?.role === 'system'
  && body.messages[0].content.startsWith('Summarize the quoted historical data');
const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

/** Real HTTP provider peer. The Host uses its normal tokenizer and planner. */
export async function respondToMemoryProof({ request, response, body, requests, frozen, waitForPublicPrefix }) {
  assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
  assert.deepEqual((body.tools ?? []).map(tool => tool.function.name),
    summary(body) ? [] : ['read_memory', 'search_memory', 'manage_memory']);
  if (frozen && !summary(body)) {
    assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
    assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false);
  }
  requests.push(body);
  const count = requests.length, text = summary(body) ? 'Prior user inputs are recorded in history.' : 'Memory turn delivered.';
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  response.write(`data: ${JSON.stringify({ id: `memory-${count}`, choices: [{ index: 0,
    delta: { content: text.slice(0, 7) }, finish_reason: null }] })}\n\n`);
  // Compaction is an internal model effect: the Kernel intentionally keeps
  // summary bytes off the public task stream. Wait only for task prefixes.
  if (!summary(body)) await waitForPublicPrefix(requests.filter(value => !summary(value)).length, text.slice(0, 7));
  response.end(`data: ${JSON.stringify({ id: `memory-${count}`, choices: [{ index: 0,
    delta: { content: text.slice(7) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
}

/** Full packed mountStudioHost with ordinary SDK inputs, not a synthetic Run
 * seed, forced compaction call, counter double or memory-port replacement.
 */
export async function runMemoryProof({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures, frozen }) {
  let harness = initial;
  const original = ' '.repeat(6000) + '我喜欢用Vim';
  try {
    let session = harness.session('native-studio-session');
    for (let turn = 1; turn <= 4; turn++) {
      const input = turn <= 2 ? original : turn === 3 ? 'Vim' : 'Vim editor';
      const result = await session.run(input);
      await writeFile(join(root, `memory-sdk-turn-${turn}.json`), JSON.stringify(result));
      assert.equal(result.finalResponse, 'Memory turn delivered.', JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
      assert.equal(result.events.filter(event => event.type === 'turn/start').length, 1);
      assert.equal(result.events.filter(event => event.type === 'turn/owner').length, 1);
      assert.equal(result.events.filter(event => event.type === 'turn/end').length, 1);
      assert.equal(result.events.filter(event => event.type === 'tool/call').length, 0);
      assert.equal(result.events.some(event => event.type === 'request/header'), false);
      if (turn === 2) {
        await harness.close(); harness = new DeepSeekHarness(options);
        session = await harness.resumeSession('native-studio-session');
      }
    }
    const delegated = await harness.session('default-session').run('Use the default engine.');
    assert.equal(delegated.finalResponse, 'Default engine completed.');
    assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
  } finally { await harness.close(); }
  assert.deepEqual(failures, []);
  await writeFile(join(root, 'memory-model-requests.json'), JSON.stringify(requests));
  assert.equal(requests.filter(body => !summary(body)).length, 4);
  for (const body of requests.filter(body => !summary(body)).slice(2)) {
    const recalled = body.messages.filter(message => message.role === 'user'
      && message.content.includes('agentkit.native-context-contribution/v1')).map(message => JSON.parse(message.content));
    assert.equal(recalled.length, 1); assert.equal(recalled[0].trust, 'untrusted');
    assert.equal(recalled[0].item.content, '我喜欢用Vim'); assert.equal(recalled[0].item.version, 1);
    assert.equal(recalled[0].item.currentFactVerification, false);
  }
  assert.ok(requests.some(summary), 'Actual Host context pressure must cause model summary dispatch');
  const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
  const events = (await Promise.all(files.map(file => rows(join(sessions, file))))).flat();
  assert.equal(events.filter(event => event.type === 'turn/owner').length, 4);
  assert.equal(events.filter(event => event.type === 'turn/end').length, 5);
  const nativeAssistant = events.filter(event => event.type === 'assistant/message' && event.data.message?.source?.kind === 'model')
    .filter(event => event.data.message.content.some(block => block.type === 'text' && block.text === 'Memory turn delivered.'));
  assert.equal(nativeAssistant.length, 4);
  assert.equal(events.some(event => event.type === 'assistant/message'
    && JSON.stringify(event.data.message.content).includes('Prior user inputs are recorded in history.')), false,
  'Internal summary prose must not appear as a public assistant response');
  const { id: agentId, buildId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  const workspaceId = createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex');
  const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId };
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const { SqliteNativeMemoryProvider } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/memory-store.mjs')).href);
  const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  let records;
  try {
    const runs = store.list(scope, 'native-studio-session'); assert.equal(runs.length, 4);
    records = runs.map(run => store.load(scope, run.runId));
    assert.equal(runs.filter(run => run.parentRunId === null).length, 1);
    for (const record of records) {
      assert.equal(record.snapshot.phase, 'completed'); assert.equal(record.configuration.hooks.length, 1);
      assert.equal(record.configuration.hooks[0].hookId, 'agentkit.memory.precompact');
      assert.equal(record.configuration.hooks[0].readOnly, false);
      assert.equal(record.configuration.contextSources[0].sourceId, 'studio.memory-recall');
      if (frozen) assert.equal(record.snapshot.buildId, buildId);
    }
    const receipts = records.flatMap(record => record.receipts.filter(receipt => receipt.result.schemaVersion === 'agentkit.native-hook-result/v1'));
    assert.ok(receipts.length >= 2, 'First compaction and later original-source replay must both be evaluated');
    assert.ok(receipts.every(receipt => receipt.status === 'committed' && receipt.result.status === 'ok' && receipt.result.event === 'PreCompact'));
    assert.ok(receipts.some(receipt => receipt.result.output.additionalContext.some(text => text.includes('"committed":1'))));
    assert.ok(records.some(record => record.snapshot.messages.some(message => message.kind === 'hook_context'
      && message.content.includes('currentFactVerification') && message.content.includes('false'))));
    const effects = records.flatMap(record => record.events.filter(event => ['model.completed', 'context.summary_completed'].includes(event.kind)));
    assert.equal(effects.length, requests.length);
  } finally { store.close(); }
  const filename = join(root, 'studio/native-harness/memory-v1', createHash('sha256').update('local').digest('hex'), 'memory.sqlite');
  const provider = new SqliteNativeMemoryProvider(filename, { principal: scope });
  try {
    const facts = provider.list(); assert.equal(facts.length, 1); assert.equal(facts[0].content, '我喜欢用Vim');
    assert.equal(facts[0].version, 1); assert.equal(facts[0].sourceSessionId, 'native-studio-session');
    const originals = records.filter(record => record.configuration.contract.objective === '我喜欢用Vim');
    assert.equal(originals.length, 2);
    const expected = originals.map(record => {
      const index = record.snapshot.messages.findIndex(message => !message.history && message.kind === 'user_input' && message.content === original);
      assert.ok(index >= 0, 'SDK admission must retain original input bytes');
      return `native-message://${record.snapshot.runId}#message=${index}`;
    });
    assert.deepEqual(new Set(facts[0].sourceEventIds), new Set(expected));
  } finally { provider.close(); }
  const foreign = new SqliteNativeMemoryProvider(filename, { principal: { ...scope, agentId: 'other-agent' } });
  try { assert.deepEqual(foreign.list(), []); } finally { foreign.close(); }
  const db = new DatabaseSync(filename);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_sources').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_observations').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_operation_receipts').get().n, 2,
      'A later compaction must reuse original candidate receipts');
  } finally { db.close(); }
  const probes = await rows(join(root, 'mounted-host-http.jsonl'));
  assert.equal(probes.length, 2); assert.ok(probes.some(probe => probe.source === 'resume'));
  assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
  const live = (await rows(join(root, 'assistant-stream.jsonl'))).filter(row => row.session === 'native-studio-session');
  const starts = live.filter(row => row.frame.type === 'start'); assert.equal(starts.length, 4);
  for (const { frame: start } of starts) {
    const frames = live.filter(row => row.frame.attemptId === start.attemptId).map(row => row.frame);
    const end = frames.at(-1), chunks = frames.filter(frame => frame.type === 'chunk');
    assert.equal(end.type, 'end'); assert.equal(end.outcome.kind, 'committed');
    assert.equal(end.index, chunks.length);
    assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index));
    const settled = events.filter(event => event.type === end.outcome.eventType && event.seq === end.outcome.seq
      && event.data.turn === start.turn && event.data.step === start.step
      && JSON.stringify(event.data.stream) === JSON.stringify(chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk }))));
    assert.equal(settled.length, 1, 'Every actual task/summary public stream settles to exact durable Session bytes');
  }
  assert.equal(JSON.stringify(events).includes('sk-studio-fixture-secret'), false);
  console.log(`Studio Native local Memory PASS: actual packed mountStudioHost, ${frozen ? 'pinned Frozen Build with latest memory disabled' : 'Agent Revision'}, authenticated preset RPC, four ordinary SDK turns across Host restart, real context pressure/tokenizer/summary HTTP, original-source PreCompact intents and receipts, two independent observations -> one v1 SQLite fact, fresh uncached recall in both later model requests, repeated compaction reuses exactly two receipts, foreign Agent isolated, every public task stream durably settled, internal summaries withheld, and default DSH. Node-only PATH; fixed local dependency graph, not a fresh install.`);
}
