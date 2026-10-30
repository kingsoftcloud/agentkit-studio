// TypeScript-vs-Python Native Harness parity test.
//
// Drives the REAL TypeScript NativeKernel / MemoryRunStore (from
// ../packages/agentkit-harness-core/dist/index.mjs) with scripted model/tool/
// verifier ports that match the frozen Python oracle scenarios in
// tests/fixtures/native-reference.json, and asserts the actual TS phase /
// outcome / reason / counts and relevant tool/control effects against the
// frozen normalized outputs.
//
// The frozen Python oracle is authoritative (source commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3). No expected value is hand-written
// here; each assertion is read from the fixture. Where the TS exposes a real
// semantic gap versus Python, the test fails honestly as a regression (see the
// known gaps below) — assertions are NOT lowered, scenarios are NOT skipped,
// and the oracle is NOT edited.
//
// Allowed language/format differences (not asserted byte-identical): event
// names, receipt serialization, field naming (snake_case vs camelCase), the
// verification-report object shape and insignificant serialization whitespace.
// We assert the semantic fields covered by these scenarios: phase, outcome,
// reason, counts (model/tool/descendant), continuations, restarts, repairs,
// provider/model errors, final text, workspace-modified paths, and the
// scenario-specific tool/control effects.
//
// This covers a bounded selection from the oracle, not the full Native feature
// set. Crash recovery here uses deterministic lease takeover; separate core
// process tests cover actual exit and SQLite reopen.
//
// Run:  node --test tests/native-reference-parity.test.mjs
// No Python runtime is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  NativeKernel, MemoryRunStore, configure, initialSnapshot, emptyUsage,
  prepareEffect, plan, commandPriority, canonical,
} from '@kingsoftcloud/agentkit-harness-core';

const fixture = JSON.parse(
  // eslint-disable-next-line no-undef
  (await import('node:fs')).readFileSync(new URL('./fixtures/native-reference.json', import.meta.url), 'utf8'),
);
const scenario = (id) => {
  const s = fixture.scenarios.find((item) => item.id === id);
  assert.ok(s, `missing fixture scenario: ${id}`);
  return s.normalized_output;
};

// --- shared building blocks (mirror the Python exporter's setup) ---
const SCOPE = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const PROFILE = {
  profileId: 'p', profileVersion: '1', providerFamily: 'fix', compatibilityDigest: 'fix/v1',
  maxOutputTokens: 512, contextWindow: 4000, maxRetries: 1, maxProviderRetries: 2,
  maxContinuations: 0, retryInitialDelayMs: 0, retryMaxDelayMs: 0, rateLimitCooldownMs: 0,
};
const ACCEPTANCE = [{
  id: 'exact_answer', required: true, verifierRef: 'fix', verifierVersion: '1',
  verificationMethod: 'deterministic', description: 'exact',
}];
const IDENTITY = { scope: SCOPE, runId: 'run', sessionId: 's', turnId: 't', buildId: 'b', parentRunId: null, taskChainId: 'c' };

