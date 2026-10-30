import { createRequire } from 'node:module';
/** Packed production Host acceptance for a portable-imported Native Frozen Build.
 *
 *  The real DSH SDK drives a complete Native turn through the packed Studio
 *  Host: a source Agent's Frozen Native Build is prepared as a portable
 *  archive, imported into a fresh isolated AGENTKIT_HOME, then the target Host
 *  — with its live Native default OFF — mounts the imported Build and executes a
 *  complete Native Run using the frozen engine, reading and writing real
 *  workspace files. A Host restart runs a second turn on the same imported
 *  Build without re-executing the first write.
 *
 *  Boundary: this verifies the "imported Frozen Build executed from the target
 *  store" path (portable-bundle.zip intentionally removed so loadPortableRuntime
 *  returns null). It does NOT verify the loadPortableRuntime/portable HTTP path
 *  or fresh dependency installation.
 *
 *  No model loop is permitted; the model adapter throws if entered. No online
 *  model or network is used. Python executor paths are explicitly unreachable. */
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

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
const repository = fileURLToPath(new URL('..', import.meta.url)), source = resolve(values.source);
const root = await mkdtemp(join(tmpdir(), 'studio-native-portable-'));
console.log(`Studio Native portable evidence: ${root}`);
let harness;
const requests = [], failures = [];

