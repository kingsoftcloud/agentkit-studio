import test from 'node:test';
import assert from 'node:assert/strict';
import { admitModelCapabilities, resolveModelBudgets } from '../src/model-capabilities.mjs';

// Saving a model used to throw invalid_model_capabilities whenever the typed
// output budget reached the context window. Budgets are now clamped instead.

test('an output budget that reaches the context window is clamped, not rejected', () => {
  for (const profile of [
    { maxOutputTokens: 200000 },                                  // default window 128000
    { contextWindow: 8192, maxOutputTokens: 8192 },               // output == window
    { contextWindow: 64000, maxOutputTokens: 65536 },             // output > window
  ]) {
    const result = admitModelCapabilities(profile);
    assert.ok(result.maxOutputTokens < result.contextWindow, JSON.stringify(profile));
    assert.ok(result.maxOutputTokens > 0);
  }
});

test('a catalog that advertises output == context (Kimi) still validates', () => {
  const result = admitModelCapabilities({}, { context_length: 262144, max_output_tokens: 262144 });
  assert.equal(result.contextWindow, 262144);
  assert.ok(result.maxOutputTokens < result.contextWindow);
  const larger = admitModelCapabilities({}, { context_length: 1048576, max_output_tokens: 1048576 });
  assert.equal(larger.contextWindow, 1048576);
  assert.ok(larger.maxOutputTokens < larger.contextWindow);
});

test('a smaller advertised window pulls the output budget down with it', () => {
  const result = admitModelCapabilities({ maxOutputTokens: 8192 }, { context_length: 4096 });
  assert.equal(result.contextWindow, 4096);
  assert.equal(result.maxOutputTokens, 2048);
});

test('resolveModelBudgets reports whether clamping happened and keeps the default intact', () => {
  assert.equal(resolveModelBudgets({ maxOutputTokens: 200000 }, null).adjusted, true);
  assert.equal(resolveModelBudgets({ maxOutputTokens: 8192, contextWindow: 128000 }, null).adjusted, false);
  const fallback = admitModelCapabilities({});
  assert.equal(fallback.contextWindow, 128000);
  assert.equal(fallback.maxOutputTokens, 8192);
});
