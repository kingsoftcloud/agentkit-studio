import { createRequire } from 'node:module';
/** Packed Studio Web loop through real SDK sessions and mountStudioHost. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sessionId = 'native-studio-session';
const page = '你好😀 world';
const rows = async filename => (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

export function createWebProof() {
  const steps = new Map(), searchRequests = [], pageRequests = [];
  async function respond({ request, response, raw, requests, frozen }) {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url, origin);
    if (url.pathname === '/search') {
      assert.equal(request.headers.authorization, 'Bearer web-proof-search-secret');
      assert.match(url.searchParams.get('q'), /^Web proof [12]$/);
      searchRequests.push(url.searchParams.get('q'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [{ title: 'Pinned local page', url: origin + '/page', snippet: 'Unicode page' }] })); return;
    }
    if (url.pathname === '/page') {
      assert.equal(request.headers.authorization, undefined);
      pageRequests.push(url.href);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<main>你好😀 <b>world</b></main><script>untrusted-script-marker()</script>'); return;
    }
    assert.equal(url.pathname, '/v1/chat/completions');
    const body = JSON.parse(raw); assert.equal(body.model, 'pinned');
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['web_fetch', 'web_search']);
    if (frozen) {
      assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
      assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false);
    }
    const goal = body.messages.filter(message => message.role === 'user' && /^Web proof [12]$/.test(message.content)).at(-1)?.content;
    assert.ok(goal, 'Model receives the actual user goal');
    const step = steps.get(goal) ?? 0; assert.ok(step < 3, 'Unexpected model repair loop'); steps.set(goal, step + 1);
    requests.push(body);
    let call;
    if (step === 0) call = { name: 'web_search', arguments: { query: goal } };
    else {
      const output = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      if (step === 1) {
        assert.equal(output.ok, true); assert.equal(output.provider, 'http');
        assert.equal(output.query, goal); assert.equal(output.results[0].title, 'Pinned local page');
        call = { name: 'web_fetch', arguments: { url: output.results[0].url, max_chars: 3 } };
      } else {
        assert.equal(output.ok, true); assert.equal(output.text, '你好😀'); assert.equal(output.truncated, true);
        assert.ok(output.persisted.path); assert.equal(JSON.stringify(output).includes('untrusted-script-marker'), false);
      }
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `${goal}-${step}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: `${goal} completed.` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `web-proof-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, sessions, requests, failures, frozen }) {
    let harness = initial;
    try {
      let session = harness.session(sessionId);
      for (let turn = 1; turn <= 2; turn++) {
        const result = await session.run(`Web proof ${turn}`);
        await writeFile(join(root, `web-sdk-turn-${turn}.json`), JSON.stringify(result));
        assert.equal(result.finalResponse, `Web proof ${turn} completed.`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
        for (const type of ['turn/start', 'turn/owner', 'turn/end']) assert.equal(result.events.filter(event => event.type === type).length, 1);
        assert.equal(result.events.filter(event => event.type === 'tool/result').length, 2);
        assert.ok(result.events.filter(event => event.type === 'tool/result').every(event => event.data.message.isError === false));
        if (turn === 1) {
          await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession(sessionId);
        }
      }
      const delegated = await harness.session('default-session').run('Use the default engine.');
      assert.equal(delegated.finalResponse, 'Default engine completed.');
      assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
    } finally {
      await harness.close();
      await writeFile(join(root, 'web-model-requests.json'), JSON.stringify(requests));
      await writeFile(join(root, 'web-model-failures.json'), JSON.stringify(failures.map(error => ({ message: error.message, stack: error.stack }))));
    }
    assert.deepEqual(failures, []); assert.equal(requests.length, 6);
    assert.deepEqual(searchRequests, ['Web proof 1', 'Web proof 2']); assert.equal(pageRequests.length, 2);
    const { id: agentId, buildId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
    const load = async file => import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/' + file.replace(/\.mjs$/, ''))).href);
    const { SqliteRunStore } = await load('sqlite-store.mjs');
    const { createNativeArtifactStore } = await load('artifact-store.mjs');
    const artifacts = await createNativeArtifactStore({ directory: join(root, 'studio/native-harness/workspace-state',
      createHash('sha256').update(agentId).digest('hex'), 'web-artifacts'), scope });
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const runs = store.list(scope, sessionId); assert.equal(runs.length, 2);
      for (const run of runs) {
        const record = store.load(scope, run.runId); assert.equal(record.snapshot.phase, 'completed');
        if (frozen) assert.equal(record.snapshot.buildId, buildId);
        assert.deepEqual(record.configuration.tools.map(tool => tool.name), ['web_fetch', 'web_search']);
        const intents = record.intents.filter(intent => intent.kind === 'tool'); assert.equal(intents.length, 2);
        assert.deepEqual(intents.flatMap(intent => intent.payload.calls.map(call => call.name)), ['web_search', 'web_fetch']);
        for (const intent of intents) {
          const receipt = record.receipts.find(receipt => receipt.operationKey === intent.operationKey);
          assert.equal(receipt.status, 'committed'); assert.equal(receipt.result.results[0].status, 'ok');
        }
        const refs = await artifacts.search({ scope, runId: run.runId, sessionId, operationKey: 'proof-search', query: 'world', limit: 10, signal: AbortSignal.timeout(2000) });
        assert.equal(refs.length, 1);
        const content = await artifacts.read({ scope, runId: run.runId, sessionId, operationKey: 'proof-read', ref: refs[0], offset: 0, limit: 100, signal: AbortSignal.timeout(2000) });
        assert.deepEqual(content, { content: page, nextOffset: null });
      }
    } finally { store.close(); }
    const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
    const events = (await Promise.all(files.map(file => rows(join(sessions, file))))).flat();
    const streams = (await rows(join(root, 'assistant-stream.jsonl'))).filter(row => row.session === sessionId);
    const starts = streams.filter(row => row.frame.type === 'start'); assert.equal(starts.length, 6);
    for (const { frame: start } of starts) {
      const frames = streams.filter(row => row.frame.attemptId === start.attemptId).map(row => row.frame);
      const end = frames.at(-1), chunks = frames.filter(frame => frame.type === 'chunk');
      assert.equal(end.type, 'end'); assert.equal(end.outcome.kind, 'committed'); assert.equal(end.index, chunks.length);
      assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index));
      assert.equal(events.filter(event => event.type === end.outcome.eventType && event.seq === end.outcome.seq
        && event.data.turn === start.turn && event.data.step === start.step
        && JSON.stringify(event.data.stream) === JSON.stringify(chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk })))).length, 1);
    }
    const probes = await rows(join(root, 'mounted-host-http.jsonl'));
    assert.equal(probes.length, 2); assert.ok(probes.some(probe => probe.source === 'resume'));
    assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
    const admissions = await rows(join(root, 'tool-admissions.jsonl')); assert.equal(admissions.length, 4);
    assert.equal(JSON.stringify(events).includes('web-proof-search-secret'), false);
    console.log(`Studio Native Web PASS: actual packed mountStudioHost ${frozen ? 'Frozen Build' : 'Revision'}, authenticated preset RPC, two SDK turns across Host restart, real search/page HTTP, 4 successful pipeline tools with durable intents/receipts, persisted full Unicode artifacts, 6 model HTTP/public streams settled to exact Session bytes, and default DSH. Node-only PATH, selected local dependencies; not browser/online/fresh-install proof.`);
  }
  return { respond, run };
}
