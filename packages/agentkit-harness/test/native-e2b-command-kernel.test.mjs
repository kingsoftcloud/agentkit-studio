// Real NativeKernel + SqliteRunStore + createNativeToolAuthority integration test.
// NOT fake always-true authority — uses the actual ledger-backed authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { factory as subprocessTransport } from './e2b-fake-transport.mjs';
import { NativeKernel, configure, emptyUsage, canonical, artifactToolDefinitions } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { fixture, scope, digest } from '../../../tests/fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeToolAuthority } from '../../../src/providers/native-tool-authority.mjs';
import { createNativeE2BCommandTools, e2bCommandToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/e2b-command-tools';
import { E2BCommandStore } from '@kingsoftcloud/agentkit-harness-node/native/e2b-background';
import { createOwnedCommandResolver } from '@kingsoftcloud/agentkit-harness-node/native/owned-command';
import { TERMINAL } from '@kingsoftcloud/agentkit-harness-node/native/e2b-command-state';

const tmp = realpathSync(tmpdir());
const delay = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, { timeoutMs = 10000 } = {}) => {
  const until = performance.now() + timeoutMs;
  for (;;) { const r = fn(); if (r) return r; if (performance.now() > until) throw new Error('poll timeout'); await delay(50); }
};

function fakeTransport(sandboxId = 'sb-kernel') {
  return subprocessTransport({ sandboxId });
}

function setupKernel(t, { maxModelCalls = 2 } = {}) {
  const root = mkdtempSync(join(tmp, 'e2b-kernel-'));
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const e2bDefs = e2bCommandToolDefinitions();
  let toolCallCount = 0;
  let toolExecutor = null;
  const ports = {
    model: { generate: async request => {
      if (request.messages[0]?.kind === 'compaction_instructions') return { kind: 'final_candidate', text: 'Compacted.', toolCalls: [], usage: emptyUsage() };
      const modelCalls = request.messages.filter(m => m.role === 'assistant').length;
      if (modelCalls === 0) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'call-1', name: 'run_command',
        arguments: { command: 'echo kernel-test', background: true, background_timeout: 10 } }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async req => { toolCallCount++; return toolExecutor ? toolExecutor(req) : { status: 'ok', content: { ok: true } }; } },
  };
  const worker = () => new NativeKernel({ store, ports, digest, owner: 'test-worker' });
  const config = configure({ ...fixture().config, instructions: 'Run a command.',
    contract: { ...fixture().config.contract, objective: 'Run a command.' },
    tools: e2bDefs, inputMessages: [{ role: 'user', kind: 'user_input', content: 'Run echo kernel-test' }],
    limits: { ...fixture().config.limits, maxModelCalls, maxToolCalls: 5, leaseMs: 60000, effectTimeoutMs: 660000, finalizationReserveModelCalls: 0 },
    profile: { ...fixture().config.profile, requestTimeoutMs: 30000 } });
  return { root, store, worker, config, toolCallCount: () => toolCallCount, setToolExecutor: fn => { toolExecutor = fn; } };
}

