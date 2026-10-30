// Validates the Native Harness reference oracle fixture.
//
// This test does NOT depend on Python. It loads the frozen fixture produced
// by .artifacts/oracle/export_native_reference.py and checks:
//   1. document structure (schema, source, scenario count);
//   2. the normalization protocol (only deterministic semantic fields, no
//      volatile identity / timestamps / digests leaked);
//   3. per-scenario behavioral invariants that encode the oracle contract the
//      TS port must match.
//
// Run:  node --test tests/native-reference-fixtures.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'native-reference.json');
const raw = readFileSync(fixturePath, 'utf8');
const doc = JSON.parse(raw);

const SOURCE_COMMIT = '355059d78e47ed764bbdb3606304cdf34e9838a3';
const SCHEMA = 'native-reference-oracle/v1';

// Fields that may legitimately appear in a normalized_output.
const ALLOWED_OUTPUT_KEYS = new Set([
  // snapshot semantics
  'phase', 'outcome', 'reason', 'model_calls', 'tool_calls',
  'descendant_model_calls', 'descendant_tool_calls', 'continuations',
  'output_restarts', 'repair_attempts', 'provider_errors', 'model_errors',
  'final_text', 'workspace_changed_paths', 'workspace_modified_paths',
  'artifact_ref_count', 'child_run_id_count', 'background_command_count',
  'verification', 'pending_intent_present', 'phase_paused_from',
  // scenario-specific extras
  'verifier_calls', 'event_kinds', 'tool_executed_args', 'tool_executed_paths',
  'parallel_effect_prepared', 'calls_in_parallel_batch', 'tool_effect_count',
  'prepared_tool_effect_count', 'parallel_readonly_flags',
  'command_receipt_status', 'tool_cancelled',
  'pause_receipt_status', 'resume_receipt_status', 'phase_before_pause',
  'paused_phase', 'paused_from',
  'awaiting_phase', 'bad_receipt_status', 'good_receipt_status',
  'interaction_decisions',
  'crashed_intent_status', 'tool_a_calls', 'tool_b_calls',
  'continuation_message_kinds',
  'first_receipt_status', 'second_receipt_status', 'third_receipt_status',
  'pending_command_kinds',
  'first_phase', 'again_phase', 'first_revision', 'again_revision', 'event_count',
  'priorities', 'sorted_desc',
  // normalize_response classification case keys
  'final_candidate', 'tool_calls', 'malformed_duplicate_call_id', 'output_limit',
  'context_overflow', 'provider_retryable_error', 'empty_response',
  'user_abort', 'policy_abort',
  // retry_delay pure outputs
  'non_retryable_delay', 'rate_limit_with_cooldown', 'explicit_server_wait_preserved',
]);

// Fields that must NEVER leak (volatile identity / timing / digests).
const FORBIDDEN_KEYS = new Set([
  'run_id', 'turn_id', 'request_id', 'attempt_id', 'operation_key',
  'event_id', 'event_seq', 'retry_not_before', 'execution_elapsed_seconds',
  'profile_digest', 'contract_digest', 'configuration_digest', 'candidate_id',
  'scope', 'fencing_token', 'commit_id',
]);

const scenarios = new Map(doc.scenarios.map((s) => [s.id, s]));

function out(id) {
  assert.ok(scenarios.has(id), `missing scenario: ${id}`);
  return scenarios.get(id).normalized_output;
}

test('document structure and source', () => {
  assert.equal(doc.schema, SCHEMA);
  assert.equal(doc.source.repo, 'ksadk-python');
  assert.equal(doc.source.branch, 'feat-ksadk-harness-2');
  assert.equal(doc.source.commit, SOURCE_COMMIT);
  assert.equal(doc.source.engine, 'ksadk.harness.native.engine.NativeKernel');
  assert.equal(doc.source.store, 'ksadk.harness.stores.native_memory.MemoryRunStore');
  assert.ok(doc.normalization && Array.isArray(doc.normalization.kept) && Array.isArray(doc.normalization.stripped));
  assert.ok(doc.scenario_count >= 12, `expected >=12 scenarios, got ${doc.scenario_count}`);
  assert.equal(doc.scenario_count, doc.scenarios.length);
});

test('every scenario has the required envelope and source evidence', () => {
  for (const s of doc.scenarios) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0, `bad id: ${JSON.stringify(s.id)}`);
    assert.ok(typeof s.description === 'string' && s.description.length > 0);
    assert.ok(s.source && typeof s.source === 'object');
    assert.equal(s.source.commit, SOURCE_COMMIT);
    assert.ok(typeof s.source.module === 'string' && s.source.module.length > 0, `${s.id} missing module`);
    assert.ok(s.input && typeof s.input === 'object', `${s.id} missing input`);
    assert.ok(s.normalized_output && typeof s.normalized_output === 'object', `${s.id} missing normalized_output`);
  }
});

