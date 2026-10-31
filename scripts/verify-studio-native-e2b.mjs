import { createRequire } from 'node:module';
/** Verify the packed production E2B binding with the installed JS SDK and a
 * refused endpoint, then restore history in a new Host process without input.
 * This proves the refusal/unknown boundary, not online E2B command success.
 * Ordinary dependencies reuse the installed graph; this is not a fresh install.
 * Usage: node scripts/verify-studio-native-e2b.mjs --source <built SDK>
 *        --archive <Studio.tgz> [--keep]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean', default: false } } });
assert.ok(values.source && values.archive, 'Use --source <built SDK> --archive <Studio.tgz>');
const source = resolve(values.source), archive = resolve(values.archive);
const repository = fileURLToPath(new URL('..', import.meta.url));
const sdkCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
const sha = data => createHash('sha256').update(data).digest('hex');
const archiveSha = sha(await readFile(archive));
const root = await mkdtemp(join(tmpdir(), 'studio-native-e2b-'));
console.log('E2B proof root:', root);
const sessionId = 'e2b-proof-session', goal = 'Inspect the E2B binding, then run the probe command.';
const marker = join(root, 'workspace/e2b-local-fallback-marker');
// An incorrect local fallback would write this exact absolute path, independent
// of the shell cwd. The real remote endpoint is unavailable and cannot run it.
const commandArgs = { command: `printf local-fallback > '${marker}'`, cwd: join(root, 'workspace') };
const calls = [
  [{ id: 'status-call', name: 'sandbox_status', arguments: {} }, { id: 'component-call', name: 'component_status', arguments: {} }],
  [{ id: 'e2b-call', name: 'run_command', arguments: commandArgs }],
];
const requests = [];
let modelFailure, harness, failed = false;
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'main');
    const selected = calls[requests.length - 1];
    assert.ok(selected, 'unknown E2B result must never trigger another model request');
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const tool_calls = selected.map((call, index) => ({ index, id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    response.end('data: ' + JSON.stringify({ id: 'main-' + requests.length, model: 'main',
      choices: [{ index: 0, delta: { tool_calls }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { modelFailure = error; if (!response.headersSent) response.writeHead(500); response.end('verification failed'); }
});
const readRows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function waitResume() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = await readRows(join(root, 'mounted-host-http.jsonl'));
    const probe = rows.find(row => row.source === 'resume');
    if (probe) return probe;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('new Host did not finish real preset/history restoration');
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph);
  execFileSync('tar', ['-xzf', archive, '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });

  // Overlay only the new test fixture; production files remain from the archive.
  await mkdir(join(installed, 'tests/fixtures'), { recursive: true });
  await copyFile(join(repository, 'tests/fixtures/studio-native-e2b.mjs'),
    join(installed, 'tests/fixtures/studio-native-e2b.mjs'));

  // Symlink the SDK's built @deepseek-ai packages into the host graph.
  const dshDeps = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const entry of await readdir(dshDeps)) {
    try { await symlink(join(dshDeps, entry), join(dependencies, '@deepseek-ai', entry)); } catch { /* exists */ }
  }
  // The idle SDK snapshot omits three mounted-host plugin packages from its
  // apps/cli hoist; their built lib/ exists under packages/. Symlink them from
  // source so the mounted host resolves dsh-client-connection,
  // dsh-api-session-controller and dsh-agent-preset-registry. The pnpm
  // workspace keeps each package's own @deepseek-ai deps resolvable.
  const missingFromSource = [
    ['packages/client/connection', 'dsh-client-connection'],
    ['packages/api/session-controller', 'dsh-api-session-controller'],
    ['packages/preset/agent-preset-registry', 'dsh-agent-preset-registry'],
  ];
  for (const [rel, pkgName] of missingFromSource) {
    try { await symlink(join(source, rel), join(dependencies, '@deepseek-ai', pkgName)); } catch { /* exists */ }
  }

  // Symlink ordinary Studio dependencies from this checkout's node_modules.
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry.startsWith('.')) continue;
    try { await symlink(join(repository, 'node_modules', entry), join(dependencies, entry)); } catch { /* exists */ }
  }

  // Node-only PATH so the host spawns no Python.
  const nodeOnlyBin = join(root, 'node-only-bin');
  await mkdir(nodeOnlyBin);
  await symlink(process.execPath, join(nodeOnlyBin, 'node'));

  // Profile packages for the mounted host: the packed Studio is the
  // @kingsoftcloud/agentkit-studio the host bootstrap imports.
  const profilePackages = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(profilePackages, { recursive: true });
  await symlink(installed, join(profilePackages, 'agentkit-studio'));

  // DSH patch YAML to mount the vision fixture with the full mounted-host
  // plugin chain (webserver + connection + model-selection-settings +
  // preset-registry with the production 'standard' default).
  const patch = join(root, 'e2b.patch.yml');
  const fixturePath = pathToFileURL(join(installed, 'tests/fixtures/studio-native-e2b.mjs')).href;
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: studio-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:',
    "        host: '127.0.0.1'", '        port: 0',
    '    - id: studio-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: studio-proof-model-selection-settings', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: studio-proof-preset-registry', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:',
    "        default: standard",
    '    - id: studio-native-e2b-proof', `      name: ${JSON.stringify(fixturePath)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`,
    `        repository: ${JSON.stringify(installed)}`,
    `        modelUrl: ${JSON.stringify(modelUrl)}`,
    `        mountHost: true`,
    '',
  ].join('\n'));

  const patches = [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch];
  const options = {
    dshBin: join(source, 'apps/cli/lib/bin.js'),
    profile: 'sdk',
    patches,
    dshHome: join(root, 'home'),
    cwd: root,
    processCwd: root,
    provider: 'agentkit-studio-fixture',
    model: 'main',
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 60_000,
    env: {
      ...process.env,
      PATH: nodeOnlyBin,
      AGENTKIT_PYTHON: '/unavailable/python',
      AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      AGENTKIT_KSADK_PYTHON: '/unavailable/python',
      AGENTKIT_KSADK_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_AGENTS_HOME: join(root, 'agents'),
    },
  };

  const e2bPackage = JSON.parse(await readFile(join(dependencies, 'e2b/package.json'), 'utf8'));
  assert.equal(e2bPackage.name, 'e2b');
  harness = new DeepSeekHarness(options);
  // Preserve the actual SDK outcome. No catch fabricates an execution phase;
  // a timeout, close failure or resume failure fails the proof.
  const turn = await harness.session(sessionId).run(goal, { signal: AbortSignal.timeout(45000) });
  await writeFile(join(root, 'actual-sdk-turn.json'), JSON.stringify(turn));
  if (modelFailure) throw modelFailure;
  assert.equal(requests.length, 2);
  const admissionsPath = join(root, 'tool-admissions.jsonl');
  const admissionsBefore = await readFile(admissionsPath, 'utf8');
  const admissions = await readRows(admissionsPath);
  assert.equal(admissions.length, 3);
  assert.deepEqual(admissions.map(a => a.name).sort(), ['component_status', 'run_command', 'sandbox_status']);
  assert.deepEqual(admissions.find(a => a.name === 'run_command').arguments, commandArgs);
  assert.deepEqual(await readdir(join(root, 'workspace')), [], 'a local shell fallback would write the explicit marker');
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  const scope = { tenantId: 'local', workspaceId: sha(JSON.stringify(resolve(root, 'workspace'))), userId: 'local-user', agentId };
  const dbPath = join(root, 'studio/native-harness/runs.sqlite');
  const store = new SqliteRunStore(dbPath);
  let record;
  try {
    const runs = store.list(scope, sessionId); assert.equal(runs.length, 1);
    record = store.load(scope, runs[0].runId);
  } finally { store.close(); }
  assert.equal(record.snapshot.phase, 'interrupted');
  assert.equal(record.snapshot.reason, 'effect_outcome_unknown');
  assert.equal(record.snapshot.usage.modelCalls, 2); assert.equal(record.snapshot.usage.toolCalls, 3);
  const results = record.receipts.flatMap(r => r.result?.results ?? []);
  assert.equal(results.length, 3);
  const status = results.find(r => r.content?.sandbox_phase);
  assert.equal(status.status, 'ok'); assert.equal(status.content.backend, 'e2b');
  assert.equal(status.content.sandbox_phase, 'absent'); assert.equal(status.content.sandbox_id, null);
  const component = results.find(r => r.content?.summary);
  assert.equal(component.status, 'ok');
  assert.equal(component.content.summary.isolated_execution, 'enabled');
  assert.equal(component.content.sandbox.backend, 'e2b'); assert.equal(component.content.sandbox.template_bound, true);
  const unknown = results.find(r => r.status === 'uncertain');
  assert.ok(unknown); assert.equal(unknown.content.error_type, 'e2b_sandbox_outcome_unknown');
  assert.equal(unknown.content.evidence_incomplete, true); assert.equal(unknown.content.callId, 'e2b-call');
  assert.equal(unknown.content.runId, record.snapshot.runId); assert.equal(unknown.content.sessionId, sessionId);
  assert.deepEqual(unknown.content.scope, scope);
  const toolIntents = record.intents.filter(i => i.kind === 'tool');
  assert.equal(toolIntents.length, 2);
  const commandIntent = toolIntents.find(i => i.payload.calls.some(c => c.name === 'run_command'));
  assert.ok(commandIntent); assert.equal(commandIntent.operationKey, unknown.content.operationKey);
  assert.equal(commandIntent.claimedFence, unknown.content.executionFence);
  assert.deepEqual(commandIntent.payload.calls, [{ callId: 'e2b-call', name: 'run_command', arguments: commandArgs }]);
  // Read the actual durable owner written before Sandbox.create, not a status
  // fabricated by the fixture. Cold history must leave these bytes untouched.
  const stateRoot = join(root, 'studio/native-harness');
  const filesBefore = (await readdir(stateRoot, { recursive: true })).sort();
  const ownerFiles = filesBefore.filter(file => file.endsWith('/owner.json'));
  assert.equal(ownerFiles.length, 1);
  const ownerPath = join(stateRoot, ownerFiles[0]);
  const ownerBefore = await readFile(ownerPath, 'utf8'), owner = JSON.parse(ownerBefore);
  assert.equal(owner.schemaVersion, 'agentkit.native-e2b-sandbox-owner/v1');
  assert.equal(owner.phase, 'unknown'); assert.equal(owner.outcomeReason, 'sandbox_create_outcome_unknown');
  assert.equal(owner.sandboxId, null); assert.deepEqual(owner.scope, scope); assert.equal(owner.sessionId, sessionId);
  assert.deepEqual(owner.createIdentity, { callId: 'e2b-call', executionFence: commandIntent.claimedFence,
    operationKey: commandIntent.operationKey, runId: record.snapshot.runId });
  assert.match(owner.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(filesBefore.some(file => /e2b-commands\/.*\/background\//.test(file)), false, 'no command supervisor starts after unknown sandbox creation');
  const before = canonical(record);
  const processesBefore = await readRows(join(root, 'host-processes.jsonl'));
  assert.equal(processesBefore.length, 1); assert.equal(processesBefore[0].node, process.version);
  assert.equal(processesBefore[0].path, nodeOnlyBin); assert.notEqual(processesBefore[0].pid, process.pid);
  await harness.close();
  assert.throws(() => process.kill(processesBefore[0].pid, 0), { code: 'ESRCH' });
  harness = new DeepSeekHarness(options);
  const resumed = await harness.resumeSession(sessionId); assert.equal(resumed.id, sessionId);
  const probe = await waitResume();
  assert.equal(probe.historyHasOriginalGoal, true); assert.equal(probe.historyHasUnknown, true);
  assert.deepEqual(probe.unknownResults, [{ content: unknown.content, isError: true }],
    'restored public history preserves the exact unknown result and original locator');
  assert.equal(probe.historyHasTurnEnd, false, 'interrupted owned turn stays open for explicit recovery');
  assert.equal(probe.historyHasOwnedTurn, true);
  const processesAfter = await readRows(join(root, 'host-processes.jsonl'));
  assert.equal(processesAfter.length, 2); assert.notEqual(processesAfter[0].pid, processesAfter[1].pid);
  assert.equal(processesAfter[1].pid, probe.pid); assert.equal(processesAfter[1].node, process.version);
  assert.equal(processesAfter[1].path, nodeOnlyBin);
  assert.equal(requests.length, 2); if (modelFailure) throw modelFailure;
  assert.equal(await readFile(admissionsPath, 'utf8'), admissionsBefore);
  assert.equal(await readFile(ownerPath, 'utf8'), ownerBefore);
  assert.deepEqual((await readdir(stateRoot, { recursive: true })).filter(f => f.includes('e2b-commands')).sort(), filesBefore.filter(f => f.includes('e2b-commands')));
  assert.deepEqual(await readdir(join(root, 'workspace')), []);
  const reopened = new SqliteRunStore(dbPath);
  try {
    assert.equal(reopened.list(scope, sessionId).length, 1);
    assert.equal(canonical(reopened.load(scope, record.snapshot.runId)), before);
  } finally { reopened.close(); }
  const evidence = { node: process.version, archive: { path: archive, sha256: archiveSha }, sdk: { source, commit: sdkCommit },
    e2bSdk: { name: e2bPackage.name, version: e2bPackage.version }, endpoint: 'https://127.0.0.1:9',
    root, runId: record.snapshot.runId, sessionId, agentId, modelRequests: requests.length,
    actualToolAdmissions: admissions.length, phase: record.snapshot.phase, reason: record.snapshot.reason,
    hostProcesses: processesAfter, resumeProbe: probe, owner: { path: ownerPath, sha256: sha(ownerBefore), phase: owner.phase },
    originalOwnerAndFullLedgerUnchanged: true, recordCanonicalLength: before.length,
    boundary: 'Installed real E2B JS SDK refused endpoint + packed Host + real new-PID history restoration. Not online E2B success or fresh installation.' };
  await writeFile(join(root, 'e2b-proof-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log('PASS: actual E2B unknown owner/receipt; no local fallback; exact 2 model/3 tool admissions; real Host restart and history restoration; full ledger and owner bytes unchanged');
} catch (error) {
  failed = true;
  await writeFile(join(root, 'e2b-proof-failure.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack, modelRequests: requests.length })).catch(() => {});
  throw error;
} finally {
  try { await harness?.close(); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!values.keep && !failed) await rm(root, { recursive: true, force: true });
  }
}