function cfg(o = {}) {
  return configure({
    profile: { ...PROFILE, ...(o.profile || {}) },
    contract: {
      objective: o.objective || 'Return JSON',
      acceptance: ACCEPTANCE,
      ...(o.finalSubmissionSchema ? { finalSubmissionSchema: o.finalSubmissionSchema } : {}),
      ...(o.finalSubmissionPayloadKey ? { finalSubmissionPayloadKey: o.finalSubmissionPayloadKey } : {}),
      finalOutputFormat: o.finalOutputFormat ?? 'json_object',
    },
    hostBindingDigest: 'fix-host/v1',
    tools: o.tools || [],
    limits: { maxModelCalls: 4, maxToolCalls: 4, maxRepairs: 1, ...(o.limits || {}) },
  });
}
function startRun(kernel, config) {
  const snapshot = initialSnapshot(IDENTITY, config, digest(config));
  return kernel.start(snapshot, config);
}
const call = (id, name, args = {}) => ({ callId: id, name, arguments: args });
const resp = (kind, o = {}) => ({
  kind, text: kind === 'final_candidate' ? '{"answer": 42}' : '',
  toolCalls: [], usage: emptyUsage(), ...o,
});
const readTool = (o = {}) => ({
  name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 10000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal', ...o,
});
const writeTool = (o = {}) => ({
  name: 'write', description: 'Write', parameters: { type: 'object', additionalProperties: false },
  readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: o.timeoutMs ?? 10000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal', ...o,
});
// Scripted model: returns script[i] for call i+1, repeating the last entry (matches the Python exporter).
function scriptedModel(scripts) {
  let n = 0;
  return { generate: async () => { n += 1; return scripts[Math.min(n - 1, scripts.length - 1)]; }, calls: () => n };
}
function verifyReport(request, { evidenceRefs = ['fixture://verified-result'], checkStatus = 'passed' } = {}) {
  return {
    status: 'passed', reason: 'fixture',
    candidateId: request.candidate.candidateId, contractRevision: request.contract.revision,
    binding: request.candidate.binding, workspaceRevision: request.candidate.workspaceRevision,
    workspaceDependency: 'none', repairable: true, failureFingerprint: 'fixture-fp',
    checks: [{
      id: 'exact_answer', status: checkStatus, verifierId: 'fix', verifierVersion: '1',
      verificationMethod: 'deterministic', evidence: 'fixture result',
      evidenceRefs, safeSummary: 'ok',
    }],
  };
}
async function withTimeout(p, ms) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`drive timeout ${ms}`)), ms); })]); }
  finally { clearTimeout(timer); }
}

// --------------------------------------------------------------------------- //
test('closed_loop_verified: no-tool verified turn matches oracle', async () => {
  const expected = scenario('closed_loop_verified');
  const model = scriptedModel([resp('final_candidate')]);
  let vcalls = 0;
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: { model, verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } } },
  });
  startRun(kernel, cfg());
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(vcalls, expected.verifier_calls);
  assert.equal(result.finalText, expected.final_text);
});

test('closed_loop_with_tool_verified: single read tool then verified matches oracle', async () => {
  const expected = scenario('closed_loop_with_tool_verified');
  const model = scriptedModel([
    resp('tool_calls', { toolCalls: [call('c1', 'read', { path: 'a.txt' })] }),
    resp('final_candidate'),
  ]);
  const executed = [];
  let vcalls = 0;
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: {
      model,
      tools: { execute: async (req) => { executed.push(req.call.arguments); return { status: 'ok', content: { path: req.call.arguments.path } }; } },
      verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } },
    },
  });
  startRun(kernel, cfg({ tools: [readTool()] }));
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(vcalls, expected.verifier_calls);
  assert.deepEqual(executed, expected.tool_executed_args);
});

test('parallel_readonly_batch: two read calls share one parallel effect', async () => {
  const expected = scenario('parallel_readonly_batch');
  const model = scriptedModel([
    resp('tool_calls', { toolCalls: [call('c1', 'read', { path: 'a' }), call('c2', 'read', { path: 'b' })] }),
    resp('final_candidate'),
  ]);
  const executed = [];
  const store = new MemoryRunStore();
  let vcalls = 0;
  const kernel = new NativeKernel({
    store, owner: 'w', digest,
    ports: {
      model,
      tools: { execute: async (req) => { executed.push(req.call.arguments.path); return { status: 'ok', content: { path: req.call.arguments.path } }; } },
      verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } },
    },
  });
  startRun(kernel, cfg({ tools: [readTool()] }));
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.deepEqual(executed, expected.tool_executed_paths);
  // exactly one tool effect intent carried both calls (parallel batch)
  const toolIntents = store.load(SCOPE, 'run').intents.filter((i) => i.kind === 'tool');
  assert.equal(toolIntents.length, expected.tool_effect_count);
  assert.equal(toolIntents[0].payload.calls.length, expected.calls_in_parallel_batch);
});

