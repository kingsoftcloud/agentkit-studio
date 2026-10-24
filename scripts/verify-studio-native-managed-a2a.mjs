/** Normal Studio archive, actual SDK/SessionController and shared Host binding.
 * Only model HTTP, remote A2A services and human answers are controlled peers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { command, permitIssuer } from '../tests/fixtures/native-managed-kernel.mjs';
import { internalPeer, spec, taskId } from '../tests/fixtures/native-a2a-internal-peer.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' },
  child: { type: 'boolean' }, approval: { type: 'boolean' }, interrupt: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
assert.ok(!values.interrupt || !values.approval, 'Interruption proves an unanswered input request');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), source = resolve(values.source), archive = resolve(values.archive);
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-managed-a2a-')));
const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
console.log(`Managed A2A evidence: ${root}`);
const issuer = permitIssuer(), requests = [], questions = [], approvals = [], failures = [];
const questionEntered = Promise.withResolvers(), releaseAnswer = Promise.withResolvers();
const peer = await internalPeer({ mode: 'pause', ...(values.approval ? { expectedContinuationParts: [{ data: 'approve' }],
  initialTask: { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: {
    messageId: 'managed-remote-approval', role: 'ROLE_AGENT', parts: [{ text: 'Approve remote operation?' }], metadata: {
      input_schema: { type: 'string', enum: ['approve', 'reject'] },
      ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
        presentation: { title: 'remote-write', description: '{"arguments":{}}' } },
    },
  } } },
} : {}) });
let harness, ledger, localLedger, identity, scope;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const jsonl = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function until(check, label) {
  const deadline = Date.now() + 20000;
  for (;;) { assert.deepEqual(failures, []); const result = await check(); if (result) return result;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function rpc(method, payload = identity) {
  const { origin, cookie } = await json(join(root, 'control-auth.json'));
  const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: canonical({ method, payload }), signal: AbortSignal.timeout(7000) });
  assert.equal(response.status, 200); const result = (await response.json()).result;
  assert.equal(result?.ok, true, canonical(result)); return result.value;
}
async function send(cmd) {
  const { origin } = await json(join(root, 'control-auth.json'));
  const response = await fetch(origin + '/_agentkit/native-kernel/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: canonical({ command: cmd, permit: issuer.issue(cmd) }), signal: AbortSignal.timeout(10000) });
  assert.ok([200, 202].includes(response.status)); return response.json();
}
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw);
    if (request.url === '/question') {
      questions.push(body); assert.equal(body.sessionId, identity.sessionId); assert.equal(body.questions.length, 1);
      questionEntered.resolve(); if (values.interrupt) await releaseAnswer.promise;
      const answer = { id: body.questions[0].id, ...(values.approval ? { selected: ['批准远端操作'] }
        : { selected: [], custom: '{"answer":1}' }) };
      if (!response.destroyed) response.end(canonical({ answers: [answer] })); return;
    }
    if (request.url === '/approval') {
      approvals.push(body); assert.equal(body.toolName, 'a2a_continue_task');
      assert.match(body.reason, /original-remote/); response.end('{"outcome":"allowed-once"}'); return;
    }
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer child-proof-secret');
    requests.push(body); const child = body.model === 'child-proof'; assert.ok(child || body.model === 'parent-proof');
    const index = requests.filter(row => row.model === body.model).length;
    let call, text;
    if (values.child && !child) {
      if (index === 1) call = { name: 'native_delegate', arguments: { role: 'reader', task: 'Ask original remote question' } };
      else { assert.match(canonical(body.messages), /Child consumed remote result/); text = 'Parent consumed child result'; }
    } else if (index === 1) call = { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Ask original remote question' } };
    else {
      const result = JSON.parse(body.messages.findLast(row => row.role === 'tool').content);
      assert.equal(result.state, 'completed'); assert.equal(result.task_id, taskId);
      assert.equal(result.reply, values.approval ? 'Approve remote operation?' : 'Please answer');
      text = child ? 'Child consumed remote result' : 'Root consumed remote result';
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `managed-a2a-${requests.length}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${canonical({ id: `response-${requests.length}`,
      choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push({ message: error.message, stack: error.stack }); response.statusCode = 500; response.end('Managed A2A proof failed'); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph); execFileSync('tar', ['-xzf', archive, '-C', graph]); await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai') continue;
    await symlink(join(repository, 'node_modules', name), join(dependencies, name));
  }
  const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(publicPackages)) await symlink(join(publicPackages, name), join(dependencies, '@deepseek-ai', name));
  for (const [path, name] of [['packages/api/session-controller', 'dsh-api-session-controller'],
    ['packages/client/connection', 'dsh-client-connection'], ['packages/preset/agent-preset-registry', 'dsh-agent-preset-registry']]) {
    try { await symlink(join(source, path), join(dependencies, '@deepseek-ai', name)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const plugin = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud'); await mkdir(plugin, { recursive: true });
  await symlink(installed, join(plugin, 'agentkit-studio'));
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
  const proofPath = join(root, 'managed-proof.json'); await writeFile(proofPath, canonical({ publicKeyPem: issuer.publicKeyPem }));
  const a2aPath = join(root, 'managed-a2a.json'); await writeFile(a2aPath, canonical({ bindings: [spec], env: peer.env,
    questionUrl: origin + '/question', approvalUrl: origin + '/approval' }));
  const patch = join(root, 'managed-a2a.patch.yml');
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
    '      config:', `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(origin + '/v1')}`,
    `        managedProofPath: ${JSON.stringify(proofPath)}`, `        managedA2aProofPath: ${JSON.stringify(a2aPath)}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-parent-profile', model: 'parent-proof', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(options); await harness.start(); await harness.session('native-child-parent').getWorkingDirectory();
  const { agentId } = await json(join(root, 'identity.json')); identity = { agentId, sessionId: 'native-child-parent' };
  scope = { tenantId: 'managed-child-tenant', userId: 'managed-child-user', agentId,
    workspaceId: createHash('sha256').update(JSON.stringify(join(root, 'workspace'))).digest('hex') };
  peer.setRecordDirectory(join(root, 'studio/native-harness/workspace-state', createHash('sha256').update(agentId).digest('hex'), 'a2a-calls'));
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  ledger = new SqliteRunStore(join(root, 'studio/native-harness/managed-kernel/runs.sqlite'));
  localLedger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  const cmd = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
    payload: { content: values.child ? 'Delegate original remote question' : 'Ask original remote question' } });
  const receipt = await send(cmd); assert.equal(receipt.status, 'accepted');
  if (values.interrupt) {
    await questionEntered.promise;
    const stop = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
      command_type: 'interrupt', payload: { run_id: receipt.run_id } });
    assert.equal((await send(stop)).status, 'accepted');
  }
  const expectedPhase = values.interrupt ? 'canceled' : 'completed';
  const status = await until(async () => {
    const value = await rpc('sessions/native-recovery-status', { ...identity, runId: receipt.run_id });
    return value.phase === expectedPhase && value.managed.owner === 'closed' && value.managed.executionState === 'idle' ? value : null;
  }, 'original actual SDK owner settles');
  releaseAnswer.resolve();
  assert.equal(status.canReconcile, false); const record = ledger.load(scope, receipt.run_id);
  assert.equal(record.snapshot.phase, expectedPhase); assert.equal(questions.length, 1); assert.equal(approvals.length, values.interrupt ? 0 : 1);
  const childReservation = record.snapshot.childBudgetReservations[0];
  const childRecord = values.child ? ledger.load(childReservation.childScope, childReservation.childRunId) : null;
  const effectRecord = childRecord ?? record;
  assert.equal(effectRecord.snapshot.phase, expectedPhase);
  assert.equal(effectRecord.intents.filter(row => row.kind === 'tool').length, 1);
  assert.equal(effectRecord.intents.filter(row => row.kind === 'tool_receipt').length, values.interrupt ? 0 : 1);
  assert.equal(effectRecord.commands.filter(row => row.command.kind === 'reconcile_tool').length, values.interrupt ? 0 : 1);
  assert.equal(requests.length, values.interrupt ? (values.child ? 2 : 1) : (values.child ? 4 : 2));
  assert.equal(peer.calls.filter(row => row.wireMethod === 'SendMessage').length, values.interrupt ? 1 : 2);
  assert.equal(peer.calls.filter(row => row.wireMethod === 'CancelTask').length, 0);
  const journal = peer.record(); assert.equal(journal.request.native.runId, effectRecord.snapshot.runId);
  if (values.interrupt) assert.deepEqual(Object.values(journal.managed.questions.entries).map(row => row.stage), ['withdrawn']);
  const admissions = await jsonl(join(root, 'managed-tool-admissions.jsonl'));
  assert.deepEqual(admissions.map(row => row.name), values.child ? ['native_delegate', 'call_a2a_agent'] : ['call_a2a_agent']);
  assert.deepEqual(localLedger.list(scope), []); assert.deepEqual(localLedger.list({ ...scope, tenantId: 'local', userId: 'local-user' }), []);
  const warm = await json(join(root, 'managed-session-history.json'));
  assert.equal(warm.filter(row => row.type === 'turn/owner').length, 1);
  assert.equal(warm.filter(row => row.type === 'turn/start').length, 1); assert.equal(warm.filter(row => row.type === 'turn/end').length, 1);
  assert.equal(warm.filter(row => row.type === 'approval/asked').length, approvals.length);
  assert.equal(warm.filter(row => row.type === 'approval/decided').length, approvals.length);
  assert.equal((await send(cmd)).status, 'duplicate'); assert.deepEqual(ledger.load(scope, receipt.run_id), record);
  const before = { models: requests.length, peer: peer.calls.length, questions: questions.length, approvals: approvals.length };
  await writeFile(join(root, 'managed-session-history-warm.json'), canonical(warm));
  await harness.close(); harness = new DeepSeekHarness(options); await harness.resumeSession(identity.sessionId);
  const coldStatus = await rpc('sessions/native-recovery-status', { ...identity, runId: receipt.run_id });
  assert.equal(coldStatus.phase, expectedPhase); assert.equal(coldStatus.managed.owner, 'closed');
  assert.deepEqual(ledger.load(scope, receipt.run_id), record);
  if (childRecord) assert.deepEqual(ledger.load(childReservation.childScope, childReservation.childRunId), childRecord);
  assert.deepEqual(peer.record(), journal); assert.deepEqual({ models: requests.length, peer: peer.calls.length,
    questions: questions.length, approvals: approvals.length }, before);
  const cold = await json(join(root, 'managed-session-history.json')); assert.deepEqual(cold.slice(0, warm.length), warm);
  assert.deepEqual(cold.slice(warm.length).map(({ type, seq, data }) => ({ type, seq, data })),
    [{ type: 'session/end-seed', seq: warm.at(-1).seq + 1, data: {} }]);
  const processes = await jsonl(join(root, 'host-processes.jsonl')); assert.equal(processes.length, 2);
  assert.notEqual(processes[0].pid, processes[1].pid); assert.ok(processes.every(row => row.path === nodeBin));
  await harness.close(); harness = null;
  await writeFile(join(root, 'managed-a2a-proof.json'), canonical({ contract: 'agentkit.managed-a2a-proof/v1', archiveSha256,
    mode: { child: Boolean(values.child), approval: Boolean(values.approval), interrupt: Boolean(values.interrupt) }, processes,
    receipt, scope, record, childRecord, journal, counts: before, tools: admissions.length, publicEvents: warm.length, coldEffects: 0 }));
  console.log('Managed A2A PASS: signed original Server command, actual SDK owner, original managed ledger, real Host question/approval audit, separately fenced receipt read or interruption, distinct-PID cold replay with no effects, Node-only PATH.');
} finally {
  releaseAnswer.resolve(); await writeFile(join(root, 'controlled-peers.json'), canonical({ requests, questions, approvals, failures, a2a: peer.calls }));
  await harness?.close(); ledger?.close(); localLedger?.close(); await peer.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); if (!values.keep) await rm(root, { recursive: true, force: true });
}
