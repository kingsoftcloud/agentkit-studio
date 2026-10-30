import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { nativeKernelFactId, projectNativeKernelEvent } from '../src/providers/native-kernel-events.mjs';
import { permitIssuer, command, target, binding, response, tool } from './fixtures/native-managed-kernel.mjs';
import { assertManagedRuntimeFacts } from './fixtures/native-managed-runtime-schema.mjs';

const terminalStates = ['completed', 'cancelled', 'failed', 'interrupted', 'waiting'];

function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-native-events-'))), issuer = permitIssuer();
  const config = { directory, target, permitVerifier: issuer.verifier, resolveBinding: ({ command }) => binding(command),
    assertCurrent: () => true, autoStart: false, ...options };
  let runtime = createManagedNativeKernel(config);
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const query = (sessionId, operation) => { const value = { tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
    session_id: sessionId, authorization_ref: randomUUID() }; return [value, issuer.issue(value, operation)]; };
  return { directory, issuer, config, get runtime() { return runtime; },
    receive: (cmd, permit = issuer.issue(cmd)) => runtime.receive(cmd, permit),
    status: id => runtime.getStatus(...query(id, 'get_status')),
    async facts(id) { const controller = new AbortController(), source = await runtime.subscribe(...query(id, 'subscribe_events'), { signal: controller.signal });
      const values = []; try { for await (const fact of source) { values.push(fact); if (fact.event_type === 'control.run_transition'
        && terminalStates.includes(fact.payload.state)) break; } } finally { controller.abort(); }
      assertManagedRuntimeFacts(values); return values;
    },
    async reopen() { await runtime.close(); runtime = createManagedNativeKernel(config); return runtime; },
  };
}

// Envelope helper for unit-level projection: the managed kernel's append step
// adds seq/timestamp/source to runtime payloads. We mimic that here so the
// strict schema validator can run on direct projectNativeKernelEvent output.
let envelopeSeq = 0;
function withEnvelope(facts, runId = 'run-unit') {
  return facts.map(fact => {
    const seq = ++envelopeSeq;
    const timestamp = '2026-01-01T00:00:00.000Z';
    if (fact.family === 'runtime') {
      const payload = { ...fact.payload, event_id: fact.event_id, seq, timestamp: Date.parse(timestamp) / 1000,
        source: { framework: 'ksadk', native_event_id: fact.event_id, native_run_id: runId, metadata: {} } };
      return { ...fact, seq, timestamp, payload };
    }
    return { ...fact, seq, timestamp };
  });
}
function nativeEvent(kind, payload, { eventId = 'evt-unit', runId = 'run-unit', turnId = 'turn-unit', seq = 1 } = {}) {
  return { eventId, runId, turnId, seq, kind, payload };
}
const runtimeFacts = facts => facts.filter(f => f.family === 'runtime');