test('normalization protocol: no volatile identity/timing/digest leaks', () => {
  for (const s of doc.scenarios) {
    const keys = Object.keys(s.normalized_output);
    for (const k of keys) {
      assert.ok(ALLOWED_OUTPUT_KEYS.has(k),
        `${s.id}: unexpected output key "${k}" not in allowlist (update the allowlist if intentional)`);
    }
    for (const bad of FORBIDDEN_KEYS) {
      assert.ok(!(bad in s.normalized_output), `${s.id}: forbidden volatile key "${bad}" leaked`);
    }
    // event_kinds, when present, is an ordered list of stable strings
    if ('event_kinds' in s.normalized_output) {
      const ek = s.normalized_output.event_kinds;
      assert.ok(Array.isArray(ek) && ek.every((e) => typeof e === 'string'));
    }
  }
});

test('closed_loop_verified: no-tool verified turn', () => {
  const o = out('closed_loop_verified');
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'verified');
  assert.equal(o.reason, 'required_acceptance_verified');
  assert.equal(o.model_calls, 1);
  assert.equal(o.tool_calls, 0);
  assert.equal(o.verifier_calls, 1);
  assert.deepEqual(o.event_kinds.slice(-1), ['run.completed']);
});

test('closed_loop_with_tool_verified: single read tool then verified', () => {
  const o = out('closed_loop_with_tool_verified');
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'verified');
  assert.equal(o.model_calls, 2);
  assert.equal(o.tool_calls, 1);
  assert.deepEqual(o.tool_executed_args, [{ path: 'a.txt' }]);
});

test('parallel_readonly_batch: two read calls share one parallel effect', () => {
  const o = out('parallel_readonly_batch');
  assert.equal(o.parallel_effect_prepared, true);
  assert.equal(o.calls_in_parallel_batch, 2);
  assert.equal(o.tool_effect_count, 1);
  assert.deepEqual(o.tool_executed_paths, ['a', 'b']);
  assert.equal(o.tool_calls, 2);
  assert.equal(o.outcome, 'verified');
});

test('serial_write_workspace_paths: non-readonly writer is serial', () => {
  const o = out('serial_write_workspace_paths');
  assert.equal(o.prepared_tool_effect_count, 1);
  assert.deepEqual(o.parallel_readonly_flags, [null]);
  assert.deepEqual(o.workspace_modified_paths, ['out.txt']);
  assert.equal(o.tool_calls, 1);
  assert.equal(o.outcome, 'verified');
});

test('cancel_priority_over_inflight_tool: cancel wins and cancels the in-flight tool', () => {
  const o = out('cancel_priority_over_inflight_tool');
  assert.equal(o.command_receipt_status, 'accepted');
  assert.equal(o.tool_cancelled, 1);
  assert.equal(o.phase, 'canceled');
  assert.equal(o.outcome, 'unverified');
  assert.equal(o.reason, 'user_canceled');
  assert.ok(o.event_kinds.includes('tools.interrupted'));
  assert.ok(o.event_kinds.includes('run.canceled'));
});

test('pause_resume: pause then resume completes', () => {
  const o = out('pause_resume');
  assert.equal(o.pause_receipt_status, 'accepted');
  assert.equal(o.resume_receipt_status, 'accepted');
  assert.equal(o.phase_before_pause, 'requesting_model');
  assert.equal(o.paused_phase, 'paused');
  assert.equal(o.paused_from, 'requesting_model');
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'verified');
});

test('approval_match_allow: matching submit_interaction re-dispatches with interaction', () => {
  const o = out('approval_match_allow');
  assert.equal(o.awaiting_phase, 'awaiting_interaction');
  // enqueue always accepts; mismatch is rejected at consume time, not enqueue
  assert.equal(o.bad_receipt_status, 'accepted');
  assert.equal(o.good_receipt_status, 'accepted');
  assert.deepEqual(o.interaction_decisions, ['allow']);
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'verified');
  assert.equal(o.tool_calls, 1);
  assert.equal(o.verifier_calls, 1);
});

test('lost_effect_not_rerun: reattach does not re-execute the lost tool', () => {
  const o = out('lost_effect_not_rerun');
  assert.equal(o.crashed_intent_status, 'running');
  assert.equal(o.tool_a_calls, 1);
  assert.equal(o.tool_b_calls, 0);
  assert.equal(o.phase, 'interrupted');
  assert.equal(o.outcome, 'unverified');
  assert.equal(o.reason, 'effect_outcome_unknown');
  assert.ok(o.event_kinds.includes('run.interrupted'));
});

test('model_budget_exhausted_not_success: budget exhaustion is a failure', () => {
  const o = out('model_budget_exhausted_not_success');
  assert.equal(o.phase, 'failed');
  assert.equal(o.outcome, 'budget_exhausted');
  assert.equal(o.reason, 'model_budget_exhausted');
  assert.notEqual(o.outcome, 'verified');
  assert.notEqual(o.phase, 'completed');
});

test('malformed_tool_call_retry_exhausted: malformed budget is separate', () => {
  const o = out('malformed_tool_call_retry_exhausted');
  assert.equal(o.phase, 'failed');
  assert.equal(o.outcome, 'failed');
  assert.equal(o.reason, 'malformed_tool_call_retry_exhausted');
});