test('real Kernel+SQLite+ToolAuthority: full lifecycle with real ledger authority', async t => {
  const wsRoot = mkdtempSync(join(tmp, 'e2b-ws-'));
  const cmdRoot = mkdtempSync(join(tmp, 'e2b-cmd-'));
  t.after(() => { rmSync(wsRoot, { recursive: true, force: true }); rmSync(cmdRoot, { recursive: true, force: true }); });
  let e2bStore;
  const owner = {
    ensure: async () => { e2bStore = new E2BCommandStore({ stateRoot: cmdRoot, workspaceRoot: wsRoot,
      sessionId: 'session', transport: fakeTransport('sb-kernel'), sandboxId: 'sb-kernel', authority: () => true });
      return { sandboxId: 'sb-kernel', created: true }; },
    inspect: () => ({ phase: 'ready', sandboxId: 'sb-kernel' }),
    close: async () => ({ confirmed: true, sandboxId: 'sb-kernel' }),
  };
  const { store, worker, config, toolCallCount, setToolExecutor } = setupKernel(t, { maxModelCalls: 2 });
  const toolPort = createNativeE2BCommandTools({
    scope, sessionId: 'session', owner, storeFactory: () => e2bStore,
    authorize: async () => 'allow',
    assertAuthority: createNativeToolAuthority({ scope, sessionId: 'session', store }),
    resolveOwnedCommand: (req, taskId) => createOwnedCommandResolver({ scope, store })(req, taskId),
  });
  setToolExecutor(req => toolPort.execute(req));

  worker().start({ ...fixture().snapshot, runId: 'run-1', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-1');

  const record = store.load(scope, 'run-1');
  assert.equal(record.snapshot.phase, 'completed', 'run completed: ' + record.snapshot.phase);
  assert.equal(toolCallCount(), 1, 'ToolPort.execute was called exactly once');
  const bgCommands = record.snapshot.backgroundCommands;
  assert.ok(bgCommands.length > 0, 'background command recorded in ledger');
  const ref = bgCommands[0].ref;
  assert.equal(ref.sourceRunId, 'run-1');
  assert.ok(ref.taskId && ref.operationKey);
  assert.ok(e2bStore, 'E2B store was created');
  await poll(() => TERMINAL.has(e2bStore.connect(ref.taskId).readOutput().status), { timeoutMs: 10000 });
  const out = e2bStore.connect(ref.taskId).readOutput();
  assert.equal(out.status, 'completed');
  assert.ok(out.stdout.includes('kernel-test'));
});

test('real Kernel authority: wrong scope rejected by createNativeToolAuthority', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor } = setupKernel(t, { maxModelCalls: 2 });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  setToolExecutor(request => {
    assert.equal(authority({ ...request, scope: { ...scope, workspaceId: 'foreign' } }), false, 'wrong scope rejected');
    assert.equal(authority({ ...request, resultGovernance: 'runtime-artifacts/v1' }), false, 'unsealed governance rejected');
    assert.equal(authority(request), true, 'correct scope accepted');
    return { status: 'ok', content: { ok: true } };
  });
  worker().start({ ...fixture().snapshot, runId: 'run-scope', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-scope');
  assert.equal(toolCallCount(), 1, 'tool was actually executed');
  assert.equal(store.load(scope, 'run-scope').snapshot.phase, 'completed');
});

test('sealed Kernel governance archives full E2B foreground output without weakening live authority', async t => {
  const root = mkdtempSync(join(tmp, 'e2b-governance-')), workspaceRoot = join(root, 'workspace');
  const { mkdirSync } = await import('node:fs'); mkdirSync(workspaceRoot);
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let commands, models = 0, executions = 0;
  const artifacts = await createNativeArtifactStore({ directory: join(root, 'artifacts'), scope });
  const owner = { ensure: async () => {
    commands ??= new E2BCommandStore({ stateRoot: join(root, 'commands'), workspaceRoot, sessionId: 'session',
      transport: fakeTransport('sb-governance'), sandboxId: 'sb-governance', authority: () => true });
    return { sandboxId: 'sb-governance', created: true };
  }, inspect: () => ({ phase: 'ready', sandboxId: 'sb-governance' }) };
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const tools = createNativeE2BCommandTools({ scope, sessionId: 'session', owner, storeFactory: () => commands,
    authorize: async () => 'allow', assertAuthority: authority,
    resolveOwnedCommand: (request, taskId) => createOwnedCommandResolver({ scope, store })(request, taskId),
    artifacts: { write: () => assert.fail('Legacy output archive must not replace the full retained result') } });
  const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1',
    tools: [...e2bCommandToolDefinitions(), ...artifactToolDefinitions()],
    limits: { effectTimeoutMs: 1000000, maxToolResultBytes: 4096 } });
  const kernel = new NativeKernel({ store, digest, owner: 'governed-e2b', ports: { artifacts,
    tools: { execute: request => {
      executions++; assert.equal(authority(request), true);
      assert.equal(authority({ ...request, resultGovernance: undefined }), false);
      return tools.execute(request);
    } }, model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'command', name: 'run_command', arguments: {
        command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(40000)+'E2B_FULL_TAIL😀')"`, timeout: 10 } }] }
      : { kind: 'final_candidate', text: 'Command retained.', toolCalls: [], usage: emptyUsage() } } } });
  kernel.start(snapshot, config); const end = await kernel.runUntilIdle(scope, snapshot.runId);
  const result = store.load(scope, snapshot.runId).receipts.flatMap(row => row.result.results ?? [])[0];
  assert.equal(end.phase, 'completed'); assert.equal(result.status, 'ok'); assert.equal(executions, 1);
  assert.match(result.content.stdout, /E2B_FULL_TAIL😀$/); assert.equal(result.content.output_budget, undefined);
  assert.ok(Buffer.byteLength(result.context.content) <= 4096); assert.equal(end.artifactRefs.length, 1);
  const tail = await artifacts.read({ ...snapshot, operationKey: 'tail-check', signal: new AbortController().signal,
    ref: end.artifactRefs[0], offset: 39000, limit: 8000 });
  assert.match(tail.content, /E2B_FULL_TAIL😀/);
});

