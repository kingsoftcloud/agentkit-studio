import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAutomationRunner } from '../src/native-automation-runner.mjs';
function harness(reason = { kind: 'completed' }, extraEvents = []) {
  const calls = []; let done = false, durable = false;
  const session = { id: 'session-a' };
  const services = {
    agents: { withoutInitiator: work => work() },
    sessions: { flush: async value => { assert.equal(value, session); assert.equal(done, true); durable = true; return true; } },
    commands: { execute: () => assert.fail('unattended policy must not execute a user command') },
    permissionPresets: { set: (_session, preset) => calls.push(['permission', preset]) },
    approval: { setPolicy: (_agent, policy, options) => calls.push(['approval', policy, options]) },
    sessionController: {
      create: async value => calls.push(['create', value]), selectModel: async value => calls.push(['model', value]),
      resolveAgent: async () => ({ agent: { session, whenIdle: async () => { done = true; }, cancel() {} } }),
      prompt: async value => calls.push(['prompt', value]),
      projections: async () => ({ asOfSeq: 9 }),
      page: async request => { assert.equal(done, true); assert.equal(durable, true); assert.equal(request.throughSeq, 9); return { records: [...extraEvents.map(event => ({ type: 'event', event })), { type: 'event', event: { type: 'turn/end', seq: 9, data: { reason } } }] }; },
    },
  };
  return { calls, services, run: createNativeAutomationRunner({ getService: name => services[name], admit: async () => ({ presetId: 'frozen-preset', modelSelection: { provider: 'bound', model: 'model-a' } }) }) };
}
test('automation preserves its Agent preset, model and native Session without a workspace', async () => {
  const { run, calls } = harness();
  const result = await run({ agentId: 'agent-a', sessionId: 'session-a', occurrenceId: 'occ-a', input: 'probe' });
  assert.deepEqual(calls[0], ['create', { sessionId: 'session-a', agentPreset: 'frozen-preset' }]);
  assert.deepEqual(calls[1], ['model', { sessionId: 'session-a', provider: 'bound', model: 'model-a', saveDefault: false }]);
  assert.deepEqual(calls[2], ['permission', 'read-only']);
  assert.deepEqual(calls[3], ['approval', 'never', { actor: 'automation' }]);
  assert.deepEqual(run.executionPolicy, { format: 'agentkit.execution-policy/v1', permissionMode: 'read-only', approvalPolicy: 'never', approvalSource: 'runtime-policy' });
  assert.equal(calls[4][1].content[0].text, 'probe'); assert.equal(result.runId, 'dsh:session-a:9');
});
test('headless runs fail before prompting when the approval service is unavailable', async () => {
  let prompted = false;
  const services = {
    agents: { withoutInitiator: work => work() },
    sessions: { flush: async () => true },
    permissionPresets: { set() {} },
    sessionController: { create: async () => {}, resolveAgent: async () => ({ agent: {} }), prompt: async () => { prompted = true; } },
  };
  const run = createNativeAutomationRunner({ getService: name => services[name], admit: async () => ({ presetId: 'frozen' }) });
  await assert.rejects(run({ agentId: 'a', sessionId: 's', input: 'probe' }), { code: 'AUTOMATION_SERVICE_UNAVAILABLE' });
  assert.equal(prompted, false);
});
test('a failed native turn is never reported as a successful occurrence', async () => {
  const { run } = harness({ kind: 'error', error: { code: 'NO_ADAPTER', message: 'missing provider' } });
  await assert.rejects(() => run({ agentId: 'a', sessionId: 's', input: 'probe' }), error => error.code === 'NO_ADAPTER');
});

test('an idle SDK turn cannot complete delivery before its actual Session flush succeeds', async () => {
  const { run, services } = harness(); let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  services.sessions.flush = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  let settled = false;
  const pending = run({ agentId: 'a', sessionId: 's', input: 'probe' });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await waiting; await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(false);
  await assert.rejects(pending, { code: 'AUTOMATION_SESSION_NOT_DURABLE' });
});

for (const result of [false, undefined, 1]) test(`flush ${String(result)} is not durable completion`, async () => {
  const { run, services } = harness(); let historyReads = 0;
  services.sessions.flush = async () => result;
  services.sessionController.page = async () => { historyReads++; assert.fail('No success from unflushed history'); };
  await assert.rejects(run({ agentId: 'a', sessionId: 's', input: 'probe' }), { code: 'AUTOMATION_SESSION_NOT_DURABLE' });
  assert.equal(historyReads, 0);
});

test('canceling an uncooperative Session flush ends delivery and observes a late rejection', async () => {
  const { run, services } = harness(), abort = new AbortController(); let rejectFlush, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  services.sessions.flush = () => { entered(); return new Promise((_, reject) => { rejectFlush = reject; }); };
  const pending = run({ agentId: 'a', sessionId: 's', input: 'probe', signal: abort.signal });
  await waiting;
  const reason = Error('caller canceled delivery'); abort.abort(reason);
  await assert.rejects(pending, error => error === reason);
  rejectFlush(Error('late flush rejection')); await new Promise(resolve => setImmediate(resolve));
});

test('Codex tool presentation facts are counted once without executing the tool again', async () => {
  const { run, calls } = harness(undefined, ['started', 'completed'].map(phase => ({ type: 'agentkit/codex-tool', data: { name: 'card', callId: 'codex:one', phase } })));
  const result = await run({ agentId: 'a', sessionId: 's', input: 'probe' });
  assert.deepEqual(result.toolCalls, [{ name: 'card', callId: 'codex:one' }]);
  assert.equal(calls.filter(call => call[0] === 'prompt').length, 1);
});

test('completed request history reconstructs presentation only; a delivery cache cannot authorize execution', async () => {
  const events = [
    { seq: 1, type: 'tool/call', data: { callId: 'original', name: 'read_file', arguments: '{}' } },
    { seq: 2, type: 'tool/result', data: { message: { source: { callId: 'original' }, content: [{ type: 'text', text: 'bytes' }] } } },
    { seq: 3, type: 'assistant/attempt', data: { message: { content: [{ type: 'text', text: 'discarded' }] } } },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'checked' }, { type: 'text', text: 'done' }] } } },
    { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
  let history = events;
  const services = { agents: { withoutInitiator: work => work() }, sessionController: {
    projections: async () => ({}), create: () => assert.fail('no new session'), prompt: () => assert.fail('no model or tool execution'),
    resolveAgent: () => assert.fail('no new permission/model mutation'),
  } };
  const run = createNativeAutomationRunner({ getService: name => services[name], reuseSession: true,
    loadReplay: async () => history, admit: () => assert.fail('no new admission') });
  const frames = [], request = { agentId: 'a', sessionId: 's', input: 'original', occurrenceId: 'once', onFrame: frame => frames.push(frame) };
  assert.equal((await run(request)).output, 'done');
  assert.equal(frames.filter(frame => frame.kind === 'event' && frame.value.type === 'tool/result').length, 1);
  assert.ok(frames.some(frame => frame.value.chunk?.text === 'checked'));
  assert.ok(frames.some(frame => frame.value.outcome?.eventType === 'assistant/attempt'));
  frames.length = 0;
  assert.equal((await run({ ...request, requireReplay: true })).output, 'done');
  assert.equal(frames.length, 0);
  history = null;
  await assert.rejects(run({ ...request, requireReplay: true }), { code: 'RUNTIME_REQUEST_HISTORY_UNAVAILABLE' });
});
