// The Native engine provider drives a REAL engine process through the protocol
// against a local model fixture. Studio code under test imports no engine module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNativeEngineRuntime, resolveEngineCommand } from '../src/providers/native-engine-runtime.mjs';
import { nativeEngineVerification } from '../src/providers/native-engine-verification.mjs';

const installedEngine = fileURLToPath(import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/engine-server'));
const engineCommand = process.env.AGENTKIT_ENGINE_COMMAND ?? process.execPath;
const engineArgs = process.env.AGENTKIT_ENGINE_COMMAND ? process.env.AGENTKIT_ENGINE_ARGS : JSON.stringify([installedEngine]);
const createTestService = async () => (await import(new URL('engine-service.mjs',
  process.env.AGENTKIT_STUDIO_TEST_ENGINE_SERVER
    ? pathToFileURL(process.env.AGENTKIT_STUDIO_TEST_ENGINE_SERVER)
    : import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/engine-server')))).createEngineService;

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const toolCall = (id, name, args) => [
  { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'Writing the file now.', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }];
const final = text => [{ id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }];
function fixture(script) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      if (handle.stream) { await handle.stream(parsed, res); return; }
      const frames = handle.respond ? await handle.respond(parsed) : script[Math.min(requests.length - 1, script.length - 1)];
      if (!Array.isArray(frames)) {
        res.writeHead(frames.status, { 'content-type': 'application/json', ...frames.headers });
        res.end(JSON.stringify(frames.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  const handle = { requests, respond: null, stream: null, close: () => new Promise(closed => { server.closeAllConnections(); server.close(closed); }) };
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(Object.assign(handle, { url: `http://127.0.0.1:${server.address().port}/v1` }))));
}
async function setup(t, script, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-engine-')), cwd = join(dir, 'workspace');
  mkdirSync(cwd);
  const model = await fixture(script);
  t.after(async () => { await model.close(); rmSync(dir, { recursive: true, force: true }); });
  const runtime = createNativeEngineRuntime({ stateRoot: join(dir, 'state'), env: { PATH: process.env.PATH, HOME: dir, AGENTKIT_ENGINE_COMMAND: engineCommand, AGENTKIT_ENGINE_ARGS: engineArgs, ...extraEnv } });
  return { runtime, model, cwd, options: { input: 'Create out.txt with a greeting.', systemPrompt: 'You are the Studio release agent.', model: 'fixture-model',
    modelProvider: { baseUrl: model.url, apiKey: 'studio-fixture-key' }, cwd, sessionId: 'session-1', turnId: '1' } };
}
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test('Studio forwards the configured search binding to its independent engine process', async t => {
  let searches = 0;
  const search = createServer((req, res) => {
    searches++;
    assert.equal(req.headers.authorization, 'Bearer separate-search-fixture');
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('q'), 'Studio search fixture');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Native search result', url: 'https://example.com/studio-search', snippet: 'Verified Studio search.' }] }));
  });
  await new Promise(resolve => search.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { search.closeAllConnections(); search.close(resolve); }));
  const f = await setup(t, [toolCall('search', 'web_search', { query: 'Studio search fixture' }), final('Search complete.')], {
    AGENTKIT_ENGINE_WEB_SEARCH_PROVIDER: 'http', AGENTKIT_ENGINE_WEB_SEARCH_BASE_URL: 'http://127.0.0.1:' + search.address().port,
    AGENTKIT_ENGINE_WEB_SEARCH_API_KEY: 'separate-search-fixture',
  });
  const chunks = await collect(f.runtime.stream({ ...f.options, input: 'Search for Studio search fixture.', sandbox: 'workspace-write' }));
  assert.equal(searches, 1);
  assert.match(JSON.stringify(f.model.requests.at(-1)), /Verified Studio search/);
  assert.doesNotMatch(JSON.stringify({ chunks, requests: f.model.requests }), /separate-search-fixture/);
});

test('Studio sends an interjection to the original Run before the retry and commits it once', { timeout: 15000 }, async t => {
  const f = await setup(t, []);
  const release = Promise.withResolvers();
  const firstRequest = Promise.withResolvers();
  const guide = { id: 'studio-guidance-1', text: 'Use the Studio browser to verify the page.' };
  let queued = null;
  const committed = [];
  f.model.respond = async () => {
    if (f.model.requests.length !== 1) return final('Verified.');
    firstRequest.resolve();
    await release.promise;
    const repeated = ' — **hmm'.repeat(160);
    return [{ id: 'c', choices: [{ index: 0, delta: { reasoning_content: repeated } }] }];
  };
  t.after(() => release.resolve());
  const stream = f.runtime.stream({ ...f.options, nextGuidance: () => queued, commitGuidance: item => {
    committed.push(item);
    queued = null;
  } });
  const events = [];
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'engine') {
        await firstRequest.promise;
        queued = guide;
      }
      if (chunk.type !== 'engine-event') continue;
      events.push(chunk);
      if (chunk.event.kind === 'effect.prepared' && chunk.event.category === 'model') release.resolve();
    }
  } finally { release.resolve(); }
  assert.deepEqual(committed, [guide]);
  assert.equal(new Set(events.map(event => event.runId)).size, 1);
  assert.equal(f.model.requests.length, 2);
  assert.equal(f.model.requests[1].max_tokens, 8192);
  assert.match(JSON.stringify(f.model.requests[1].messages), /Use the Studio browser to verify the page/);
  assert.equal(events.filter(({ event }) => event.kind === 'input.guidance_applied').length, 1);
  assert.equal(events.filter(({ event }) => event.kind === 'effect.prepared' && event.retry === true).length, 1);
});

