import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserQuestionTool, USER_QUESTION_TOOL_NAME, USER_QUESTION_TOOL_SPEC } from '../src/providers/user-question-tool.mjs';

test('the question tool advertises a model-callable function schema', () => {
  assert.equal(USER_QUESTION_TOOL_SPEC.name, USER_QUESTION_TOOL_NAME);
  assert.equal(USER_QUESTION_TOOL_SPEC.type, 'function');
  assert.deepEqual(USER_QUESTION_TOOL_SPEC.inputSchema.required, ['question']);
  assert.ok(USER_QUESTION_TOOL_SPEC.inputSchema.properties.options);
});

test('a tool call presents one question on the question channel and returns the answer', async () => {
  const asks = [];
  const tool = createUserQuestionTool({
    sessionId: 'sess-q',
    request: async ask => { asks.push(ask); return { answers: { answer: '写代码' } }; },
  });
  const output = JSON.parse(await tool.handler({
    name: USER_QUESTION_TOOL_NAME,
    arguments: { question: '你今天想完成什么？', options: ['写代码', '答疑'] },
  }));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].kind, 'question');
  assert.equal(asks[0].questions[0].question, '你今天想完成什么？');
  assert.deepEqual(asks[0].questions[0].options, ['写代码', '答疑']);
  assert.equal(asks[0].questions[0].multiSelect, undefined);
  assert.deepEqual(output, { answered: true, answer: '写代码' });
});

test('multi_select is forwarded and a declined/timeout ask reports unanswered', async () => {
  const asks = [];
  const tool = createUserQuestionTool({
    sessionId: 'sess-q',
    request: async ask => { asks.push(ask); return { answers: {} }; },
  });
  const output = JSON.parse(await tool.handler({
    name: USER_QUESTION_TOOL_NAME,
    arguments: { question: '选一个', options: ['a', 'b'], multi_select: true },
  }));
  assert.equal(asks[0].questions[0].multiSelect, true);
  assert.deepEqual(output, { answered: false, answer: null });
});

test('an empty question is rejected and other tools are not intercepted', async () => {
  const tool = createUserQuestionTool({ sessionId: 'sess-q', request: async () => ({ answers: {} }) });
  await assert.rejects(() => tool.handler({ name: USER_QUESTION_TOOL_NAME, arguments: {} }), /USER_QUESTION_INVALID|question/);
  assert.equal(await tool.handler({ name: 'other_tool', arguments: {} }), undefined);
});

test('no live run means the ask resolves unanswered instead of hanging', async () => {
  const tool = createUserQuestionTool({ sessionId: 'sess-q', request: () => undefined });
  const output = JSON.parse(await tool.handler({ name: USER_QUESTION_TOOL_NAME, arguments: { question: 'q' } }));
  assert.deepEqual(output, { answered: false, answer: null });
});