test('serial_write_workspace_paths: non-readonly writer is serial and records paths', async () => {
  const expected = scenario('serial_write_workspace_paths');
  const model = scriptedModel([
    resp('tool_calls', { toolCalls: [call('c1', 'write')] }),
    resp('final_candidate'),
  ]);
  const store = new MemoryRunStore();
  let vcalls = 0;
  const kernel = new NativeKernel({
    store, owner: 'w', digest,
    ports: {
      model,
      tools: { execute: async () => ({ status: 'ok', content: { done: true }, workspaceChangedPaths: ['out.txt'] }) },
      verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } },
    },
  });
  startRun(kernel, cfg({ tools: [writeTool()] }));
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.deepEqual(result.workspaceModifiedPaths, expected.workspace_modified_paths);
  // a non-readonly writer is never admitted into a parallel batch
  const toolIntents = store.load(SCOPE, 'run').intents.filter((i) => i.kind === 'tool');
  assert.equal(toolIntents.length, expected.prepared_tool_effect_count);
  assert.equal(toolIntents[0].payload.calls.length, 1);
});

test('cancel_priority_over_inflight_tool: cancel wins and counts the aborted attempt', async () => {
  const expected = scenario('cancel_priority_over_inflight_tool');
  let cancelled = 0, entered;
  const ready = new Promise((r) => { entered = r; });
  const model = scriptedModel([resp('tool_calls', { toolCalls: [call('c1', 'write')] })]);
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: {
      model,
      tools: {
        execute: async (req) => {
          entered();
          req.signal.addEventListener('abort', () => { cancelled += 1; }, { once: true });
          return new Promise(() => {});
        },
      },
    },
  });
  startRun(kernel, cfg({ tools: [writeTool()] }));
  const drive = kernel.runUntilIdle(SCOPE, 'run');
  await ready;
  const receipt = kernel.submit(SCOPE, 'run', { commandId: 'cancel-1', kind: 'cancel', payload: {} });
  const result = await withTimeout(drive, 5000);
  assert.equal(receipt.status, expected.command_receipt_status);
  assert.equal(cancelled, expected.tool_cancelled);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  // An aborted claimed attempt still consumes the tool allowance.
  assert.equal(result.usage.toolCalls, expected.tool_calls);
});

test('pause_resume: pause then resume completes verified', async () => {
  const expected = scenario('pause_resume');
  const model = scriptedModel([resp('final_candidate')]);
  let vcalls = 0;
  const store = new MemoryRunStore(), config = cfg();
  const kernel = new NativeKernel({
    store, owner: 'w', digest,
    ports: { model, verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } } },
  });
  let before = startRun(kernel, config);
  const lease = store.acquire(SCOPE, 'run', 'preparer', 0, 30000);
  for (let step = 0; step < 2; step++) before = store.commit(SCOPE, 'run', lease, 0, before.revision,
    plan(before, config, { workspace: false, context: false, verification: true }));
  store.release(SCOPE, 'run', lease);
  assert.equal(before.phase, expected.phase_before_pause);
  assert.equal(store.load(SCOPE, 'run').intents.at(-1).status, 'prepared');
  const pause = kernel.submit(SCOPE, 'run', { commandId: 'pause-1', kind: 'pause', payload: {} });
  assert.equal(pause.status, expected.pause_receipt_status);
  const paused = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(paused.phase, expected.paused_phase);
  assert.equal(paused.resumePhase, expected.paused_from);
  const resume = kernel.submit(SCOPE, 'run', { commandId: 'resume-1', kind: 'resume', payload: {} });
  assert.equal(resume.status, expected.resume_receipt_status);
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(vcalls, expected.verifier_calls);
});

