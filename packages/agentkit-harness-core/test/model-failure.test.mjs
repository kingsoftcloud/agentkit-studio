import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelResult, reduceModel, plan, transition, validateModelFailure } from '../dist/index.mjs';
import { fixture } from './fixtures.mjs';

const diagnostic = { contract: 'model-failure-diagnostic/v1', protocol: 'openai-chat',
  phase: 'stream', code: 'usage_conflict', frameIndex: 2 };
const failed = { kind: 'provider_terminal_error', text: '', toolCalls: [],
  usage: { inputTokens: 9, outputTokens: 1, modelCalls: 0, toolCalls: 0, cost: 0 }, usageReported: true,
  failureKind: 'invalid_response', failureDiagnostic: diagnostic };

const conflictDiagnostic = { ...diagnostic, contract: 'model-failure-diagnostic/v2', usageConflict: {
  previousFrameIndex: 0,
  previous: { inputTokens: 9, outputTokens: 1, cachedInputTokens: 4, reasoningTokens: 1 },
  reported: { inputTokens: 9, outputTokens: 2, cachedInputTokens: 4, reasoningTokens: 2 },
} };

test('usage conflict evidence is versioned, numeric, bounded and distinct from billable usage', () => {
  assert.deepEqual(validateModelResult({ ...failed, failureDiagnostic: conflictDiagnostic }).usage, failed.usage);
  const evidence = conflictDiagnostic.usageConflict;
  for (const value of [
    { ...conflictDiagnostic, contract: 'model-failure-diagnostic/v1' },
    { ...conflictDiagnostic, code: 'identity_conflict' },
    { ...conflictDiagnostic, protocol: 'anthropic-messages' },
    { ...conflictDiagnostic, usageConflict: undefined },
    { ...conflictDiagnostic, usageConflict: { ...evidence, previousFrameIndex: 2 } },
    { ...conflictDiagnostic, usageConflict: { ...evidence, previousFrameIndex: 0.5 } },
    { ...conflictDiagnostic, usageConflict: { ...evidence, raw: 'private' } },
    ...[null, [], { inputTokens: 9 }, { inputTokens: 9, outputTokens: -1 },
      { inputTokens: 9, outputTokens: 1.5 }, { inputTokens: 9, outputTokens: Infinity },
      { inputTokens: 9, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { inputTokens: 9, outputTokens: '2' }, { inputTokens: 9, outputTokens: 2, secret: 'private' },
      { inputTokens: 9, outputTokens: 2, cost: 0 }, evidence.previous,
    ].map(reported => ({ ...conflictDiagnostic, usageConflict: { ...evidence, reported } })),
  ]) assert.throws(() => validateModelFailure(value), { code: 'invalid_model_failure_diagnostic' });
});

test('model failure facts accept only bounded content-free fields and failure results', () => {
  assert.deepEqual(validateModelResult(failed), failed);
  for (const value of [
    { ...diagnostic, message: 'private provider error' }, { ...diagnostic, code: 'arbitrary-provider-code' },
    { ...diagnostic, protocol: 'https://private-provider' }, { ...diagnostic, frameIndex: -1 },
    { ...diagnostic, frameIndex: 0.5 }, { ...diagnostic, httpStatus: 401 },
    { ...diagnostic, phase: 'buffered' },
    { ...diagnostic, code: 'http_authentication' },
    { contract: diagnostic.contract, protocol: diagnostic.protocol, phase: 'http-error', code: 'http_authentication', httpStatus: 500 },
  ]) assert.throws(() => validateModelFailure(value), { code: 'invalid_model_failure_diagnostic' });
  assert.throws(() => validateModelResult({ ...failed, kind: 'final_candidate', text: 'answer' }),
    { code: 'model_failure_diagnostic_requires_failure' });
});

test('terminal facts retain the last failed model attempt without changing outcome or execution policy', () => {
  const { config, snapshot } = fixture();
  const changes = reduceModel({ ...snapshot, phase: 'requesting_model' }, failed, config, 0, 0);
  assert.equal(changes.phase, 'finalizing');assert.equal(changes.reason, 'provider_terminal_error');
  assert.deepEqual(changes.diagnostics.lastModelFailure, diagnostic);
  const terminal = plan({ ...snapshot, ...changes }, config, {}, 0);
  assert.equal(terminal.snapshot.phase, 'failed');
  assert.deepEqual(terminal.events.find(e => e.kind === 'run.terminal').payload.modelFailure, diagnostic);
  assert.deepEqual(terminal.intents, []);
});

test('versioned conflict evidence reaches terminal events without authorizing another effect', () => {
  const { config, snapshot } = fixture();
  const changes = reduceModel({ ...snapshot, phase: 'requesting_model' },
    { ...failed, failureDiagnostic: conflictDiagnostic }, config, 0, 0);
  const terminal = plan({ ...snapshot, ...changes }, config, {}, 0);
  assert.deepEqual(changes.diagnostics.lastModelFailure, conflictDiagnostic);
  assert.equal(terminal.snapshot.phase, 'failed');
  assert.deepEqual(terminal.events.find(e => e.kind === 'run.terminal').payload.modelFailure, conflictDiagnostic);
  assert.deepEqual(terminal.intents, []);
});

test('a later successful attempt clears stale failure provenance and unrelated termination does not inherit it', () => {
  const { config, snapshot } = fixture();
  const previous = { ...snapshot, phase: 'requesting_model', diagnostics: { lastModelFailure: diagnostic } };
  const changes = reduceModel(previous, { kind: 'final_candidate', text: 'answer', toolCalls: [], usage: failed.usage }, config, 0, 0);
  assert.equal(changes.diagnostics.lastModelFailure, null);
  const canceled = transition(previous, { phase: 'canceled', reason: 'user_cancel' },
    [{ kind: 'run.terminal', payload: { phase: 'canceled', reason: 'user_cancel' } }]);
  assert.equal(canceled.events[0].payload.modelFailure, undefined);
});
