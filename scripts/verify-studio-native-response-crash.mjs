import { createRequire } from 'node:module';
/** Frozen HTTP response-projection SIGKILL acceptance.
 *
 *  Verifies the production Frozen HTTP response-projection persistence window
 *  survives a real SIGKILL at two boundaries:
 *
 *  before-append: the Native Run completes and turn/end is persisted, but the
 *    projection event has NOT been appended to the Session log. On restart,
 *    replaying the same request_id must NOT find a cached projection; the
 *    original history reconstructs and persists delivery without re-execution.
 *
 *  after-flush: the projection event is appended AND flushed (durable). On
 *    restart, replaying the same request_id must serve the exact original
 *    projection (same response, events, created_at, output IDs) with zero new
 *    model/tool calls.
 *
 *  The verifier drives the real packed Host via the authenticated Frozen HTTP
 *  /v1/responses endpoint. The fixture injects the fault by wrapping the real
 *  Session.append or ctx.sessions.flush. Node-only PATH, Python unreachable. */
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

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, boundary: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive && values.boundary, 'Use --source <DSH> --archive <Studio.tgz> --boundary before-append|after-flush');
assert.ok(['before-append', 'after-flush'].includes(values.boundary), `boundary must be before-append or after-flush: ${values.boundary}`);
const boundary = values.boundary;
const repository = fileURLToPath(new URL('..', import.meta.url)), source = resolve(values.source);
const root = await mkdtemp(join(tmpdir(), 'studio-native-response-crash-'));
console.log(`Studio Native response crash evidence: ${root} (boundary=${boundary})`);
let harness, parentReplay, originalNativeRecord, originalProjection;
const requests = [], failures = [];

const archiveBytes = await readFile(resolve(values.archive));
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
const sourceHead = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const runtimeToken = 'portable-crash-proof-token-0123456789';
const portProbe = createServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const runtimePort = portProbe.address().port;
portProbe.close();

const workspaceRoot = join(root, 'workspace');
const originalBytes = 'Original crash bytes.';

// Model server: Turn 1 = read(0) → write-deny(1) → read(2) → final(3) = 4 calls.
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(body.model, 'pinned');
    const toolResults = body.messages.filter(m => m.role === 'tool');
    const step = toolResults.length;
    let call;
    if (step === 0) call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } };
    else if (step === 1) call = { name: 'write_workspace_file', arguments: { path: 'target.txt', content: 'Crash attempt.' } };
    else if (step === 2) call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } };
    else call = null;
    if (call) {
      const delta = { tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta: { content: 'Crash proof completed the turn.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
    }
  } catch (error) {
    failures.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('response crash verification failed');
  }
});

function buildOptions(modelUrl, nodeBin) {
  return { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'),
      join(root, 'response-crash.patch.yml')], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-response-crash-proof', model: 'pinned',
    initializeTimeoutMs: 30_000, requestTimeoutMs: 60_000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk' } };
}