test('approval_match_allow: matching submit_interaction re-dispatches with interaction', async () => {
  const expected = scenario('approval_match_allow');
  const model = scriptedModel([
    resp('tool_calls', { toolCalls: [call('w1', 'write')] }),
    resp('final_candidate'),
  ]);
  const decisions = [];
  let vcalls = 0;
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: {
      model,
      tools: {
        execute: async (req) => {
          if (!req.interaction) return { status: 'approval_required', content: {}, interactionId: 'host-1' };
          decisions.push(req.interaction.decision);
          return { status: 'ok', content: { done: true }, workspaceChangedPaths: ['out.txt'] };
        },
      },
      verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } },
    },
  });
  startRun(kernel, cfg({ tools: [writeTool()] }));
  const pending = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(pending.phase, expected.awaiting_phase);
  const bad = kernel.submit(SCOPE, 'run', { commandId: 'bad', kind: 'submit_interaction', payload: { interactionId: 'wrong', decision: 'allow' } });
  assert.equal(bad.status, expected.bad_receipt_status);
  const good = kernel.submit(SCOPE, 'run', { commandId: 'good', kind: 'submit_interaction', payload: { interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
  assert.equal(good.status, expected.good_receipt_status);
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(vcalls, expected.verifier_calls);
  assert.deepEqual(decisions, expected.interaction_decisions);
  assert.deepEqual(result.workspaceModifiedPaths, expected.workspace_modified_paths);
});

test('lost_effect_not_rerun: lost tool effect is not re-executed and run interrupts', async () => {
  const expected = scenario('lost_effect_not_rerun');
  let execs = 0, entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const store = new MemoryRunStore();
  const model = scriptedModel([resp('tool_calls', { toolCalls: [call('w1', 'write')] })]);
  const kernel = new NativeKernel({
    store, owner: 'w', digest, now: () => 0,
    ports: {
      model,
      tools: { execute: async () => { execs += 1; entered(); await new Promise(resolve => { release = resolve; }); return { status: 'ok', content: {} }; } },
    },
  });
  startRun(kernel, cfg({ tools: [writeTool()] }));
  const drive = kernel.runUntilIdle(SCOPE, 'run');
  // Observe a claimed intent with no result, then advance the replacement's
  // lease clock past the original expiry. No timeout result is manufactured.
  await ready;
  const crashed = store.load(SCOPE, 'run');
  assert.equal(crashed.intents.find(intent => intent.operationKey === crashed.snapshot.pendingIntent).status, expected.crashed_intent_status);
  assert.equal(crashed.receipts.some(receipt => receipt.operationKey === crashed.snapshot.pendingIntent), false);
  let execsB = 0;
  const kernelB = new NativeKernel({
    store, owner: 'w2', digest, now: () => 40000,
    ports: { model: scriptedModel([resp('final_candidate')]), tools: { execute: async () => { execsB += 1; return { status: 'ok', content: {} }; } } },
  });
  let result;
  try { result = await withTimeout(kernelB.runUntilIdle(SCOPE, 'run'), 5000); }
  finally { release(); await assert.rejects(drive, { code: 'stale_fence' }); }
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(execs, expected.tool_a_calls);
  assert.equal(execsB, expected.tool_b_calls);
});

test('model_budget_exhausted_not_success: model budget exhaustion is a failure', async () => {
  const expected = scenario('model_budget_exhausted_not_success');
  const model = scriptedModel([resp('tool_calls', { toolCalls: [call('c1', 'read', { path: 'a' })] })]);
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: { model, tools: { execute: async () => ({ status: 'ok', content: {} }) } },
  });
  // maxModelCalls=1 and no finalization reserve: the single task call returns
  // tool_calls, the read tool executes, and the next preparing_context hits the
  // model budget (matching the Python exporter's finalization_reserve=0 setup).
  startRun(kernel, cfg({
    tools: [readTool()],
    limits: { maxModelCalls: 1, maxToolCalls: 4, maxRepairs: 1, finalizationReserveModelCalls: 0 },
  }));
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
});

