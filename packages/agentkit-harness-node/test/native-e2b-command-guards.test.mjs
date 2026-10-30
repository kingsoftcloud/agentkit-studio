import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../../agentkit-harness-core/dist/index.mjs';
import { createNativeE2BCommandTools } from '../src/native/e2b-command-tools.mjs';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', userId: 'user' };
const taskId = 'a'.repeat(64);
const output = () => ({ status: 'running', stdout: '', stderr: '', exitCode: null,
  stdoutCursor: 0, stderrCursor: 0, cancelRequested: false, outputMayBeTruncated: false,
  evidenceIncomplete: false, observedExitCode: null, outcomeReason: '' });
function setup(options = {}) {
  const effects = { ensure: 0, start: 0, cancel: 0, inspect: 0 };
  const handle = { commandId: taskId, readOutput: output, requestCancel() { effects.cancel++; return output(); } };
  const commandStore = { commandId: () => taskId, connect: () => handle,
    start: async () => { effects.start++; return handle; } };
  const tools = createNativeE2BCommandTools({ scope, sessionId: 'session',
    owner: { ensure: async () => { effects.ensure++; return { sandboxId: 'sandbox' }; },
      inspect: () => { effects.inspect++; return { phase: 'ready', sandboxId: 'sandbox' }; } },
    storeFactory: () => commandStore, authorize: async () => 'allow', assertAuthority: () => true,
    resolveOwnedCommand: () => ({ backend: 'e2b', ref: { taskId, sourceRunId: 'run', operationKey: 'launch' } }), ...options });
  const controller = new AbortController();
  const request = { scope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build', parentRunId: null,
    taskChainId: 'chain', operationKey: 'operation', executionFence: 1, signal: controller.signal,
    definition: tools.definitions.find(d => d.name === 'run_command'),
    call: { callId: 'call', name: 'run_command', arguments: { command: 'echo hello', background: true } } };
  return { tools, request, controller, effects, commandStore, handle };
}

test('small budgets reject before any external effect; admitted successful/uncertain results retain full ownership within budget', async () => {
  for (const limit of [256, 512, 4096]) {
    for (const unknown of [false, true]) {
      const h = setup({ maxOutputBytes: limit });
      h.request.operationKey += '长'.repeat(200);
      if (unknown) h.commandStore.start = async () => { h.effects.start++; throw Object.assign(Error('lost'), { code: 'x'.repeat(8000) }); };
      const result = await h.tools.execute(h.request);
      assert.ok(Buffer.byteLength(canonical(result.content)) <= limit);
      if (limit < 4096) {
        assert.equal(result.status, 'error'); assert.equal(result.content.executed, false);
        assert.equal(h.effects.ensure, 0); assert.equal(h.effects.start, 0);
      } else {
        assert.equal(result.status, unknown ? 'uncertain' : 'ok');
        assert.equal(result.content.operationKey, h.request.operationKey);
        assert.equal(result.content.task_id, taskId); assert.equal(result.content.sandbox_id, 'sandbox');
        assert.equal(h.effects.start, 1);
        if (!unknown) assert.deepEqual(result.backgroundCommandRef, { taskId, sourceRunId: 'run', operationKey: h.request.operationKey });
      }
    }
  }
});

test('the only excluded non-JSON identity field is the original top-level signal', async () => {
  const h = setup(); h.request.futureSignal = new AbortController().signal;
  const result = await h.tools.execute(h.request);
  assert.equal(result.status, 'error'); assert.equal(h.effects.ensure, 0); assert.equal(h.effects.start, 0);
});

test('a synchronous authority callback cannot mutate the original request and then authorize an effect', async () => {
  const h = setup({ assertAuthority: request => { request.future = { rebound: true }; return true; } });
  const result = await h.tools.execute(h.request);
  assert.equal(result.status, 'error'); assert.equal(h.effects.ensure, 0); assert.equal(h.effects.start, 0);
});

test('post-launch request drift retains the real original task, sandbox and background receipt', async () => {
  const h = setup();
  h.commandStore.start = async () => { h.effects.start++; h.request.runId = 'foreign'; return h.handle; };
  const result = await h.tools.execute(h.request);
  assert.equal(result.status, 'uncertain'); assert.equal(h.effects.start, 1);
  assert.equal(result.content.runId, 'run'); assert.equal(result.content.task_id, taskId);
  assert.equal(result.content.sandbox_id, 'sandbox');
  assert.deepEqual(result.backgroundCommandRef, { taskId, sourceRunId: 'run', operationKey: 'operation' });
});

test('original cancellation settles an uncooperative sandbox creation without starting a command or leaking late rejection', async () => {
  let entered, reject;
  const ready = new Promise(resolve => { entered = resolve; });
  const h = setup({ owner: { inspect: () => null, ensure: () => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); } } });
  const pending = h.tools.execute(h.request); await ready; h.controller.abort();
  const result = await Promise.race([pending, new Promise((_r, fail) => { const timer = setTimeout(() => fail(Error('cancel stalled')), 500); timer.unref(); })]);
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.error_type, 'e2b_command_aborted');
  assert.equal(h.effects.start, 0); reject(Error('late remote failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('cancellation while command start is pending retains its predetermined durable task locator', async () => {
  const h = setup(); let entered, reject;
  const ready = new Promise(resolve => { entered = resolve; });
  h.commandStore.start = () => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); };
  const pending = h.tools.execute(h.request); await ready; h.controller.abort();
  const result = await pending;
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.task_id, taskId);
  assert.equal(result.content.sandbox_id, 'sandbox'); assert.equal(result.content.operationKey, 'operation');
  reject(Error('late start failure')); await new Promise(resolve => setImmediate(resolve));
});

test('async status callbacks fail closed and rejected promises are observed', async () => {
  const h = setup({ owner: { ensure() { throw Error('must not create'); }, inspect: () => Promise.reject(Error('async status')) } });
  h.request.call = { callId: 'status', name: 'sandbox_status', arguments: {} };
  h.request.definition = h.tools.definitions.find(d => d.name === 'sandbox_status');
  const result = await h.tools.execute(h.request); assert.equal(result.status, 'error');
  await new Promise(resolve => setImmediate(resolve));
});

test('an ownership resolver that changes the original call cannot cancel a remote task', async () => {
  const h = setup({ resolveOwnedCommand: request => { request.call.callId = 'other'; return { backend: 'e2b', ref: { taskId } }; } });
  h.request.call = { callId: 'stop', name: 'stop_command', arguments: { task_id: taskId } };
  h.request.definition = h.tools.definitions.find(d => d.name === 'stop_command');
  const result = await h.tools.execute(h.request);
  assert.equal(result.status, 'error'); assert.equal(h.effects.cancel, 0);
});

test('a completed read cannot return success after its backend changed the original identity', async () => {
  const h = setup();
  h.request.call = { callId: 'read', name: 'read_command_output', arguments: { task_id: taskId } };
  h.request.definition = h.tools.definitions.find(d => d.name === 'read_command_output');
  h.handle.readOutput = () => { h.request.futureContext = 'changed'; return { ...output(), status: 'completed', exitCode: 0 }; };
  const result = await h.tools.execute(h.request);
  assert.equal(result.status, 'error'); assert.equal(h.effects.ensure, 0); assert.equal(h.effects.start, 0);
});