test('model→tool→result persists tool_call, tool_result and reasoning items, then cold replay is identical', async t => {
  let models = 0, writes = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async (request, emit) => {
      if (++models === 1) {
        emit({ kind: 'thinking', text: 'Considering the request carefully' });
        return response({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write-1', name: 'write', arguments: { path: 'a.txt' } }] });
      }
      assert.equal(request.messages.at(-1).role, 'tool'); return response();
    } }, tools: { execute: async () => { writes++; return { status: 'ok', content: 'Written' }; } },
  }, { tools: [tool()] }) });
  const cmd = command(), first = await f.receive(cmd);
  assert.equal(first.status, 'accepted');
  await f.runtime.drain(cmd.session_id);
  const facts = await f.facts(cmd.session_id);
  assert.equal(models, 2); assert.equal(writes, 1);
  assert.deepEqual(facts.map(f => f.seq), facts.map((_, i) => i + 1));
  assert.equal(new Set(facts.map(f => f.event_id)).size, facts.length);
  const toolCall = facts.find(f => f.event_type === 'item.completed' && f.payload.item_kind === 'tool_call');
  assert.ok(toolCall, 'tool_call item projected');
  const callPart = toolCall.payload.snapshot.parts[0];
  assert.equal(callPart.content_type, 'tool_call');
  assert.equal(callPart.call_id, 'write-1');
  assert.equal(callPart.name, 'write');
  assert.deepEqual(callPart.arguments, { path: 'a.txt' });
  const toolResult = facts.find(f => f.event_type === 'item.completed' && f.payload.item_kind === 'tool_result');
  assert.ok(toolResult, 'tool_result item projected');
  const resultPart = toolResult.payload.snapshot.parts[0];
  assert.equal(resultPart.content_type, 'tool_result');
  assert.equal(resultPart.call_id, 'write-1');
  assert.equal(resultPart.result, 'Written');
  assert.equal(resultPart.is_error, false);
  const reasoning = facts.find(f => f.event_type === 'item.completed' && f.payload.item_kind === 'reasoning');
  assert.ok(reasoning, 'reasoning item projected from displayStream thinking');
  assert.equal(reasoning.payload.snapshot.parts[0].text, 'Considering the request carefully');
  assert.equal(facts.at(-2).event_type, 'run.completed');
  assert.equal(facts.at(-1).payload.state, 'completed');
  assertManagedRuntimeFacts(facts);
  await f.reopen();
  const retry = await f.receive({ ...cmd, authorization_ref: randomUUID(), source: { ...cmd.source, ref: 'retry' } });
  assert.equal(retry.status, 'duplicate');
  await f.runtime.drain(cmd.session_id);
  assert.deepEqual(await f.facts(cmd.session_id), facts);
});

test('tool error and uncertain outcomes project is_error and item.failed respectively', async t => {
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => ++models === 1
      ? response({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'fail-1', name: 'write', arguments: {} }] })
      : response() },
    tools: { execute: async () => ({ status: 'error', content: { code: 'boom' } }) },
  }, { tools: [tool()] }) });
  const cmd = command(); await f.receive(cmd); await f.runtime.drain(cmd.session_id);
  const facts = await f.facts(cmd.session_id);
  const toolResult = facts.find(f => f.event_type === 'item.completed' && f.payload.item_kind === 'tool_result');
  assert.ok(toolResult);
  assert.equal(toolResult.payload.snapshot.parts[0].is_error, true);
  assert.deepEqual(toolResult.payload.snapshot.parts[0].result, { code: 'boom' });
  assert.equal(facts.at(-1).payload.state, 'completed');
});

test('an uncertain tool outcome ends the run as interrupted with run.interrupted and item.failed', async t => {
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => ++models === 1
      ? response({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'unc-1', name: 'write', arguments: {} }] })
      : response() },
    tools: { execute: async () => { throw new Error('secret internal error'); } },
  }, { tools: [tool()] }) });
  const cmd = command(); await f.receive(cmd); await f.runtime.drain(cmd.session_id);
  const facts = await f.facts(cmd.session_id);
  const interrupted = facts.find(f => f.event_type === 'run.interrupted');
  assert.ok(interrupted, 'run.interrupted projected (not run.failed)');
  assert.equal(interrupted.payload.status, 'interrupted');
  assert.equal(interrupted.payload.reason, 'effect_outcome_unknown');
  const toolFailed = facts.find(f => f.event_type === 'item.failed' && f.payload.item_kind === 'tool_result');
  assert.ok(toolFailed, 'uncertain tool projected as item.failed');
  assert.equal(toolFailed.payload.error.code, 'NATIVE_TOOL_OUTCOME_UNKNOWN');
  assert.equal(facts.at(-1).payload.state, 'interrupted');
  assert.doesNotMatch(JSON.stringify(facts), /secret internal error/u);
});