test('malformed_tool_call_retry_exhausted: malformed budget is separate', async () => {
  const expected = scenario('malformed_tool_call_retry_exhausted');
  const model = scriptedModel([
    resp('malformed_tool_call'), resp('malformed_tool_call'),
  ]);
  const kernel = new NativeKernel({ store: new MemoryRunStore(), owner: 'w', digest, ports: { model } });
  startRun(kernel, cfg());
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.modelErrors, expected.model_errors);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
});

test('provider_retry_budget_exhausted: provider retry budget is separate', async () => {
  const expected = scenario('provider_retry_budget_exhausted');
  const model = scriptedModel([
    resp('provider_retryable_error', { failureKind: 'rate_limit' }),
    resp('provider_retryable_error', { failureKind: 'rate_limit' }),
    resp('provider_retryable_error', { failureKind: 'rate_limit' }),
  ]);
  const kernel = new NativeKernel({ store: new MemoryRunStore(), owner: 'w', digest, ports: { model } });
  startRun(kernel, cfg());
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.providerErrors, expected.provider_errors);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
});

test('output_limit_tools_not_executed: truncated output does not execute tools', async () => {
  const expected = scenario('output_limit_tools_not_executed');
  let tools = 0;
  const model = scriptedModel([
    resp('output_limit', { text: 'partial answer with no closing' }),
    resp('output_limit', { text: 'partial answer with no closing' }),
  ]);
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: { model, tools: { execute: async () => { tools += 1; return { status: 'ok', content: {} }; } } },
  });
  // Two attempts: maxContinuations=1 lets one continuation, then the second
  // output_limit exhausts the continuation budget (matches the Python exporter).
  startRun(kernel, cfg({ profile: { maxContinuations: 1 }, tools: [readTool()] }));
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.continuations, expected.continuations);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(tools, 0, 'truncated output must not execute tools');
  const continuationKinds = result.messages.filter((m) => m.kind).map((m) => m.kind)
    .filter((k) => k === 'continuation_fragment' || k === 'continuation_observation');
  assert.deepEqual(continuationKinds, expected.continuation_message_kinds);
});

test('no_verifier_unverified: absent verifier never yields verified', async () => {
  const expected = scenario('no_verifier_unverified');
  const model = scriptedModel([resp('final_candidate')]);
  const kernel = new NativeKernel({ store: new MemoryRunStore(), owner: 'w', digest, ports: { model } });
  startRun(kernel, cfg());
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.notEqual(result.outcome, 'verified');
  assert.equal(result.reason, expected.reason);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.finalText, expected.final_text);
});

test('verifier_no_evidence_unverified: passed without evidence is not verified', async () => {
  const expected = scenario('verifier_no_evidence_unverified');
  const model = scriptedModel([resp('final_candidate')]);
  let vcalls = 0;
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: { model, verification: { verify: async (req) => { vcalls += 1; return verifyReport(req, { evidenceRefs: [] }); } } },
  });
  startRun(kernel, cfg());
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.notEqual(result.outcome, 'verified');
  assert.equal(result.reason, expected.reason);
  assert.equal(vcalls, expected.verifier_calls);
  assert.equal(result.usage.modelCalls, expected.model_calls);
});

