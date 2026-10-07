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
  const services = { sessionController: controller, agents: { withoutInitiator: work => work() }, commands: { execute: async () => ({}) } };
  const run = createNativeAutomationRunner({ reuseSession: true, getService: name => services[name], admit: async () => { admits++; return { presetId: 'frozen-r1', modelSelection: { provider: 'bound', model: 'model' } }; } });
  const first = { agentId: 'agent', sessionId: 'session', occurrenceId: 'one', input: 'first' };
  assert.equal((await run(first)).output, 'first');
  assert.equal((await run({ ...first, occurrenceId: 'two', input: 'second' })).output, 'second');
  assert.equal((await run(first)).output, 'first');
  assert.deepEqual({ admits, creates, modelChanges, prompts }, { admits: 1, creates: 1, modelChanges: 1, prompts: 2 });
});