const archiveBytes = await readFile(resolve(values.archive));
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
const sourceHead = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(body.model, 'pinned');
    const toolResults = body.messages.filter(message => message.role === 'tool');
    const step = toolResults.length;
    const tools = (body.tools ?? []).map(tool => tool.function.name);
    const userMessages = body.messages.filter(message => message.role === 'user' && typeof message.content === 'string');
    const input = userMessages.at(-1)?.content || '';
    const hasTurn2Prompt = userMessages.some(message => message.content.includes('Re-read') || message.content.includes('without rewriting'));
    const hasTurn3Prompt = userMessages.some(message => message.content.includes('denied') || message.content.includes('outside'));
    const isTurn2 = hasTurn2Prompt && step >= 3 && !hasTurn3Prompt;
    const isTurn3 = hasTurn3Prompt;

    if (isTurn3) {
      assert.ok(tools.includes('write_workspace_file'), 'Turn 3 tools must include write_workspace_file');
      const deniedSeen = toolResults.some(message => /denied|rejected|outside|escape|error|invalid/i.test(JSON.stringify(message.content)));
      if (deniedSeen) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta: { content: 'Both writes were rejected by policy.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
      } else {
        const calls = [
          { name: 'write_workspace_file', arguments: { path: 'denied.txt', content: 'Denied.' } },
          { name: 'write_workspace_file', arguments: { path: '../outside.txt', content: 'Escaped' } },
        ];
        const delta = { tool_calls: calls.map((call, index) => ({ index, id: `tool-${requests.length}-${index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
      }
      return;
    }

    if (isTurn2) {
      if (toolResults.length > 3) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta: { content: 'Turn 2 completed: the frozen contract history was retained without re-executing the first write.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const delta = { tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function',
        function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: 'target.txt' }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
      return;
    }

    let call;
    if (step === 0) { assert.ok(tools.includes('read_workspace_file')); call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } }; }
    else if (step === 1) { assert.ok(tools.includes('write_workspace_file')); call = { name: 'write_workspace_file', arguments: { path: 'target.txt', content: 'Portable evidence bytes.' } }; }
    else if (step === 2) { assert.ok(tools.includes('read_workspace_file')); call = { name: 'read_workspace_file', arguments: { path: 'target.txt' } }; }
    else call = null;
    if (call) {
      const delta = { tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta: { content: 'Turn 1 completed: the portable Build read, wrote, and re-read the real workspace file.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`);
    }
  } catch (error) {
    failures.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('portable verification failed');
  }
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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
  await writeFile(join(installed, 'tests', 'fixtures', 'studio-native-portable.mjs'),
    await readFile(join(repository, 'tests', 'fixtures', 'studio-native-portable.mjs')));

  const nodeBin = join(root, 'node-only-bin');
  await mkdir(nodeBin);
  await symlink(process.execPath, join(nodeBin, 'node'));

  const patch = join(root, 'portable.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: portable-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: portable-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: portable-proof-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: portable-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: portable-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: portable-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: portable-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: portable-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-portable.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        repository: ${JSON.stringify(installed)}`, `        modelUrl: ${JSON.stringify(modelUrl)}`, '',
  ].join('\n'));

  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-portable-proof', model: 'pinned', initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk' } };

  harness = new DeepSeekHarness(options);
  await harness.start();

  const identityDeadline = Date.now() + 60_000;
  let identity;
  while (Date.now() < identityDeadline) {
    try { identity = JSON.parse(await readFile(join(root, 'portable-identity.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(identity, 'Portable fixture did not persist identity');

  const report = { passed: false, node: process.version, sourceHead, archiveSha256,
    liveDefaultOff: true, boundary: 'portable-bundle.zip removed; verifies Frozen-store execution path, not loadPortableRuntime/portable HTTP or fresh install',
    firstTurn: {}, secondTurn: {}, thirdTurn: {} };

  // --- Turn 1: read → write → read → final.
  let session = harness.session('portable-native-session');
  const result1 = await session.run('Read target.txt, write "Portable evidence bytes." to it, then re-read it and report completion.');
  report.firstTurn = summarize(result1, 1);
  assert.equal(result1.finalResponse, 'Turn 1 completed: the portable Build read, wrote, and re-read the real workspace file.',
    JSON.stringify(result1.events.filter(event => event.type === 'turn/end')));
  assert.equal(result1.events.filter(event => event.type === 'tool/call').length, 3,
    JSON.stringify(result1.events.filter(event => event.type === 'tool/call').map(event => event.data)));
  assert.equal(await readFile(join(root, 'workspace', 'target.txt'), 'utf8'), 'Portable evidence bytes.');
  report.firstTurn.wroteRealFile = true;
  assert.equal(result1.events.some(event => event.type === 'turn/owner'), true, 'turn/owner missing');
  assert.equal(result1.events.some(event => ['request/header', 'request/context'].includes(event.type)), false, 'request/header leaked');
  // Usage from the model server: 3 tool-call requests + 1 final = 4 assistant messages.
  assert.deepEqual(result1.events.filter(event => event.type === 'assistant/message').map(event => event.data.usage),
    [{ inputTokens: 5, outputTokens: 7 }, { inputTokens: 5, outputTokens: 7 }, { inputTokens: 5, outputTokens: 7 }, { inputTokens: 5, outputTokens: 9 }]);

  // --- Host restart: real close/reopen/resumeSession.
  await harness.close();
  harness = new DeepSeekHarness(options);
  await harness.start();
  session = await harness.resumeSession('portable-native-session');

  // --- Turn 2: one read only (no re-write).
  const beforeContent = await readFile(join(root, 'workspace', 'target.txt'), 'utf8');
  const result2 = await session.run('Re-read target.txt and confirm it still holds the first turn evidence without rewriting it.');
  report.secondTurn = summarize(result2, 2);
  assert.equal(result2.finalResponse, 'Turn 2 completed: the frozen contract history was retained without re-executing the first write.',
    JSON.stringify(result2.events.filter(event => event.type === 'turn/end')));
  const turn2Calls = result2.events.filter(event => event.type === 'tool/call').map(event => event.data.name);
  assert.equal(turn2Calls.length, 1, `Turn 2 must issue exactly one read, no re-write: ${JSON.stringify(turn2Calls)}`);
  assert.equal(turn2Calls[0], 'read_workspace_file', `Turn 2 tool must be read_workspace_file: ${JSON.stringify(turn2Calls)}`);
  assert.equal(result2.events.some(event => event.type === 'tool/call' && event.data.name === 'write_workspace_file'), false, 'Turn 2 must not call write_workspace_file');
  // Restore the real after-content assertion (was deleted in review2).
  const afterContent = await readFile(join(root, 'workspace', 'target.txt'), 'utf8');
  assert.equal(afterContent, beforeContent, 'Turn 2 must not change target.txt');
  report.secondTurn.wroteRealFile = false;
  assert.equal(result2.events.some(event => event.type === 'turn/owner'), true, 'turn 2 owner missing');
  // Verify per-message usage values (same as turn 1): tool-call + final.
  assert.deepEqual(result2.events.filter(event => event.type === 'assistant/message').map(event => event.data.usage),
    [{ inputTokens: 5, outputTokens: 7 }, { inputTokens: 5, outputTokens: 9 }],
    'turn 2 assistant usage must match the model server values');

  // --- Turn 3: permission denial (denied.txt) + path escape (../outside.txt).
  const result3 = await session.run('Attempt to write denied.txt and ../outside.txt; report both were rejected.');
  report.thirdTurn = summarize(result3, 3);
  assert.equal(result3.finalResponse, 'Both writes were rejected by policy.',
    JSON.stringify(result3.events.filter(event => event.type === 'turn/end')));
  const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const deniedAdmission = admissions.find(a => a.path === 'denied.txt');
  const escapeAdmission = admissions.find(a => a.path === '../outside.txt');
  assert.ok(deniedAdmission, 'denied.txt write must appear in tool-admissions');
  assert.ok(escapeAdmission, '../outside.txt write must appear in tool-admissions');
  assert.equal(existsSync(join(root, 'workspace', 'denied.txt')), false, 'denied.txt must not exist');
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'Outside the workspace.', 'path escape must not overwrite outside.txt');
  report.thirdTurn.denied = true; report.thirdTurn.escaped = false;

  // --- Source leak checks.
  assert.equal(identity.sourcePathLeaked, false, 'source path leaked into decompressed archive entries');
  assert.equal(identity.sourceSecretLeaked, false, 'source secret leaked into decompressed archive entries');

  // --- SQLite Run store evidence: read the actual Native harness ledger.
  // Require the SQLite database to exist; do not skip if missing.
  const sqlitePath = join(root, 'target-home', 'studio', 'native-harness', 'runs.sqlite');
  assert.ok(existsSync(sqlitePath), `Native harness SQLite store must exist at ${sqlitePath}`);
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const { canonical, parseNativeJson } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-core')).href);
  const { readNativeDshOwnership } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership')).href);
  const store = new SqliteRunStore(sqlitePath);
  const workspaceId = createHash('sha256').update(canonical(resolve(join(root, 'workspace')))).digest('hex');
  const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: identity.agentId };
  const runs = store.list(scope);
  assert.equal(runs.length, 3, `expected 3 completed runs, got ${runs.length}`);
  // Sort by actual snapshot.turnId, not array position.
  runs.sort((a, b) => Number(a.turnId) - Number(b.turnId));
  assert.deepEqual(runs.map(run => Number(run.turnId)), [1, 2, 3], `turn sequence must be 1/2/3: ${runs.map(run => run.turnId)}`);
  assert.ok(runs.every(run => run.phase === 'completed'), `all runs must be completed: ${runs.map(run => run.phase)}`);
  assert.ok(runs.every(run => run.buildId === identity.buildId), `all runs must use the imported Build: ${runs.map(run => run.buildId)}`);
  report.sqlite = { runCount: runs.length, phases: runs.map(run => run.phase),
    buildIds: runs.map(run => run.buildId), goals: runs.map(run => run.goal),
    turnIds: runs.map(run => Number(run.turnId)) };

  // Read the session JSONL log for turn/owner events.
  const sessionLogDir = join(root, 'sessions');
  const sessionLogFiles = (await readdir(sessionLogDir, { recursive: true })).filter(file => file.endsWith('session.v4.jsonl'));
  assert.ok(sessionLogFiles.length > 0, 'session log must exist');
  const sessionEvents = (await Promise.all(sessionLogFiles.map(file => readFile(join(sessionLogDir, file), 'utf8'))))
    .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
  const ownerEvents = sessionEvents.filter(event => event.type === 'turn/owner');
  assert.equal(ownerEvents.length, 3, `expected 3 turn/owner events, got ${ownerEvents.length}`);

  // Parse each turn/owner to verify the complete frozen Build binding and Native
  // engine. Match by actual turnId, not array position. Verify canonical
  // (configuration) equals the SQLite record's configuration.
  for (let i = 0; i < runs.length; i++) {
    const turn = Number(runs[i].turnId);
    // Find the turn/owner event whose runId matches this SQLite run. readNativeDshOwnership
    // throws on mismatched turn/session, so wrap in try/catch for the find predicate.
    let ownerEvent;
    for (const event of ownerEvents) {
      try {
        const admission = readNativeDshOwnership(event.data, { sessionId: 'portable-native-session', turn });
        if (admission.identity.runId === runs[i].runId) { ownerEvent = event; break; }
      } catch { /* not this turn */ }
    }
    assert.ok(ownerEvent, `turn/owner for turn ${turn} (runId ${runs[i].runId}) not found`);
    const admission = readNativeDshOwnership(ownerEvent.data, { sessionId: 'portable-native-session', turn });
    assert.equal(admission.identity.buildId, identity.buildId, `turn/owner ${turn} buildId must match imported Build`);
    assert.equal(admission.configuration.engine, 'agentkit.native/v1', `turn/owner ${turn} configuration must use Native engine`);
    assert.equal(admission.identity.sessionId, 'portable-native-session', `turn/owner ${turn} sessionId must match`);
    assert.equal(admission.identity.scope.agentId, identity.agentId, `turn/owner ${turn} scope agentId must match`);
    assert.equal(admission.identity.scope.tenantId, 'local', `turn/owner ${turn} scope tenantId must be local`);
    assert.equal(admission.identity.scope.workspaceId, workspaceId, `turn/owner ${turn} scope workspaceId must match`);
    assert.equal(admission.identity.scope.userId, 'local-user', `turn/owner ${turn} scope userId must match`);
    assert.equal(admission.identity.runId, runs[i].runId, `turn/owner ${turn} runId must match SQLite run`);
    // Turn 1 has no parent; turns 2+ chain to the previous turn's runId.
    if (turn === 1) assert.equal(admission.identity.parentRunId, null, `turn/owner ${turn} parentRunId must be null`);
    else assert.equal(admission.identity.parentRunId, runs[i - 1].runId, `turn/owner ${turn} parentRunId must chain to previous run`);
    assert.equal(admission.identity.taskChainId, 'portable-native-session', `turn/owner ${turn} taskChainId must match sessionId`);
    assert.ok(admission.configuration.instructions.includes('PORTABLE_NATIVE_SYSTEM'),
      `turn/owner ${turn} instructions must include the frozen system prompt`);
    // Verify canonical(configuration) matches the SQLite record's configuration.
    const record = store.load(scope, runs[i].runId);
    assert.equal(canonical(admission.configuration), canonical(record.configuration),
      `turn/owner ${turn} canonical(configuration) must equal SQLite record configuration`);
    assert.equal(admission.configDigest, createHash('sha256').update(canonical(admission.configuration)).digest('hex'),
      `turn/owner ${turn} configDigest must match hash(canonical(configuration))`);
  }

  // Load each SQLite run and match tool intents to receipts by operationKey.
  // Assert receipt.status === 'committed', calls.length === results.length,
  // and save callId/name/arguments + operationKey/result index pairings.
  const runDetails = [];
  for (let i = 0; i < runs.length; i++) {
    const snapshot = runs[i];
    const turn = Number(snapshot.turnId);
    const record = store.load(scope, snapshot.runId);
    const toolIntents = record.intents.filter(intent => intent.kind === 'tool');
    const runInfo = { runId: snapshot.runId, turnId: turn,
      toolIntentCount: toolIntents.length,
      toolCalls: [], receipts: [] };
    for (const intent of toolIntents) {
      const calls = intent.payload.calls ?? [];
      const receipt = record.receipts.find(r => r.operationKey === intent.operationKey);
      assert.ok(receipt, `turn ${turn} intent ${intent.operationKey} must have a matching receipt`);
      assert.equal(receipt.status, 'committed',
        `turn ${turn} receipt status must be 'committed' (not ${receipt.status})`);
      const results = receipt.result?.results ?? [];
      assert.equal(calls.length, results.length,
        `turn ${turn} calls.length (${calls.length}) must equal results.length (${results.length})`);
      for (let j = 0; j < calls.length; j++) {
        runInfo.toolCalls.push({ callId: calls[j].callId, name: calls[j].name, arguments: calls[j].arguments });
        runInfo.receipts.push({ operationKey: intent.operationKey, resultIndex: j,
          callId: calls[j].callId, name: calls[j].name,
          status: results[j].status, content: results[j].content });
      }
    }
    runDetails.push(runInfo);
  }
  store.close();
  report.sqlite.runDetails = runDetails;

  // Turn 1: 3 tool calls (read, write, read) with exact pairing.
  const t1 = runDetails.find(r => r.turnId === 1);
  assert.ok(t1, 'turn 1 run not found');
  assert.deepEqual(t1.toolCalls.map(c => c.name), ['read_workspace_file', 'write_workspace_file', 'read_workspace_file'],
    `turn 1 tool calls: ${JSON.stringify(t1.toolCalls)}`);
  // The write receipt (2nd intent) must be committed with ok:true and path target.txt.
  const t1WriteReceipt = t1.receipts.find(r => r.name === 'write_workspace_file' && r.status === 'ok' && r.content?.ok === true && r.content?.path === 'target.txt');
  assert.ok(t1WriteReceipt, `turn 1 must have a committed write receipt for target.txt: ${JSON.stringify(t1.receipts)}`);
  // The re-read receipt (3rd intent, callId tool-3) must contain the actual written bytes.
  const t1RereadReceipt = t1.receipts.find(r => r.callId === 'tool-3' && r.status === 'ok' && typeof r.content?.content === 'string');
  assert.ok(t1RereadReceipt, `turn 1 third tool (re-read, callId tool-3) must have a read receipt with content: ${JSON.stringify(t1.receipts)}`);
  assert.ok(t1RereadReceipt.content.content.includes('Portable evidence bytes.'),
    `turn 1 re-read receipt content must contain the written bytes: ${t1RereadReceipt.content.content}`);
  report.firstTurn.rereadContent = t1RereadReceipt.content.content;

  // Turn 2: 1 tool call (read only) with exact pairing.
  const t2 = runDetails.find(r => r.turnId === 2);
  assert.ok(t2, 'turn 2 run not found');
  assert.deepEqual(t2.toolCalls.map(c => c.name), ['read_workspace_file'],
    `turn 2 tool calls: ${JSON.stringify(t2.toolCalls)}`);
  const t2ReadReceipt = t2.receipts.find(r => r.name === 'read_workspace_file' && r.status === 'ok' && typeof r.content?.content === 'string');
  assert.ok(t2ReadReceipt, `turn 2 must have a read receipt with content: ${JSON.stringify(t2.receipts)}`);
  assert.ok(t2ReadReceipt.content.content.includes(beforeContent),
    `turn 2 read receipt content must match the actual file bytes: ${t2ReadReceipt.content.content}`);
  report.secondTurn.rereadContent = t2ReadReceipt.content.content;

  // Turn 3: 2 tool calls with per-path verification.
  const t3 = runDetails.find(r => r.turnId === 3);
  assert.ok(t3, 'turn 3 run not found');
  assert.equal(t3.toolCalls.length, 2, `turn 3 must have 2 tool calls: ${t3.toolCalls.length}`);
  // denied.txt: receipt status 'error', content is the policy denial text.
  const t3DeniedReceipt = t3.receipts.find(r => r.name === 'write_workspace_file' && r.content?.arguments?.path === 'denied.txt'
    || (r.callId && t3.toolCalls.find(c => c.callId === r.callId && c.arguments?.path === 'denied.txt')));
  const t3DeniedByCall = t3.receipts.find(r => {
    const call = t3.toolCalls.find(c => c.callId === r.callId);
    return call && call.arguments?.path === 'denied.txt';
  });
  assert.ok(t3DeniedByCall, `turn 3 must have a receipt paired to the denied.txt write call: ${JSON.stringify(t3.receipts)}`);
  assert.equal(t3DeniedByCall.status, 'error', `turn 3 denied.txt receipt must have status 'error': ${JSON.stringify(t3DeniedByCall)}`);
  // The denied.txt error comes from the fixture's pre-execute hook.
  assert.ok(JSON.stringify(t3DeniedByCall.content).includes('Verification policy denied this write'),
    `turn 3 denied.txt receipt must carry the fixture policy denial: ${JSON.stringify(t3DeniedByCall.content)}`);
  // ../outside.txt: receipt status 'error', content.error_type === 'path_escape', content.ok === false.
  const t3EscapeByCall = t3.receipts.find(r => {
    const call = t3.toolCalls.find(c => c.callId === r.callId);
    return call && call.arguments?.path === '../outside.txt';
  });
  assert.ok(t3EscapeByCall, `turn 3 must have a receipt paired to the ../outside.txt write call: ${JSON.stringify(t3.receipts)}`);
  assert.equal(t3EscapeByCall.status, 'error', `turn 3 ../outside.txt receipt must have status 'error': ${JSON.stringify(t3EscapeByCall)}`);
  assert.equal(t3EscapeByCall.content?.error_type, 'path_escape',
    `turn 3 ../outside.txt receipt must have error_type 'path_escape': ${JSON.stringify(t3EscapeByCall.content)}`);
  assert.equal(t3EscapeByCall.content?.ok, false,
    `turn 3 ../outside.txt receipt content.ok must be false: ${JSON.stringify(t3EscapeByCall.content)}`);
  report.thirdTurn.receiptStatuses = t3.receipts.map(r => r.status);
  report.thirdTurn.receiptDetails = t3.receipts.map(r => ({ callId: r.callId, name: r.name, status: r.status, errorType: r.content?.error_type, ok: r.content?.ok }));

  report.passed = true;
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2));
  console.log('PASS: portable-imported Native Frozen Build executes real Node workspace tools through the packed Host; frozen engine retained across restart; DSH model loop never entered; source paths/secrets never reached the archive; permission denial and path escape rejected.');
} catch (error) {
  if (failures.length) console.error('Model server failures:', JSON.stringify(failures.map(item => ({ message: item.message, stack: item.stack })), null, 2));
  try { await writeFile(join(root, 'proof-failed.json'), JSON.stringify({ passed: false, code: error.code, message: error.message, stack: error.stack, requests: requests.length, failures: failures.map(item => ({ message: item.message, stack: item.stack })) }, null, 2)); } catch { /* best effort */ }
  throw error;
} finally {
  await harness?.close();
  server.close();
  if (!values.keep) await rm(root, { recursive: true, force: true });
}

function summarize(result, turn) {
  const events = result.events || [];
  return { turn, finalResponse: result.finalResponse,
    toolCalls: events.filter(event => event.type === 'tool/call').length,
    toolResults: events.filter(event => event.type === 'tool/result').length,
    toolCallNames: events.filter(event => event.type === 'tool/call').map(event => event.data.name),
    hasTurnOwner: events.some(event => event.type === 'turn/owner'),
    hasTurnEnd: events.some(event => event.type === 'turn/end') };
}
