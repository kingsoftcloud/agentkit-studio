import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { fixture, tool, scope, digest } from './fixtures.mjs';

// Deterministic behavioral reference for the diagnose-before-repeat/v1 tool-error
// recovery policy, ported from the Python Native harness suite. Tools are scripted
// but every result is produced by the real NativeKernel dispatch path; no model
// statement alone is trusted as success.

const writeTool = () => tool({ name: 'write', readOnly: false, concurrentSafe: false });
const readTool = () => tool({ name: 'read', description: 'Read actual state', contextRole: 'workspace_read' });
const replaceTool = () => tool({ name: 'replace', description: 'Alternative write', readOnly: false, concurrentSafe: false });
const recoveryTools = () => [writeTool(), readTool(), replaceTool()];

function scriptedTools() {
  const calls = [];
  const execute = async (request) => {
    calls.push(request.call.name);
    if (request.call.name === 'read')
      return { status: 'ok', content: { actual: 'use corrected content' } };
    if (request.call.name === 'replace' || request.call.arguments.text === 'corrected')
      return { status: 'ok', content: { written: true }, workspaceChangedPaths: ['result.txt'] };
    return { status: 'error', content: { code: 'exact_content_mismatch' } };
  };
  return { calls, tools: { execute } };
}

function scriptedModel(responses) {
  const requests = [];
  const generate = async (request) => { requests.push(request); return responses[requests.length - 1]; };
  return { requests, model: { generate } };
}

const action = (callId, name = 'write', args = {}) => ({
  kind: 'tool_calls', text: '', toolCalls: [{ callId, name, arguments: args }], usage: emptyUsage(),
});
const batch = (toolCalls) => ({ kind: 'tool_calls', text: '', toolCalls, usage: emptyUsage() });
const final = (text) => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const refusalReceipt = (message) => {
  assert.ok(message, 'refusal receipt recorded');
  const receipt = JSON.parse(message.content);
  assert.equal(receipt.execution_status, 'not_dispatched');
  assert.equal(receipt.content.reason, 'tool_error_diagnosis_required');
  return receipt;
};

test('after six same write errors, a batched read plus blind corrected write cannot use the read until the next model decision', async () => {
  const { calls, tools } = scriptedTools();
  const responses = [];
  for (let i = 0; i < 6; i++) responses.push(action(`call-${i}`, 'write', {}));
  responses.push(batch([
    { callId: 'call-6', name: 'read', arguments: {} },
    { callId: 'call-blind', name: 'write', arguments: { text: 'corrected' } },
  ]));
  responses.push(action('call-7', 'write', { text: 'corrected' }));
  responses.push(final('done'));
  const { requests, model } = scriptedModel(responses);

  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, ports: { model, tools }, owner: 'worker', digest });
  const { config, snapshot } = fixture({
    toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1',
    toolErrorRecoveryModelCalls: 3,
    tools: recoveryTools(),
    limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 },
  });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');

  assert.deepEqual(calls, [...Array(6).fill('write'), 'read', 'write']);
  assert.equal(result.usage.modelCalls, 9);
  assert.equal(result.usage.toolCalls, 8);
  assert.equal(result.phase, 'completed');
  refusalReceipt(result.messages.find(message => message.callId === 'call-blind'));
  assert.ok(requests[7].messages.some(message => message.callId === 'call-blind'),
    'the blind refusal is observed before the corrected write is requested');
});

test('an all-readonly concurrent batch cannot smuggle the guarded query past admission after a diagnostic read', async () => {
  const { calls, tools } = scriptedTools();
  const responses = [];
  for (let i = 0; i < 6; i++) responses.push(action(`call-${i}`, 'write', { text: 'wrong' }));
  responses.push(batch([
    { callId: 'call-6', name: 'read', arguments: {} },
    { callId: 'call-smuggled', name: 'write', arguments: { text: 'wrong' } },
  ]));
  responses.push(final('Report the diagnosis'));
  const { requests, model } = scriptedModel(responses);

  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, ports: { model, tools }, owner: 'worker', digest });
  const { config, snapshot } = fixture({
    toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1',
    toolErrorRecoveryModelCalls: 3,
    tools: [
      tool({ name: 'write', readOnly: true, concurrentSafe: true }),
      tool({ name: 'read', readOnly: true, concurrentSafe: true, contextRole: 'workspace_read' }),
      tool({ name: 'replace', readOnly: true, concurrentSafe: true }),
    ],
    limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 },
  });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');

  assert.deepEqual(calls, [...Array(6).fill('write'), 'read']);
  assert.equal(result.usage.toolCalls, 7);
  assert.equal(result.usage.modelCalls, 8);
  assert.equal(result.phase, 'completed');
  refusalReceipt(result.messages.find(message => message.callId === 'call-smuggled'));
});

test('an uncapped policy permits eight diagnostic reads then a single corrected trial and final', async () => {
  const { calls, tools } = scriptedTools();
  const responses = [];
  for (let i = 0; i < 6; i++) responses.push(action(`call-${i}`, 'write', {}));
  for (let i = 6; i < 14; i++) responses.push(action(`call-${i}`, 'read', { path: `diagnostic-${i}` }));
  responses.push(action('call-14', 'write', { text: 'corrected' }));
  responses.push(final('done'));
  const { requests, model } = scriptedModel(responses);

  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, ports: { model, tools }, owner: 'worker', digest });
  const { config, snapshot } = fixture({
    toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1',
    tools: recoveryTools(),
    limits: { maxModelCalls: null, maxToolCalls: null, finalizationReserveModelCalls: 0 },
  });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');

  assert.equal(result.phase, 'completed');
  assert.equal(result.usage.modelCalls, 16);
  assert.equal(result.usage.toolCalls, 15);
  assert.deepEqual(calls, [...Array(6).fill('write'), ...Array(8).fill('read'), 'write']);
  assert.equal(result.toolErrorRecovery, null);
  const observation = requests[6].messages.find(message => message.kind === 'tool_error_recovery_observation');
  assert.ok(observation, 'recovery observation injected before the first diagnostic read');
  assert.equal(JSON.parse(observation.content).remaining_model_calls, null);
});

test('a failed corrected trial consumes the single trial despite a later read; an authorized alternative write and final still complete', async () => {
  const { calls, tools } = scriptedTools();
  const responses = [];
  for (let i = 0; i < 6; i++) responses.push(action(`call-${i}`, 'write', {}));
  responses.push(action('call-6', 'read', {}));
  responses.push(action('call-7', 'write', { text: 'still wrong' }));
  responses.push(action('call-8', 'read', { path: 'second observation' }));
  responses.push(action('call-9', 'write', { text: 'corrected' }));
  responses.push(action('call-10', 'replace', {}));
  responses.push(final('done'));
  const { requests, model } = scriptedModel(responses);

  const store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, ports: { model, tools }, owner: 'worker', digest });
  const { config, snapshot } = fixture({
    toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1',
    tools: recoveryTools(),
    limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 },
  });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');

  assert.equal(result.phase, 'completed');
  assert.equal(result.usage.modelCalls, 12);
  assert.equal(result.usage.toolCalls, 10);
  assert.deepEqual(calls, [...Array(6).fill('write'), 'read', 'write', 'read', 'replace']);
  refusalReceipt(result.messages.find(message => message.callId === 'call-9'));
  assert.equal(result.toolErrorRecovery.trialConsumed, true);
});