test('Studio carries a real model retry and a terminal 400 without confusing the two', async t => {
  const requestId = '65cd9c89-0944-4a65-ac03-ec5eff3e17cf';
  const f = await setup(t, [
    toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'saved\n' }),
    { status: 429, headers: { 'retry-after': '0', 'x-request-id': 'Bearer private-id' },
      body: { error: { code: 'private-provider-code' } } },
    { status: 400, headers: { 'x-request-id': requestId },
      body: { code: 'invalid_request_error', type: 'BadRequestError', message: 'Bearer private-gateway-body' } },
  ]);
  const chunks = [];
  let approvals = 0;
  await assert.rejects(async () => {
    for await (const chunk of f.runtime.stream({ ...f.options, requestApproval: async () => { approvals++; return 'allowed-once'; } }))
      chunks.push(chunk);
  }, /HTTP 400.*未自动重试/);
  const events = chunks.filter(chunk => chunk.type === 'engine-event').map(chunk => chunk.event);
  const failures = events.filter(event => event.kind === 'model.failure_observed');
  const retries = events.filter(event => event.kind === 'effect.prepared' && event.retry === true);
  assert.equal(f.model.requests.length, 3);
  assert.equal(approvals, 1);
  assert.equal(readFileSync(join(f.cwd, 'out.txt'), 'utf8'), 'saved\n');
  assert.deepEqual(failures.map(event => event.httpStatus), [429, 400]);
  assert.equal(failures[0].gateway, undefined);
  assert.deepEqual(failures[1].gateway, { code: 'invalid_request_error', type: 'BadRequestError', requestId });
  assert.equal(retries.length, 1);
  assert.ok(failures[0].seq < retries[0].seq && retries[0].seq < failures[1].seq);
  assert.match(events.find(event => event.kind === 'run.terminal').modelError, /HTTP 400.*未自动重试/);
  assert.doesNotMatch(JSON.stringify(chunks), /正在重试|private-id|private-gateway-body|private-provider-code|studio-fixture-key/);
});

test('the engine keeps provider cache hits and reasoning separate from the already-inclusive token totals', async t => {
  const answer = final('Completed.');
  answer.at(-1).usage = { ...usage, prompt_tokens_details: { cached_tokens: 7 },
    completion_tokens_details: { reasoning_tokens: 2 } };
  const f = await setup(t, [answer]);
  const chunks = await collect(f.runtime.stream(f.options));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'usage'), [{ type: 'usage', usage: {
    inputTokens: 10, outputTokens: 5, cachedInputTokens: 7, reasoningTokens: 2,
  } }]);
});

test('an invalid executable fails initialization without exiting Studio', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-engine-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createNativeEngineRuntime({ stateRoot: join(root, 'state'), env: {
    AGENTKIT_ENGINE_COMMAND: join(root, 'missing-engine'),
  } });
  await assert.rejects(collect(runtime.stream({ input: 'Hello', cwd: root, sessionId: 'fixture', model: 'fixture',
    modelProvider: { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture' } })), { code: 'NATIVE_ENGINE_UNAVAILABLE' });
});

test('consecutive identical inputs without a turn ID start different Runs', async t => {
  const f = await setup(t, [final('Done.')]);
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const chunks = await collect(f.runtime.stream({ ...f.options, turnId: '' }));
    runs.push(chunks.find(chunk => chunk.type === 'engine-event').runId);
  }
  assert.notEqual(runs[0], runs[1]);
});

test('an approved turn writes the file and streams engine progress as ordinary runtime chunks', async t => {
  const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('Created out.txt.')]);
  const approvals = [];
  const chunks = await collect(f.runtime.stream({ ...f.options, requestApproval: async info => { approvals.push(info); return 'allowed-once'; } }));
  assert.equal(readFileSync(join(f.cwd, 'out.txt'), 'utf8'), 'hi\n');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'native/write_workspace_file');
  assert.match(approvals[0].reason, /out\.txt/);
  const engine = chunks.find(chunk => chunk.type === 'engine').engine;
  assert.equal(engine.protocol, 'agentkit.engine/v1'); assert.equal(engine.preset.preset, 'official');
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'tool'), [{ type: 'tool', name: 'write_workspace_file', phase: 'completed' }]);
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning' && chunk.text === 'Writing the file now.'));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text'), [{ type: 'text', text: 'Created out.txt.' }]);
  assert.ok(chunks.filter(chunk => chunk.type === 'usage').every(chunk => chunk.usage.inputTokens === 10 && chunk.usage.outputTokens === 5));
  // Studio's instructions reach the model inside the engine's Host slot; the base prompt is the engine's.
  const system = f.model.requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('You are the Studio release agent.') && system.includes('<host_instructions'));
  assert.ok(!JSON.stringify(chunks).includes('studio-fixture-key'));
});

test('a turn without an approval seat cannot write, and a declined approval leaves the workspace untouched', async t => {
  for (const requestApproval of [undefined, async () => 'denied']) {
    const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('The write was not permitted.')]);
    const chunks = await collect(f.runtime.stream({ ...f.options, ...(requestApproval ? { requestApproval } : {}) }));
    assert.equal(existsSync(join(f.cwd, 'out.txt')), false);
    assert.ok(chunks.some(chunk => chunk.type === 'tool' && chunk.phase === 'failed'));
  }
});

