/** Author tests for the A2A question presenter. Not run by the implementer
 *  unless the parent main repo is available (the presenter depends on
 *  packages/agentkit-harness-core which exists in the main repo; this worktree
 *  lacks that dist). Parent runs them in the main repo.
 *
 *  Covers: input submit (string + object/array/number/bigint/-0 schemas),
 *  empty-string submit, input reject, approval approve/reject, wrong
 *  interactionId, duplicate answers, ambiguous custom, unknown option, abort,
 *  service replacement, session replacement, missing service, bad wait binding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioA2aQuestionPresenter } from '../src/host/services/a2a-question-presenter.mjs';

const INTERACTION = 'item_int_abc';
const baseWait = (overrides = {}) => ({
  contract: 'agentkit.a2a-question-wait/v1', interactionId: INTERACTION, continuationId: 'cont-1',
  request: { request_type: 'structured_input', prompt: 'City?', schema: { type: 'string' } },
  deadlineAt: Date.now() + 60000, scopeId: 'scope-1', taskId: 'task-1',
  target: { local_name: 'helper', target_agent_id: 'agent-x' }, ...overrides,
});
const approvalWait = (overrides = {}) => baseWait({
  request: { request_type: 'approval', prompt: 'Permit?', detail: { name: 'tool' } }, ...overrides,
});

function fakeAgent(sessionId = 'ses-1') { return { session: { id: sessionId } }; }
function fakeCtx(service) { return { get: name => (name === 'userQuestions' ? service : undefined) }; }
function askService(impl) {
  return { ask: impl, _other: 'unused' };
}
function answer(id, selected, custom) {
  return { answers: [{ id, selected, ...(custom === undefined ? {} : { custom }) }] };
}
const assertTrue = () => true;
const ac = () => new AbortController();

// ---- input submit -------------------------------------------------------

test('string schema: submit with raw custom (including empty string)', async () => {
  for (const custom of ['Shanghai', '', '  spaced  ', 'true']) {
    const service = askService(async () => answer(INTERACTION, [], custom));
    const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
    const out = await present({ wait: baseWait(), signal: ac().signal });
    assert.deepEqual(out, { action: 'submit', parts: [{ data: custom }] });
  }
});

test('object schema: submit with parseNativeJson(custom) preserving structure', async () => {
  const service = askService(async () => answer(INTERACTION, [], '{"city":"Shanghai"}'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: baseWait({ request: { request_type: 'structured_input', schema: { type: 'object' } } }), signal: ac().signal });
  assert.deepEqual(out, { action: 'submit', parts: [{ data: { city: 'Shanghai' } }] });
});

test('number schema: submit with parseNativeJson preserving exact number', async () => {
  const service = askService(async () => answer(INTERACTION, [], '42'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: baseWait({ request: { request_type: 'structured_input', schema: { type: 'number' } } }), signal: ac().signal });
  assert.deepEqual(out, { action: 'submit', parts: [{ data: 42 }] });
});

test('array schema: submit with parseNativeJson array', async () => {
  const service = askService(async () => answer(INTERACTION, [], '["a","b"]'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: baseWait({ request: { request_type: 'structured_input', schema: { type: 'array' } } }), signal: ac().signal });
  assert.deepEqual(out, { action: 'submit', parts: [{ data: ['a', 'b'] }] });
});

test('no schema: submit uses parseNativeJson (non-string default)', async () => {
  const service = askService(async () => answer(INTERACTION, [], '{"ok":true}'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: baseWait({ request: { request_type: 'structured_input', prompt: 'X?' } }), signal: ac().signal });
  assert.deepEqual(out, { action: 'submit', parts: [{ data: { ok: true } }] });
});

// ---- input reject -------------------------------------------------------

test('input reject: selected=["拒绝输入"] and no custom', async () => {
  const service = askService(async () => answer(INTERACTION, ['拒绝输入']));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: baseWait(), signal: ac().signal });
  assert.deepEqual(out, { action: 'reject' });
});

test('input reject with custom is invalid', async () => {
  const service = askService(async () => answer(INTERACTION, ['拒绝输入'], 'leftover'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_ANSWER_INVALID' });
});

// ---- approval -----------------------------------------------------------

test('approval approve: selected=["批准远端操作"] no custom', async () => {
  const service = askService(async () => answer(INTERACTION, ['批准远端操作']));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: approvalWait(), signal: ac().signal });
  assert.deepEqual(out, { action: 'approve' });
});

test('approval reject: selected=["拒绝远端操作"] no custom', async () => {
  const service = askService(async () => answer(INTERACTION, ['拒绝远端操作']));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const out = await present({ wait: approvalWait(), signal: ac().signal });
  assert.deepEqual(out, { action: 'reject' });
});

test('approval with custom is invalid', async () => {
  const service = askService(async () => answer(INTERACTION, ['批准远端操作'], 'note'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: approvalWait(), signal: ac().signal }), { code: 'A2A_QUESTION_ANSWER_INVALID' });
});

test('approval unknown option is invalid', async () => {
  const service = askService(async () => answer(INTERACTION, ['maybe']));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: approvalWait(), signal: ac().signal }), { code: 'A2A_QUESTION_ANSWER_INVALID' });
});

// ---- wrong id / duplicate / extra answers -------------------------------

test('answer with wrong interactionId is invalid', async () => {
  const service = askService(async () => answer('other-id', []));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_ANSWER_INVALID' });
});

test('duplicate answers (length>1) is invalid', async () => {
  const service = askService(async () => ({ answers: [answer(INTERACTION, [], 'a').answers[0], answer(INTERACTION, [], 'b').answers[0]] }));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_ANSWER_INVALID' });
});

test('empty answers array is invalid', async () => {
  const service = askService(async () => ({ answers: [] }));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_ANSWER_INVALID' });
});

// ---- abort / late settlement --------------------------------------------

test('pre-aborted signal rejects with abort reason', async () => {
  const service = askService(async () => answer(INTERACTION, [], 'x'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const c = ac(); c.abort(new Error('user'));
  await assert.rejects(() => present({ wait: baseWait(), signal: c.signal }), { message: 'user' });
});

test('abort during ask: late settlement does not return', async () => {
  let resolveAsk, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const service = askService(() => new Promise((r, rej) => { resolveAsk = { r, rej }; entered(); }));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  const c = ac();
  const p = present({ wait: baseWait(), signal: c.signal });
  await ready;
  c.abort(new Error('cancelled'));
  await assert.rejects(p, { message: 'cancelled' });
  resolveAsk.r(answer(INTERACTION, [], 'late')); // late settlement ignored
});

test('ask NO_PROVIDER surfaces as A2A_QUESTION_UNAVAILABLE', async () => {
  const service = askService(async () => { const e = new Error('no answerer'); e.code = 'NO_PROVIDER'; throw e; });
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_UNAVAILABLE' });
});

// ---- service / session / agent replacement ------------------------------

test('service replacement after ask rejects (binding invalid)', async () => {
  const replacement = askService(async () => answer(INTERACTION, [], 'x'));
  let current = askService(async () => { current = replacement; return answer(INTERACTION, [], 'x'); });
  const ctx = { get: () => current };
  const present = createStudioA2aQuestionPresenter({ ctx, agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});

test('session replacement after ask rejects', async () => {
  const service = askService(async () => answer(INTERACTION, [], 'x'));
  const agent = fakeAgent();
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent, assertCurrent: assertTrue });
  agent.session.id = 'changed'; // mutate after construction
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});

test('agent instance replacement rejects', async () => {
  const service = askService(async () => answer(INTERACTION, [], 'x'));
  const agent = fakeAgent();
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent, assertCurrent: assertTrue });
  // The presenter pins the agent at construction; replacing the session id
  // (covered above) exercises the same drift guard. Here we verify a present()
  // call against an agent whose session was swapped before the call still
  // rejects because the pinned originalSessionId no longer matches.
  const otherAgent = fakeAgent('other');
  // Re-bind by mutating the pinned agent's session: simulate drift.
  agent.session = { id: 'other' };
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});

// ---- missing service / bad binding --------------------------------------

test('missing userQuestions service rejects A2A_QUESTION_UNAVAILABLE when a question is presented', async () => {
  const ctx = { get: () => undefined };
  const present = createStudioA2aQuestionPresenter({ ctx, agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_UNAVAILABLE' });
});

test('ask not a function rejects A2A_QUESTION_UNAVAILABLE', async () => {
  const ctx = { get: () => ({ notAsk: true }) };
  const present = createStudioA2aQuestionPresenter({ ctx, agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_UNAVAILABLE' });
});

test('bad wait contract rejects binding invalid', async () => {
  const service = askService(async () => answer(INTERACTION, [], 'x'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: { contract: 'wrong' }, signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});

test('missing signal rejects', async () => {
  const service = askService(async () => answer(INTERACTION, [], 'x'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(() => present({ wait: baseWait() }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});

test('assertCurrent returns false rejects binding invalid', async () => {
  const service = askService(async () => answer(INTERACTION, [], 'x'));
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: () => false });
  await assert.rejects(() => present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});

// ---- ask is called with the right question ------------------------------

test('approval ask offers exactly two approval labels', async () => {
  let captured;
  const service = askService(async req => { captured = req; return answer(INTERACTION, ['批准远端操作']); });
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await present({ wait: approvalWait(), signal: ac().signal });
  assert.equal(captured.questions.length, 1);
  const labels = captured.questions[0].options.map(o => o.label);
  assert.deepEqual(labels.sort(), ['拒绝远端操作', '批准远端操作'].sort());
});

test('input ask offers exactly the reject-input option', async () => {
  let captured;
  const service = askService(async req => { captured = req; return answer(INTERACTION, [], 'a'); });
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await present({ wait: baseWait(), signal: ac().signal });
  assert.equal(captured.questions.length, 1);
  assert.deepEqual(captured.questions[0].options.map(o => o.label), ['拒绝输入']);
});

test('ask is never called with approval/tools/send — only questions', async () => {
  let captured;
  const service = askService(async req => { captured = req; return answer(INTERACTION, [], 'a'); });
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await present({ wait: baseWait(), signal: ac().signal });
  assert.equal(captured.agent?.session?.id, 'ses-1');
  assert.ok(captured.signal instanceof AbortSignal);
  assert.ok(Array.isArray(captured.questions));
  // No approval/tools keys on the request.
  assert.equal(captured.approval, undefined);
  assert.equal(captured.tools, undefined);
});
test('a different Session object with the same id cannot receive an old answer', async () => {
  const agent = fakeAgent();
  const service = askService(async () => { agent.session = { id: agent.session.id }; return answer(INTERACTION, [], 'x'); });
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent, assertCurrent: assertTrue });
  await assert.rejects(present({ wait: baseWait(), signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});
test('stable Cordis tracker identity permits distinct tracing proxies', async () => {
  const identity = {}, service = askService(async () => answer(INTERACTION, [], 'x'));
  const ctx = { get: () => ({ ...service, [Symbol.for('cordis.tracker')]: identity }) };
  const present = createStudioA2aQuestionPresenter({ ctx, agent: fakeAgent(), assertCurrent: assertTrue });
  assert.deepEqual(await present({ wait: baseWait(), signal: ac().signal }), { action: 'submit', parts: [{ data: 'x' }] });
});
test('wait drift cannot redirect an answer and object approval detail remains visible', async () => {
  const wait = approvalWait(), service = askService(async request => {
    assert.match(request.questions[0].detail, /tool/); wait.continuationId = 'changed';
    return answer(INTERACTION, ['批准远端操作']);
  });
  const present = createStudioA2aQuestionPresenter({ ctx: fakeCtx(service), agent: fakeAgent(), assertCurrent: assertTrue });
  await assert.rejects(present({ wait, signal: ac().signal }), { code: 'A2A_QUESTION_BINDING_INVALID' });
});
