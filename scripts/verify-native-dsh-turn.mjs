/** Verify the actual Native loop and delivery through a built, shipped DSH SDK profile. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, context: { type: 'boolean', default: false },
  live: { type: 'boolean', default: false } } });
assert.ok(values.source, 'Use --source <built maintained DSH checkout>');
const source = resolve(values.source), root = await mkdtemp(join(tmpdir(), 'studio-native-dsh-'));
const requests = [], failures = [];
let taskRequests = 0, summaryRequests = 0;
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
    const summary = values.context && !body.tools?.length;
    if (summary) { summaryRequests++; assert.equal(body.max_tokens, 80); }
    else { taskRequests++; assert.deepEqual(body.tools.map(tool => tool.function.name), ['publish']); }
    const count = requests.length, turn = Math.ceil(taskRequests / 2);
    const delta = summary ? { content: 'PRIVATE-CONTEXT-NOTES: historical evidence remains unverified.' }
      : taskRequests % 2 ? { tool_calls: [{ index: 0, id: 'reused-provider-call-id', type: 'function',
      function: { name: 'publish', arguments: JSON.stringify({ value: `publication-${turn}` }) } }] }
      : { content: `Native turn ${turn} completed.` };
    const result = { id: `response-${count}`, choices: [{ index: 0, delta, finish_reason: !summary && taskRequests % 2 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } };
    // This no-fault proof counts one successful HTTP request per Native model
    // attempt. Close each fixture connection explicitly so an idle keep-alive
    // socket cannot race the next call while large summaries are assembled.
    // Retry/error paths are exercised separately by the model/core suites.
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); response.writeHead(500); response.end('verification failed'); }
});
let harness;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const patch = join(root, 'native.patch.yml'), sessions = join(root, 'sessions');
  const fixture = fileURLToPath(new URL('../tests/fixtures/native-dsh-turn.mjs', import.meta.url));
  await writeFile(patch, [
    '- id: session-persistence-jsonl',
    "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:', `    root: ${JSON.stringify(sessions)}`, '    compression: none',
    '- insert:', '    - id: studio-native-turn-verification', `      name: ${JSON.stringify(pathToFileURL(fixture).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`,
    `        promptModule: ${JSON.stringify(join(source, 'packages/core/system-prompt/lib/index.js'))}`,
    `        agentModule: ${JSON.stringify(join(source, 'packages/core/agent/lib/index.js'))}`,
    `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`,
    `        contextPlanning: ${values.context}`, `        publishLive: ${values.live}`,
    '',
  ].join('\n'));
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk', patches: [patch],
    dshHome: join(root, 'home'), cwd: root, processCwd: root, provider: 'native-fixture', model: 'pinned',
    initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } };
  harness = new DeepSeekHarness(options);
  let session = harness.session('native-sdk-session');
  for (let turn = 1; turn <= 2; turn++) {
    const requestStart = requests.length, summaryStart = summaryRequests, taskRequestStart = taskRequests;
    const result = await session.run(`Publish marker ${turn} and report completion.`);
    assert.equal(result.finalResponse, `Native turn ${turn} completed.`, JSON.stringify({ turn, requests: requests.length,
      end: result.events.filter(event => event.type === 'turn/end').map(event => event.data) }));
    const events = result.events;
    if (values.live) {
      const records = JSON.parse(await readFile(join(root, `native-turn-${turn}-live.json`), 'utf8'));
      const ends = records.filter(item => item.frame.type === 'end');
      assert.equal(ends.length, taskRequests - taskRequestStart, 'one live settlement per public Native model response');
      for (const { frame, durablyFlushed } of ends) {
        assert.equal(durablyFlushed, true, 'live committed end must follow an actual SDK flush');
        assert.equal(frame.outcome.kind, 'committed');
        assert.equal(events.find(event => event.seq === frame.outcome.seq)?.type, frame.outcome.eventType);
      }
    }
    if (values.context) assert.ok(summaryRequests > summaryStart, `Turn ${turn} must use actual summary HTTP requests`);
    for (const kind of ['turn/start', 'turn/end', 'tool/call', 'tool/result']) {
      assert.equal(events.filter(event => event.type === kind).length, 1, `${kind} count for turn ${turn}`);
    }
    for (const kind of ['step/start', 'step/end', 'assistant/message']) {
      const count = events.filter(event => event.type === kind).length;
      const diagnostics = count === requests.length - requestStart ? '' : JSON.stringify({
        positions: events.filter(event => ['step/start', 'step/end', 'assistant/message'].includes(event.type))
          .map(event => ({ type: event.type, turn: event.data.turn, step: event.data.step })),
        native: JSON.parse(await readFile(join(root, `native-turn-${turn}-diagnostics.json`), 'utf8')),
      });
      assert.equal(count, requests.length - requestStart, `${kind} count for turn ${turn} ${diagnostics}`);
    }
    assert.equal(events.some(event => event.type === 'request/header' || event.type === 'request/context'), false);
    const assistant = events.filter(event => event.type === 'assistant/message');
    assert.deepEqual(assistant.map(event => event.data.usage), Array.from({ length: requests.length - requestStart }, () => ({ inputTokens: 5, outputTokens: 7, totalTokens: 12 })));
    assert.equal(JSON.stringify(events).includes('PRIVATE-CONTEXT-NOTES'), false, 'Summary prose must stay out of the public conversation');
    assert.ok(assistant.every(event => event.data.message.source.provider === 'native-fixture'));
    assert.equal(await readFile(join(root, 'published.txt'), 'utf8'), `publication-${turn}`);
    await assert.rejects(readFile(join(root, 'default-invocations.jsonl')), { code: 'ENOENT' });
    if (turn === 1) {
      await harness.close();
      harness = new DeepSeekHarness(options);
      await harness.start();
      session = await harness.resumeSession('native-sdk-session');
    }
  }
  const delegated = await session.run('Use the default engine to reply after the Native tool turns.');
  assert.equal(delegated.finalResponse, 'Default engine completed.');
  assert.equal(delegated.events.filter(event => event.type === 'request/header').length, 1);
  assert.equal(delegated.events.filter(event => event.type === 'request/context').length, 1);
  assert.equal((await readFile(join(root, 'default-invocations.jsonl'), 'utf8')).trim().split('\n').length, 1);
  await harness.close(); harness = null;
  assert.deepEqual(failures, []); assert.equal(taskRequests, 4);
  assert.equal(requests.length, 4 + summaryRequests);
  const writes = (await readFile(join(root, 'writes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(writes.length, 2); assert.notEqual(writes[0].key, writes[1].key);
  assert.deepEqual(writes.map(write => write.value), ['publication-1', 'publication-2']);
  const files = await readdir(sessions, { recursive: true });
  const logs = files.filter(file => file.endsWith('.jsonl'));
  assert.equal(logs.length, 1);
  const stored = (await readFile(join(sessions, logs[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(stored.filter(event => event.type === 'assistant/message').length, requests.length + 1);
  assert.equal(stored.filter(event => event.type === 'tool/result').length, 2);
  assert.equal(stored.filter(event => event.type === 'turn/end').length, 3);
  if (values.context) {
    const markers = stored.filter(event => event.type === 'agentkit-native/context-marker');
    assert.ok(markers.length >= 2, 'Compactions from both Native turns persist through the actual SDK restart');
    assert.equal(new Set(markers.map(event => event.data.runId)).size, 2);
    assert.ok(markers.every(event => event.ignorable === true && !Object.hasOwn(event, 'surfaceOp')
      && event.data.contract === 'agentkit.native-context-presentation/v1' && event.data.marker.status === 'completed'));
    const { createSessionTaskProjector } = await import('../src/client/dsh/session-task-events.mjs');
    const windows = createSessionTaskProjector({ sessionId: 'native-sdk-session' }).project({ revision: 1,
      entries: stored.filter(event => typeof event.type === 'string' && event.data).map(event => ({ type: 'event', event })) });
    for (const turn of [1, 2]) assert.ok(windows.find(row => row.turn === turn)?.state.contextMarkers?.length,
      `Cold UI history retains committed compaction markers for turn ${turn}`);
  }
  const ids = stored.filter(event => event.type === 'tool/call').map(event => event.data.callId);
  assert.equal(new Set(ids).size, 2, 'Reused provider call IDs stay distinct across turns and process restart');
  console.log(`Native shipped SDK verification passed: 2 Native turns across process restart, ${requests.length} real HTTP attempts (${summaryRequests} summaries), 2 actual writes, then 1 delegated default turn; duplicate delivery adds no events.${values.live ? ' Live end frames follow actual SDK durability.' : ''}`);
} finally {
  await harness?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
