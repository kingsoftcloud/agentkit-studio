import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeContext } from '../src/providers/native-context.mjs';
const description = { protocol: 'openai-chat', modelName: 'fixture', parameters: {}, contextWindow: 128000, maxOutputTokens: 8192 };

test('new admissions pin pre-model budgeting without changing model capacity or restored policy defaults', () => {
  const legacy = bindNativeContext({ description });
  const current = bindNativeContext({ description, preModelBudgetDefaults: true });
  assert.equal(Object.hasOwn(legacy.policy, 'budgetTiming'), false);
  assert.equal(current.policy.budgetTiming, 'before-model/v1');
  assert.deepEqual(current.profile, legacy.profile);
  assert.equal(current.policy.tokenizerDigest, legacy.policy.tokenizerDigest);
  assert.equal(current.policy.triggerRatio, legacy.policy.triggerRatio);
  assert.equal(bindNativeContext({ description, preModelBudgetDefaults: false }).policy.budgetTiming, undefined);
});

test('ordered chat context is admitted explicitly and never activates on legacy or other protocol profiles', () => {
  const current = bindNativeContext({ description, orderedContextDefaults: true });
  const legacy = bindNativeContext({ description });
  assert.equal(current.policy.continuityPlacement, 'after-history/v1');
  assert.equal(legacy.policy.continuityPlacement, undefined);
  assert.deepEqual(current.profile, legacy.profile);
  assert.equal(current.policy.triggerRatio, legacy.policy.triggerRatio);
  assert.equal(current.policy.targetRatio, legacy.policy.targetRatio);
  for (const protocol of ['anthropic-messages', 'openai-responses'])
    assert.equal(bindNativeContext({ description: { ...description, protocol }, orderedContextDefaults: true }).policy.continuityPlacement, undefined);
});

test('source reuse is explicitly versioned for new chat admissions without changing pruning or thresholds', () => {
  const legacy=bindNativeContext({description}),current=bindNativeContext({description,sourceReuseDefaults:true});
  assert.equal(legacy.policy.sourceReusePolicy,undefined);assert.equal(current.policy.sourceReusePolicy,'captured-source/v1');
  assert.equal(current.policy.pruneToolResults,undefined);assert.equal(current.policy.triggerRatio,legacy.policy.triggerRatio);
  for(const protocol of ['anthropic-messages','openai-responses'])
    assert.equal(bindNativeContext({description:{...description,protocol},sourceReuseDefaults:true}).policy.sourceReusePolicy,undefined);
});