test('configuration decides which engine runs; missing prerequisites fail with typed errors', async t => {
  assert.deepEqual(resolveEngineCommand({ AGENTKIT_ENGINE_COMMAND: '/opt/engine/bin/agentkit-engine', AGENTKIT_ENGINE_ARGS: '["--flag"]' }),
    { command: '/opt/engine/bin/agentkit-engine', args: ['--flag'], source: 'configured' });
  assert.throws(() => resolveEngineCommand({ AGENTKIT_ENGINE_COMMAND: 'x', AGENTKIT_ENGINE_ARGS: '{}' }), { code: 'NATIVE_ENGINE_CONFIG_INVALID' });
  assert.throws(() => resolveEngineCommand({}), { code: 'NATIVE_ENGINE_UNAVAILABLE' });
  const f = await setup(t, [final('unused')]);
  await assert.rejects(collect(f.runtime.stream({ ...f.options, cwd: '' })), { code: 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE' });
  await assert.rejects(collect(f.runtime.stream({ ...f.options, modelProvider: {} })), { code: 'NATIVE_ENGINE_MODEL_UNAVAILABLE' });
  const broken = createNativeEngineRuntime({ stateRoot: join(tmpdir(), 'studio-engine-broken'), env: { PATH: process.env.PATH },
    resolveCommand: () => ({ command: process.execPath, args: ['-e', 'process.exit(3)'] }) });
  await assert.rejects(collect(broken.stream(f.options)), { code: 'NATIVE_ENGINE_UNAVAILABLE' });
  assert.equal(f.model.requests.length, 0);
});

test('Studio resource tools run through Studio\'s own handler, with engine-refused names aliased and mapped back', async t => {
  const longName = 'mcp__knowledge-base.prod__search_documents_by_semantic_similarity_v2';
  const f = await setup(t, []);
  const handled = [];
  // The model calls whatever name the engine advertised; read it back from the first request.
  let advertised = [];
  const runtime = f.runtime;
  const original = f.model;
  const chunks = [];
  const stream = runtime.stream({ ...f.options, input: 'Find the refund policy.',
    dynamicTools: [
      { type: 'function', name: longName, description: 'Semantic search.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { type: 'function', name: 'run_command', description: 'A Studio tool that clashes with an engine tool.', inputSchema: { type: 'object', properties: {} } },
    ],
    toolHandler: async call => { handled.push(call); if (call.name === 'run_command') throw new Error('should not be reached'); return [{ type: 'inputText', text: 'Refunds within 30 days.' }]; } });
  // Drive the fixture by name once the engine has advertised its tools.
  original.respond = body => {
    advertised = body.tools.map(tool => tool.function.name);
    const alias = advertised.find(name => name.startsWith('host_mcp__knowledge-base_prod__'));
    return original.requests.length === 1 ? toolCall('call_kb', alias, { query: 'refund' }) : final('Refunds are accepted within 30 days.');
  };
  for await (const chunk of stream) chunks.push(chunk);
  const alias = advertised.find(name => name.startsWith('host_mcp__knowledge-base_prod__'));
  assert.ok(alias && alias.length <= 64, advertised.join(','));
  assert.ok(advertised.includes('run_command') && advertised.filter(name => name.startsWith('host_run_command_')).length === 1);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].name, longName);
  assert.deepEqual(handled[0].arguments, { query: 'refund' });
  assert.ok(JSON.stringify(original.requests[1].messages).includes('Refunds within 30 days.'));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text'), [{ type: 'text', text: 'Refunds are accepted within 30 days.' }]);
});

test('the engine view is fetched once per build, cached by hash, and each engine event is surfaced for the Session', async t => {
  const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('Created out.txt.')]);
  const chunks = await collect(f.runtime.stream({ ...f.options, requestApproval: async () => 'allowed-once' }));
  const engine = chunks.find(chunk => chunk.type === 'engine');
  assert.match(engine.view, /^[a-f0-9]{64}$/);
  const html = f.runtime.view(engine.view);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal(f.runtime.view('0'.repeat(64)), null); assert.equal(f.runtime.view('../etc'), null);
  const events = chunks.filter(chunk => chunk.type === 'engine-event');
  assert.ok(events.length > 3 && events.every(chunk => chunk.view === engine.view && chunk.runId === events[0].runId));
  assert.deepEqual(events.map(chunk => chunk.event.seq), [...events.map(chunk => chunk.event.seq)].sort((a, b) => a - b));
  assert.ok(events.some(chunk => chunk.event.kind === 'tool.completed' && chunk.event.callId === 'call_1'));
  const { nativeEngineViewResponse } = await import('../src/host/routes/native-engine-view.mjs');
  const ok = nativeEngineViewResponse(new Request(`http://studio/api/agentkit.native-engine.view?sha256=${engine.view}`), f.runtime);
  assert.equal(ok.status, 200); assert.match(ok.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal(await ok.text(), html);
  for (const bad of ['', 'abc', '0'.repeat(64)]) assert.equal(nativeEngineViewResponse(new Request(`http://studio/x?sha256=${bad}`), f.runtime).status, 404);
});

