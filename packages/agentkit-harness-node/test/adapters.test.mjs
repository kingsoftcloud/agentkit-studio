// Package-local focused tests for @kingsoftcloud/agentkit-harness-node.
//
// These tests exercise the ACTUAL bundled dist (dist/index.mjs) against the
// ACTUAL core kernel — no mocked core, no standalone reimplementation. They
// resolve @kingsoftcloud/agentkit-harness-core by linking the local core
// package into this package's node_modules for the duration of the test run
// (the repo has no workspace install for the @kingsoftcloud scope), then
// dynamically import the dist. The full packed-installation path is exercised
// by scripts/verify-native-standalone.mjs; these tests cover the public
// adapter surface directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = resolve(here, '..');
const coreDir = resolve(pkgDir, '../agentkit-harness-core');

// Link the local core into this package's node_modules so the dist's external
// @kingsoftcloud/agentkit-harness-core import resolves to the real core dist.
// Self-healing: a stale or broken link from a prior run is replaced.
const scopeDir = resolve(pkgDir, 'node_modules/@kingsoftcloud');
const coreLink = resolve(scopeDir, 'agentkit-harness-core');
mkdirSync(scopeDir, { recursive: true });
let linkOk = false;
try { linkOk = realpathSync(coreLink) === coreDir; } catch {}
if (!linkOk) {
  rmSync(coreLink, { force: true });
  symlinkSync(coreDir, coreLink, 'dir');
}
const dist = await import('../dist/index.mjs');
const { SqliteRunStore, createNativeModelPort, nativeModelRecoveryPolicy } = dist;
const core = await import('@kingsoftcloud/agentkit-harness-core');
const { NativeKernel, configure, initialSnapshot, canonical, emptyUsage } = core;

const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };

function fixture(overrides = {}) {
  const config = configure({
    profile: { profileId: 'fake', profileVersion: '1', providerFamily: 'fake', compatibilityDigest: 'fake/v1',
      maxOutputTokens: 256, requestTimeoutMs: 10000, maxRetries: 0, maxProviderRetries: 0, streaming: false },
    contract: { objective: 'Test the node adapters', acceptance: [{ id: 'complete', required: true,
      verifierRef: 'standalone', verifierVersion: '1', verificationMethod: 'deterministic', description: 'done' }] },
    tools: [], limits: { effectTimeoutMs: 15000, leaseMs: 8000, maxRecoveryRetries: 0 }, hostBindingDigest: 'node-test/v1',
    modelRecoveryPolicy: nativeModelRecoveryPolicy({ protocol: 'openai-chat', parameters: {} }),
    ...overrides,
  });
  const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c' }, config, sha(config));
  return { config, snapshot };
}

function jsonResponse(bodyText) {
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(bodyText)); controller.close(); } }),
  };
}