test('final_submission_schema_tool: submit_final_output seals a candidate directly', async () => {
  const expected = scenario('final_submission_schema_tool');
  let vcalls = 0;
  const model = scriptedModel([
    resp('tool_calls', { toolCalls: [call('s1', 'submit_final_output', { answer: { value: 42 } })] }),
  ]);
  const kernel = new NativeKernel({
    store: new MemoryRunStore(), owner: 'w', digest,
    ports: {
      model,
      verification: { verify: async (req) => { vcalls += 1; return verifyReport(req); } },
    },
  });
  // Python used final_output_format='json_object' + final_submission_payload_key='answer';
  // the TS equivalent is contract.finalOutputFormat='json_object'. The model
  // returns a single submit_final_output call whose 'answer' payload is sealed
  // as the candidate (finalText='{"value":42}', no tool dispatch).
  startRun(kernel, cfg({
    objective: 'Submit',
    tools: [],
    limits: { maxModelCalls: 4, maxToolCalls: 0, maxRepairs: 1 },
    finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'object' } }, required: ['answer'] },
    finalSubmissionPayloadKey: 'answer',
    finalOutputFormat: 'json_object',
  }));
  const result = await withTimeout(kernel.runUntilIdle(SCOPE, 'run'), 5000);
  assert.equal(result.phase, expected.phase);
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.reason, expected.reason);
  assert.equal(result.finalText, expected.final_text);
  assert.equal(result.usage.modelCalls, expected.model_calls);
  assert.equal(result.usage.toolCalls, expected.tool_calls);
  assert.equal(vcalls, expected.verifier_calls);
});

// --- pure contract / store comparisons (no kernel loop) ---
test('command_priority_ordering: matches the locked contract', () => {
  const expected = scenario('command_priority_ordering');
  // Node adds explicit receipt-inspection and workspace-repair commands; every original command
  // retains the exact reference priority and ordering.
  const { reconcile_tool: inspectionPriority, repair_workspace: repairPriority, ...sharedPriority } = commandPriority;
  assert.equal(inspectionPriority, 75);
  assert.equal(repairPriority, 75);
  assert.deepEqual(sharedPriority, expected.priorities);
  assert.deepEqual(
    Object.keys(sharedPriority).sort((a, b) => sharedPriority[b] - sharedPriority[a]),
    expected.sorted_desc,
  );
});

test('store_command_dedup: enqueue dedups by command_id+payload', () => {
  const expected = scenario('store_command_dedup');
  const store = new MemoryRunStore();
  const config = cfg();
  const kernel = new NativeKernel({ store, owner: 'w', digest, ports: { model: scriptedModel([resp('final_candidate')]) } });
  startRun(kernel, config);
  const pause = { commandId: 'cmd-1', kind: 'pause', payload: {} };
  const first = store.enqueue(SCOPE, 'run', pause);
  const second = store.enqueue(SCOPE, 'run', pause);
  const cancel = { commandId: 'cmd-2', kind: 'cancel', payload: {} };
  const third = store.enqueue(SCOPE, 'run', cancel);
  const pending = store.load(SCOPE, 'run').commands.filter((row) => !row.consumed).map((row) => row.command.kind)
    .sort((a, b) => commandPriority[b] - commandPriority[a]);
  assert.equal(first.status, expected.first_receipt_status);
  assert.equal(second.status, expected.second_receipt_status);
  assert.equal(third.status, expected.third_receipt_status);
  assert.deepEqual(pending, expected.pending_command_kinds);
});

test('store_commit_idempotent: replaying a commit returns the archived snapshot', () => {
  const expected = scenario('store_commit_idempotent');
  const store = new MemoryRunStore();
  const config = cfg();
  const snapshot = initialSnapshot(IDENTITY, config, digest(config));
  store.create(config, snapshot);
  const lease = store.acquire(SCOPE, 'run', 'w', 0, 30000);
  const batch = prepareEffect(snapshot, 'workspace', 'preparing_context', { cursor: '0:0:0:', purpose: 'workspace' });
  const first = store.commit(SCOPE, 'run', lease, 0, 0, batch);
  const again = store.commit(SCOPE, 'run', lease, 0, 0, batch);
  assert.equal(first.phase, expected.first_phase);
  assert.equal(again.phase, expected.again_phase);
  assert.equal(first.revision, expected.first_revision);
  assert.equal(again.revision, expected.again_revision);
  assert.equal(store.events(SCOPE, 'run').length, expected.event_count);
});