test('the Session permission mode decides writes when no approval seat exists, and history reaches the engine', async t => {
  const { engineConversation } = await import('../src/providers/native-engine-runtime.mjs');
  assert.deepEqual(engineConversation([{ role: 'user', content: 'Fix calc.py' }, { role: 'assistant', content: [{ type: 'text', text: 'Failed.' }] },
    { role: 'user', source: { kind: 'notice' }, content: 'background done' }, { role: 'tool', content: 'x' }, { role: 'user', content: 'retry' }], 'retry'),
  [{ role: 'user', text: 'Fix calc.py' }, { role: 'assistant', text: 'Failed.' }]);
  for (const [sandbox, written] of [['workspace-write', true], ['danger-full-access', true], ['read-only', false], [undefined, false]]) {
    const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('Done.')]);
    await collect(f.runtime.stream({ ...f.options, ...(sandbox ? { sandbox } : {}), input: 'retry',
      messages: [{ role: 'user', content: 'Create out.txt.' }, { role: 'assistant', content: 'Failed earlier.' }, { role: 'user', content: 'retry' }] }));
    assert.equal(existsSync(join(f.cwd, 'out.txt')), written, String(sandbox));
    const sent = JSON.stringify(f.model.requests[0].messages);
    assert.ok(sent.includes('User: Create out.txt.') && sent.includes('Assistant: Failed earlier.'));
  }
});

test('an independent service honors full Session access with a strict Agent policy', async t => {
  const createEngineService = await createTestService();
  const token = 'fixture-studio-permission-token';
  const contract = 'agentkit.native-agent-policy/v1';
  for (const [sandbox, mode, rules, writes] of [
    ['danger-full-access', 'strict', {}, true],
    ['workspace-write', 'strict', {}, false],
    ['danger-full-access', 'custom', { write_workspace_file: 'deny' }, false],
  ]) {
    const f = await setup(t, [toolCall('call_1', 'write_workspace_file', { path: 'out.txt', content: 'hi\n' }), final('Done.')]);
    if (mode === 'custom') f.model.respond = request => {
      assert.ok(!request.tools.some(tool => tool.function.name === 'write_workspace_file'));
      return final('Write tool unavailable.');
    };
    const service = createEngineService({ token, startup: { workspace: f.cwd, stateDir: join(f.cwd, '..', 'service-state'),
      model: { name: 'fixture-model', baseUrl: f.model.url, apiKeyEnv: 'MODEL_KEY' },
      scope: { tenantId: 'local', workspaceId: 'fixture', userId: 'user', agentId: 'agent' } }, env: { MODEL_KEY: 'fixture-key' } });
    t.after(() => service.close());
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const runtime = createNativeEngineRuntime({ stateRoot: join(f.cwd, '..', 'host-state'), env: {
      AGENTKIT_ENGINE_SERVICE_URL: 'http://127.0.0.1:' + service.server.address().port,
      AGENTKIT_ENGINE_SERVICE_TOKEN: token, AGENTKIT_ENGINE_SERVICE_WORKSPACE: f.cwd,
    } });
    let prompts = 0;
    await collect(runtime.stream({ ...f.options, sandbox, agentToolPolicy: { contract, mode, rules },
      requestPolicyApproval: async () => { prompts++; return 'denied'; }, signal: AbortSignal.timeout(10000) }));
    assert.equal(existsSync(join(f.cwd, 'out.txt')), writes, `${sandbox} / ${mode}`);
    assert.equal(prompts, sandbox === 'workspace-write' ? 1 : 0);
  }
});

test('only a negotiated image-capable engine receives current-turn image input', async t => {
  const f = await setup(t, [final('Image received.')]);
  const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  const inputImages = [{ type: 'image_url', image_url: { url } }];
  await assert.rejects(collect(f.runtime.stream({ ...f.options, inputImages })), { code: 'NATIVE_ENGINE_IMAGE_UNAVAILABLE' });
  assert.equal(f.model.requests.length, 0);
  const chunks = await collect(f.runtime.stream({ ...f.options, input: '', inputImages,
    modelProvider: { ...f.options.modelProvider, images: true } }));
  assert.equal(chunks.findLast(chunk => chunk.type === 'text')?.text, 'Image received.');
  const user = f.model.requests[0].messages.findLast(message => message.role === 'user');
  assert.equal(user.content.find(part => part.type === 'image_url')?.image_url.url, url);
  assert.doesNotMatch(JSON.stringify(chunks), /data:image/);
});

test('Workspace Write auto-allows scoped writes and read-only commands, but prompts for a shell mutation', {
}, async t => {
  const f = await setup(t, [
    toolCall('write', 'write_workspace_file', { path: 'out.txt', content: 'fixture' }),
    toolCall('read', 'run_command', { command: 'cat out.txt' }),
    toolCall('shell', 'run_command', { command: 'printf changed > side.txt' }),
    toolCall('blocked', 'run_command', { command: 'rm -r scratch' }),
    final('Done.'),
  ]);
  const runtime = await serviceRuntime(t, f);
  const approvals = [];
  const chunks = await collect(runtime.stream({ ...f.options, sandbox: 'workspace-write',
    requestApproval: async request => { approvals.push(request.toolName); return 'allowed-once'; } }));
  assert.deepEqual(approvals, ['native/run_command']);
  assert.equal(readFileSync(join(f.cwd, 'out.txt'), 'utf8'), 'fixture');
  assert.equal(readFileSync(join(f.cwd, 'side.txt'), 'utf8'), 'changed');
  const blocked = chunks.find(chunk => chunk.event?.kind === 'tool.completed' && chunk.event?.callId === 'blocked')?.event;
  assert.equal(blocked.result.error_type, 'command_policy_blocked');
  assert.equal(blocked.result.executed, false);
  assert.match(blocked.result.finding.detail, /blocked by the command policy/);
  assert.equal(chunks.some(chunk => chunk.event?.kind === 'approval.requested' && chunk.event?.callId === 'blocked'), false);
});