test('real Kernel authority: wrong sessionId rejected', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor } = setupKernel(t, { maxModelCalls: 2 });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  setToolExecutor(request => {
    assert.equal(authority({ ...request, sessionId: 'wrong' }), false, 'wrong session rejected');
    return { status: 'ok', content: { ok: true } };
  });
  worker().start({ ...fixture().snapshot, runId: 'run-sess', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-sess');
  assert.equal(toolCallCount(), 1, 'tool was actually executed');
});

test('real Kernel authority: wrong executionFence rejected', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor } = setupKernel(t, { maxModelCalls: 2 });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  setToolExecutor(request => {
    assert.equal(authority({ ...request, executionFence: 999 }), false, 'wrong fence rejected');
    assert.equal(authority(request), true, 'correct fence accepted');
    return { status: 'ok', content: { ok: true } };
  });
  worker().start({ ...fixture().snapshot, runId: 'run-fence', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-fence');
  assert.equal(toolCallCount(), 1, 'tool was actually executed');
});

test('real Kernel authority: aborted signal rejected', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor } = setupKernel(t, { maxModelCalls: 2 });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  setToolExecutor(request => {
    const ac = new AbortController(); ac.abort();
    assert.equal(authority({ ...request, signal: ac.signal }), false, 'aborted signal rejected');
    return { status: 'ok', content: { ok: true } };
  });
  worker().start({ ...fixture().snapshot, runId: 'run-abort', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-abort');
  assert.equal(toolCallCount(), 1, 'tool was actually executed');
});

test('budget: 1800-byte command with full identity fits the admitted 2048-byte budget', async t => {
  const longCommand = 'echo ' + 'x'.repeat(1800);
  const longStdout = 'y'.repeat(2000);
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 's1', maxOutputBytes: 2048,
    owner: { ensure: async () => ({sandboxId:'sb',created:true}), inspect: () => null },
    storeFactory: () => ({ start: async () => ({ commandId: 'a'.repeat(64), readOutput: () => ({ status: 'completed', stdout: longStdout, stderr: '', exitCode: 0, stdoutCursor: 2000, stderrCursor: 0, cancelRequested: false, outputMayBeTruncated: false, evidenceIncomplete: false, observedExitCode: null, outcomeReason: '' }) }) }),
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
    artifacts: { write: async () => ({ uri: 'artifact://test', sizeBytes: 5000 }) },
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: longCommand, timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op1', runId: 'r1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'ch1',
    executionFence: 1, scope, sessionId: 's1', signal: ac.signal };
  const r = await tools.execute(req);
  assert.equal(r.status, 'ok');
  assert.equal(r.content.operationKey, 'op1');
  assert.ok(r.artifactRefs?.length, 'full output retained');
  const finalBytes = Buffer.byteLength(canonical(r.content));
  assert.ok(finalBytes <= 2048, `final canonical size ${finalBytes} within budget 2048`);
});

test('budget: 512-byte budget with long artifact_uri still bounded or honest error', async t => {
  const longUri = 'artifact://' + 'z'.repeat(500);
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 's1', maxOutputBytes: 512,
    owner: { ensure: async () => ({sandboxId:'sb',created:true}), inspect: () => null },
    storeFactory: () => ({ start: async () => ({ commandId: 'a'.repeat(64), readOutput: () => ({ status: 'completed', stdout: 'x'.repeat(300), stderr: '', exitCode: 0, stdoutCursor: 300, stderrCursor: 0, cancelRequested: false, outputMayBeTruncated: false, evidenceIncomplete: false, observedExitCode: null, outcomeReason: '' }) }) }),
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
    artifacts: { write: async () => ({ uri: longUri, sizeBytes: 5000 }) },
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: 'echo test', timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op1', runId: 'r1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'ch1',
    executionFence: 1, scope, sessionId: 's1', signal: ac.signal };
  const r = await tools.execute(req);
  const finalBytes = Buffer.byteLength(canonical(r.content));
  // STRICT: ALL returned content must be within budget, regardless of status.
  assert.ok(finalBytes <= 512, `final canonical(${finalBytes}) MUST be within 512 bytes for ALL results: status=${r.status}`);
  if (r.status !== 'ok') assert.ok(r.content.evidence_incomplete === true || r.content.error_type, `non-ok must have evidence_incomplete or error_type`);
});

