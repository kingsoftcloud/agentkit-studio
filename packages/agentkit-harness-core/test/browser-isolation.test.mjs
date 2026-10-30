import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceTools, isolatedBrowserFailure, validateBrowserSessionRef } from '../dist/index.mjs';
import { fixture, tool, scope, digest } from './fixtures.mjs';

const browser = tool({ name: 'browser', readOnly: false, concurrentSafe: false,
  observationRole: 'browser', recoveryPolicy: 'ephemeral-browser/v1' });
const call = { name: 'browser', callId: 'lost-click', arguments: {} };
const ref = validateBrowserSessionRef({ sessionId: 'page', scope, runId: 'run', runtimeId: 'owner', backend: 'playwright',
  workspaceRevision: 'source', generation: 1, leaseEpoch: 1 });
const proof = { contract: 'agentkit.browser-isolation/v1', sessionRef: ref, operationKey: 'effect',
  fenced: true, externalEffects: false, oldActionsReplayed: false };
const result = { status: 'uncertain', content: { code: 'action_timed_out' }, browserSessionRef: ref,
  browserIsolation: proof };
function pending(options = {}) {
  const { config, snapshot } = fixture({ tools: [browser], ...options });
  return { config, snapshot: { ...snapshot, phase: 'executing_tools', pendingIntent: 'effect', pendingTools: [call],
    browserSessionRefs: [ref], browserReobservationRefs: [],
    lastBrowserObservation: { sessionRef: ref, digest: 'old' }, candidate: { text: 'old' },
    finalText: 'old', verification: { status: 'passed' }, preparedContext: { sourceDigest: 'old' } },
  intent: { operationKey: 'effect', kind: 'tool', payload: { calls: [call] } } };
}

test('certified private page loss preserves unknown result, spends existing recovery budget, and invalidates evidence', () => {
  const { config, snapshot, intent } = pending();
  const changes = reduceTools(snapshot, [result], [call], intent, config, digest);
  assert.notEqual(changes.phase, 'finalizing');
  assert.deepEqual(changes.pendingTools, []);
  assert.equal(changes.usage.toolCalls, 1);
  assert.equal(changes.recoveryRetriesUsed, 1);
  assert.deepEqual(changes.browserReobservationRefs, [ref]);
  for (const key of ['candidate', 'verification', 'preparedContext', 'lastBrowserObservation']) assert.equal(changes[key], null);
  assert.equal(changes.finalText, '');
  assert.equal(changes.messages.at(-1).role, 'tool');
  assert.match(changes.messages.at(-1).content, /action_timed_out/);
  assert.equal(result.status, 'uncertain', 'receipt is never rewritten to success');
});

test('legacy policy, model-visible proof, or missing owner proof cannot authorize continued execution', () => {
  const { snapshot, config, intent } = pending();
  const { browserIsolation, ...withoutProof } = result;
  for (const value of [withoutProof, { ...withoutProof, content: proof },
    { ...withoutProof, metadata: { browserIsolation: proof } }]) {
    assert.equal(reduceTools(snapshot, [value], [call], intent, config, digest).reason, 'effect_outcome_unknown');
  }
  const legacy = { ...config, tools: [{ ...browser, recoveryPolicy: undefined }] };
  assert.equal(reduceTools(snapshot, [result], [call], intent, legacy, digest).reason, 'effect_outcome_unknown');
});

test('proof must bind the exact effect, resource owner and closed generation', () => {
  const { snapshot } = pending();
  for (const change of [{ operationKey: 'other' }, { fenced: false }, { externalEffects: true },
    { oldActionsReplayed: true }, { extra: true }, { sessionRef: { ...ref, generation: 2 } },
    { sessionRef: { ...ref, runId: 'other' } }, { sessionRef: { ...ref, scope: { ...scope, userId: 'other' } } }]) {
    assert.throws(() => isolatedBrowserFailure(snapshot, { ...result, browserIsolation: { ...proof, ...change } }, browser, 'effect'),
      { code: 'invalid_browser_isolation' });
  }
});

test('resource recovery cannot reset the shared retry budget or discard the rest of a model tool batch', () => {
  const { snapshot, config, intent } = pending({ limits: { maxRecoveryRetries: 1 } });
  const exhausted = reduceTools({ ...snapshot, recoveryRetriesUsed: 1 }, [result], [call], intent, config, digest);
  assert.equal(exhausted.phase, 'finalizing'); assert.equal(exhausted.reason, 'recovery_retry_exhausted');
  assert.equal(exhausted.recoveryRetriesUsed, 1);
  const next = { ...call, callId: 'next' };
  const continued = reduceTools({ ...snapshot, pendingTools: [call, next] }, [result], [call], intent, config, digest);
  assert.deepEqual(continued.pendingTools, [next]);
});

test('only isolated browser definitions may declare this policy', () => {
  for (const change of [{ observationRole: 'none' }, { readOnly: true }, { concurrentSafe: true },
    { childBudgetPolicy: 'delegate/v1' }, { backgroundCommandPolicy: 'owned-command-launch/v1' },
    { workspaceChangePolicy: 'observed-command/v1' }]) {
    assert.throws(() => fixture({ tools: [{ ...browser, ...change }] }));
  }
});