test('pause then resume projects control.run_transition for each and the run still completes', async t => {
  let models = 0;
  const f = fixture(t, { resolveBinding: ({ command }) => binding(command, {
    model: { generate: async () => ++models === 1
      ? response({ kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write', name: 'write', arguments: {} }] })
      : response() },
    tools: { execute: async () => ({ status: 'ok', content: 'ok' }) },
  }, { tools: [tool()] }) });
  const cmd = command(), accepted = await f.receive(cmd);
  const pause = command({ command_type: 'pause', payload: { run_id: accepted.run_id } });
  await f.receive(pause);
  await f.runtime.drain(cmd.session_id);
  assert.equal((await f.status(cmd.session_id)).runs[0].phase, 'paused');
  assert.equal(models, 0);
  const resume = command({ command_type: 'resume', payload: { target: { kind: 'run', id: accepted.run_id } } });
  await f.receive(resume);
  await f.runtime.drain(cmd.session_id);
  const facts = await f.facts(cmd.session_id);
  const transitions = facts.filter(f => f.event_type === 'control.run_transition');
  const paused = transitions.find(f => f.payload.state === 'paused');
  assert.ok(paused, 'pause projects control.run_transition(paused)');
  assert.equal(paused.causation_id, pause.command_id);
  const resumed = transitions.filter(f => f.payload.state === 'running');
  assert.ok(resumed.some(f => f.causation_id === resume.command_id), 'resume projects control.run_transition(running)');
  assert.equal(facts.at(-1).payload.state, 'completed');
  assert.equal(models, 2);
});

test('unit: tool.completed ok/error/uncertain project the right tool_result item', () => {
  const ok = projectNativeKernelEvent(nativeEvent('tool.completed',
    { callId: 'c1', name: 'write', status: 'ok', content: 'done' }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(runtimeFacts(ok).length, 1);
  assert.equal(ok[0].event_type, 'item.completed');
  assert.equal(ok[0].payload.item_kind, 'tool_result');
  assert.equal(ok[0].payload.snapshot.parts[0].is_error, false);
  assert.equal(ok[0].payload.snapshot.parts[0].result, 'done');

  const err = projectNativeKernelEvent(nativeEvent('tool.completed',
    { callId: 'c2', name: 'write', status: 'error', content: { code: 'boom' } }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(err[0].payload.snapshot.parts[0].is_error, true);
  assert.deepEqual(err[0].payload.snapshot.parts[0].result, { code: 'boom' });

  const unc = projectNativeKernelEvent(nativeEvent('tool.completed',
    { callId: 'c3', name: 'write', status: 'uncertain' }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(unc[0].event_type, 'item.failed');
  assert.equal(unc[0].payload.error.code, 'NATIVE_TOOL_OUTCOME_UNKNOWN');
  const nullResult = projectNativeKernelEvent(nativeEvent('tool.completed',
    { callId: 'c4', name: 'write', status: 'ok', content: null }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(nullResult[0].payload.snapshot.parts[0].result, null);
  assertManagedRuntimeFacts(withEnvelope([...ok, ...err, ...unc, ...nullResult]));
});

test('unit: tool.rejected and tool.not_dispatched project item.failed', () => {
  const rejected = projectNativeKernelEvent(nativeEvent('tool.rejected',
    { callId: 'c1', name: 'write', reason: 'tool_not_advertised' }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(rejected[0].event_type, 'item.failed');
  assert.equal(rejected[0].payload.item_kind, 'tool_result');
  assert.equal(rejected[0].payload.error.code, 'NATIVE_TOOL_REJECTED');
  assert.equal(rejected[0].payload.error.message, 'tool_not_advertised');

  const notDispatched = projectNativeKernelEvent(nativeEvent('tool.not_dispatched',
    { callId: 'c2', name: 'read', reason: 'goal_steered' }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(notDispatched[0].payload.error.code, 'NATIVE_TOOL_NOT_DISPATCHED');
  assert.equal(notDispatched[0].payload.error.message, 'goal_steered');
  assertManagedRuntimeFacts(withEnvelope([...rejected, ...notDispatched]));
});

test('unit: model.completed toolCalls project tool_call items after existing facts', () => {
  const event = nativeEvent('model.completed', {
    kind: 'tool_calls', text: 'partial answer', messageIndex: 0, messageCursor: 1, usageReported: true,
    toolCalls: [{ callId: 't1', name: 'write', arguments: { x: 1 } }, { callId: 't2', name: 'read', arguments: {} }],
    usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1, toolCalls: 0, cost: 0 },
  });
  const facts = projectNativeKernelEvent(event, { scopeId: 'run-1', commandId: 'cmd-1' });
  const types = facts.map(f => f.event_type);
  // Existing facts keep indices 0-2; tool_call items are appended after.
  assert.deepEqual(types.slice(0, 3), ['item.updated', 'item.completed', 'usage.reported']);
  assert.equal(types[3], 'item.completed');
  assert.equal(facts[3].payload.item_kind, 'tool_call');
  assert.equal(facts[3].payload.item_id, 'call-t1');
  assert.equal(facts[4].payload.item_kind, 'tool_call');
  assert.equal(facts[4].payload.item_id, 'call-t2');
  // Existing event_ids depend only on (eventId, index) and are unchanged.
  assert.equal(facts[0].event_id, nativeKernelFactId(event.eventId, 0));
  assert.equal(facts[1].event_id, nativeKernelFactId(event.eventId, 1));
  assert.equal(facts[2].event_id, nativeKernelFactId(event.eventId, 2));
  assert.equal(facts[3].event_id, nativeKernelFactId(event.eventId, 3));
  assertManagedRuntimeFacts(withEnvelope(facts));
});

test('unit: model.completed displayStream thinking records project a reasoning item', () => {
  const event = nativeEvent('model.completed', {
    kind: 'final_candidate', text: 'answer', messageIndex: 0, messageCursor: 1, usageReported: true,
    toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, modelCalls: 1, toolCalls: 0, cost: 0 },
    displayStream: { version: 'agentkit.model-display/v1', records: [
      { time: 1, event: { kind: 'text', text: 'a' } },
      { time: 2, event: { kind: 'thinking', text: 'first thought' } },
      { time: 3, event: { kind: 'thinking', text: ' second thought' } },
      { time: 4, event: { kind: 'tool_delta', text: 'x', metadata: { index: 0 } } },
    ], truncated: false, discarded: 0 },
  });
  const facts = projectNativeKernelEvent(event, { scopeId: 'run-1', commandId: 'cmd-1' });
  const reasoning = facts.find(f => f.payload.item_kind === 'reasoning');
  assert.ok(reasoning);
  assert.equal(reasoning.payload.snapshot.parts[0].text, 'first thought second thought');
  assert.equal(reasoning.payload.snapshot.parts[0].part_id, 'thinking');
  assertManagedRuntimeFacts(withEnvelope(facts));
});

test('unit: model.completed without displayStream or thinking records emits no reasoning item', () => {
  const noStream = projectNativeKernelEvent(nativeEvent('model.completed', {
    kind: 'final_candidate', text: 'answer', messageIndex: 0, messageCursor: 1, usageReported: false,
    toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0, cost: 0 },
  }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.ok(!noStream.some(f => f.payload.item_kind === 'reasoning'));

  const emptyThinking = projectNativeKernelEvent(nativeEvent('model.completed', {
    kind: 'final_candidate', text: 'answer', messageIndex: 0, messageCursor: 1, usageReported: false,
    toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, modelCalls: 1, toolCalls: 0, cost: 0 },
    displayStream: { version: 'agentkit.model-display/v1', records: [
      { time: 1, event: { kind: 'text', text: 'a' } }], truncated: false, discarded: 0 },
  }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.ok(!emptyThinking.some(f => f.payload.item_kind === 'reasoning'));
});

test('unit: command.applied pause/resume project control.run_transition, rejections unchanged', () => {
  const pause = projectNativeKernelEvent(nativeEvent('command.applied',
    { commandId: 'pause-cmd', kind: 'pause', reason: 'applied' }), { scopeId: 'run-1', commandId: 'enqueue-cmd' });
  assert.equal(pause[0].event_type, 'control.run_transition');
  assert.equal(pause[0].payload.state, 'paused');
  assert.equal(pause[0].causation_id, 'pause-cmd');

  const resume = projectNativeKernelEvent(nativeEvent('command.applied',
    { commandId: 'resume-cmd', kind: 'resume', reason: 'applied' }), { scopeId: 'run-1', commandId: 'enqueue-cmd' });
  assert.equal(resume[0].payload.state, 'running');
  assert.equal(resume[0].causation_id, 'resume-cmd');

  const alreadyPaused = projectNativeKernelEvent(nativeEvent('command.applied',
    { commandId: 'pause-cmd', kind: 'pause', reason: 'already_paused' }), { scopeId: 'run-1', commandId: 'enqueue-cmd' });
  assert.equal(alreadyPaused.length, 0);

  const rejected = projectNativeKernelEvent(nativeEvent('command.applied',
    { commandId: 'steer-cmd', kind: 'steer', reason: 'effect_in_flight' }), { scopeId: 'run-1', commandId: 'enqueue-cmd' });
  assert.equal(rejected[0].event_type, 'control.command_rejected');
  assert.equal(rejected[0].payload.reason, 'effect_in_flight');
});

test('unit: run.terminal interrupted projects run.interrupted (not run.failed)', () => {
  const event = nativeEvent('run.terminal', {
    phase: 'interrupted', outcome: 'unverified', reason: 'effect_outcome_unknown', finalText: '', usage: {},
  });
  const facts = projectNativeKernelEvent(event, { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(facts[0].event_type, 'run.interrupted');
  assert.equal(facts[0].payload.status, 'interrupted');
  assert.equal(facts[0].payload.reason, 'effect_outcome_unknown');
  assert.equal(facts[1].event_type, 'control.run_transition');
  assert.equal(facts[1].payload.state, 'interrupted');
  assertManagedRuntimeFacts(withEnvelope(facts));
});

test('unit: run.terminal completed/canceled/failed keep their existing mappings', () => {
  const completed = projectNativeKernelEvent(nativeEvent('run.terminal',
    { phase: 'completed', outcome: 'verified', reason: null, finalText: 'done', usage: {} }), { scopeId: 'run-1', commandId: 'cmd-1' });
  const runCompleted = completed.find(f => f.event_type === 'run.completed');
  assert.ok(runCompleted);
  assert.deepEqual(runCompleted.payload.output_refs, [{ scope_id: 'run-1', item_id: 'final-run-unit', part_id: 'text' }]);

  const canceled = projectNativeKernelEvent(nativeEvent('run.terminal',
    { phase: 'canceled', outcome: 'unverified', reason: 'user_canceled', finalText: '', usage: {} }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(canceled[0].event_type, 'run.canceled');

  const failed = projectNativeKernelEvent(nativeEvent('run.terminal',
    { phase: 'failed', outcome: 'failed', reason: 'provider_terminal_error', finalText: '', usage: {} }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(failed[0].event_type, 'run.failed');
  assert.equal(failed[0].payload.error.code, 'NATIVE_EXECUTION_NOT_COMPLETED');
  assert.match(failed[0].payload.error.message, /模型请求未能完成/);
  const privateFailure = projectNativeKernelEvent(nativeEvent('run.terminal',
    { phase: 'failed', outcome: 'failed', reason: 'secret-token-from-provider', finalText: '', usage: {} }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.doesNotMatch(JSON.stringify(privateFailure), /secret-token-from-provider/);
  const inheritedName = projectNativeKernelEvent(nativeEvent('run.terminal',
    { phase: 'failed', outcome: 'failed', reason: 'constructor', finalText: '', usage: {} }), { scopeId: 'run-1', commandId: 'cmd-1' });
  assert.equal(typeof inheritedName[0].payload.error.message, 'string');
  assertManagedRuntimeFacts(withEnvelope([...completed, ...canceled, ...failed]));
});