test('budget: 512 with long operationKey (800 chars) → rejected BEFORE ensure/start with executed:false, 0 effects', async t => {
  let ensures = 0, starts = 0;
  const longOpKey = 'original-' + 'x'.repeat(800);
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 'session-original', maxOutputBytes: 512,
    owner: { ensure: async () => { ensures++; return { sandboxId: 'sandbox-original', created: true }; }, inspect: () => null },
    storeFactory: () => ({ start: async () => { starts++; return { commandId: 'a'.repeat(64), readOutput: () => ({ status: 'starting' }) }; } }),
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: 'echo hello', background: true, background_timeout: 10 }, callId: 'call-original' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: longOpKey, runId: 'run-original', turnId: '1', buildId: 'build-original',
    parentRunId: null, taskChainId: 'chain', executionFence: 1, scope, sessionId: 'session-original', signal: ac.signal };
  const r = await tools.execute(req);
  assert.equal(r.status, 'error', 'rejected before any side-effect');
  assert.equal(r.content.executed, false, 'executed:false');
  assert.equal(r.content.error_type, 'e2b_command_budget_below_minimum_identity');
  assert.equal(ensures, 0, 'owner.ensure was NOT called');
  assert.equal(starts, 0, 'store.start was NOT called');
  assert.ok(Buffer.byteLength(canonical(r.content)) <= 512, 'pre-effect refusal is bounded too');
  assert.equal(req.operationKey, longOpKey, 'full original intent identity is unchanged');
});

test('budget: 2048 with short operationKey, unknown start → uncertain keeps full operationKey, not executed:false', async t => {
  let ensures = 0, starts = 0;
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 'session-original', maxOutputBytes: 2048,
    owner: { ensure: async () => { ensures++; return { sandboxId: 'sb', created: true }; }, inspect: () => null },
    storeFactory: () => ({ start: async () => { starts++; throw Object.assign(new Error('lost'), { code: 'probe_remote_unknown' }); } }),
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: 'echo hi', background: true, background_timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op-short', runId: 'run-orig', turnId: '1', buildId: 'b-orig',
    parentRunId: null, taskChainId: 'chain', executionFence: 1, scope, sessionId: 'session-original', signal: ac.signal };
  const r = await tools.execute(req);
  assert.equal(r.status, 'uncertain', 'dispatched then threw → uncertain');
  assert.notEqual(r.status, 'error', 'must NOT be executed:false error after dispatch');
  assert.equal(ensures, 1, 'owner.ensure was called');
  assert.equal(starts, 1, 'store.start was called');
  assert.equal(r.content.runId, 'run-orig', 'keeps original runId');
  assert.equal(r.content.operationKey, 'op-short', 'keeps full operationKey');
  assert.equal(r.content.evidence_incomplete, true);
  assert.equal(r.content.sandbox_id, 'sb', 'keeps sandbox_id');
  assert.ok(Buffer.byteLength(canonical(r.content)) <= 2048);
});

test('budget: 2048 with short operationKey, successful background launch → ok status preserved, backgroundCommandRef preserved', async t => {
  let ensures = 0, starts = 0;
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 'session-original', maxOutputBytes: 2048,
    owner: { ensure: async () => { ensures++; return { sandboxId: 'sb', created: true }; }, inspect: () => null },
    storeFactory: () => ({ start: async () => { starts++; return { commandId: 'a'.repeat(64), readOutput: () => ({ status: 'starting', stdout: '', stderr: '', exitCode: null, stdoutCursor: 0, stderrCursor: 0, cancelRequested: false, outputMayBeTruncated: false, evidenceIncomplete: false, observedExitCode: null, outcomeReason: '' }) }; } }),
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: 'echo hi', background: true, background_timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op-short', runId: 'run-orig', turnId: '1', buildId: 'b-orig',
    parentRunId: null, taskChainId: 'chain', executionFence: 1, scope, sessionId: 'session-original', signal: ac.signal };
  const r = await tools.execute(req);
  assert.equal(r.status, 'ok', 'successful background launch stays ok');
  assert.ok(r.backgroundCommandRef, 'backgroundCommandRef preserved');
  assert.ok(Buffer.byteLength(canonical(r.content)) <= 2048);
  assert.equal(r.backgroundCommandRef.sourceRunId, 'run-orig');
  assert.equal(r.backgroundCommandRef.taskId, 'a'.repeat(64));
  assert.equal(ensures, 1, 'owner.ensure was called');
  assert.equal(starts, 1, 'store.start was called');
});

