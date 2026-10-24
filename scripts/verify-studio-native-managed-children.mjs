/** Packed Studio + actual maintained SDK/SessionController, signed Server
 * admission, authenticated existing child routes, real child/model/tool ports.
 * Only the HTTP model responses and Server signing key are controlled peers. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { command, permitIssuer } from '../tests/fixtures/native-managed-kernel.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), source = resolve(values.source), archive = resolve(values.archive);
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-managed-children-')));
const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
console.log(`Managed child evidence: ${root}`);
const issuer = permitIssuer(), requests = [], failures = [], receipts = [], commands = [], runs = [];
let harness, ledger, localLedger, scope, identity, current, parentStep, childStep, continued;
const admissions = async () => (await readFile(join(root, 'managed-tool-admissions.jsonl'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
})).trim().split('\n').filter(Boolean).map(JSON.parse);
async function until(check, label) {
  const deadline = Date.now() + 15000;
  for (;;) { assert.deepEqual(failures, []); const result = await check(); if (result) return result;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function rpc(method, payload = identity, expected = true) {
  const { origin, cookie } = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
  const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: canonical({ method, payload }), signal: AbortSignal.timeout(7000) });
  assert.equal(response.status, 200); const result = (await response.json()).result;
  assert.equal(result?.ok, expected, canonical(result)); return expected ? result.value : result;
}
const rootRecord = runId => ledger.load(scope, runId);
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push({ action: current, body });
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer child-proof-secret');
    const child = body.model === 'child-proof'; assert.ok(child || body.model === 'parent-proof');
    let call, text;
    if (child) {
      assert.deepEqual((body.tools ?? []).map(row => row.function.name), ['read_workspace_file']);
      assert.match(body.messages[0].content, /CHILD_WORKSPACE_READER/);
      if (childStep++ === 0) {
        const history = await rpc('sessions/native-child-history'), task = history.tasks[0];
        assert.ok(task); assert.equal(task.canSendInput, true); assert.equal(task.canCancel, true); assert.equal(task.canPromote, true);
        assert.equal(task.resultAvailable, false); assert.equal(task.usageIncludedInParent, false);
        const pending = await rpc('sessions/native-child-result', { ...identity, runId: history.runId, childRunId: task.childRunId });
        assert.equal(pending.text, ''); assert.equal(pending.task.resultAvailable, false);
        assert.equal((await rpc('sessions/native-child-tasks')).tasks[0].childRunId, task.childRunId);
        const control = { ...identity, runId: history.runId, childRunId: task.childRunId, commandId: randomUUID(),
          ...(current === 'send' ? { text: 'Managed SDK guidance: read original proof.txt.', expectedGoalRevision: task.goalRevision } : {}) };
        const method = `sessions/native-child-${current}`;
        const wrong = await rpc(method, { ...control, runId: 'foreign-run' }, false);
        assert.match(canonical(wrong), /control_run_unavailable/);
        assert.equal((await rpc(method, control)).status, 'accepted');
        assert.equal((await rpc(method, control)).status, 'duplicate');
        receipts.push({ method, control });
        if (current === 'send') await until(() => {
          const parent = rootRecord(history.runId), reservation = parent.snapshot.childBudgetReservations[0];
          return ledger.load(reservation.childScope, reservation.childRunId).commands.some(row => row.command.kind === 'guide');
        }, 'original child receives guidance before response');
        if (current === 'cancel') await until(async () => (await rpc('sessions/native-child-history')).tasks[0].phase === 'canceled',
          'original held child cancels without its provider completing');
        if (current === 'promote') {
          await continued.promise;
          const tasks = await rpc('sessions/native-child-tasks', { ...identity, runId: history.runId });
          assert.equal(tasks.tasks[0].delivery, 'background'); assert.equal(tasks.tasks[0].canPromote, false);
          assert.equal(childStep, 1, 'parent continues before original child model completes');
        }
        call = { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
      } else {
        assert.match(JSON.stringify(body.messages), /Evidence from the actual child workspace/);
        if (current === 'send') assert.match(JSON.stringify(body.messages), /Managed SDK guidance/);
        text = `Child ${current} evidence`;
      }
    } else if (parentStep++ === 0) {
      assert.ok(body.tools.some(row => row.function.name === 'native_delegate'));
      call = { name: 'native_delegate', arguments: { role: 'reader', task: `Read proof.txt for ${current}` } };
    } else { continued.resolve(); text = `Parent completed ${current}`; }
    const delta = call ? { tool_calls: [{ index: 0, id: `managed-child-tool-${requests.length}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${canonical({ id: `response-${requests.length}`,
      choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push({ message: error.message, stack: error.stack }); response.statusCode = 500; response.end('Managed child model proof failed'); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph); execFileSync('tar', ['-xzf', archive, '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai') continue;
    await symlink(join(repository, 'node_modules', name), join(dependencies, name));
  }
  const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(publicPackages)) await symlink(join(publicPackages, name), join(dependencies, '@deepseek-ai', name));
  for (const [path, name] of [['packages/api/session-controller', 'dsh-api-session-controller'],
    ['packages/client/connection', 'dsh-client-connection'], ['packages/preset/agent-preset-registry', 'dsh-agent-preset-registry']]) {
    try { await symlink(join(source, path), join(dependencies, '@deepseek-ai', name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const plugin = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud'); await mkdir(plugin, { recursive: true });
  await symlink(installed, join(plugin, 'agentkit-studio'));
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
  const proof = join(root, 'managed-proof.json'); await writeFile(proof, canonical({ publicKeyPem: issuer.publicKeyPem }));
  const patch = join(root, 'managed-children.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:', '    - id: child-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: child-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: child-proof-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: child-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: child-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: child-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: child-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: child-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-children.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`,
    `        managedProofPath: ${JSON.stringify(proof)}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-parent-profile', model: 'parent-proof', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(options); await harness.start(); await harness.session('native-child-parent').getWorkingDirectory();
  const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
  identity = { agentId, sessionId: 'native-child-parent' };
  scope = { tenantId: 'managed-child-tenant', userId: 'managed-child-user', agentId,
    workspaceId: createHash('sha256').update(JSON.stringify(join(root, 'workspace'))).digest('hex') };
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  ledger = new SqliteRunStore(join(root, 'studio/native-harness/managed-kernel/runs.sqlite'));
  localLedger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  const localScope = { ...scope, tenantId: 'local', userId: 'local-user' };
  for (current of ['send', 'cancel', 'promote']) {
    parentStep = 0; childStep = 0; continued = Promise.withResolvers();
    const cmd = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
      payload: { content: `Run bounded child ${current}` } });
    commands.push(cmd);
    const { origin } = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
    const send = () => fetch(origin + '/_agentkit/native-kernel/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: canonical({ command: cmd, permit: issuer.issue(cmd) }), signal: AbortSignal.timeout(10000) });
    const accepted = await send(); assert.equal(accepted.status, 202); const receipt = await accepted.json();
    runs.push(receipt.run_id);
    const status = await until(async () => {
      const state = await rpc('sessions/native-recovery-status', { ...identity, runId: receipt.run_id });
      return state.phase === 'completed' && state.managed.owner === 'closed' && state.managed.executionState === 'idle' ? state : null;
    }, `managed ${current} closes its actual SDK owner`);
    assert.equal(status.managed.executionState, 'idle'); assert.equal(status.canReconcile, false);
    const parent = rootRecord(receipt.run_id), reservation = parent.snapshot.childBudgetReservations[0];
    assert.equal(parent.snapshot.phase, 'completed'); assert.equal(parent.snapshot.finalText, `Parent completed ${current}`);
    // A promoted child completes after the parent's first candidate. Its
    // observation invalidates that candidate and requires one final model pass.
    assert.equal(parent.snapshot.usage.modelCalls, current === 'promote' ? 3 : 2);
    assert.equal(parent.snapshot.parentRunId, runs.length > 1 ? runs.at(-2) : null);
    const child = ledger.load(reservation.childScope, reservation.childRunId);
    assert.equal(child.snapshot.phase, current === 'cancel' ? 'canceled' : 'completed');
    assert.equal(child.snapshot.usage.toolCalls, current === 'cancel' ? 0 : 1); assert.ok(reservation.settledUsageDigest);
    assert.equal(parent.snapshot.descendantUsage.modelCalls, current === 'cancel' ? 1 : 2);
    const activeReceipt = receipts.at(-1); assert.equal(activeReceipt.control.runId, receipt.run_id);
    assert.equal((await rpc(activeReceipt.method, activeReceipt.control)).status, 'duplicate');
    const historical = await rpc('sessions/native-child-history', { ...identity, runId: receipt.run_id });
    const task = historical.tasks.find(row => row.childRunId === reservation.childRunId);
    assert.ok(task); assert.equal(task.resultAvailable, true); assert.equal(task.canCancel, false); assert.equal(task.canSendInput, false);
    const detail = await rpc('sessions/native-child-result', { ...identity, runId: receipt.run_id, childRunId: child.snapshot.runId });
    assert.equal(detail.text, current === 'cancel' ? '' : `Child ${current} evidence`);
    const duplicate = await send(); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).status, 'duplicate');
    assert.deepEqual(rootRecord(receipt.run_id), parent, 'terminal reads and duplicate confirmations cannot mutate the original root');
    assert.deepEqual(localLedger.list(scope), []); assert.deepEqual(localLedger.list(localScope), []);
  }
  const history = await rpc('sessions/native-child-history');
  assert.equal(history.totalTasks, 3, 'consecutive managed roots share original Session ancestry');
  const before = { records: runs.map(rootRecord), childRecords: runs.map(runId => {
    const reservation = rootRecord(runId).snapshot.childBudgetReservations[0]; return ledger.load(reservation.childScope, reservation.childRunId);
  }), counts: { models: requests.length, tools: (await admissions()).length },
  history: JSON.parse(await readFile(join(root, 'managed-session-history.json'), 'utf8')) };
  assert.equal(before.counts.models, 12); assert.equal(before.counts.tools, 5);
  assert.deepEqual((await admissions()).map(row => row.name), ['native_delegate', 'read_workspace_file', 'native_delegate', 'native_delegate', 'read_workspace_file']);
  const fileMtime = (await stat(join(root, 'workspace/proof.txt'), { bigint: true })).mtimeNs;
  assert.equal(before.history.filter(row => row.type === 'turn/start').length, 3);
  assert.equal(before.history.filter(row => row.type === 'turn/end').length, 3);
  await writeFile(join(root, 'managed-session-history-warm.json'), canonical(before.history));
  await harness.close(); harness = new DeepSeekHarness(options); await harness.resumeSession(identity.sessionId);
  assert.deepEqual(await rpc('sessions/native-child-history'), history);
  for (let index = 0; index < receipts.length; index++) {
    const { method, control } = receipts[index];
    assert.equal((await rpc(method, control)).status, 'duplicate');
    const refused = await rpc(method, { ...control, commandId: randomUUID() }, false); assert.match(canonical(refused), /control_run_unavailable/);
    const result = await rpc('sessions/native-child-result', { ...identity, runId: runs[index], childRunId: control.childRunId });
    assert.equal(result.text, index === 1 ? '' : `Child ${['send', 'cancel', 'promote'][index]} evidence`);
    assert.deepEqual(rootRecord(runs[index]), before.records[index]);
    const reservation = before.records[index].snapshot.childBudgetReservations[0];
    assert.deepEqual(ledger.load(reservation.childScope, reservation.childRunId), before.childRecords[index]);
  }
  assert.deepEqual({ models: requests.length, tools: (await admissions()).length }, before.counts);
  assert.equal((await stat(join(root, 'workspace/proof.txt'), { bigint: true })).mtimeNs, fileMtime);
  const cold = JSON.parse(await readFile(join(root, 'managed-session-history.json'), 'utf8'));
  assert.deepEqual(cold.slice(0, before.history.length), before.history);
  assert.deepEqual(cold.slice(before.history.length).map(({ type, seq, data }) => ({ type, seq, data })),
    [{ type: 'session/end-seed', seq: before.history.at(-1).seq + 1, data: {} }],
    'only the actual SDK restore seed may be appended; no repeated user/model/tool/usage events');
  const processes = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(processes.length, 2); assert.notEqual(processes[0].pid, processes[1].pid);
  assert.ok(processes.every(row => row.path === join(root, 'node-only-bin')));
  await harness.close(); harness = null;
  await writeFile(join(root, 'managed-children-proof.json'), canonical({ contract: 'agentkit.managed-children-proof/v1', archiveSha256,
    processes, scope, runs, commands, receipts, counts: before.counts, publicEvents: before.history.length,
    coldModelCalls: requests.length - before.counts.models, coldToolCalls: (await admissions()).length - before.counts.tools }));
  console.log('Managed children PASS: three consecutive signed Server roots, actual SDK owner lifecycle, authenticated send/cancel/promote, exact retry, original managed history/results, real workspace reads, distinct-PID cold replay with zero model/tool effects, Node-only PATH.');
} finally {
  await writeFile(join(root, 'controlled-model-requests.json'), canonical({ requests, failures }));
  continued?.resolve(); await harness?.close(); ledger?.close(); localLedger?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); if (!values.keep) await rm(root, { recursive: true, force: true });
}
