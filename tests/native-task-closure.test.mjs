import { nativeGoalContract, nativeVerificationRequired, ARTIFACT_VERIFIER_REF } from '../src/providers/native-verification.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRunPresentation } from '../src/client/state/native-outcome.mjs';
import { nativeCapabilitySummary, NATIVE_CAPABILITY_PRESETS } from '../src/client/state/native-capabilities.mjs';
import { nativeLocalToolContract } from '../src/native-tool-catalog.mjs';
import { nativeToolDisplay } from '../src/client/dsh/native-tool-view.mjs';
import { nativePublicTerminalError } from '../src/providers/native-terminal-failure.mjs';
import { projectNativeKernelEvent } from '../src/providers/native-kernel-events.mjs';

test('model errors use validated provenance rather than guessing credentials from a terminal failure', () => {
  const failure = { contract: 'model-failure-diagnostic/v1', protocol: 'openai-chat', phase: 'stream', code: 'usage_conflict', frameIndex: 2 };
  const protocol = nativePublicTerminalError('failed', 'provider_terminal_error', failure);
  assert.match(protocol.message, /协议校验/);assert.doesNotMatch(protocol.message, /凭据/);
  const auth = nativePublicTerminalError('failed', 'provider_terminal_error', {
    ...failure, phase: 'http-error', code: 'http_authentication', httpStatus: 401, frameIndex: undefined,
  });
  assert.match(auth.message, /身份认证/);
  assert.doesNotMatch(nativePublicTerminalError('failed', 'provider_terminal_error').message, /凭据/);
  assert.doesNotMatch(nativePublicTerminalError('failed', 'provider_terminal_error', { ...failure, message: 'SECRET' }).message, /SECRET/);
  const events = projectNativeKernelEvent({ eventId: 'event', runId: 'run', kind: 'run.terminal',
    payload: { phase: 'failed', reason: 'provider_terminal_error', modelFailure: failure } });
  assert.equal(events.find(e => e.event_type === 'run.failed').payload.error.message, protocol.message);
  const withCounters = { ...failure, contract: 'model-failure-diagnostic/v2', usageConflict: { previousFrameIndex: 0,
    previous: { inputTokens: 9, outputTokens: 1 }, reported: { inputTokens: 9, outputTokens: 2 } } };
  assert.deepEqual(nativePublicTerminalError('failed', 'provider_terminal_error', withCounters), protocol);
  const observed = projectNativeKernelEvent({ eventId: 'event-v2', runId: 'run', kind: 'run.terminal',
    payload: { phase: 'failed', reason: 'provider_terminal_error', modelFailure: withCounters } });
  assert.equal(observed.find(e => e.event_type === 'run.failed').payload.error.message, protocol.message);
});

test('plain conversation is allowed without pretending it can browse or edit files', () => {
  const pure = nativeCapabilitySummary();
  assert.match(pure.text, /纯对话/); assert.match(pure.hint, /绑定能力/);
  assert.deepEqual(pure.names, []);
  for (const preset of NATIVE_CAPABILITY_PRESETS) for (const name of preset.tools) assert.ok(nativeLocalToolContract(name), name);
  const configured = nativeCapabilitySummary({ tools: ['web_fetch'], mcp: ['crm'] });
  assert.deepEqual(configured.names, ['web_fetch']); assert.match(configured.text, /1 个工具、1 个 MCP/);
});

test('task evidence is independent from an ended conversation and failures remain failures', () => {
  const base = { runId: 'run', phase: 'completed' };
  assert.equal(nativeRunPresentation({ ...base, outcome: 'unverified' }).label, '本轮已结束');
  assert.match(nativeRunPresentation({ ...base, outcome: 'unverified', verificationRequired: true }).label, /结果未验证/);
  assert.doesNotMatch(nativeRunPresentation({ ...base, outcome: 'unverified', verificationRequired: false }).detail, /验证通过/);
  assert.equal(nativeRunPresentation({ ...base, outcome: 'verified' }).label, '任务已验证');
  assert.equal(nativeRunPresentation({ ...base, outcome: 'blocked' }).label, '任务受阻');
  assert.equal(nativeRunPresentation({ ...base, phase: 'failed', outcome: 'blocked' }).label, '任务受阻');
  const contextError = nativePublicTerminalError('failed', 'context_compaction_limit');
  assert.match(contextError.message, /压缩次数上限/);
  const budgetFailure = nativeRunPresentation({ ...base, phase: 'failed', outcome: 'blocked', error: contextError });
  assert.equal(budgetFailure.detail, contextError.message);
  assert.doesNotMatch(budgetFailure.detail, /绑定能力|审批/);
  assert.equal(nativeRunPresentation({ ...base, outcome: 'partial' }).label, '部分完成');
  assert.equal(nativeRunPresentation({ ...base, outcome: 'partial', reason: 'required_verification_incomplete' }).label, '部分已验证');
  assert.equal(nativeRunPresentation({ ...base, phase: 'failed', outcome: 'budget_exhausted' }).label, '执行失败');
  assert.equal(nativeRunPresentation({ ...base, phase: 'canceled' }).label, '已取消');
  assert.match(nativeRunPresentation({ ...base, phase: 'awaiting_interaction' }).label, /等待审批/);
  assert.equal(nativeRunPresentation({ ...base, phase: 'verifying', outcome: null }).label, '验证结果');
  assert.equal(nativeRunPresentation({ ...base, outcome: 'unverified', verificationRequired: false, reason: 'required_verification_incomplete' }).label, '本轮已结束');
  assert.equal(nativeRunPresentation(null), null);
  assert.match(nativeRunPresentation({ runId: 'run', phase: 'requesting_model', state: 'recoverable', canResume: true }).label, /中断/);
  assert.equal(nativeRunPresentation({ runId: 'run', phase: 'requesting_model', state: 'recovering', canResume: false }).label, '正在生成回复');
});

test('Native tool error rows keep their real tool title and exact raw evidence', () => {
  const text = JSON.stringify({ code: 'deferred_tool_not_loaded_or_not_deferred', executed: false });
  const block = { kind: 'tool-result', isError: true, call: { argsRaw: '{"name":"Bash","input":{}}' }, content: [{ type: 'text', text }] };
  const display = nativeToolDisplay('DeferredToolCall', block);
  assert.equal(display.title, '调用已加载工具'); assert.equal(display.summary, 'Bash');
  assert.match(display.error, /未绑定/); assert.equal(display.text, text);
  assert.equal(nativeToolDisplay('read_workspace_file', { phase: 'preparing', argsRaw: '{' }).error, '');
});

test('the default rejection-only guard is not presented as a configured acceptance oracle', () => {
  const contract = nativeGoalContract({ sessionId: 's', goal: 'Explain this local report' });
  assert.equal(nativeVerificationRequired(contract), false);
  assert.equal(contract.acceptance[0].required, true);
  const configured = { ...contract, acceptance: [...contract.acceptance,
    { id: 'exact', required: true, verifierRef: ARTIFACT_VERIFIER_REF }] };
  assert.equal(nativeVerificationRequired(configured), true);
  assert.equal(nativeVerificationRequired({ ...configured, acceptance: configured.acceptance.map(item => ({ ...item, required: false })) }), false);
});