// Origin preservation: the catch block must use the ORIGINAL snapshot, not
// snapshot(request) after mutation. Three deterministic probes.
test('origin preservation: store.start mutates runId then throws → uncertain keeps original runId', async t => {
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 's1',
    owner: { ensure: async () => ({ sandboxId: 'sb-original', created: true }), inspect: () => null },
    storeFactory: () => ({
      start: async () => { throw Object.assign(new Error('remote unknown'), { code: 'probe_remote_unknown' }); },
    }),
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: 'echo test', timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op1', runId: 'original-run', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'ch1',
    executionFence: 1, scope, sessionId: 's1', signal: ac.signal };
  // store.start mutates the request's runId then throws.
  const originalRunId = req.runId;
  const fakeStore = {
    start: async function() { req2.runId = 'foreign-run'; throw Object.assign(new Error('remote unknown'), { code: 'probe_remote_unknown' }); },
  };
  // Override storeFactory to return the mutating store.
  const tools2 = createNativeE2BCommandTools({
    scope, sessionId: 's1',
    owner: { ensure: async () => ({ sandboxId: 'sb-original', created: true }), inspect: () => null },
    storeFactory: () => fakeStore,
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const req2 = { call: { name: 'run_command', arguments: { command: 'echo test', timeout: 10 }, callId: 'c2' },
    definition: tools2.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op2', runId: 'original-run', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'ch1',
    executionFence: 1, scope, sessionId: 's1', signal: ac.signal };
  const r = await tools2.execute(req2);
  assert.equal(r.status, 'uncertain', 'dispatched then threw → uncertain');
  assert.equal(r.content.runId, 'original-run', 'locator keeps original runId, not foreign-run');
  assert.equal(r.content.sandbox_id, 'sb-original', 'locator keeps sandbox_id');
  assert.equal(r.content.evidence_incomplete, true);
  assert.notEqual(r.content.runId, 'foreign-run', 'must NOT use mutated runId');
});

test('origin preservation: store.start mutates scope then throws → uncertain keeps original scope', async t => {
  const fakeStore = {
    start: async function() { req.scope = { ...scope, workspaceId: 'foreign-ws' }; throw Object.assign(new Error('unknown'), { code: 'probe_scope' }); },
  };
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 's1',
    owner: { ensure: async () => ({ sandboxId: 'sb', created: true }), inspect: () => null },
    storeFactory: () => fakeStore,
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const ac = new AbortController();
  const req = { call: { name: 'run_command', arguments: { command: 'echo test', timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op1', runId: 'original-run', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'ch1',
    executionFence: 1, scope, sessionId: 's1', signal: ac.signal };
  const r = await tools.execute(req);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.scope.workspaceId, 'workspace', 'locator keeps original scope');
  assert.notEqual(r.content.scope.workspaceId, 'foreign-ws', 'must NOT use mutated scope');
});

test('origin preservation: signal replaced + aborted → uncertain uses original signal status, not executed:false', async t => {
  const originalAC = new AbortController();
  const fakeStore = {
    start: async function() {
      // Replace the signal with a new aborted one, then throw.
      const newAC = new AbortController(); newAC.abort();
      req.signal = newAC.signal;
      throw Object.assign(new Error('unknown'), { code: 'probe_signal' });
    },
  };
  const tools = createNativeE2BCommandTools({
    scope, sessionId: 's1',
    owner: { ensure: async () => ({ sandboxId: 'sb', created: true }), inspect: () => null },
    storeFactory: () => fakeStore,
    authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => ({}),
  });
  const req = { call: { name: 'run_command', arguments: { command: 'echo test', timeout: 10 }, callId: 'c1' },
    definition: tools.definitions.find(d => d.name === 'run_command'),
    operationKey: 'op1', runId: 'original-run', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'ch1',
    executionFence: 1, scope, sessionId: 's1', signal: originalAC.signal };
  const r = await tools.execute(req);
  assert.equal(r.status, 'uncertain', 'dispatched then threw → uncertain (not error/executed:false)');
  assert.equal(r.content.runId, 'original-run', 'keeps original identity');
  assert.equal(r.content.evidence_incomplete, true);
  assert.notEqual(r.status, 'error', 'must not be clean error after dispatch');
  // The original signal was NOT aborted, so the error_type must NOT be 'e2b_command_aborted'.
  // The replaced signal was aborted, but the original must govern classification.
  assert.notEqual(r.content.error_type, 'e2b_command_aborted', 'must NOT classify as aborted — original signal was not aborted, replaced signal must not govern');
});
