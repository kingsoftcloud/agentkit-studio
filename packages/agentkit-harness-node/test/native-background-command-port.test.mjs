import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, commandProbe, transition, admitBackgroundNotification } from '../../agentkit-harness-core/dist/index.mjs';
import { createBackgroundCommandPort } from '../src/native/background-command-port.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launcher = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' });
const final = () => ({ kind: 'final_candidate', text: 'Complete', toolCalls: [], usage: emptyUsage() });

test('idle completion admission uses the original receipt-selected backend without executing another command', async t => {
  const host = await setup(t, { reader: async () => ({ status: 'running' }) });
  const source = await new NativeKernel({ store: host.store, digest, owner: 'finish-source', now: () => 100, ports: {
    model: { generate: async () => final() }, background: host.port,
  } }).runUntilIdle(scope, 'run');
  assert.equal(source.phase, 'completed');
  let captured, reads = 0;
  const port = createBackgroundCommandPort({ scope, store: host.store, readers: { local_process: async request => {
    reads++; assert.equal(request.runId, 'run'); assert.equal(request.waitSeconds, 0);
    return { status: 'completed', stdout: 'actual owned handle completion', exitCode: 0 };
  }, e2b: async () => assert.fail('wrong backend') } });
  const admitted = await admitBackgroundNotification({ store: host.store, scope, sourceRunId: 'run', taskId: source.backgroundCommands[0].ref.taskId,
    digest, signal: new AbortController().signal, observe: request => { captured = request; return port.observeCompletion(request); } });
  assert.equal(admitted.created, true);
  assert.equal(reads, 1);
  assert.match(admitted.snapshot.messages.at(-1).content, /actual owned handle completion/);
  assert.equal(host.store.load(scope, 'run').snapshot.phase, 'completed');
  await assert.rejects(port.observeCompletion(captured), { code: 'background_notification_read_unbound' });
  assert.equal(reads, 1, 'already admitted head cannot authorize another external read');
});
async function setup(t, { backend = 'sandbox/local_process', reader, status = 'ok', sourceTools = [launcher], store = new MemoryRunStore() } = {}) {
  let launches = 0, calls = 0, paused = false;
  const { config, snapshot } = fixture({ tools: sourceTools, backgroundNotificationPolicy: 'completed-before-model/v1' });
  const kernel = new NativeKernel({ store, digest, owner: 'launch-owner', now: () => 1, onCheckpoint: async state => {
    if (state.backgroundCommands.length && !paused) { paused = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} }); }
  }, ports: { model: { generate: async () => {
    calls++; return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] };
  } }, tools: { execute: async request => {
    launches++; return { status, content: { backend, task_id: 'a'.repeat(64) },
      backgroundCommandRef: { taskId: 'a'.repeat(64), sourceRunId: 'run', operationKey: request.operationKey } };
  } } } });
  kernel.start(snapshot, config); const waiting = await kernel.runUntilIdle(scope, 'run');
  assert.equal(waiting.phase, 'paused'); assert.equal(launches, 1); assert.equal(calls, 1);
  // Return to the safe context boundary without running another effect.
  const lease = store.acquire(scope, 'run', 'test-host', 100, 30), before = store.load(scope, 'run').snapshot;
  const batch = transition(before, { phase: 'preparing_context', resumePhase: null });
  store.commit(scope, 'run', lease, 100, before.revision, batch); store.release(scope, 'run', lease);
  const request = { ...commandProbe(batch.snapshot, config), signal: new AbortController().signal };
  const reads = [];
  const readers = { local_process: async request => { reads.push(['local_process', request]); return reader ? reader(request) : { status: 'completed', exitCode: 0, stdout: 'hello', stdoutCursor: 5 }; },
    e2b: async request => { reads.push(['e2b', request]); return reader ? reader(request) : { status: 'completed', exitCode: 0 }; } };
  const port = createBackgroundCommandPort({ scope, store, readers });
  return { store, config, request, reads, readers, port };
}
test('the scoped port resolves the actual committed launcher receipt before a bounded read', async t => {
  const host = await setup(t), result = await host.port.observe(host.request);
  assert.equal(result.length, 1); assert.deepEqual(result[0].ref, host.request.refs[0]); assert.equal(result[0].stdout, 'hello');
  const [backend, read] = host.reads[0]; assert.equal(backend, 'local_process'); assert.equal(read.sessionId, 'session');
  assert.equal(read.maxBytes, 8192); assert.equal(read.waitSeconds, 0); assert.equal(read.stdoutCursor, 0); assert.equal(read.stderrCursor, 0);
  assert.equal(Object.hasOwn(read, 'command'), false); assert.equal(Object.hasOwn(read, 'approval'), false);
});
test('the receipt selects e2b even when both backends are bound', async t => {
  const host = await setup(t, { backend: 'sandbox/e2b' }); await host.port.observe(host.request);
  assert.equal(host.reads[0][0], 'e2b');
});
for (const backend of [null, 'local_process', 'sandbox/unknown']) test(`unsealed or unsupported backend ${backend} never falls back to a reader`, async t => {
  const host = await setup(t, { backend }); const results = await host.port.observe(host.request);
  assert.equal(results[0].status, 'unavailable'); assert.equal(host.reads.length, 0);
});
test('a sealed but currently unbound backend is unavailable', async t => {
  const host = await setup(t), port = createBackgroundCommandPort({ scope, store: host.store });
  assert.equal((await port.observe(host.request))[0].status, 'unavailable'); assert.equal(host.reads.length, 0);
});
for (const status of ['starting', 'running']) test(`${status} emits no terminal notification`, async t => {
  const host = await setup(t, { reader: async () => ({ status }) });
  assert.deepEqual(await host.port.observe(host.request), []);
});
test('incomplete evidence and observed exit code survive an unknown backend outcome', async t => {
  const host = await setup(t, { reader: async () => ({ status: 'unknown', evidenceIncomplete: true, observedExitCode: 137,
    stdout: 'partial', stdoutCursor: 9000, stderrCursor: 0 }) });
  const result = (await host.port.observe(host.request))[0]; assert.equal(result.status, 'unknown');
  assert.equal(result.evidenceIncomplete, true); assert.equal(result.observedExitCode, 137); assert.equal(result.outputMayBeTruncated, true);
});
test('the 8192-byte read cursor retains the truncation warning even if a backend reports false', async t => {
  const host = await setup(t, { reader: async () => ({ status: 'completed', stdoutCursor: 8192, outputMayBeTruncated: false }) });
  assert.equal((await host.port.observe(host.request))[0].outputMayBeTruncated, true);
});
for (const kind of ['scope', 'session', 'source', 'operation', 'duplicate', 'cursor']) test(`forged ${kind} is rejected before external reads`, async t => {
  const host = await setup(t), request = { ...host.request, refs: structuredClone(host.request.refs) };
  if (kind === 'scope') request.scope = { ...scope, tenantId: 'foreign' };
  if (kind === 'session') request.sessionId = 'foreign';
  if (kind === 'source') request.refs[0].sourceRunId = 'foreign';
  if (kind === 'operation') request.refs[0].operationKey = 'foreign';
  if (kind === 'duplicate') request.refs.push(request.refs[0]);
  if (kind === 'cursor') request.cursor = 'foreign';
  await assert.rejects(host.port.observe(request)); assert.equal(host.reads.length, 0);
});
test('a committed error receipt cannot become a read capability', async t => {
  const host = await setup(t, { status: 'error' });
  await assert.rejects(host.port.observe(host.request), { code: 'background_command_launcher_receipt_mismatch' }); assert.equal(host.reads.length, 0);
});
for (const corruption of ['uncommitted', 'different-session', 'different-ref', 'not-a-launcher', 'wrong-intent', 'multiple-results'])
  test(`source receipt ${corruption} cannot authorize a backend read`, async t => {
    const host = await setup(t); let loads = 0;
    const store = { load(...args) {
      const record = host.store.load(...args);
      if (++loads !== 2) return record;
      const receipt = record.receipts.find(item => item.operationKey === host.request.refs[0].operationKey);
      const intent = record.intents.find(item => item.operationKey === receipt.operationKey);
      if (corruption === 'uncommitted') receipt.status = 'uncertain';
      if (corruption === 'different-session') record.snapshot.sessionId = 'foreign';
      if (corruption === 'different-ref') receipt.result.results[0].backgroundCommandRef.taskId = 'b'.repeat(64);
      if (corruption === 'not-a-launcher') delete record.configuration.tools[0].backgroundCommandPolicy;
      if (corruption === 'wrong-intent') intent.kind = 'model';
      if (corruption === 'multiple-results') receipt.result.results.push(structuredClone(receipt.result.results[0]));
      return record;
    } };
    const port = createBackgroundCommandPort({ scope, store, readers: host.readers });
    await assert.rejects(port.observe(host.request), { code: 'background_command_launcher_receipt_mismatch' }); assert.equal(host.reads.length, 0);
  });