test('Studio verifies only an explicit acceptance command on the delivered workspace revision', {
}, async t => {
  for (const stale of [false, true]) {
    const f = await setup(t, [
      toolCall('write', 'write_workspace_file', { path: 'out.txt', content: 'fixture' }),
      toolCall('test', 'run_command', { command: 'test -f out.txt' }),
      ...(stale ? [toolCall('late', 'write_workspace_file', { path: 'late.txt', content: 'unverified change' })] : []),
      final('Done.'),
    ]);
    const runtime = await serviceRuntime(t, f);
    const chunks = await collect(runtime.stream({ ...f.options, sandbox: 'workspace-write',
      requestPolicyApproval: async () => 'allowed-once',
      input: 'Create out.txt.\n验收命令：`test -f out.txt`' }));
    const terminal = chunks.find(chunk => chunk.event?.kind === 'run.terminal')?.event;
    assert.equal(terminal?.status, stale ? 'blocked' : 'verified', JSON.stringify(terminal));
    assert.equal(terminal?.reason, stale ? 'required_acceptance_blocked' : 'required_acceptance_verified');
  }
});

test('acceptance ignores unrelated success and rejects failed or stale matching receipts', () => {
  const objective = 'Create out.txt.\nAcceptance command: `node test.mjs`';
  const verifier = nativeEngineVerification({ objective, runId: 'fixture' });
  assert.equal(nativeEngineVerification({ objective: 'Run node test.mjs', runId: 'fixture' }), null);
  const receipt = { eventId: 'receipt', status: 'ok', call: { name: 'run_command', arguments: { command: 'node test.mjs' } },
    content: { status: 'completed', evidence_incomplete: false, exit_code: 0 },
    workspaceChangeObservation: { status: 'captured', revision: 'current' } };
  const check = calls => verifier.verify({ contract: verifier.definition.contract, definition: verifier.definition,
    runId: 'fixture', goal: objective, workspaceRevision: 'current', operationKey: 'verify', inputDigest: 'input', evidence: { calls } });
  assert.equal(check([receipt]).status, 'passed');
  assert.equal(check([{ ...receipt, content: { ...receipt.content, exit_code: 1 } }, receipt]).status, 'failed');
  assert.equal(check([{ ...receipt, workspaceChangeObservation: { status: 'captured', revision: 'previous' } }]).status, 'blocked');
  assert.equal(check([{ ...receipt, call: { ...receipt.call, arguments: { command: 'true' } } }]).status, 'blocked');
});

async function serviceRuntime(t, f, { images = false } = {}) {
  const createEngineService = await createTestService();
  const token = 'fixture-studio-service-approval-token';
  const service = createEngineService({ token, startup: { workspace: f.cwd, stateDir: join(f.cwd, '..', 'service-state'),
    model: { name: 'fixture-model', baseUrl: f.model.url, apiKeyEnv: 'MODEL_KEY', images },
    scope: { tenantId: 'local', workspaceId: 'fixture', userId: 'user', agentId: 'agent' } }, env: { MODEL_KEY: 'fixture-key' } });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  return createNativeEngineRuntime({ stateRoot: join(f.cwd, '..', 'studio-state'), env: {
    AGENTKIT_ENGINE_SERVICE_URL: 'http://127.0.0.1:' + service.server.address().port,
    AGENTKIT_ENGINE_SERVICE_TOKEN: token, AGENTKIT_ENGINE_SERVICE_WORKSPACE: f.cwd, AGENTKIT_ENGINE_SERVICE_MODEL: 'fixture-model',
  } });
}

test('reconnecting an active Run refuses a replacement service that lacks its tool policy', async () => {
  const { connectEngineService } = await import('../src/providers/engine-service-client.mjs');
  const contract = 'agentkit.native-agent-policy/v1';
  const calls = [];
  let replaced = false;
  const engine = connectEngineService({
    endpoint: 'http://127.0.0.1:8787', token: 'fixture-engine-service-token', sessionId: 'fixture',
    requiredToolPolicy: contract, onApproveTool: async () => 'allow',
    fetchImpl: async (_url, request) => {
      const frame = JSON.parse(request.body);
      calls.push(frame.method);
      if (frame.method === 'run/events') return Response.json({ error: 'session_not_found' }, { status: 404 });
      return Response.json({ jsonrpc: '2.0', id: frame.id, result: { capabilities: replaced
        ? { approvals: 'durable' } : { approvals: 'durable', toolPolicy: contract } } });
    },
  });
  try {
    await engine.initialize();
    replaced = true;
    await assert.rejects(engine.events('active-run'), { code: 'NATIVE_ENGINE_TOOL_POLICY_UNAVAILABLE' });
    assert.deepEqual(calls, ['initialize', 'run/events', 'initialize']);
  } finally { await engine.close(); }
});

test('an attached event cursor survives repeated transport failures and reinitializes the same session', async t => {
  const { connectEngineService } = await import('../src/providers/engine-service-client.mjs');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const engine = connectEngineService({
    endpoint: 'http://127.0.0.1:8787', token: 'fixture-engine-service-token', sessionId: 'fixture', runId: 'active-run',
    fetchImpl: async (url, request) => {
      assert.match(url, /\/v1\/sessions\/fixture\/rpc$/);
      const frame = JSON.parse(request.body);
      calls.push({ method: frame.method, params: frame.params });
      if (calls.length <= 2) {
        now += 35000;
        throw new DOMException('request deadline elapsed', 'TimeoutError');
      }
      if (calls.length === 3) return { ok: true, async json() {
        throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } });
      } };
      if (calls.length === 4) return Response.json({ error: 'session_not_found' }, { status: 404 });
      if (frame.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: frame.id, result: {} });
      return Response.json({ jsonrpc: '2.0', id: frame.id, result: { events: [], cursor: 73, running: true } });
    },
  });
  try {
    assert.equal((await engine.events('active-run', 73, 5000, 'original-thinking', 'original-tool')).cursor, 73);
    assert.deepEqual(calls.map(call => call.method), [
      'run/events', 'run/events', 'run/events', 'run/events', 'initialize', 'run/events',
    ]);
    for (const call of calls.filter(call => call.method === 'run/events')) assert.deepEqual(call, calls[0]);
  } finally { await engine.close(); }
});