test('provider_retry_budget_exhausted: provider retry budget is separate', () => {
  const o = out('provider_retry_budget_exhausted');
  assert.equal(o.phase, 'failed');
  assert.equal(o.outcome, 'failed');
  assert.equal(o.reason, 'provider_retryable_error_retry_exhausted');
  // distinct from the malformed budget reason
  assert.notEqual(o.reason, 'malformed_tool_call_retry_exhausted');
});

test('output_limit_tools_not_executed: truncated output does not execute tools', () => {
  const o = out('output_limit_tools_not_executed');
  assert.equal(o.phase, 'failed');
  assert.equal(o.outcome, 'unverified');
  assert.equal(o.reason, 'continuation_budget_exhausted');
  assert.equal(o.tool_calls, 0);
  assert.ok(o.continuation_message_kinds.includes('continuation_observation'));
});

test('no_verifier_unverified: absent verifier never yields verified', () => {
  const o = out('no_verifier_unverified');
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'unverified');
  assert.notEqual(o.outcome, 'verified');
  assert.equal(o.reason, 'verification_report_missing');
});

test('verifier_no_evidence_unverified: passed without evidence is not verified', () => {
  const o = out('verifier_no_evidence_unverified');
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'unverified');
  assert.notEqual(o.outcome, 'verified');
  assert.equal(o.reason, 'qualified_evidence_missing');
  assert.equal(o.verifier_calls, 1);
});

test('final_submission_schema_tool: submit_final_output seals a candidate directly', () => {
  const o = out('final_submission_schema_tool');
  assert.equal(o.phase, 'completed');
  assert.equal(o.outcome, 'verified');
  assert.equal(o.model_calls, 1);
  assert.equal(o.tool_calls, 0); // the submission tool is not dispatched
});

test('store_command_dedup: enqueue dedups by command_id+payload', () => {
  const o = out('store_command_dedup');
  assert.equal(o.first_receipt_status, 'accepted');
  assert.equal(o.second_receipt_status, 'duplicate');
  assert.equal(o.third_receipt_status, 'accepted');
  // priority-sorted descending: cancel(100) before pause(80)
  assert.deepEqual(o.pending_command_kinds, ['cancel', 'pause']);
});

test('store_commit_idempotent: replaying a commit returns the archived snapshot', () => {
  const o = out('store_commit_idempotent');
  assert.equal(o.first_phase, 'preparing_context');
  assert.equal(o.again_phase, 'preparing_context');
  assert.equal(o.first_revision, o.again_revision);
  // idempotent replay did not duplicate the event
  assert.equal(o.event_count, 1);
});

test('normalize_response_classification: sealed attempt classification', () => {
  const o = out('normalize_response_classification');
  assert.equal(o.final_candidate, 'final_candidate');
  assert.equal(o.tool_calls, 'tool_calls');
  assert.equal(o.malformed_duplicate_call_id, 'malformed_tool_call');
  assert.equal(o.output_limit, 'output_limit');
  assert.equal(o.context_overflow, 'context_overflow');
  assert.equal(o.provider_retryable_error, 'provider_retryable_error');
  assert.equal(o.empty_response, 'empty_response');
  assert.equal(o.user_abort, 'user_abort');
  assert.equal(o.policy_abort, 'policy_abort');
});

test('retry_delay_pure: deterministic backoff semantics', () => {
  const o = out('retry_delay_pure');
  assert.equal(o.non_retryable_delay, 0.0);
  // rate-limit cooldown floor 5.0 + bounded upward jitter (pinned source 0.5)
  assert.ok(o.rate_limit_with_cooldown >= 5.0 && o.rate_limit_with_cooldown <= 6.25);
  // explicit server wait preserved exactly
  assert.equal(o.explicit_server_wait_preserved, 12.0);
});

test('command_priority_ordering: matches the locked contract', () => {
  const o = out('command_priority_ordering');
  assert.deepEqual(o.priorities, {
    cancel: 100, policy_revoked: 95, submit_interaction: 90, cancel_child: 85,
    pause: 80, resume: 80, promote_child: 70, message_child: 70,
    steer: 60, guide: 60,
  });
  assert.deepEqual(o.sorted_desc, [
    'cancel', 'policy_revoked', 'submit_interaction', 'cancel_child',
    'pause', 'resume', 'promote_child', 'message_child', 'steer', 'guide',
  ]);
});

test('scenario set covers the required priority list', () => {
  const required = [
    'closed_loop_verified', 'parallel_readonly_batch', 'serial_write_workspace_paths',
    'cancel_priority_over_inflight_tool', 'pause_resume', 'approval_match_allow',
    'lost_effect_not_rerun', 'model_budget_exhausted_not_success',
    'malformed_tool_call_retry_exhausted', 'provider_retry_budget_exhausted',
    'output_limit_tools_not_executed', 'no_verifier_unverified',
  ];
  for (const id of required) {
    assert.ok(scenarios.has(id), `missing required scenario: ${id}`);
  }
});