test('reader exceptions and malformed terminal output become unavailable; cancellation stays cancellation', async t => {
  for (const reader of [async () => { throw Error('private backend diagnostic'); }, async () => ({ status: ['completed'] }),
    async () => ({ status: 'completed', stdout: 'x'.repeat(8193) })]) {
    const host = await setup(t, { reader }); assert.equal((await host.port.observe(host.request))[0].status, 'unavailable');
  }
  const host = await setup(t), controller = new AbortController(); controller.abort(Error('cancel'));
  await assert.rejects(host.port.observe({ ...host.request, signal: controller.signal }), /cancel/); assert.equal(host.reads.length, 0);
});
test('the real observer joins the Native loop, records one notice and dispatches no launcher', async t => {
  const host = await setup(t); let models = 0;
  const kernel = new NativeKernel({ store: host.store, digest, owner: 'observer-owner', now: () => 100, ports: {
    background: host.port, tools: { execute: async () => assert.fail('observation cannot launch') },
    model: { generate: async request => { models++; assert.ok(request.messages.some(message => message.kind === 'background_command_observation')); return final(); } },
  } });
  const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(result.phase, 'completed'); assert.equal(models, 1);
  assert.equal(host.reads.length, 1); assert.equal(result.backgroundCommands[0].notified, true);
});
test('SQLite reopen and a continuation retain source receipt ownership while observing in the current run', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-command-port-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const host = await setup(t, { store, reader: async () => ({ status: 'running' }) });
  const first = new NativeKernel({ store, digest, owner: 'old-run', now: () => 100, ports: {
    background: host.port, model: { generate: async () => final() }, tools: { execute: async () => assert.fail() },
  } });
  const previous = await first.runUntilIdle(scope, 'run'); assert.equal(previous.phase, 'completed'); assert.equal(previous.backgroundCommands[0].notified, false);
  store.close(); store = new SqliteRunStore(filename); const reads = [];
  const port = createBackgroundCommandPort({ store, scope, readers: { local_process: async request => {
    reads.push(request); return { status: 'completed', exitCode: 0, stdout: 'after restart' };
  } } });
  const second = new NativeKernel({ store, digest, owner: 'new-run', now: () => 200, ports: {
    background: port, model: { generate: async request => {
      assert.equal(request.messages.filter(message => message.kind === 'background_command_observation').length, 1); return final();
    } }, tools: { execute: async () => assert.fail() },
  } });
  second.start({ ...previous, runId: 'continuation', turnId: 'next', parentRunId: 'run' }, host.config);
  const result = await second.runUntilIdle(scope, 'continuation'); assert.equal(result.phase, 'completed'); assert.equal(reads.length, 1);
  assert.equal(reads[0].runId, 'continuation'); assert.equal(reads[0].ref.sourceRunId, 'run'); assert.equal(reads[0].sessionId, 'session');
  assert.equal(store.load(scope, 'run').snapshot.backgroundCommands[0].notified, false); assert.equal(result.backgroundCommands[0].notified, true);
});