test('a duplicate Host frame resends only the cached reply after a lost acknowledgement', async () => {
  const { connectEngineService } = await import('../src/providers/engine-service-client.mjs');
  const received = Promise.withResolvers();
  let dispatches = 0, deliveries = 0;
  const replies = [];
  const frame = { id: 'engine-fixture', method: 'host/callTool', expiresAt: Date.now() + 10000, params: { runId: 'original' } };
  const engine = connectEngineService({
    endpoint: 'http://127.0.0.1:8787', token: 'fixture-engine-service-token', sessionId: 'fixture', runId: 'original',
    onCallTool: async () => { dispatches++; await sleep(200); return { status: 'ok', content: 'saved once' }; },
    fetchImpl: async (url, options) => {
      const address = new URL(url);
      if (address.pathname.endsWith('/host-requests')) {
        assert.equal(address.searchParams.get('runId'), 'original');
        assert.match(address.searchParams.get('receiver'), /^[a-f0-9-]{36}$/);
        deliveries++;
        return Response.json({ requests: [frame] });
      }
      const request = JSON.parse(options.body);
      if (address.pathname.endsWith('/host-reply')) {
        replies.push(request);
        if (replies.length === 1) throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } });
        received.resolve();
        return Response.json({ accepted: true });
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } });
    },
  });
  try {
    await engine.initialize();
    await Promise.race([received.promise, sleep(5000, null, { ref: false }).then(() => assert.fail('Host reply did not recover'))]);
    assert.ok(deliveries >= 2);
    assert.equal(dispatches, 1);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0], replies[1]);
  } finally { await engine.close(); }
});

test('turn cancellation stops reconnecting and authorization failures are not retried', async () => {
  const { connectEngineService } = await import('../src/providers/engine-service-client.mjs');
  const run = new AbortController(), sent = Promise.withResolvers();
  let attempts = 0;
  const options = { endpoint: 'http://127.0.0.1:8787', token: 'fixture-engine-service-token', sessionId: 'fixture', runId: 'active-run' };
  const engine = connectEngineService({ ...options, runSignal: run.signal, fetchImpl: async () => {
    attempts++;
    sent.resolve();
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  } });
  const forbidden = connectEngineService({ ...options, fetchImpl: async () => {
    attempts++;
    return new Response(null, { status: 403 });
  } });
  try {
    const pending = engine.events('active-run');
    await sent.promise;
    run.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(forbidden.events('active-run'), /engine_service_http_403/);
    assert.equal(attempts, 2);
  } finally { await engine.close(); await forbidden.close(); }
});

