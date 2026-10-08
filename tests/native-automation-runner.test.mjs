import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAutomationRunner } from '../src/native-automation-runner.mjs';
function harness(reason = { kind: 'completed' }, extraEvents = []) {
  const calls = []; let done = false;
  const services = {
    agents: { withoutInitiator: work => work() },
    commands: { execute: async (...args) => { calls.push(['permission', args[1]]); return { result: {} }; } },
    sessionController: {
      create: async value => calls.push(['create', value]), selectModel: async value => calls.push(['model', value]),
      resolveAgent: async () => ({ agent: { whenIdle: async () => { done = true; }, cancel() {} } }),
      prompt: async value => calls.push(['prompt', value]),
      projections: async () => ({ asOfSeq: 9 }),
      page: async request => { assert.equal(done, true); assert.equal(request.throughSeq, 9); return { records: [...extraEvents.map(event => ({ type: 'event', event })), { type: 'event', event: { type: 'turn/end', seq: 9, data: { reason } } }] }; },
    },
  };
  return { calls, run: createNativeAutomationRunner({ getService: name => services[name], admit: async () => ({ presetId: 'frozen-preset', modelSelection: { provider: 'bound', model: 'model-a' } }) }) };
}
test('automation preserves its Agent preset, model and native Session without a workspace', async () => {
  const { run, calls } = harness();
  const result = await run({ agentId: 'agent-a', sessionId: 'session-a', occurrenceId: 'occ-a', input: 'probe' });
  assert.deepEqual(calls[0], ['create', { sessionId: 'session-a', agentPreset: 'frozen-preset' }]);
  assert.deepEqual(calls[1], ['model', { sessionId: 'session-a', provider: 'bound', model: 'model-a', saveDefault: false }]);
  assert.deepEqual(calls[2], ['permission', '/permission read-only']);
  assert.equal(calls[3][1].content[0].text, 'probe'); assert.equal(result.runId, 'dsh:session-a:9');
});
test('a failed native turn is never reported as a successful occurrence', async () => {
  const { run } = harness({ kind: 'error', error: { code: 'NO_ADAPTER', message: 'missing provider' } });
  await assert.rejects(() => run({ agentId: 'a', sessionId: 's', input: 'probe' }), error => error.code === 'NO_ADAPTER');
});

test('Codex tool presentation facts are counted once without executing the tool again', async () => {
  const { run, calls } = harness(undefined, ['started', 'completed'].map(phase => ({ type: 'agentkit/codex-tool', data: { name: 'card', callId: 'codex:one', phase } })));
  const result = await run({ agentId: 'a', sessionId: 's', input: 'probe' });
  assert.deepEqual(result.toolCalls, [{ name: 'card', callId: 'codex:one' }]);
  assert.equal(calls.filter(call => call[0] === 'prompt').length, 1);
});