// ---- SqliteRunStore: real durable ledger round-trip ------------------------
test('SqliteRunStore persists a run, events and receipts across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-node-sqlite-'));
  const db = join(dir, 'run.sqlite');
  let store = new SqliteRunStore(db);
  try {
    const { config, snapshot } = fixture();
    const kernel = new NativeKernel({ store, owner: 'tester', digest: sha,
      ports: {
        model: { generate: async () => ({ kind: 'final_candidate', text: 'done', toolCalls: [], usage: emptyUsage() }) },
        verification: { verify: async request => ({ status: 'passed', reason: 'ok', candidateId: request.candidate.candidateId,
          contractRevision: request.contract.revision, binding: request.candidate.binding,
          workspaceRevision: request.candidate.workspaceRevision, workspaceDependency: 'none',
          checks: [{ id: 'complete', status: 'passed', verifierId: 'standalone', verifierVersion: '1',
            verificationMethod: 'deterministic', evidence: 'ok', evidenceRefs: ['standalone://ok'] }] }) } } });
    kernel.start(snapshot, config);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed');
    const before = store.load(scope, 'run');
    assert.ok(before.events.length > 0);
    assert.ok(before.receipts.length > 0);
  } finally { store.close(); }
  // Reopen the same file: the ledger is durable.
  store = new SqliteRunStore(db);
  try {
    const record = store.load(scope, 'run');
    assert.ok(record.events.length > 0, 'events must persist across reopen');
    assert.ok(record.receipts.length > 0, 'receipts must persist across reopen');
    assert.equal(record.snapshot.phase, 'completed');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- createNativeModelPort: one HTTP request, sealed result, no retries ----
test('createNativeModelPort issues one request and seals a final candidate (no network)', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(init.method, 'POST');
    assert.ok(init.headers.Authorization, 'apiKey must travel only in headers');
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}');
  };
  const port = createNativeModelPort({
    resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: 'https://example.test/v1', apiKey: 'secret-key', model: 'm', parameters: {} }),
    fetchImpl,
  });
  const result = await port.generate({
    profile: { profileId: 'p', profileVersion: '1', providerFamily: 'openai-chat', compatibilityDigest: 'd/v1',
      maxOutputTokens: 64, contextWindow: 1000, maxRetries: 0, maxProviderRetries: 0, maxContinuations: 0,
      requestTimeoutMs: 5000, retryInitialDelayMs: 0, retryMaxDelayMs: 0, retryBackoffMultiplier: 1, rateLimitCooldownMs: 0,
      providerReplayMode: 'none', streaming: false },
    messages: [{ role: 'user', content: 'hi' }], tools: [], finalizationOnly: false, maxInlineImageBytes: 0,
    scope, runId: 'run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c',
    operationKey: 'op', signal: new AbortController().signal,
  }, () => {});
  assert.equal(calls, 1, 'exactly one HTTP request per attempt');
  assert.equal(result.kind, 'final_candidate');
  assert.equal(result.text, 'hello');
  assert.doesNotMatch(JSON.stringify(result), /secret-key/, 'apiKey must not leak into the result');
});

test('createNativeModelPort classifies a 429 as retryable rate_limit without reading the body', async () => {
  let bodyRead = false;
  const fetchImpl = async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }),
    body: { async cancel() {},
      getReader() { bodyRead = true; throw new Error('429 body must not be consumed'); } } });
  const port = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', baseUrl: 'https://x.test', apiKey: 'k', model: 'm' }), fetchImpl });
  const result = await port.generate({ profile: { profileId: 'p', profileVersion: '1', providerFamily: 'openai-chat', compatibilityDigest: 'd', maxOutputTokens: 8, contextWindow: 1000, maxRetries: 0, maxProviderRetries: 0, maxContinuations: 0, requestTimeoutMs: 5000, retryInitialDelayMs: 0, retryMaxDelayMs: 0, retryBackoffMultiplier: 1, rateLimitCooldownMs: 0, providerReplayMode: 'none', streaming: false }, messages: [], tools: [], finalizationOnly: false, maxInlineImageBytes: 0, scope, runId: 'r', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c', operationKey: 'o', signal: new AbortController().signal }, () => {});
  assert.equal(result.kind, 'provider_retryable_error');
  assert.equal(result.failureKind, 'rate_limit');
  assert.equal(result.retryAfterMs, 2000);
  assert.equal(bodyRead, false, 'a 429 must not read the response body');
});

// ---- nativeModelRecoveryPolicy ---------------------------------------------
test('nativeModelRecoveryPolicy admits only plain inference', () => {
  assert.equal(nativeModelRecoveryPolicy({ protocol: 'openai-chat', parameters: {} }), 'pure-inference/v1');
  assert.equal(nativeModelRecoveryPolicy({ protocol: 'openai-responses', parameters: {} }), 'pure-inference/v1');
  assert.equal(nativeModelRecoveryPolicy({ protocol: 'anthropic-messages', parameters: {} }), 'pure-inference/v1');
  assert.equal(nativeModelRecoveryPolicy({ protocol: 'openai-chat', parameters: { temperature: 0 } }), 'manual');
  assert.equal(nativeModelRecoveryPolicy({ protocol: 'custom', parameters: {} }), 'manual');
  assert.equal(nativeModelRecoveryPolicy(), 'manual');
});