async function waitForRuntime(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const h = await fetch(`${url}/health`); if (h.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function waitForCheckpoint(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
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
  await writeFile(join(installed, 'tests', 'fixtures', 'studio-native-response-crash.mjs'),
    await readFile(join(repository, 'tests', 'fixtures', 'studio-native-response-crash.mjs')));

  const nodeBin = join(root, 'node-only-bin');
  await mkdir(nodeBin);
  await symlink(process.execPath, join(nodeBin, 'node'));

  const patch = join(root, 'response-crash.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: crash-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: crash-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: crash-proof-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: crash-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: crash-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: crash-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: crash-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: crash-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-response-crash.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        repository: ${JSON.stringify(installed)}`,
    `        modelUrl: ${JSON.stringify(modelUrl)}`, `        runtimeToken: ${JSON.stringify(runtimeToken)}`,
    `        runtimePort: ${JSON.stringify(runtimePort)}`, `        boundary: ${JSON.stringify(boundary)}`, '',
  ].join('\n'));

  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = buildOptions(modelUrl, nodeBin);

  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const token = runtimeToken;
  const checkpointFile = join(root, 'crash-checkpoint.json');
  const report = { passed: false, node: process.version, sourceHead, archiveSha256, boundary,
    fixtureSha256: createHash('sha256').update(await readFile(join(repository, 'tests/fixtures/studio-native-response-crash.mjs'))).digest('hex'),
    runtimePort, failures: [] };

  // --- Phase 1: Start Host, send first request (triggers fault + hang).
  harness = new DeepSeekHarness(options);
  await harness.start();

  // Wait for fixture identity.
  const identityDeadline = Date.now() + 60_000;
  let identity;
  while (Date.now() < identityDeadline) {
    try { identity = JSON.parse(await readFile(join(root, 'response-crash-identity.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(identity, 'Fixture did not persist identity');
  assert.ok(await waitForRuntime(runtimeUrl), 'Frozen HTTP not ready');

  // Send the first request. It will trigger the Native Run, which completes,
  // then the fault injects and the process hangs. The HTTP response will not
  // arrive (the request is still in-flight when the process is killed).
  const firstBody = { input: 'Read target.txt, attempt to write, re-read and report.', session_id: 'crash-session', request_id: 'first' };
  const callsBeforeFirst = requests.length;
  // Fire-and-forget: the request will hang when the fault triggers.
  const firstPromise = fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });

  void firstPromise.catch(() => {});
  // Wait for the checkpoint to appear (the fault was triggered).
  const checkpoint = await waitForCheckpoint(checkpointFile, 60_000);
  assert.ok(checkpoint, `Checkpoint was not written (fault did not trigger) within 60s`);
  report.checkpoint = checkpoint;
  report.modelCallsBeforeKill = requests.length - callsBeforeFirst;
  console.log(`Checkpoint: ${JSON.stringify(checkpoint)}, model calls before kill: ${report.modelCallsBeforeKill}`);

  // The first request's model calls should be exactly 4 (read/write/read/final).
  assert.equal(report.modelCallsBeforeKill, 4, `first turn must make exactly 4 model calls before kill: ${report.modelCallsBeforeKill}`);

  // Capture the exact durable record and SDK terminal BEFORE the real kill.
  const { SqliteRunStore: BeforeStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const { canonical: beforeCanonical } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-core')).href);
  const beforeScope = { tenantId:'local', workspaceId:createHash('sha256').update(beforeCanonical(resolve(workspaceRoot))).digest('hex'), userId:'local-user', agentId:identity.agentId };
  const beforeStore = new BeforeStore(join(root,'target-home/studio/native-harness/runs.sqlite'));
  const beforeRuns = beforeStore.list(beforeScope); assert.equal(beforeRuns.length,1);
  originalNativeRecord=beforeCanonical(beforeStore.load(beforeScope,beforeRuns[0].runId)); beforeStore.close();
  const beforeLogFiles=(await readdir(join(root,'sessions'),{recursive:true})).filter(f=>f.endsWith('session.v4.jsonl'));
  assert.equal(beforeLogFiles.length,1);
  const beforeEvents=(await readFile(join(root,'sessions',beforeLogFiles[0]),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(beforeEvents.findLast(e=>e.type==='turn/end')?.data?.reason?.kind,'completed','SDK terminal must be durable before presentation boundary');
  const beforeProjections=beforeEvents.filter(e=>e.type==='studio/runtime-response-projection');
  assert.equal(beforeProjections.length,boundary==='after-flush'?1:0);
  report.projectionsBeforeKill=beforeProjections.length;
  originalProjection=beforeProjections[0]?.data;
  assert.ok(Number.isSafeInteger(checkpoint.pid)&&checkpoint.pid>0&&checkpoint.pid!==process.pid);
  process.kill(checkpoint.pid,0); process.kill(checkpoint.pid,'SIGKILL');
  report.actualKill={pid:checkpoint.pid,signal:'SIGKILL'};
  await harness.close(); harness=null;
  assert.throws(()=>process.kill(checkpoint.pid,0),error=>error.code==='ESRCH','original Host must have exited');
  firstPromise.catch(()=>{});

  // --- Phase 2: Restart the Host. The checkpoint file exists, so the fixture
  // skips re-injecting the fault and mounts normally.
  await new Promise(r => setTimeout(r, 1000)); // Let the port release.
  harness = new DeepSeekHarness(buildOptions(modelUrl, nodeBin));
  await harness.start();
  assert.ok(await waitForRuntime(runtimeUrl), 'Frozen HTTP not ready after restart');

  // --- Phase 3: Replay the same request_id. Verify behavior per boundary.
  const callsBeforeReplay = requests.length;
  const replayBody = firstBody; // same request_id + session_id
  const replayResp = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(replayBody) });

  assert.equal(replayResp.status,200,'Rebuilt or persisted completed response is required');
  parentReplay=await replayResp.json(); assert.equal(parentReplay.status,'completed');
  console.log('Recovered delivery:',replayResp.status,parentReplay.output_text);
  if (boundary === 'after-flush') {
    // The projection was durable. Replay must return 200 with the original
    // response (same id, output_text, model, status, usage, created_at).
    assert.equal(replayResp.status, 200, `after-flush replay must be 200: ${replayResp.status}`);
    const replay = parentReplay;
    assert.deepEqual(replay,originalProjection.response);
    assert.ok(replay.id, 'replay must have id');
    assert.ok(replay.output_text, 'replay must have output_text');
    assert.equal(replay.status, 'completed', `replay status must be completed: ${replay.status}`);
    report.afterFlush = { responseId: replay.id, outputText: replay.output_text, model: replay.model, status: replay.status, createdAt: replay.created_at };
    // No new model/tool calls: the projection was served from history.
    assert.equal(requests.length, callsBeforeReplay, 'after-flush replay must not trigger new model calls');
    // File unchanged.
    assert.equal(await readFile(join(workspaceRoot, 'target.txt'), 'utf8'), originalBytes, 'file unchanged after-flush replay');
    report.afterFlush.noNewModelCalls = true;
  } else {
    // No original HTTP completion was delivered. Rebuild its presentation
    // from the already durable request history, then persist that delivery.
    const replayStatus = replayResp.status;
    report.beforeAppend = { replayStatus, modelCallsAfterReplay: requests.length - callsBeforeReplay };
    // The original Run was completed and persisted; replaying the same
    // request_id must reuse the original Run (no new model calls).
    assert.equal(requests.length, callsBeforeReplay,
      `before-append replay must not trigger new model calls (original Run reused): ${requests.length - callsBeforeReplay}`);
    // File unchanged.
    assert.equal(await readFile(join(workspaceRoot, 'target.txt'), 'utf8'), originalBytes, 'file unchanged before-append replay');
    report.beforeAppend.noNewModelCalls = true;
  }

  // --- SQLite: verify exactly 1 run (the original; replay did not create new).
  const sqlitePath = join(root, 'target-home', 'studio', 'native-harness', 'runs.sqlite');
  assert.ok(existsSync(sqlitePath), `SQLite store must exist: ${sqlitePath}`);
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const { canonical } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-core')).href);
  const { readNativeDshOwnership } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership')).href);
  const store = new SqliteRunStore(sqlitePath);
  const wId = createHash('sha256').update(canonical(resolve(workspaceRoot))).digest('hex');
  const scope = { tenantId: 'local', workspaceId: wId, userId: 'local-user', agentId: identity.agentId };
  const runs = store.list(scope);
  assert.equal(runs.length, 1, `exactly 1 run (replay must not create new): ${runs.length}`);
  assert.equal(runs[0].phase, 'completed', `run must be completed: ${runs[0].phase}`);
  assert.equal(runs[0].buildId, identity.buildId, 'run must use imported Build');

  // Verify DSH owner.
  const sessionLogDir = join(root, 'sessions');
  const sessionLogFiles = (await readdir(sessionLogDir, { recursive: true })).filter(f => f.endsWith('session.v4.jsonl'));
  const sessionEvents = (await Promise.all(sessionLogFiles.map(f => readFile(join(sessionLogDir, f), 'utf8')))).flatMap(t => t.trim().split('\n').map(l => JSON.parse(l)));
  const ownerEvents = sessionEvents.filter(e => e.type === 'turn/owner');
  assert.equal(ownerEvents.length, 1, `exactly 1 turn/owner: ${ownerEvents.length}`);
  const admission = readNativeDshOwnership(ownerEvents[0].data, { sessionId: sessionEvents[0].id, turn: 1 });
  assert.equal(admission.identity.buildId, identity.buildId, 'owner buildId');
  assert.equal(admission.configuration.engine, 'agentkit.native/v1', 'owner engine');
  assert.equal(admission.identity.runId, runs[0].runId, 'owner runId');
  assert.equal(canonical(admission.configuration), canonical(store.load(scope, runs[0].runId).configuration), 'canonical(configuration)');

  // Intent+receipt pairing: 3 tools (read, write-deny, read).
  const record = store.load(scope, runs[0].runId);
  const toolIntents = record.intents.filter(i => i.kind === 'tool');
  assert.equal(toolIntents.length, 3, `exactly 3 tool intents: ${toolIntents.length}`);
  const runReceipts = [];
  for (const intent of toolIntents) {
    const calls = intent.payload.calls ?? [];
    const receipt = record.receipts.find(r => r.operationKey === intent.operationKey);
    assert.ok(receipt, `intent must have receipt`);
    assert.equal(receipt.status, 'committed', `receipt committed: ${receipt.status}`);
    assert.equal(calls.length, (receipt.result?.results ?? []).length, `calls=results for ${intent.operationKey}`);
    for (let j = 0; j < calls.length; j++) {
      runReceipts.push({ callId: calls[j].callId, name: calls[j].name, status: receipt.result.results[j].status, content: receipt.result.results[j].content });
    }
  }
  assert.equal(canonical(record),originalNativeRecord,'Original complete ledger must not change');
  store.close();
  assert.deepEqual(runReceipts.map(r => r.name), ['read_workspace_file', 'write_workspace_file', 'read_workspace_file'], 'tool sequence');
  const writeR = runReceipts[1];
  assert.equal(writeR.status, 'error', `write denied: ${writeR.status}`);
  assert.equal(writeR.content?.code, 'STUDIO_NATIVE_PERMISSION_DENIED', `policy denial: ${writeR.content?.code}`);

  // Check projection event presence in session log per boundary.
  const projectionEvents = sessionEvents.filter(e => e.type === 'studio/runtime-response-projection');
  if (boundary === 'after-flush') {
    assert.equal(projectionEvents.length, 1, `after-flush must have exactly 1 projection event: ${projectionEvents.length}`);
    report.projectionPersisted = true;
  } else {
    assert.equal(projectionEvents.length, 1, `before-append recovery must persist one projection: ${projectionEvents.length}`);
    assert.deepEqual(projectionEvents[0].data.response,parentReplay);
    report.projectionPersisted = true;
  }

  // Exact repeated JSON and every SSE presentation fact must survive the kill.
  const duplicate = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });
  assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), parentReplay);
  const stream = await fetch(`${runtimeUrl}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...firstBody, stream: true }) });
  assert.equal(stream.status, 200);
  const rawFrames = (await stream.text()).split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean);
  assert.equal(rawFrames.at(-1), '[DONE]');
  const frames = rawFrames.filter(data => data !== '[DONE]').map(data => JSON.parse(data));
  assert.equal(frames[0].type, 'response.created');
  assert.equal(frames[0].response.created_at, parentReplay.created_at);
  assert.equal(frames.at(-1).type, 'response.completed'); assert.deepEqual(frames.at(-1).response, parentReplay);
  assert.deepEqual(frames.map(frame => frame.sequence_number), frames.map((_, index) => index));
  const lifecycle = new Set(['response.created', 'response.in_progress', 'response.completed']);
  const presentation = frames.filter(frame => !lifecycle.has(frame.type)).map(frame => {
    const { type, sequence_number: _sequence, ...data } = frame; return { type, data };
  });
  assert.deepEqual(presentation, projectionEvents[0].data.events);
  assert.equal(presentation.filter(event => event.type === 'response.tool_result').length, 3);
  assert.equal(requests.length, callsBeforeReplay, 'JSON and SSE replay cannot invoke the model');
  const finalStore = new SqliteRunStore(sqlitePath);
  try {
    assert.equal(finalStore.list(scope).length, 1);
    assert.equal(canonical(finalStore.load(scope, record.snapshot.runId)), originalNativeRecord);
  } finally { finalStore.close(); }
  report.replay = { status: 200, exactRepeatedJson: true, exactSseEvents: true, sseEventCount: frames.length,
    originalRecordUnchanged: true, newModelCalls: 0, newRuns: 0 };

  report.sqlite = { runCount: 1, runReceipts: runReceipts.map(r => ({ callId: r.callId, name: r.name, status: r.status, denialCode: r.content?.code })) };
  report.sourcePathLeaked = identity.sourcePathLeaked;
  report.sourceSecretLeaked = identity.sourceSecretLeaked;
  assert.equal(identity.sourcePathLeaked, false, 'source path leaked');
  assert.equal(identity.sourceSecretLeaked, false, 'source secret leaked');
  assert.equal(failures.length, 0, `model server failures: ${JSON.stringify(failures.map(f => f.message))}`);

  report.passed = true;
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: response-projection SIGKILL (${boundary}): checkpoint PID=${checkpoint.pid}, ${report.projectionPersisted ? 'projection durable' : 'projection absent (expected)'}, 1 Run, replay no new calls, SQLite intent+receipt paired.`);
} catch (error) {
  if (failures.length) console.error('Model server failures:', JSON.stringify(failures.map(item => ({ message: item.message, stack: item.stack })), null, 2));
  try { await writeFile(join(root, 'proof-failed.json'), JSON.stringify({ passed: false, code: error.code, message: error.message, stack: error.stack, requests: requests.length, failures: failures.map(item => ({ message: item.message, stack: item.stack })), boundary }, null, 2)); } catch {}
  throw error;
} finally {
  await harness?.close();
  server.close();
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
