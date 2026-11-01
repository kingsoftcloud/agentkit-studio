import { createRequire } from 'node:module';
/** Normal Studio archive, actual SDK/SessionController and shared Host binding.
 * Only model HTTP, remote A2A services and human answers are controlled peers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { DatabaseSync } from 'node:sqlite';
import { command, permitIssuer } from '../tests/fixtures/native-managed-kernel.mjs';
import { internalPeer, spec, taskId } from '../tests/fixtures/native-a2a-internal-peer.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' },
  child: { type: 'boolean' }, approval: { type: 'boolean' }, interrupt: { type: 'boolean' },
  'answer-crash': { type: 'boolean' }, 'effect-crash': { type: 'boolean' }, 'server-input': { type: 'boolean' },
  scoped: { type: 'boolean' }, strict: { type: 'boolean' }, 'scoped-crash': { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
assert.ok(!values.interrupt || !values.approval, 'Interruption proves an unanswered input request');
assert.ok(!values['answer-crash'] || !values.interrupt, 'Answer crash and interruption are separate boundaries');
assert.ok(!values['effect-crash'] || !(values['answer-crash'] || values.interrupt),
  'Effect crash, answer crash and interruption prove separate boundaries');
assert.ok(!values['server-input'] || !(values['answer-crash'] || values['effect-crash'] || values.interrupt),
  'Server input is a separate original structured interaction proof');
assert.ok(!values.scoped || !(values['answer-crash'] || values['effect-crash'] || values.interrupt || values['server-input']),
  'Scoped cancellation is a separate original invocation proof');
assert.ok(!values.strict || values.scoped, 'Strict approval reuse is verified with scoped cancellation');
assert.ok(!values['scoped-crash'] || values.scoped, 'Scoped cancellation crash requires --scoped');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), source = resolve(values.source), archive = resolve(values.archive);
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-managed-a2a-')));
const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
console.log(`Managed A2A evidence: ${root}`);
const issuer = permitIssuer(), requests = [], questions = [], approvals = [], failures = [];
const questionEntered = Promise.withResolvers(), releaseAnswer = Promise.withResolvers();
const releasePermission = Promise.withResolvers(); let permissionsReleased = false, crashEvidence;
const effectEntered = Promise.withResolvers(), releaseEffect = Promise.withResolvers();
const peer = await internalPeer({ mode: 'pause', ...(values.approval ? { expectedContinuationParts: [{ data: 'approve' }],
  initialTask: { id: 'original-remote', contextId: 'original-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: {
    messageId: 'managed-remote-approval', role: 'ROLE_AGENT', parts: [{ text: 'Approve remote operation?' }], metadata: {
      input_schema: { type: 'string', enum: ['approve', 'reject'] },
      ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
        presentation: { title: 'remote-write', description: '{"arguments":{}}' } },
    },
  } } },
} : {}) });
if (values['effect-crash']) peer.setHook(async (call, response) => {
  if (call.wireMethod === 'SendMessage' && call.body?.params?.message?.taskId) {
    // internalPeer has already applied the actual continuation to its remote
    // task before this hook. Hold only the response, never the effect itself.
    effectEntered.resolve(); await releaseEffect.promise;
    if (!response.destroyed) response.destroy();
  }
});
if (values['scoped-crash']) peer.setHook(async (call, response) => {
  if (call.wireMethod === 'CancelTask') {
    // The real remote fixture has applied cancellation. Its reply is still
    // held, so neither the private command nor the Server queue can confirm it.
    effectEntered.resolve(); await releaseEffect.promise;
    if (!response.destroyed) response.destroy();
  }
});
let harness, ledger, localLedger, identity, scope;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const jsonl = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function until(check, label) {
  const deadline = Date.now() + 50000;
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
async function send(cmd, statuses = [200, 202]) {
  const { origin } = await json(join(root, 'control-auth.json'));
  const response = await fetch(origin + '/_agentkit/native-kernel/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: canonical({ command: cmd, permit: issuer.issue(cmd) }), signal: AbortSignal.timeout(10000) });
  assert.ok(statuses.includes(response.status), `Unexpected command HTTP status: ${response.status}`); return response.json();
}
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw);
    if (request.url === '/question') {
      questions.push(body); assert.equal(body.sessionId, identity.sessionId); assert.equal(body.questions.length, 1);
      questionEntered.resolve(); if (values.interrupt || values['server-input'] || values.scoped) await releaseAnswer.promise;
      const answer = { id: body.questions[0].id, ...(values.approval ? { selected: ['批准远端操作'] }
        : { selected: [], custom: '{"answer":1}' }) };
      if (!response.destroyed) response.end(canonical({ answers: [answer] })); return;
    }
    if (request.url === '/approval') {
      approvals.push(body); assert.equal(body.toolName, values.strict ? 'call_a2a_agent' : 'a2a_continue_task');
      assert.match(body.reason, values.strict ? /strict policy/ : /original-remote/);
      if (values['answer-crash'] && !permissionsReleased) await releasePermission.promise;
      if (!response.destroyed) response.end('{"outcome":"allowed-once"}'); return;
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
      assert.equal(result.state, values.scoped ? 'cancelled' : 'completed'); assert.equal(result.task_id, taskId);
      assert.equal(result.reply, values.scoped ? '' : values.approval ? 'Approve remote operation?' : 'Please answer');
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
  const a2aPath = join(root, 'managed-a2a.json'); await writeFile(a2aPath, canonical({ bindings: [{ ...spec,
    ...(values.strict ? { policy_ref: 'policy://a2a/strict' } : {}) }], env: peer.env,
    questionUrl: origin + '/question', approvalUrl: origin + '/approval', serverInput: Boolean(values['server-input']), strict: Boolean(values.strict) }));
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
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  ledger = new SqliteRunStore(join(root, 'studio/native-harness/managed-kernel/runs.sqlite'));
  localLedger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  const cmd = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
    payload: { content: values.child ? 'Delegate original remote question' : 'Ask original remote question' } });
  const receipt = await send(cmd); assert.equal(receipt.status, 'accepted');
  let serverInputEvidence;
  if (values['server-input']) {
    await questionEntered.promise;
    const db = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/commands.sqlite'));
    try {
      const pending = await until(() => db.prepare('SELECT * FROM managed_interactions WHERE answer IS NULL').get(), 'original Server interaction');
      const effects = () => peer.calls.filter(row => row.wireMethod).map(row => row.wireMethod);
      const descriptor = JSON.parse(pending.data), before = { models: requests.length, remote: effects(), approvals: approvals.length };
      assert.equal(pending.run_id, receipt.run_id); assert.equal(pending.session_id, identity.sessionId);
      assert.equal(descriptor.pending.kind, values.approval ? 'approval' : 'structured_input');
      const reply = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
        command_type: 'submit_interaction', payload: { run_id: receipt.run_id, interaction_id: pending.interaction_id,
          token_ref: 'managed-input-token', expected_revision: 1, action: values.approval ? 'approve' : 'submit',
          response: values.approval ? {} : { answer: 1 } } });
      for (const fields of [{ token_ref: 'wrong' }, { expected_revision: 2 }, { run_id: 'foreign' }, { interaction_id: 'foreign' },
        { a2a_interaction_kind: values.approval ? 'structured_input' : 'approval' }]) {
        assert.equal((await send({ ...reply, command_id: command().command_id, idempotency_key: command().idempotency_key,
          payload: { ...reply.payload, ...fields } }, [400])).status, 'rejected');
        assert.equal(db.prepare('SELECT answer FROM managed_interactions WHERE interaction_id=?').get(pending.interaction_id).answer, null);
      }
      assert.deepEqual({ models: requests.length, remote: effects(), approvals: approvals.length }, before,
        'invalid submissions cannot execute remote operations; original committed event delivery may finish independently');
      assert.equal((await send(reply)).status, 'accepted');
      const answered = db.prepare('SELECT * FROM managed_interactions WHERE interaction_id=?').get(pending.interaction_id);
      assert.equal(answered.command_id, reply.command_id); assert.notEqual(answered.answer, null);
      assert.equal((await send(reply)).status, 'duplicate');
      serverInputEvidence = { pending: descriptor, command: reply, answer: JSON.parse(answered.answer) };
    } finally { db.close(); }
  }
  if (values['effect-crash']) {
    await effectEntered.promise;
    const original = ledger.load(scope, receipt.run_id);
    const journal = await until(() => {
      const current = peer.record(), questions = current.managed.questions;
      return questions.sessionDelivery?.through === questions.nextSeq - 1 ? current : null;
    }, 'original admitted-operation observation delivered to actual Session before crash');
    const native = journal.request.native, effect = ledger.load(native.scope, native.runId);
    const answered = Object.values(journal.managed.questions.entries), control = Object.values(journal.controls)
      .find(row => row.command.kind === 'continue');
    assert.equal(questions.length, 1); assert.equal(approvals.length, 1); assert.equal(requests.length, values.child ? 2 : 1);
    assert.equal(effect.snapshot.phase, 'awaiting_reconciliation'); assert.equal(answered.length, 1);
    assert.equal(answered[0].stage, 'operation_admitted'); assert.equal(control.phase, 'sending');
    assert.equal(control.command.commandId, answered[0].effectCommandId);
    const beforeCounts = { models: requests.length, peer: peer.calls.length, questions: questions.length, approvals: approvals.length };
    const beforeReads = peer.calls.filter(row => row.wireMethod === 'GetTask').length;
    assert.equal(peer.calls.filter(row => row.wireMethod === 'SendMessage').length, 2);
    const dead = harness.client.child, exited = once(dead, 'exit');
    assert.equal(dead.kill('SIGKILL'), true); const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });
    await harness.close(); releaseEffect.resolve();
    harness = new DeepSeekHarness(options); await harness.resumeSession(identity.sessionId);
    await until(async () => {
      const status = await rpc('sessions/native-recovery-status', { ...identity, runId: receipt.run_id });
      return status.managed.owner === 'open' && status.managed.executionState === 'running'
        && ledger.load(native.scope, native.runId).fence > effect.fence;
    }, 'replacement original owner reaches its reconciliation wait');
    // Observe an actually running replacement, not an unstarted queue. Its
    // idle waiter must not treat transport admission as a safe retry/read.
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual({ models: requests.length, peer: peer.calls.length, questions: questions.length, approvals: approvals.length }, beforeCounts);
    const restored = ledger.load(native.scope, native.runId);
    assert.deepEqual(restored.snapshot, effect.snapshot); assert.deepEqual(restored.intents, effect.intents);
    assert.deepEqual(restored.receipts, effect.receipts); assert.deepEqual(peer.record(), journal);
    const intent = effect.intents.find(row => row.kind === 'tool'), call = intent.payload.calls[0];
    const query = { ...identity, runId: receipt.run_id, operationKey: intent.operationKey, callId: call.callId,
      ...(values.child ? { childRunId: effect.snapshot.runId } : {}),
      kind: 'get', commandId: 'original-unknown-operation-observation' };
    if (values.child) {
      const history = await rpc('sessions/native-child-history', { ...identity, runId: receipt.run_id });
      const task = history.tasks.find(row => row.childRunId === effect.snapshot.runId);
      assert.deepEqual(task?.a2aTasks, [{ runId: receipt.run_id, childRunId: effect.snapshot.runId,
        childAgentId: effect.snapshot.scope.agentId, childSessionId: effect.snapshot.sessionId, operationKey: intent.operationKey, callId: call.callId }]);
      for (const changed of [{ childRunId: 'foreign-child' }, { callId: 'foreign-call' }, { sessionId: 'foreign-session' }])
        await assert.rejects(rpc('sessions/native-a2a-control', { ...query, ...changed }));
      assert.deepEqual({ models: requests.length, peer: peer.calls.length, questions: questions.length, approvals: approvals.length }, beforeCounts,
        'foreign child/call/parent-session probes cannot observe or control a remote task');
    }
    const observation = await rpc('sessions/native-a2a-control', query);
    assert.equal(observation.outcome, 'observed'); assert.equal(observation.state, 'completed');
    assert.equal(peer.calls.filter(row => row.wireMethod === 'SendMessage').length, 2);
    assert.equal(approvals.length, 1); assert.equal(questions.length, 1);
    crashEvidence = { boundary: 'remote-continuation-effect-before-reply', signal, originalPid: dead.pid,
      recoveredPid: harness.client.child.pid, original, effect, journal, answered, beforeCounts,
      beforeReads, automaticRecovery: true, newNativeCommandOrRecoveryRpc: false, observation: { query, result: observation } };
    await writeFile(join(root, 'managed-a2a-crash-checkpoint.json'), canonical(crashEvidence));
  }
  if (values['answer-crash']) {
    await until(() => approvals.length === 1, 'first operation permission request after durable answer');
    const original = ledger.load(scope, receipt.run_id), journal = peer.record(), native = journal.request.native;
    const effect = ledger.load(native.scope, native.runId), answered = Object.values(journal.managed.questions.entries);
    assert.equal(answered.length, 1); assert.equal(answered[0].stage, 'awaiting_permission');
    assert.equal(answered[0].status, values.approval ? 'approved' : 'submitted');
    assert.equal(effect.snapshot.phase, 'awaiting_reconciliation');
    assert.equal(questions.length, 1); assert.equal(requests.length, values.child ? 2 : 1);
    assert.equal(peer.calls.filter(row => row.wireMethod === 'SendMessage').length, 1);
    const durableHistory = await until(async () => {
      const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
      if (logs.length !== 1) return false;
      const history = await jsonl(join(root, 'sessions', logs[0]));
      return history.filter(row => row.type === 'approval/asked').length === 1 ? history : false;
    }, 'actual operation approval audit persisted before SIGKILL');
    const beforeCounts = { models: requests.length, peer: peer.calls.length, questions: questions.length };
    const dead = harness.client.child, exited = once(dead, 'exit');
    assert.equal(approvals[0].pid, dead.pid); assert.equal(dead.kill('SIGKILL'), true);
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' }); await harness.close();
    harness = new DeepSeekHarness(options); await harness.resumeSession(identity.sessionId);
    let lastStatusAt = 0;
    await until(async () => {
      if (Date.now() - lastStatusAt > 1000) {
        lastStatusAt = Date.now();
        await writeFile(join(root, 'managed-a2a-crash-recovery-status.json'), canonical(await rpc('sessions/native-recovery-status',
          { ...identity, runId: receipt.run_id })));
      }
      return approvals.length === 2;
    }, 'automatic original-command recovery requests fresh permission');
    assert.notEqual(approvals[1].pid, dead.pid); assert.equal(approvals[1].pid, harness.client.child.pid);
    assert.deepEqual({ models: requests.length, peer: peer.calls.length, questions: questions.length }, beforeCounts,
      'restoring a durable answer cannot repeat model/discovery/send/get/cancel or ask the question again');
    assert.deepEqual(Object.values(peer.record().managed.questions.entries), answered);
    const restored = ledger.load(native.scope, native.runId);
    assert.equal(restored.snapshot.runId, effect.snapshot.runId); assert.deepEqual(restored.snapshot, effect.snapshot);
    assert.deepEqual(restored.intents, effect.intents); assert.deepEqual(restored.receipts, effect.receipts);
    assert.equal(ledger.list(scope, identity.sessionId).length, 1);
    crashEvidence = { boundary: 'durable-answer-before-permission', signal, originalPid: dead.pid, recoveredPid: approvals[1].pid,
      original, effect, answered, durableHistory, beforeCounts, automaticRecovery: true, newNativeCommandOrRecoveryRpc: false };
    await writeFile(join(root, 'managed-a2a-crash-checkpoint.json'), canonical(crashEvidence));
    permissionsReleased = true; releasePermission.resolve();
  }
  let scopedEvidence;
  if (values.scoped) {
    await questionEntered.promise;
    await until(() => peer.record()?.managed?.questions?.entries && Object.keys(peer.record().managed.questions.entries).length === 1,
      'original question is durable');
    const original = peer.record(), before = { models: requests.length, sends: peer.calls.filter(row => row.wireMethod === 'SendMessage').length,
      cancels: peer.calls.filter(row => row.wireMethod === 'CancelTask').length, approvals: approvals.length };
    const cancel = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
      command_type: 'interrupt', payload: { run_id: receipt.run_id, scope_id: original.request.scopeId } });
    const wrong = command({ tenant_id: scope.tenantId, agent_instance_id: agentId, session_id: identity.sessionId,
      command_type: 'interrupt', payload: { run_id: receipt.run_id, scope_id: 'a2a-unowned' } });
    assert.equal((await send(wrong, [400])).error.code, 'native_child_scope_not_found');
    assert.deepEqual({ models: requests.length, sends: peer.calls.filter(row => row.wireMethod === 'SendMessage').length,
      cancels: peer.calls.filter(row => row.wireMethod === 'CancelTask').length, approvals: approvals.length }, before);
    assert.equal((await send(cancel)).status, 'accepted');
    if (values['scoped-crash']) {
      await effectEntered.promise;
      const journal = await until(() => { const current = peer.record(), local = current.managed.questions;
        return local.sessionDelivery?.through === local.nextSeq - 1 ? current : null; }, 'withdrawn original question delivery before crash');
      const control = Object.values(journal.controls).find(row => row.command.commandId === cancel.command_id);
      assert.equal(control.phase, 'sending'); assert.equal(control.hostDecision, undefined);
      assert.equal(control.scopeCancellation.commandId, cancel.command_id);
      const native = journal.request.native, effect = ledger.load(native.scope, native.runId), parent = ledger.load(scope, receipt.run_id);
      const counts = { models: requests.length, questions: questions.length, approvals: approvals.length,
        remote: peer.calls.filter(row => row.wireMethod).length };
      const beforeReads = peer.calls.filter(row => row.wireMethod === 'GetTask').length;
      const db = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/commands.sqlite'), { readOnly: true });
      try { assert.equal(db.prepare('SELECT state FROM managed_scoped_controls WHERE command_id=?').get(cancel.command_id).state, 'queued'); }
      finally { db.close(); }
      const dead = harness.client.child, exited = once(dead, 'exit'); assert.equal(dead.kill('SIGKILL'), true);
      const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });
      await harness.close(); releaseEffect.resolve();
      harness = new DeepSeekHarness(options); await harness.resumeSession(identity.sessionId);
      await until(async () => { const status = await rpc('sessions/native-recovery-status', { ...identity, runId: receipt.run_id });
        return status.managed.owner === 'open' && status.managed.executionState === 'running'
          && ledger.load(scope, receipt.run_id).fence > parent.fence; }, 'replacement resumes the original root owner');
      const recoveredDb = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/commands.sqlite'), { readOnly: true });
      let recovered;
      try { recovered = await until(() => { const row = recoveredDb.prepare('SELECT * FROM managed_scoped_controls WHERE command_id=?').get(cancel.command_id);
        return row?.state === 'delivered' && row; }, 'replacement delivers same scoped command without remote replay'); }
      finally { recoveredDb.close(); }
      assert.equal(JSON.parse(recovered.result).outcome, 'unknown');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.deepEqual({ models: requests.length, questions: questions.length, approvals: approvals.length,
        remote: peer.calls.filter(row => row.wireMethod).length }, counts);
      const restored = ledger.load(native.scope, native.runId);
      assert.deepEqual(restored.snapshot, effect.snapshot); assert.deepEqual(restored.intents, effect.intents);
      assert.deepEqual(restored.receipts, effect.receipts); assert.deepEqual(peer.record(), journal);
      const query = { ...identity, runId: receipt.run_id, operationKey: native.operationKey, callId: native.call.callId,
        ...(values.child ? { childRunId: native.runId } : {}), kind: 'get', commandId: 'confirm-unknown-scoped-cancel' };
      const observed = await rpc('sessions/native-a2a-control', query); assert.equal(observed.state, 'cancelled');
      crashEvidence = { boundary: 'remote-scoped-cancel-effect-before-reply', originalPid: dead.pid, recoveredPid: harness.client.child.pid,
        signal, parent, effect, journal, control, counts, beforeReads, automaticRecovery: true, scopedCommand: cancel,
        observation: { query, result: observed } };
      await writeFile(join(root, 'managed-a2a-crash-checkpoint.json'), canonical(crashEvidence));
    }
    const db = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/commands.sqlite'), { readOnly: true });
    try { const row = await until(() => { const row = db.prepare('SELECT * FROM managed_scoped_controls WHERE command_id=?').get(cancel.command_id);
      return row?.state !== 'queued' && row; }, 'original Server scoped cancellation delivery');
      assert.equal(row.state, 'delivered', canonical(row)); assert.equal(JSON.parse(row.result).outcome, values['scoped-crash'] ? 'unknown' : 'remote_cancelled');
      scopedEvidence = { command: cancel, original, delivered: JSON.parse(row.result), before }; }
    finally { db.close(); }
    assert.equal((await send(cancel)).status, 'duplicate');
  }
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
  assert.equal(record.snapshot.phase, expectedPhase); assert.equal(questions.length, 1);
  assert.equal(approvals.length, values.scoped ? values.strict ? 1 : 0 : values.interrupt ? 0 : values['answer-crash'] ? 2 : 1);
  const childReservation = record.snapshot.childBudgetReservations[0];
  const childRecord = values.child ? ledger.load(childReservation.childScope, childReservation.childRunId) : null;
  const effectRecord = childRecord ?? record;
  assert.equal(effectRecord.snapshot.phase, expectedPhase);
  assert.equal(effectRecord.intents.filter(row => row.kind === 'tool').length, 1);
  assert.equal(effectRecord.intents.filter(row => row.kind === 'tool_receipt').length, values.interrupt ? 0 : 1);
  assert.equal(effectRecord.commands.filter(row => row.command.kind === 'reconcile_tool').length, values.interrupt ? 0 : 1);
  assert.equal(requests.length, values.interrupt ? (values.child ? 2 : 1) : (values.child ? 4 : 2));
  assert.equal(peer.calls.filter(row => row.wireMethod === 'SendMessage').length, values.interrupt || values.scoped ? 1 : 2);
  assert.equal(peer.calls.filter(row => row.wireMethod === 'CancelTask').length, values.scoped ? 1 : 0);
  if (values['effect-crash']) assert.equal(peer.calls.filter(row => row.wireMethod === 'GetTask').length, crashEvidence.beforeReads + 1,
    'only authenticated human observation queries remotely; the separately fenced Native receipt read consumes that durable terminal confirmation');
  if (values['scoped-crash']) assert.equal(peer.calls.filter(row => row.wireMethod === 'GetTask').length, crashEvidence.beforeReads + 1);
  const journal = peer.record(); assert.equal(journal.request.native.runId, effectRecord.snapshot.runId);
  if (values.interrupt || values.scoped) assert.deepEqual(Object.values(journal.managed.questions.entries).map(row => row.stage), ['withdrawn']);
  if (values.scoped) {
    assert.ok(!record.commands.some(row => row.command.kind === 'cancel'));
    assert.ok(!effectRecord.commands.some(row => row.command.kind === 'cancel'));
    const resolved = journal.managed.events.log.filter(row => row.event_type === 'interaction.resolved');
    assert.equal(resolved.length, 1); assert.equal(resolved[0].source.metadata.host_decision, undefined);
    assert.equal(resolved[0].source.metadata.scope_cancellation.commandId, scopedEvidence.command.command_id);
    assert.equal(Object.values(journal.controls).find(row => row.scopeCancellation)?.hostDecision, undefined);
  }
  const admissions = await jsonl(join(root, 'managed-tool-admissions.jsonl'));
  assert.deepEqual(admissions.map(row => row.name), values.child ? ['native_delegate', 'call_a2a_agent'] : ['call_a2a_agent']);
  assert.deepEqual(localLedger.list(scope), []); assert.deepEqual(localLedger.list({ ...scope, tenantId: 'local', userId: 'local-user' }), []);
  const warm = await json(join(root, 'managed-session-history.json'));
  assert.equal(warm.filter(row => row.type === 'turn/owner').length, 1);
  assert.equal(warm.filter(row => row.type === 'turn/start').length, 1); assert.equal(warm.filter(row => row.type === 'turn/end').length, 1);
  assert.equal(warm.filter(row => row.type === 'approval/asked').length, approvals.length);
  assert.equal(warm.filter(row => row.type === 'approval/decided').length, values.scoped ? values.strict ? 1 : 0 : values.interrupt ? 0 : 1);
  assert.equal((await send(cmd)).status, 'duplicate'); assert.deepEqual(ledger.load(scope, receipt.run_id), record);
  const before = { models: requests.length, peer: peer.calls.length, questions: questions.length, approvals: approvals.length };
  const interactionRecords = () => {
    const db = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/commands.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM managed_interactions ORDER BY interaction_id').all()
      .map(row => ({ ...row, data: JSON.parse(row.data), answer: row.answer === null ? null : JSON.parse(row.answer) })); }
    finally { db.close(); }
  };
  const managedInteractions = interactionRecords(); assert.equal(managedInteractions.length, 1);
  if (values.interrupt || values.scoped) { assert.equal(managedInteractions[0].data.closed, true); assert.equal(managedInteractions[0].answer, null); }
  else {
    assert.equal(managedInteractions[0].data.pending.kind, values.approval ? 'approval' : 'structured_input');
    assert.equal(managedInteractions[0].answer.action, values.approval ? 'approve' : 'submit');
    if (!values.approval) assert.deepEqual(managedInteractions[0].answer.parts, [{ data: { answer: 1 } }]);
    if (serverInputEvidence) assert.equal(managedInteractions[0].command_id, serverInputEvidence.command.command_id);
  }
  await writeFile(join(root, 'managed-session-history-warm.json'), canonical(warm));
  await harness.close(); harness = new DeepSeekHarness(options); await harness.resumeSession(identity.sessionId);
  const coldStatus = await rpc('sessions/native-recovery-status', { ...identity, runId: receipt.run_id });
  assert.equal(coldStatus.phase, expectedPhase); assert.equal(coldStatus.managed.owner, 'closed');
  assert.deepEqual(ledger.load(scope, receipt.run_id), record);
  if (childRecord) assert.deepEqual(ledger.load(childReservation.childScope, childReservation.childRunId), childRecord);
  assert.deepEqual(peer.record(), journal); assert.deepEqual({ models: requests.length, peer: peer.calls.length,
    questions: questions.length, approvals: approvals.length }, before);
  assert.deepEqual(interactionRecords(), managedInteractions, 'cold replay preserves the exact original Server interaction ledger');
  const cold = await json(join(root, 'managed-session-history.json')); assert.deepEqual(cold.slice(0, warm.length), warm);
  assert.deepEqual(cold.slice(warm.length).map(({ type, seq, data }) => ({ type, seq, data })),
    [{ type: 'session/end-seed', seq: warm.at(-1).seq + 1, data: {} }]);
  const processes = await jsonl(join(root, 'host-processes.jsonl')); assert.equal(processes.length, crashEvidence ? 3 : 2);
  assert.equal(new Set(processes.map(row => row.pid)).size, processes.length); assert.ok(processes.every(row => row.path === nodeBin));
  await harness.close(); harness = null;
  await writeFile(join(root, 'managed-a2a-proof.json'), canonical({ contract: 'agentkit.managed-a2a-proof/v1', archiveSha256,
    mode: { child: Boolean(values.child), approval: Boolean(values.approval), interrupt: Boolean(values.interrupt), serverInput: Boolean(values['server-input']),
      scoped: Boolean(values.scoped), strict: Boolean(values.strict), scopedCrash: Boolean(values['scoped-crash']) }, processes,
    receipt, scope, record, childRecord, journal, managedInteractions, ...(crashEvidence ? { crashEvidence } : {}),
    ...(serverInputEvidence ? { serverInputEvidence } : {}),
    ...(scopedEvidence ? { scopedEvidence } : {}),
    counts: before, tools: admissions.length, publicEvents: warm.length, coldEffects: 0 }));
  console.log(`Managed A2A PASS: signed original Server command, actual SDK owner, original managed ledger, real Host question/approval audit, separately fenced receipt read or interruption, ${crashEvidence ? `actual SIGKILL at ${crashEvidence.boundary} and automatic original-command recovery, ` : ''}distinct-PID cold replay with no effects, Node-only PATH.`);
} finally {
  releaseAnswer.resolve(); releasePermission.resolve(); releaseEffect.resolve();
  await writeFile(join(root, 'controlled-peers.json'), canonical({ requests, questions, approvals, failures, a2a: peer.calls }));
  await harness?.close(); ledger?.close(); localLedger?.close(); await peer.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); if (!values.keep) await rm(root, { recursive: true, force: true });
}