test('Studio follows the same Run after service replacement without rerunning a committed tool', { timeout: 15000 }, async t => {
  const f = await setup(t, []);
  const createEngineService = await createTestService();
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.model.respond = async () => {
    const n = f.model.requests.length;
    if (n === 1) return toolCall('first-write', 'write_workspace_file', { path: 'out.txt', content: 'settled before disconnect\n' });
    if (n === 2) { reached.resolve(); await release.promise; }
    return final('Continued after reconnect.');
  };
  const token = 'fixture-studio-replacement-token';
  let port = 0, service;
  async function start() {
    service = createEngineService({ startup: { workspace: f.cwd, stateDir: join(f.cwd, '..', 'restart-state'),
      model: { name: 'fixture-model', baseUrl: f.model.url, apiKeyEnv: 'MODEL_KEY' },
      scope: { tenantId: 'local', workspaceId: 'fixture', userId: 'user', agentId: 'agent' } }, token, env: { MODEL_KEY: 'fixture-key' } });
    await new Promise(resolve => service.server.listen(port, '127.0.0.1', resolve));
    port = service.server.address().port;
  }
  await start();
  t.after(() => service?.close());
  const runtime = createNativeEngineRuntime({ stateRoot: join(f.cwd, '..', 'studio-state'), env: {
    AGENTKIT_ENGINE_SERVICE_URL: 'http://127.0.0.1:' + port,
    AGENTKIT_ENGINE_SERVICE_TOKEN: token, AGENTKIT_ENGINE_SERVICE_WORKSPACE: f.cwd,
  } });
  const signal = AbortSignal.timeout(12000);
  const chunks = [];
  const observedWrite = Promise.withResolvers();
  const consuming = (async () => {
    for await (const chunk of runtime.stream({ ...f.options, sandbox: 'danger-full-access', signal })) {
      chunks.push(chunk);
      if (chunk.event?.kind === 'tool.completed') observedWrite.resolve();
    }
  })();
  consuming.catch(() => {});
  await Promise.race([Promise.all([reached.promise, observedWrite.promise]), consuming.then(() => assert.fail('Run ended before disconnect'))]);
  const path = join(f.cwd, 'out.txt'), before = statSync(path, { bigint: true });
  await service.close();
  service = null;
  release.resolve();
  await sleep(650);
  await start();
  await consuming;
  const after = statSync(path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  const events = chunks.filter(chunk => chunk.type === 'engine-event');
  assert.equal(new Set(events.map(chunk => chunk.runId)).size, 1);
  assert.equal(events.filter(chunk => chunk.event.kind === 'run.started').length, 1);
  assert.equal(events.filter(chunk => chunk.event.kind === 'tool.completed').length, 1);
  assert.equal(events.filter(chunk => chunk.event.kind === 'run.terminal').length, 1);
  assert.match(chunks.findLast(chunk => chunk.type === 'text').text, /Continued after reconnect/);
  assert.equal(f.model.requests.length, 3);
  assert.ok(f.model.requests.at(-1).messages.some(message => message.role === 'tool'));
});

test('an uncertain bound A2A Send pauses the independent Run without a model retry', async t => {
  const f = await setup(t, [toolCall('reused-model-id', 'call_a2a_agent', { agent: 'research', message: 'check' })]);
  const createEngineService = await createTestService();
  const token = 'fixture-studio-engine-effects-token';
  const service = createEngineService({ startup: { workspace: f.cwd, stateDir: join(f.cwd, '..', 'service-state'),
    model: { name: 'fixture-model', baseUrl: f.model.url, apiKeyEnv: 'MODEL_KEY' },
    scope: { tenantId: 'local', workspaceId: 'fixture', userId: 'user', agentId: 'agent' } }, token, env: { MODEL_KEY: 'fixture-key' } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const runtime = createNativeEngineRuntime({ stateRoot: join(f.cwd, '..', 'host-state'), env: {
    AGENTKIT_ENGINE_SERVICE_URL: 'http://127.0.0.1:' + service.server.address().port,
    AGENTKIT_ENGINE_SERVICE_TOKEN: token, AGENTKIT_ENGINE_SERVICE_WORKSPACE: f.cwd,
  } });
  const effectProtocol = 'agentkit.engine-host-tool-effect/v1';
  const requests = [];
  const chunks = await collect(runtime.stream({ ...f.options, sandbox: 'workspace-write', signal: AbortSignal.timeout(10000),
    dynamicTools: [{ name: 'call_a2a_agent', inputSchema: { type: 'object' }, effectProtocol }],
    toolHandler: async () => assert.fail('bound A2A must use its owned handler'),
    nativeHostToolHandler: async request => {
      requests.push(request);
      assert.equal(request.effect.contract, effectProtocol);
      return { status: 'uncertain', content: { code: 'remote_reply_unknown' } };
    },
  }));
  assert.equal(requests.length, 1);
  assert.equal(f.model.requests.length, 1);
  assert.ok(chunks.some(chunk => chunk.type === 'engine-event' && chunk.event?.status === 'uncertain')
    || chunks.some(chunk => chunk.type === 'text' && /effect_outcome_unknown|任务已暂停/.test(chunk.text)));
});

test('two workspace bindings isolate writes, model traffic and Run history even with identical Session and Run IDs', async t => {
  const createEngineService = await createTestService();
  const projects = await Promise.all(['Alpha', 'Beta'].map(async (label, i) => {
    const project = await setup(t, [
      toolCall('same-call', 'write_workspace_file', { path: 'out.txt', content: label + '\n' }),
      final(label + ' complete.'),
      final(label + ' resumed.'),
    ]);
    const tokenEnv = 'TEST_ENGINE_TOKEN_' + i, token = 'test-isolated-harness-token-' + i;
    const service = createEngineService({ token, startup: {
      workspace: project.cwd, stateDir: join(project.cwd, '..', 'isolated-engine'),
      model: { name: label, baseUrl: project.model.url, apiKeyEnv: 'TEST_MODEL_KEY' },
      scope: { tenantId: 'local', workspaceId: label, userId: 'user', agentId: 'agent' },
    }, env: { TEST_MODEL_KEY: 'fixture-key' } });
    t.after(() => service.close());
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    return { ...project, label, token, binding: { workspace: project.cwd, tokenEnv, model: label,
      endpoint: 'http://127.0.0.1:' + service.server.address().port } };
  }));
  const [alpha, beta] = projects, stateRoot = join(alpha.cwd, '..', 'studio-shared-state');
  const env = { AGENTKIT_ENGINE_SERVICE_WORKSPACES: JSON.stringify(projects.map(project => project.binding)),
    ...Object.fromEntries(projects.map(project => [project.binding.tokenEnv, project.token])) };
  const open = () => createNativeEngineRuntime({ stateRoot, env, resolveCommand: () => assert.fail('HTTP must never fall back to a process') });
  const runtime = open();
  assert.deepEqual(runtime.serviceModels, ['Alpha', 'Beta']);
  assert.equal(runtime.serviceWorkspace(undefined), undefined);
  const turn = (runtime, project, turnId, input = 'Write out.txt') =>
    collect(runtime.stream({ cwd: project.cwd, input, sessionId: 'same-session', turnId, sandbox: 'danger-full-access' }));
  const first = await turn(runtime, alpha, '1');
  assert.equal(beta.model.requests.length, 0);
  assert.equal(existsSync(join(beta.cwd, 'out.txt')), false);
  const second = await turn(runtime, beta, '1');
  const terminal = chunks => chunks.findLast(chunk => chunk.event?.kind === 'run.terminal');
  assert.equal(terminal(first).runId, terminal(second).runId);
  assert.equal(first.findLast(chunk => chunk.type === 'text').text, 'Alpha complete.');
  assert.equal(second.findLast(chunk => chunk.type === 'text').text, 'Beta complete.');
  const restartedStudio = open();
  const result = await turn(restartedStudio, alpha, '2', 'Continue the original session.');
  assert.equal(result.findLast(chunk => chunk.type === 'text').text, 'Alpha resumed.');
  assert.match(JSON.stringify(alpha.model.requests[2].messages), /Alpha complete/);
  assert.doesNotMatch(JSON.stringify(alpha.model.requests[2].messages), /Beta complete/);
  assert.equal(beta.model.requests.length, 2);
  for (const project of projects) {
    assert.equal(runtime.serviceWorkspace(project.cwd).modelSelection.model, project.label);
    assert.ok(project.model.requests.every(request => request.model === project.label));
    assert.equal(readFileSync(join(project.cwd, 'out.txt'), 'utf8'), project.label + '\n');
    assert.ok(await restartedStudio.readDeliveryEvidence({ cwd: project.cwd, sessionId: 'same-session', runId: terminal(first).runId }));
  }
  await assert.rejects(turn(runtime, { cwd: stateRoot }, '1'), { code: 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE' });
  for (const duplicate of [
    { ...beta.binding, workspace: alpha.cwd },
    { ...beta.binding, endpoint: alpha.binding.endpoint + '/' },
    { ...beta.binding, tokenEnv: alpha.binding.tokenEnv },
  ]) {
    assert.throws(() => createNativeEngineRuntime({ stateRoot, env: { ...env,
      AGENTKIT_ENGINE_SERVICE_WORKSPACES: JSON.stringify([alpha.binding, duplicate]) } }), { code: 'NATIVE_ENGINE_CONFIG_INVALID' });
  }
});


test('Native body previews reach Studio before completion and preserve exactly one final answer', { timeout: 15000,
}, async t => {
  const f = await setup(t, []);
  const next = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => { next.resolve(); finish.resolve(); });
  let finished = false;
  f.model.stream = async (request, response) => {
    assert.equal(request.stream, true);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = delta => response.write(`data: ${JSON.stringify({ id: 'live-text', choices: [{ index: 0, delta }] })}\n\n`);
    send({ role: 'assistant', content: 'First part. ' });
    await next.promise;
    send({ content: 'Second part.' });
    await finish.promise;
    finished = true;
    response.end(`data: ${JSON.stringify({ id: 'live-text', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
  };
  const runtime = await serviceRuntime(t, f), previews = [], finals = [];
  for await (const chunk of runtime.stream({ ...f.options, signal: AbortSignal.timeout(12000) })) {
    if (chunk.type === 'engine-text') {
      assert.equal(finished, false, 'a terminal-only implementation would deadlock here');
      previews.push(chunk);
      if (chunk.delta === 'First part. ') next.resolve();
      if (chunk.delta === 'Second part.') finish.resolve();
    }
    if (chunk.type === 'text') finals.push(chunk.text);
  }
  assert.deepEqual(previews.map(p => p.delta), ['First part. ', 'Second part.']);
  assert.equal(previews[0].requestId, previews[1].requestId);
  assert.notEqual(previews[0].cursor, previews[1].cursor);
  assert.deepEqual(finals, ['First part. Second part.']);
});


test('Studio model capabilities come from the bound service and image inputs reach that exact model', async t => {
  const { createHarnessServiceModelAdapter } = await import('../src/providers/native-engine-runtime.mjs');
  const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  for (const images of [false, true]) {
    const f = await setup(t, [final('Image received.')]);
    const runtime = await serviceRuntime(t, f, { images });
    const adapter = createHarnessServiceModelAdapter(class {}, ['fixture-model'], model => runtime.serviceModelInfo(model));
    assert.deepEqual((await adapter.resolveModel('Harness', 'fixture-model')).modalities, images ? ['text', 'image'] : ['text']);
    const run = collect(runtime.stream({ ...f.options, inputImages: [{ type: 'image_url', image_url: { url } }] }));
    if (!images) {
      await assert.rejects(run, { code: 'NATIVE_ENGINE_IMAGE_UNAVAILABLE' });
      assert.equal(f.model.requests.length, 0);
    } else {
      assert.equal((await run).findLast(chunk => chunk.type === 'text').text, 'Image received.');
      assert.ok(f.model.requests.some(request => request.messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'image_url' && part.image_url.url === url))));
    }
  }
});

test('a committed provider backoff explains the wait before any retry actually starts', { timeout: 15000,
}, async t => {
  const f = await setup(t, [{ status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'rate_limit' } } }, final('Recovered without resending.')]);
  const runtime = await serviceRuntime(t, f), events = [], started = Date.now();
  for await (const chunk of runtime.stream({ ...f.options, signal: AbortSignal.timeout(12000) })) {
    if (chunk.type !== 'engine-event') continue;
    events.push(chunk.event);
    if (chunk.event.kind === 'model.retry_scheduled') {
      assert.equal(f.model.requests.length, 1);
      assert.equal(chunk.event.httpStatus, 429);
      assert.ok(chunk.event.retryAt >= started + 900);
      assert.equal(events.some(event => event.kind === 'effect.prepared' && event.retry === true), false);
    }
  }
  const scheduled = events.findIndex(event => event.kind === 'model.retry_scheduled');
  const retry = events.findIndex(event => event.kind === 'effect.prepared' && event.retry === true);
  assert.ok(scheduled >= 0 && retry > scheduled);
  assert.equal(f.model.requests.length, 2);
});
