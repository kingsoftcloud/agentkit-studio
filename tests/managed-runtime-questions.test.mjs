import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedApprovalRegistry } from '../src/managed-runtime-approval.mjs';

function registryWithRun(timeoutMs = 5000) {
  const published = [];
  const publishedDone = [];
  const registry = createManagedApprovalRegistry({ ctx: {}, timeoutMs, now: () => Date.now() });
  const run = registry.begin({
    runId: 'run_q1',
    sessionId: 'sess-q1',
    nativeSessionId: 'native-q1',
    mode: 'risk',
    publish: item => published.push(item),
    publishDone: (...args) => publishedDone.push(args),
  });
  assert.ok(run);
  return { registry, published, publishedDone };
}

test('a question is presented on its own channel and resolves with the user answers', async () => {
  const { registry, published, publishedDone } = registryWithRun();
  const pending = registry.request({
    kind: 'question',
    nativeSessionId: 'native-q1',
    sessionId: 'sess-q1',
    questions: [{ id: 'goal', question: '想做什么？', options: [{ id: 'code' }] }],
  });
  assert.ok(pending);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'mcp_user_question');
  assert.deepEqual(published[0].questions[0].id, 'goal');

  const receipt = registry.resolve({
    sessionId: 'sess-q1',
    nativeSessionId: 'native-q1',
    runId: 'run_q1',
    interactionId: published[0].id,
    expectedRevision: 1,
    action: 'submit',
    response: { answers: { goal: 'code' } },
    idempotencyKey: 'idem-1',
  });
  assert.equal(receipt.decision, 'submitted');
  assert.deepEqual(await pending, { answers: { goal: 'code' } });
  assert.equal(publishedDone.length, 1);
  assert.equal(publishedDone[0][3].kind, 'question');
  assert.deepEqual(publishedDone[0][3].answers, { goal: 'code' });
});

test('a question times out into an empty answer instead of stranding the run', async () => {
  const { registry, published } = registryWithRun(30);
  const pending = registry.request({ kind: 'question', nativeSessionId: 'native-q1', sessionId: 'sess-q1',
    questions: [{ id: 'goal', question: '想做什么？' }] });
  const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('timeout'), 1000))]);
  assert.deepEqual(outcome, { answers: {} });
  assert.equal(published[0].type, 'mcp_user_question');
});

test('approval and question channels cannot resolve each other', async () => {
  const { registry, published } = registryWithRun();
  const pending = registry.request({ kind: 'question', nativeSessionId: 'native-q1', sessionId: 'sess-q1',
    questions: [{ id: 'goal', question: '想做什么？' }] });
  const questionId = published[0].id;

  assert.throws(() => registry.resolve({ sessionId: 'sess-q1', nativeSessionId: 'native-q1', runId: 'run_q1',
    interactionId: questionId, expectedRevision: 1, action: 'approve', response: {}, idempotencyKey: 'x' }),
  /RUNTIME_INTERACTION_ACTION_UNSUPPORTED/);

  // The Responses compatibility input (mcp_approval_response) must not settle a question.
  assert.throws(() => registry.resolveInput({ sessionId: 'sess-q1', nativeSessionId: 'native-q1',
    interactionId: questionId, approve: true }), /RUNTIME_INTERACTION_CHANNEL_MISMATCH/);

  registry.resolve({ sessionId: 'sess-q1', nativeSessionId: 'native-q1', runId: 'run_q1',
    interactionId: questionId, expectedRevision: 1, action: 'submit',
    response: { answers: {} }, idempotencyKey: 'y' });
  await pending;
});

test('a tool approval still presents mcp_approval_request and cannot be answered with submit', async () => {
  const { registry, published } = registryWithRun();
  const pending = registry.request({ toolName: 'codex/command', nativeSessionId: 'native-q1', sessionId: 'sess-q1' });
  assert.equal(published[0].type, 'mcp_approval_request');
  assert.throws(() => registry.resolve({ sessionId: 'sess-q1', nativeSessionId: 'native-q1', runId: 'run_q1',
    interactionId: published[0].id, expectedRevision: 1, action: 'submit', response: {}, idempotencyKey: 'z' }),
  /RUNTIME_INTERACTION_ACTION_UNSUPPORTED/);
  registry.resolve({ sessionId: 'sess-q1', nativeSessionId: 'native-q1', runId: 'run_q1',
    interactionId: published[0].id, expectedRevision: 1, action: 'approve', response: {}, idempotencyKey: 'w' });
  assert.equal(await pending, 'allowed-once');
});
