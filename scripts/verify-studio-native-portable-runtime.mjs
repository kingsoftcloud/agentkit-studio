/** Archive-present portable Frozen HTTP acceptance.
 *
 *  The real DSH SDK drives a complete Native Run through the packed Studio
 *  Host's production Frozen HTTP transport. The portable archive is PRESERVED
 *  so loadPortableRuntime activates inside mountStudioHost, triggering
 *  bindFrozenRuntime/startFrozenBuildRuntime. The Frozen runtime uses
 *  UNATTENDED_EXECUTION_POLICY (read-only/never) — a product constraint.
 *
 *  The proof verifies: unauthorized HTTP rejected (401, no model/tool calls);
 *  authorized request drives read → write-deny (policy) → read (bytes unchanged)
 *  → final with exact model call count; original request replay returns the
 *  identical stable response (id, model, status, output_text, usage) with no
 *  new model/tool/Run; real Host close/reopen first replays the original
 *  request (cold idempotency: same response, no new Run), then a new request
 *  continues on the same Session; SQLite ledger has exactly 2 completed runs
 *  with DSH owner/Native configuration verified via readNativeDshOwnership,
 *  exact intent/receipt pairing (callId/name/args/status/policy-denial-reason);
 *  failures array must be empty. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readSse } from '../src/sse.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
const repository = fileURLToPath(new URL('..', import.meta.url)), source = resolve(values.source);
const root = await mkdtemp(join(tmpdir(), 'studio-native-portable-runtime-'));
console.log(`Studio Native portable runtime evidence: ${root}`);
let harness;
const requests = [], failures = [];

const archiveBytes = await readFile(resolve(values.archive));
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
const sourceHead = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const runtimeToken = 'portable-runtime-proof-token-0123456789';
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const runtimePort = portProbe.address().port;
portProbe.close();

const workspaceRoot = join(root, 'workspace');
const originalBytes = 'Original frozen bytes.';

// Model server: Turn 1 = read(0) → write-deny(1) → read(2) → final(3) = 4 calls.
// Turn 2 (after restart) = read(0 within its own run) → final(1) = 2 calls.
// The step counter resets per Run because each Run starts a fresh model conversation.
// We detect turn boundaries by the user prompt text.
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(body.model, 'pinned');
    const toolResults = body.messages.filter(message => message.role === 'tool');
    const step = toolResults.length;
    const userMessages = body.messages.filter(m => m.role === 'user' && typeof m.content === 'string');
    const isTurn2 = userMessages.some(m => m.content.includes('confirm it holds the original bytes'));
    let call;
    if (!isTurn2) {
      // Turn 1: read → write → read → final (steps 0-3 within this Run).
      if (step === 0) call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } };
      else if (step === 1) call = { name: 'write_workspace_file', arguments: { path: 'target.txt', content: 'Portable runtime evidence.' } };
      else if (step === 2) call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } };
      else call = null;
    } else {
      // Turn 2: read → final. The resumed session carries turn 1's tool results,
      // so step counts are cumulative (3 from turn 1). Turn 2's first request
      // has step=3; after issuing a read (step=4), deliver the final answer.
      if (step <= 3) call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } };
      else call = null;
    }
    if (call) {
      const delta = { tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    } else {
      const text = isTurn2 ? 'Confirmed original bytes.' : 'Portable runtime completed the turn.';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
    }
  } catch (error) {
    failures.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('portable runtime verification failed');
  }
});

function buildOptions(modelUrl, nodeBin) {
  return { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'),
      join(root, 'portable-runtime.patch.yml')], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-portable-runtime-proof', model: 'pinned',
    initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk' } };
}

async function waitForRuntime(runtimeUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const h = await fetch(`${runtimeUrl}/health`); if (h.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph);
  execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai') continue;
    await symlink(join(repository, 'node_modules', name), join(dependencies, name));
  }
  const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(publicPackages)) await symlink(join(publicPackages, name), join(dependencies, '@deepseek-ai', name));
  const pluginDirectory = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(pluginDirectory, { recursive: true });
  await symlink(installed, join(pluginDirectory, 'agentkit-studio'));

  await mkdir(join(installed, 'tests', 'fixtures'), { recursive: true });
  await writeFile(join(installed, 'tests', 'fixtures', 'studio-native-portable-runtime.mjs'),
    await readFile(join(repository, 'tests', 'fixtures', 'studio-native-portable-runtime.mjs')));

  const nodeBin = join(root, 'node-only-bin');
  await mkdir(nodeBin);
  await symlink(process.execPath, join(nodeBin, 'node'));

  const patch = join(root, 'portable-runtime.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: portable-rt-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: portable-rt-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: portable-rt-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: portable-rt-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: portable-rt-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: portable-rt-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: portable-rt-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: portable-rt-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-portable-runtime.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        repository: ${JSON.stringify(installed)}`,
    `        modelUrl: ${JSON.stringify(modelUrl)}`, `        runtimeToken: ${JSON.stringify(runtimeToken)}`,
    `        runtimePort: ${JSON.stringify(runtimePort)}`, '',
  ].join('\n'));

  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = buildOptions(modelUrl, nodeBin);

  // --- First Host lifecycle.
  harness = new DeepSeekHarness(options);
  await harness.start();

  const identityDeadline = Date.now() + 60_000;
  let identity;
  while (Date.now() < identityDeadline) {
    try { identity = JSON.parse(await readFile(join(root, 'portable-runtime-identity.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(identity, 'Portable runtime fixture did not persist identity');
  assert.equal(identity.runtimePort, runtimePort); assert.equal(identity.runtimeToken, runtimeToken);

  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const token = runtimeToken;
  assert.ok(await waitForRuntime(runtimeUrl), 'Frozen HTTP transport did not become ready');

  const report = { passed: false, node: process.version, sourceHead, archiveSha256,
    boundary: 'archive-present loadPortableRuntime to Frozen HTTP; portable-bundle.zip preserved; read-only policy is product constraint; not fresh install',
    runtimePort, identity: { agentId: identity.agentId, buildId: identity.buildId,
      sourcePathLeaked: identity.sourcePathLeaked, sourceSecretLeaked: identity.sourceSecretLeaked } };

  // --- Unauthorized: 401, no model calls.
  const callsBeforeAuth = requests.length;
  const unauth = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'test', session_id: 'conv' }) });
  assert.equal(unauth.status, 401, 'unauthorized must be 401');
  assert.equal(requests.length, callsBeforeAuth, 'unauthorized must not trigger model calls');
  report.unauthorizedRejected = true;

  // --- Authorized request 1: read → write-deny → read → final.
  const firstInput = 'Read target.txt, attempt to write new bytes, then re-read and report.';
  const firstBody = { input: firstInput, session_id: 'portable-rt-session', request_id: 'first' };
  const callsBeforeFirst = requests.length;
  const firstResp = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });
  assert.equal(firstResp.status, 200, `first must be 200: ${firstResp.status}`);
  const first = await firstResp.json();
  assert.ok(first.id, 'first must have id');
  assert.ok(first.output_text, 'first must have output_text');
  assert.equal(first.status, 'completed', `first status must be completed: ${first.status}`);
  assert.ok(first.usage, 'first must have usage');
  assert.equal(first.output_text, 'Portable runtime completed the turn.');
  // Exactly 4 model calls: read + write + read + final.
  assert.equal(requests.length - callsBeforeFirst, 4, `first turn must make exactly 4 model calls: ${requests.length - callsBeforeFirst}`);
  // Write denied by policy: file bytes unchanged.
  assert.equal(await readFile(join(workspaceRoot, 'target.txt'), 'utf8'), originalBytes, 'target.txt unchanged after write-deny');
  report.first = { id: first.id, outputText: first.output_text, model: first.model, status: first.status, usage: first.usage, modelCalls: 4, writeDenied: true };

  // --- Replay (same request_id + session_id): same response, no new calls.
  const callsBeforeReplay = requests.length;
  const replayResp = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });
  assert.equal(replayResp.status, 200, `replay must be 200: ${replayResp.status}`);
  const replay = await replayResp.json();
  assert.deepEqual(replay, first, 'Warm replay preserves the complete public response');
  const streamReplay = async () => {
    const response = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...firstBody, stream: true }) });
    assert.equal(response.status, 200);
    const frames = []; for await (const frame of readSse(response.body)) frames.push(frame);
    assert.equal(frames.at(-1).type, 'response.completed');
    assert.deepEqual(frames.at(-1).response, first);
    assert.equal(frames.filter(frame => frame.type === 'response.tool_result').length, 3);
    assert.equal(frames.filter(frame => frame.type === 'response.tool_result' && frame.is_error).length, 1);
    return frames;
  };
  const warmFrames = await streamReplay();
  // Assert the entire stable response matches (not just id/output_text).
  assert.equal(replay.id, first.id, 'replay id must match');
  assert.equal(replay.output_text, first.output_text, 'replay output_text must match');
  assert.equal(replay.model, first.model, 'replay model must match');
  assert.equal(replay.status, first.status, 'replay status must match');
  assert.deepEqual(replay.usage, first.usage, 'replay usage must match');
  assert.equal(requests.length, callsBeforeReplay, 'replay must not trigger new model calls');
  assert.equal(await readFile(join(workspaceRoot, 'target.txt'), 'utf8'), originalBytes, 'replay must not change file');
  report.replay = { sameResponse: true, noNewModelCalls: true };

  // --- Source leak checks.
  assert.equal(identity.sourcePathLeaked, false, 'source path leaked');
  assert.equal(identity.sourceSecretLeaked, false, 'source secret leaked');

  // --- SQLite: exactly 1 run (replay did not create a new one).
  const sqlitePath = join(root, 'target-home', 'studio', 'native-harness', 'runs.sqlite');
  assert.ok(existsSync(sqlitePath), `SQLite store must exist: ${sqlitePath}`);
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const { canonical } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness-core/dist/index.mjs')).href);
  const { readNativeDshOwnership } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/dsh-turn-ownership.mjs')).href);
  const store = new SqliteRunStore(sqlitePath);
  const wId = createHash('sha256').update(canonical(resolve(workspaceRoot))).digest('hex');
  const scope = { tenantId: 'local', workspaceId: wId, userId: 'local-user', agentId: identity.agentId };
  const runs1 = store.list(scope);
  assert.equal(runs1.length, 1, `exactly 1 run before restart (replay must not create new): ${runs1.length}`);
  assert.equal(runs1[0].phase, 'completed', `run must be completed: ${runs1[0].phase}`);
  assert.equal(runs1[0].buildId, identity.buildId, 'run must use imported Build');

  // Verify DSH owner/Native configuration via readNativeDshOwnership.
  const sessionLogDir = join(root, 'sessions');
  const sessionLogFiles = (await readdir(sessionLogDir, { recursive: true })).filter(f => f.endsWith('session.v4.jsonl'));
  const sessionEvents = (await Promise.all(sessionLogFiles.map(f => readFile(join(sessionLogDir, f), 'utf8')))).flatMap(t => t.trim().split('\n').map(l => JSON.parse(l)));
  const ownerEvents = sessionEvents.filter(e => e.type === 'turn/owner');
  assert.equal(sessionLogFiles.length, 1, 'All HTTP requests target the original persisted Session');
  const sessionId = sessionEvents[0].id;
  assert.equal(runs1[0].sessionId, sessionId);
  assert.equal(ownerEvents.length, 1, `exactly 1 turn/owner before restart: ${ownerEvents.length}`);
  const admission = readNativeDshOwnership(ownerEvents[0].data, { sessionId: sessionEvents[0].id, turn: 1 });
  assert.equal(admission.identity.buildId, identity.buildId, 'owner buildId must match');
  assert.equal(admission.configuration.engine, 'agentkit.native/v1', 'owner engine must be Native');
  assert.equal(admission.identity.runId, runs1[0].runId, 'owner runId must match SQLite run');
  assert.equal(canonical(admission.configuration), canonical(store.load(scope, runs1[0].runId).configuration),
    'canonical(configuration) must equal SQLite record configuration');
  assert.ok(admission.configuration.instructions.includes('PORTABLE_RUNTIME_SYSTEM'), 'owner instructions must include frozen system prompt');

  // Load run 1: exact intent/receipt pairing.
  const record1 = store.load(scope, runs1[0].runId);
  const identityKeys = ['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'];
  assert.deepEqual(admission.identity, Object.fromEntries(identityKeys.map(key => [key, record1.snapshot[key]])));
  assert.equal(record1.snapshot.usage.modelCalls, 4); assert.equal(record1.snapshot.usage.toolCalls, 3);
  assert.equal(record1.snapshot.usage.inputTokens, 20); assert.equal(record1.snapshot.usage.outputTokens, 30);
  function verifyToolPairing(record, events, expectedCalls) {
    const turn = Number(record.snapshot.turnId);
    const intents = record.intents.filter(intent => intent.kind === 'tool');
    const calls = events.filter(event => event.type === 'tool/call' && event.data.turn === turn);
    const results = events.filter(event => event.type === 'tool/result' && event.data.turn === turn);
    assert.equal(intents.length, expectedCalls.length); assert.equal(calls.length, expectedCalls.length); assert.equal(results.length, expectedCalls.length);
    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index], expected = expectedCalls[index];
      assert.equal(intent.payload.calls.length, 1);
      const call = intent.payload.calls[0], receipt = record.receipts.find(row => row.operationKey === intent.operationKey);
      assert.equal(receipt?.status, 'committed'); assert.equal(receipt.result.results.length, 1);
      assert.equal(call.name, expected.name); assert.deepEqual(call.arguments, expected.arguments);
      const projectedCall = calls[index], projectedResult = results[index];
      // Session delivery deliberately gives public call IDs their own stable
      // namespace; they are not the internal ToolRegistry invocation IDs.
      const deliveryIdentity = createHash('sha256').update(canonical({ scope: record.snapshot.scope,
        runId: record.snapshot.runId })).digest('hex');
      const publicCallId = `ak-native-${createHash('sha256').update(canonical({ identity: deliveryIdentity,
        key: `call:${call.callId}` })).digest('hex')}`;
      assert.equal(projectedCall.data.callId, publicCallId); assert.equal(projectedCall.data.name, call.name);
      assert.deepEqual(JSON.parse(projectedCall.data.arguments), call.arguments);
      assert.equal(projectedResult.data.message.toolCallId, publicCallId);
      assert.equal(projectedResult.data.message.source.callId, publicCallId);
      assert.ok(projectedCall.seq < projectedResult.seq);
      const result = receipt.result.results[0];
      assert.equal(result.status, expected.status); assert.equal(projectedResult.data.message.isError, expected.status === 'error');
      if (expected.status === 'ok') assert.ok(result.content.content.includes(originalBytes));
      else { assert.equal(result.content.code, 'STUDIO_NATIVE_PERMISSION_DENIED'); assert.equal(result.content.executed, false); }
    }
  }
  const readCall = { name: 'read_workspace_file', arguments: { path: 'target.txt' }, status: 'ok' };
  verifyToolPairing(record1, sessionEvents, [readCall,
    { name: 'write_workspace_file', arguments: { path: 'target.txt', content: 'Portable runtime evidence.' }, status: 'error' }, readCall]);
  const toolIntents1 = record1.intents.filter(i => i.kind === 'tool');
  // Exactly 3 tool intents: read, write-deny, read.
  assert.equal(toolIntents1.length, 3, `run 1 must have exactly 3 tool intents: ${toolIntents1.length}`);
  const receipts1 = [];
  for (const intent of toolIntents1) {
    const calls = intent.payload.calls ?? [];
    const receipt = record1.receipts.find(r => r.operationKey === intent.operationKey);
    assert.ok(receipt, `intent must have matching receipt`);
    assert.equal(receipt.status, 'committed', `receipt must be committed: ${receipt.status}`);
    assert.equal(calls.length, (receipt.result?.results ?? []).length, `calls.length must equal results.length`);
    for (let j = 0; j < calls.length; j++) {
      const result = receipt.result.results[j];
      receipts1.push({ callId: calls[j].callId, name: calls[j].name, arguments: calls[j].arguments,
        status: result.status, content: result.content });
    }
  }
  store.close();
  // Exact tool sequence: read, write, read.
  assert.deepEqual(receipts1.map(r => r.name), ['read_workspace_file', 'write_workspace_file', 'read_workspace_file'],
    `run 1 tool sequence: ${JSON.stringify(receipts1.map(r => r.name))}`);
  // Write receipt: error with policy denial reason.
  const writeR = receipts1[1];
  assert.equal(writeR.status, 'error', `write receipt must be error: ${writeR.status}`);
  assert.equal(writeR.content?.code, 'STUDIO_NATIVE_PERMISSION_DENIED', `write denial must be policy: ${writeR.content?.code}`);
  assert.equal(writeR.content?.executed, false, `write must not have executed: ${writeR.content?.executed}`);
  // First read (file not found since pre-seeded) and third read (original bytes).
  // Both reads must be ok and contain the original bytes.
  assert.equal(receipts1[0].status, 'ok', `first read must be ok: ${receipts1[0].status}`);
  assert.equal(receipts1[2].status, 'ok', `third read must be ok: ${receipts1[2].status}`);
  assert.ok(receipts1[2].content?.content?.includes(originalBytes), `third read must contain original bytes: ${receipts1[2].content?.content}`);
  report.sqlite = { runCount: 1, runReceipts: receipts1.map(r => ({ callId: r.callId, name: r.name, status: r.status, denialCode: r.content?.code })) };

  // --- Host restart: real close/reopen.
  await harness.close();
  harness = new DeepSeekHarness(buildOptions(modelUrl, nodeBin));
  await harness.start();
  assert.ok(await waitForRuntime(runtimeUrl), 'Frozen HTTP must be ready after restart');

  // --- Cold replay of original first request: same response, no new Run/calls.
  const callsBeforeColdReplay = requests.length;
  const coldReplayResp = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });
  assert.equal(coldReplayResp.status, 200, `cold replay must be 200: ${coldReplayResp.status}`);
  const coldReplay = await coldReplayResp.json();
  assert.deepEqual(coldReplay, first, 'Cold replay preserves the complete public response');
  assert.deepEqual(await streamReplay(), warmFrames, 'Cold SSE preserves original item IDs, indices and tool results');
  assert.equal(coldReplay.id, first.id, 'cold replay id must match original');
  assert.equal(coldReplay.output_text, first.output_text, 'cold replay output_text must match');
  assert.equal(coldReplay.model, first.model, 'cold replay model must match');
  assert.equal(coldReplay.status, first.status, 'cold replay status must match');
  assert.deepEqual(coldReplay.usage, first.usage, 'cold replay usage must match');
  assert.equal(requests.length, callsBeforeColdReplay, 'cold replay must not trigger new model calls');
  assert.equal(await readFile(join(workspaceRoot, 'target.txt'), 'utf8'), originalBytes, 'cold replay must not change file');
  report.coldReplay = { sameResponse: true, noNewModelCalls: true };
  const coldStore = new SqliteRunStore(sqlitePath);
  try { assert.deepEqual(coldStore.list(scope, sessionId).map(row => row.runId), [record1.snapshot.runId]);
    assert.equal(canonical(coldStore.load(scope, record1.snapshot.runId)), canonical(record1), 'Warm/cold replays leave the original Native ledger unchanged');
  } finally { coldStore.close(); }

  // --- New request (different request_id) on same session: new Run, new calls.
  const callsBeforeSecond = requests.length;
  const secondBody = { input: 'Read target.txt and confirm it holds the original bytes.', session_id: 'portable-rt-session', request_id: 'second' };
  const secondResp = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(secondBody) });
  assert.equal(secondResp.status, 200, `second must be 200: ${secondResp.status}`);
  const second = await secondResp.json();
  assert.ok(second.id, 'second must have id');
  assert.notEqual(second.id, first.id, 'second id must differ from first');
  assert.equal(second.status, 'completed', `second status must be completed: ${second.status}`);
  assert.equal(second.output_text, 'Confirmed original bytes.');
  assert.deepEqual(second.conversation, first.conversation); assert.equal(second.session_id, first.session_id);
  // Exactly 2 model calls: read + final.
  assert.equal(requests.length - callsBeforeSecond, 2, `second turn must make exactly 2 model calls: ${requests.length - callsBeforeSecond}`);
  assert.equal(await readFile(join(workspaceRoot, 'target.txt'), 'utf8'), originalBytes, 'file unchanged after second');
  report.second = { id: second.id, outputText: second.output_text, modelCalls: 2, bytesUnchanged: true };

  // --- Final SQLite: exactly 2 runs (first + second; both replays did not create new).
  const store2 = new SqliteRunStore(sqlitePath);
  const runs2 = store2.list(scope);
  assert.equal(runs2.length, 2, `exactly 2 runs after restart+replay+second: ${runs2.length}`);
  assert.ok(runs2.every(r => r.phase === 'completed'), `all runs completed: ${runs2.map(r => r.phase)}`);
  assert.ok(runs2.every(r => r.buildId === identity.buildId), `all runs use imported Build: ${runs2.map(r => r.buildId)}`);
  assert.ok(runs2.every(row => row.sessionId === sessionId));
  // Verify the second run's DSH owner chains to the first.
  const sessionEvents2 = (await Promise.all(sessionLogFiles.map(f => readFile(join(sessionLogDir, f), 'utf8')))).flatMap(t => t.trim().split('\n').map(l => JSON.parse(l)));
  const ownerEvents2 = sessionEvents2.filter(e => e.type === 'turn/owner');
  assert.equal(ownerEvents2.length, 2, `exactly 2 turn/owner events: ${ownerEvents2.length}`);
  runs2.sort((a, b) => Number(a.turnId) - Number(b.turnId));
  assert.deepEqual(runs2.map(r => Number(r.turnId)), [1, 2], `turn sequence must be [1,2]: ${runs2.map(r => r.turnId)}`);
  const admission2 = readNativeDshOwnership(ownerEvents2[1].data, { sessionId: sessionEvents2[0].id, turn: 2 });
  assert.equal(admission2.identity.buildId, identity.buildId, 'turn 2 owner buildId must match');
  assert.equal(admission2.configuration.engine, 'agentkit.native/v1', 'turn 2 owner engine must be Native');
  assert.equal(admission2.identity.parentRunId, runs2[0].runId, 'turn 2 parentRunId must chain to turn 1');
  assert.equal(admission2.identity.scope.agentId, identity.agentId, 'turn 2 scope agentId must match');
  assert.equal(canonical(admission2.configuration), canonical(store2.load(scope, runs2[1].runId).configuration),
    'turn 2 canonical(configuration) must equal SQLite record');
  const record2 = store2.load(scope, runs2[1].runId);
  assert.deepEqual(admission2.identity, Object.fromEntries(identityKeys.map(key => [key, record2.snapshot[key]])));
  // Host binding includes each turn's sealed input capsule. Compare the
  // frozen authority fields, not hashes that intentionally bind different inputs.
  for (const configuration of [record1.configuration, record2.configuration]) assert.match(configuration.hostBindingDigest, /^[a-f0-9]{64}$/);
  for (const key of ['instructions', 'profile', 'tools', 'contextPolicy']) assert.deepEqual(record2.configuration[key], record1.configuration[key]);
  const { messages: firstMessages, ...firstBinding } = record1.configuration.hostRecoveryBinding;
  const { messages: secondMessages, ...secondBinding } = record2.configuration.hostRecoveryBinding;
  assert.deepEqual(secondBinding, firstBinding);
  assert.ok(canonical(firstMessages).includes(firstInput)); assert.ok(canonical(secondMessages).includes(secondBody.input));
  assert.equal(record2.snapshot.taskChainId, record1.snapshot.taskChainId);
  assert.equal(record2.snapshot.usage.modelCalls, 2); assert.equal(record2.snapshot.usage.toolCalls, 1);
  assert.equal(record2.snapshot.usage.inputTokens, 10); assert.equal(record2.snapshot.usage.outputTokens, 16);
  verifyToolPairing(record2, sessionEvents2, [readCall]);
  store2.close();
  report.sqlite.runCountFinal = 2;
  report.sqlite.turnIds = runs2.map(r => Number(r.turnId));
  report.sqlite.ownerEngines = ['agentkit.native/v1', 'agentkit.native/v1'];
  report.sqlite.parentChain = [null, runs2[0].runId];

  // --- Failures array must be empty (model server had no internal errors).
  assert.equal(failures.length, 0, `model server failures must be empty: ${JSON.stringify(failures.map(f => f.message))}`);

  report.passed = true;
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2));
  console.log('PASS: archive-present portable Frozen HTTP: read-only policy denies write, exact 2 Runs, cold replay idempotent, DSH owner verified, SQLite intent+receipt paired, Host restart preserves Build/Session.');
} catch (error) {
  if (failures.length) console.error('Model server failures:', JSON.stringify(failures.map(item => ({ message: item.message, stack: item.stack })), null, 2));
  try { await writeFile(join(root, 'proof-failed.json'), JSON.stringify({ passed: false, code: error.code, message: error.message, stack: error.stack, requests: requests.length, failures: failures.map(item => ({ message: item.message, stack: item.stack })) }, null, 2)); } catch {}
  throw error;
} finally {
  await harness?.close();
  server.close();
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
