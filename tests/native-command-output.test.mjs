import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { OWNED_COMMAND_OUTPUT_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/owned-command';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { createStudioNativeCommandOutput } from '../src/host/services/native-command-output.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';

const scope = { tenantId: 'local', workspaceId: 'w', userId: 'local-user', agentId: 'a' };
const taskId = 'a'.repeat(64), request = () => ({ agentId: 'a', sessionId: 's', taskId });
function fixture(project = source => ({ kind: 'command_preview', stdout: source.stdout.replaceAll('PRIVATE', '[hidden]'), stderr: '' })) {
  const lifetime = new AbortController(), agent = { session: { id: 's' } };
  let reads = 0, inspections = 0, headRun = 'r';
  const binding = { runtime: 'harness', local: true, agentId: 'a', agentRevision: 1, nativeEngineContract: NATIVE_DSH_TURN_CONTRACT,
    nativeTools: { commandOutputObserver: () => ({ contract: OWNED_COMMAND_OUTPUT_CONTRACT, read: async input => {
      reads++; assert.equal(input.sessionId, 's'); assert.equal(input.runId, 'r');
      return { status: 'running', stdout: 'PRIVATE', stderr: '', stdoutCursor: 7, stderrCursor: 0, exitCode: null,
        observedExitCode: null, evidenceIncomplete: false, outputMayBeTruncated: false };
    } }) } };
  const configuration = { hostRecoveryBinding: nativeRecoveryBinding({ binding, input: { messages: [{ id: 'i', role: 'user', content: [] }] },
    source: { model: 'm', provider: 'p' }, selection: {}, systemPrompt: '' }) };
  const record = { configuration, snapshot: { scope, runId: 'r', sessionId: 's',
    configDigest: createHash('sha256').update(canonical(configuration)).digest('hex'), backgroundCommands: [{ ref: { taskId } }] } };
  const read = createStudioNativeCommandOutput({ ctx: {}, store: { sessionHead: () => ({ ...record.snapshot, runId: headRun }) },
    recovery: { inspect: async () => { inspections++; return { agent, scope, record }; } },
    agentEvents: () => ({ serial: async () => binding }), lifetime, project });
  return { read, record, binding, lifetime, changeHead: () => { headRun = 'new'; }, counts: () => ({ reads, inspections }) };
}
test('only projected operator output is published, without using display length as the backend cursor', async () => {
  const f = fixture(), before = structuredClone(f.record), result = await f.read(request());
  assert.equal(result.stdout, '[hidden]'); assert.equal(result.stdoutCursor, 7); assert.equal(result.exitCode, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.deepEqual(f.record, before);
  assert.deepEqual(f.counts(), { reads: 1, inspections: 1 });
});
test('a withholding policy cannot discard unread bytes', async () => {
  const f = fixture(() => null), result = await f.read(request());
  assert.equal(result.withheld, true); assert.equal(result.stdout, ''); assert.equal(result.stdoutCursor, 0);
});
test('display policies cannot overwrite canonical command status or exit information', async () => {
  const f = fixture((source, execution) => {
    source.status = 'completed'; source.exitCode = 0; execution.runId = 'foreign';
    return { kind: 'command_preview', stdout: '[hidden]', stderr: '' };
  });
  const result = await f.read(request()); assert.equal(result.status, 'running'); assert.equal(result.exitCode, null); assert.equal(result.runId, 'r');
});
for (const kind of ['abort', 'head', 'request']) test(`late output policies cannot publish after ${kind}`, async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; })), input = request();
  const pending = f.read(input);
  while (!resolve) await new Promise(done => setImmediate(done));
  if (kind === 'abort') { f.lifetime.abort(); await assert.rejects(pending); }
  if (kind === 'head') f.changeHead();
  if (kind === 'request') input.sessionId = 'foreign';
  resolve({ kind: 'command_preview', stdout: 'late', stderr: '' }); await assert.rejects(pending);
});
test('changed Native presets cannot read the backend', async () => {
  const f = fixture(); f.binding.agentRevision = 2;
  await assert.rejects(f.read(request()), { code: 'studio_native_recovery_preset_changed' }); assert.equal(f.counts().reads, 0);
});
test('the authenticated route validates shape before resolving the Host and forwards cancellation', async () => {
  let calls = 0;
  const controller = new AbortController();
  const routes = createSessionRoutes({ getNativeHost: async () => ({ commandOutput: async (payload, signal) => {
    calls++; assert.deepEqual(payload, request()); assert.equal(signal, controller.signal); return { status: 'running' };
  } }) });
  const result = await routes('sessions/native-command-output', request(), controller.signal);
  assert.deepEqual(result, { ok: true, value: { status: 'running' } });
  for (const change of [{ taskId: 'foreign' }, { maxBytes: 65537 }, { stdoutCursor: -1 }, { command: 'unexpected' }])
    await assert.rejects(routes('sessions/native-command-output', { ...request(), ...change }, controller.signal));
  controller.abort(); await assert.rejects(routes('sessions/native-command-output', request(), controller.signal)); assert.equal(calls, 1);
});
