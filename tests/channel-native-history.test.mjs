import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeRequestEvents } from '../src/native-request-history.mjs';
import { createNativeAutomationRunner } from '../src/native-automation-runner.mjs';

const turn = (number, requestId, output) => [
  { type: 'turn/start', data: { turn: number } },
  { type: 'user/message', data: { source: { rpcId: requestId } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: output }] } } },
  { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
];
test('paged request lookup returns the exact older turn, never the latest answer', async () => {
  const events = [...turn(1, 'request-1', 'first'), ...turn(2, 'request-2', 'second')].map((event, seq) => ({ ...event, seq }));
  const controller = {
    projections: async () => ({ asOfSeq: 7 }),
    page: async ({ beforeSeq = 8 }) => ({ records: events.slice(Math.max(0, beforeSeq - 3), beforeSeq).map(event => ({ type: 'event', event })), hasMore: beforeSeq > 3 }),
  };
  const result = await readNativeRequestEvents(controller, 'session', 'request-1', new AbortController().signal);
  assert.equal(result[2].data.message.content[0].text, 'first');
  await assert.rejects(readNativeRequestEvents(controller, 'session', 'absent', new AbortController().signal), { code: 'CHANNEL_REQUEST_NOT_FOUND' });
});

test('native channel continuation keeps the existing preset/model and deduplicates through DSH requestId', async () => {
  let exists = false, admits = 0, creates = 0, modelChanges = 0, prompts = 0;
  const events = [];
  const controller = {
    projections: async () => exists ? { asOfSeq: events.length - 1 } : null,
    create: async () => { exists = true; creates++; }, selectModel: async () => { modelChanges++; },
    resolveAgent: async () => ({ agent: { whenIdle: async () => {}, cancel() {} } }),
    prompt: async ({ requestId, content }) => {
      if (events.some(event => event.type === 'user/message' && event.data.source.rpcId === requestId)) return;
      prompts++;
      for (const event of turn(prompts, requestId, content[0].text)) events.push({ ...event, seq: events.length });
    },
    page: async () => ({ records: events.map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, permissionPresets: { set() {} }, approval: { setPolicy: (_agent, policy) => assert.equal(policy, 'never') } };
  const run = createNativeAutomationRunner({ reuseSession: true, getService: name => services[name], admit: async () => { admits++; return { presetId: 'frozen-r1', modelSelection: { provider: 'bound', model: 'model' } }; } });
  const first = { agentId: 'agent', sessionId: 'session', occurrenceId: 'one', input: 'first' };
  assert.equal((await run(first)).output, 'first');
  assert.equal((await run({ ...first, occurrenceId: 'two', input: 'second' })).output, 'second');
  assert.equal((await run(first)).output, 'first');
  assert.deepEqual({ admits, creates, modelChanges, prompts }, { admits: 1, creates: 1, modelChanges: 1, prompts: 2 });
});

test('legacy request lookup finds an inherited native header on an earlier history page', async () => {
  const header = { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'old-model' } } } };
  const events = [header, ...turn(1, 'first', 'first answer'), ...turn(2, 'second', 'second answer'),
    { ...header, data: { header: { config: { provider: 'fixture', model: 'new-model' } } } }, ...turn(3, 'third', 'third answer')]
    .map((event, seq) => ({ ...event, seq }));
  const pages = [];
  const controller = {
    projections: async () => ({ asOfSeq: events.length - 1 }),
    page: async ({ beforeSeq = events.length }) => {
      pages.push(beforeSeq);
      return { records: events.slice(Math.max(0, beforeSeq - 4), beforeSeq).map(event => ({ type: 'event', event })), hasMore: beforeSeq > 4 };
    },
  };
  const result = await readNativeRequestEvents(controller, 'session', 'second', new AbortController().signal, { includeRequestHeader: true });
  assert.equal(result[0].data.header.config.model, 'old-model');
  assert.equal(result.find(event => event.type === 'assistant/message').data.message.content[0].text, 'second answer');
  assert.equal(result.at(-1).data.turn, 2);
  assert.ok(pages.length >= 3);
});

test('a failed turn that recorded no user message surfaces the recorded failure code', async () => {
  const events = [];
  const controller = {
    projections: async () => ({ asOfSeq: events.length - 1 }),
    create: async () => {}, selectModel: async () => {},
    resolveAgent: async () => ({ agent: { whenIdle: async () => {}, cancel() {} } }),
    prompt: async () => {
      events.push({ type: 'turn/start', data: { turn: 1 }, seq: events.length });
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'failed', error: { code: 'MANAGED_RESOURCE_SERVER_UNAVAILABLE', message: 'resource server unavailable' } } }, seq: events.length });
    },
    page: async () => ({ records: events.map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, permissionPresets: { set() {} }, approval: { setPolicy() {} } };
  const run = createNativeAutomationRunner({ reuseSession: true, getService: name => services[name], admit: async () => ({ presetId: 'frozen-r1' }) });
  await assert.rejects(run({ agentId: 'agent', sessionId: 'session', occurrenceId: 'failed-turn', input: 'hello' }),
    { code: 'MANAGED_RESOURCE_SERVER_UNAVAILABLE' });
});

test('an absent request keeps the missing-request code when the session ended cleanly', async () => {
  const events = turn(1, 'other-request', 'other answer').map((event, seq) => ({ ...event, seq }));
  const controller = {
    projections: async () => ({ asOfSeq: events.length - 1 }),
    create: async () => {}, selectModel: async () => {},
    resolveAgent: async () => ({ agent: { whenIdle: async () => {}, cancel() {} } }),
    prompt: async () => {},
    page: async () => ({ records: events.map(event => ({ type: 'event', event })) }),
  };
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, permissionPresets: { set() {} }, approval: { setPolicy() {} } };
  const run = createNativeAutomationRunner({ reuseSession: true, getService: name => services[name], admit: async () => ({ presetId: 'frozen-r1' }) });
  await assert.rejects(run({ agentId: 'agent', sessionId: 'session', occurrenceId: 'missing', input: 'hello' }),
    { code: 'CHANNEL_REQUEST_NOT_FOUND' });
});
