import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  NativeKernel, configure, initialSnapshot, canonical, copy, emptyUsage,
} from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import {
  createNativeComponentTools, nativeComponentToolDefinitions, NATIVE_COMPONENT_TOOLS_CONTRACT,
} from '@kingsoftcloud/agentkit-harness-node/native/component-tools';
import { createNativeToolAuthority } from '../../../src/providers/native-tool-authority.mjs';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const identity = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

const FULL_STATUS = {
  summary: {
    model: 'claude-test', knowledge_base_bound: true, long_term_memory_bound: true,
    skill_space_bound: true, isolated_execution: 'enabled', sandbox_direct_tools: 'enabled',
  },
  skill_space: {
    space_ids: ['sp-1'], user_space_ids: ['sp-1'], public_space_ids: ['pub-1'],
    service_url: 'https://service.example.com', aicp_endpoint_mode: 'auto',
    tools: ['list_skills', 'search_skills', 'load_skill', 'execute_skills'],
  },
  skill_runtime: { backend: 'e2b', enabled: true, template_bound: true, request_protocol: '--request-file JSON envelope' },
  sandbox: { backend: 'e2b', enabled: true, template_bound: true, tools: ['sandbox_status', 'run_command', 'run_code'] },
  workspace: {
    root: '/workspace/root',
    tools: ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
      'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
      'search_workspace_files', 'delete_workspace_file'],
    boundary: 'Workspace tools are confined to the AgentEngine UI workspace directory.',
    editing_model: 'write tools support whole-file writes; edit_workspace_file supports exact snippet replacement; lint_workspace_file provides lightweight built-in checks.',
  },
};
const EXPECTED_STATUS = { ok: true, ...copy(FULL_STATUS) };

/** Build a real NativeKernel + SqliteRunStore harness. The store is created
 *  first, then the port with a real createNativeToolAuthority bound to that
 *  store as the default assertCurrent — no leaking a throwaway store. Tests
 *  that need fault injection pass an explicit assertCurrent override. */
function setup({ status = copy(FULL_STATUS), assertCurrent, captureRequest = false, filename } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'native-component-'));
  const dbFile = filename ?? join(base, 'ledger.sqlite');
  const store = new SqliteRunStore(dbFile);
  const port = createNativeComponentTools({
    scope, sessionId: 'session', status,
    assertCurrent: assertCurrent ?? createNativeToolAuthority({ scope, sessionId: 'session', store }),
  });
  const config = configure({
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    contract: { objective: 'Report component status' }, hostBindingDigest: 'fixture-host/v1', tools: port.definitions,
  });
  const snapshot = initialSnapshot(identity, config, digest(config));
  let models = 0;
  const model = { generate: async () => {
    if (++models === 1) return {
      kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'call', name: 'component_status', arguments: {} }],
    };
    return { kind: 'final_candidate', text: 'Status reported', toolCalls: [], usage: emptyUsage() };
  } };
  // When captureRequest is set, wrap the tool port so the real ToolRequest the
  // kernel hands to the port is recorded before forwarding to execute.
  const captured = [];
  const toolsPort = captureRequest
    ? { execute: async request => { captured.push(request); return port.execute(request); } }
    : port;
  const kernel = new NativeKernel({ store, owner: 'worker', digest, ports: { model, tools: toolsPort } });
  return {
    base, port, config, snapshot, store, dbFile, model, kernel, captured,
    cleanup: () => { try { store.close(); } catch {} try { port.close(); } catch {} rmSync(base, { recursive: true, force: true }); },
  };
}

function makeExec(definition, { signal } = {}) {
  return {
    call: { callId: 'call', name: 'component_status', arguments: {} },
    definition,
    scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build',
    parentRunId: null, taskChainId: 'chain',
    operationKey: 'operation', executionFence: 1,
    budget: { maxModelCallsRemaining: 10, maxToolCallsRemaining: 10, parentFinalizationReserved: true, depth: 0, maxDepth: 3 },
    interaction: null,
    signal: signal ?? new AbortController().signal,
  };
}

// --- contract + definition ---------------------------------------------------

test('exposes the v1 contract and one read-only component_status definition', () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => true });
  assert.equal(port.contract, NATIVE_COMPONENT_TOOLS_CONTRACT);
  assert.equal(port.definitions.length, 1);
  const def = port.definitions[0];
  assert.equal(def.name, 'component_status');
  assert.equal(def.readOnly, true);
  assert.equal(def.concurrentSafe, true);
  assert.equal(def.contextRole, 'none');
  assert.deepEqual(def.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.ok(Object.isFrozen(def));
  port.close();
});

test('nativeComponentToolDefinitions returns an isolated copy the caller cannot use to mutate the port', () => {
  const standalone = nativeComponentToolDefinitions();
  assert.equal(standalone.length, 1);
  assert.equal(standalone[0].name, 'component_status');
  assert.equal(standalone[0].readOnly, true);
  // The returned definition is a fresh copy, not the port's frozen object.
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => true });
  assert.notEqual(standalone[0], port.definitions[0]);
  assert.deepEqual(standalone[0], port.definitions[0]);
  // Mutating the returned copy does not affect the port's definitions.
  standalone[0].name = 'tampered';
  standalone.push({ name: 'extra' });
  assert.equal(port.definitions[0].name, 'component_status');
  assert.equal(port.definitions.length, 1);
  // A second call returns another fresh copy.
  const again = nativeComponentToolDefinitions();
  assert.notEqual(again, standalone);
  assert.equal(again[0].name, 'component_status');
  port.close();
});

test('the output always carries ok:true and the input status must not set ok', async () => {
  // The port emits ok:true (Host-fixed read-only result); the input status must
  // not accept an ok field — the model cannot set it.
  assert.throws(() => createNativeComponentTools({
    scope, sessionId: 'session', status: { ok: true, summary: {} }, assertCurrent: () => true,
  }), /component_status_unknown_field:ok/);
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: {}, assertCurrent: () => true });
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.ok, true);
  port.close();
});

// --- real kernel: model plans component_status, assert result + reopen -------

test('a real kernel plans component_status and returns the full status snapshot', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  h.kernel.start(h.snapshot, h.config);
  const result = await h.kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.equal(result.usage.toolCalls, 1);
  const toolResults = h.store.load(scope, 'run').receipts.flatMap(item => item.result?.results ?? []);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].status, 'ok');
  assert.deepEqual(toolResults[0].content, EXPECTED_STATUS);
  // SQLite reopen: a new store reads the same durable receipt.
  const store2 = new SqliteRunStore(h.dbFile);
  const receipt2 = store2.load(scope, 'run').receipts.flatMap(item => item.result?.results ?? []);
  assert.equal(receipt2[0].status, 'ok');
  assert.deepEqual(receipt2[0].content, EXPECTED_STATUS);
  store2.close();
});

// --- real authority: createNativeToolAuthority gates the call ---------------

test('a real createNativeToolAuthority authorizes a live executing-tools call', async (t) => {
  const h = setup();
  t.after(h.cleanup);
  h.kernel.start(h.snapshot, h.config);
  const result = await h.kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.equal(result.usage.toolCalls, 1);
  assert.ok(result.messages.some(m => m.role === 'tool' && m.content.includes('claude-test')));
});

test('a real authority rejects a replayed ToolRequest after the run completes and store closes', async (t) => {
  // Capture the real ToolRequest the kernel hands to the port during a live
  // executing-tools call. After the run completes and the original store is
  // closed, a fresh store + fresh real authority must reject that exact
  // original request (no live lease/fence/phase) — verified by calling the
  // port directly, not by re-running the kernel (which would not reach the
  // port on a terminal run).
  const h = setup({ captureRequest: true });
  t.after(h.cleanup);
  h.kernel.start(h.snapshot, h.config);
  const first = await h.kernel.runUntilIdle(scope, 'run');
  assert.equal(first.phase, 'completed');
  assert.equal(h.captured.length, 1);
  const originalRequest = h.captured[0];
  assert.equal(originalRequest.call.name, 'component_status');
  // Close the original store so the live lease is gone.
  h.store.close();

  // A fresh store and fresh real authority see a completed (terminal) run.
  const store2 = new SqliteRunStore(h.dbFile);
  const authority2 = createNativeToolAuthority({ scope, sessionId: 'session', store: store2 });
  const port2 = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: authority2 });
  // The original request carries the real run's operationKey/executionFence;
  // the fresh authority checks the live ledger and must reject it.
  const replay = await port2.execute(originalRequest);
  assert.equal(replay.status, 'error');
  assert.notEqual(replay.content.code, 'invalid_arguments');
  assert.notEqual(replay.content.code, 'component_status_definition_mismatch');
  assert.notEqual(replay.content.code, 'component_status_scope_mismatch');
  // No new tool result was recorded — the ledger was not advanced.
  const receipts = store2.load(scope, 'run').receipts.flatMap(item => item.result?.results ?? []);
  assert.equal(receipts.length, 1); // only the original durable result
  assert.equal(receipts[0].status, 'ok'); // the original, not a new execution
  store2.close(); port2.close();
});

// --- status groups, disabled, empty, no fabricated tools --------------------

test('disabled components are reported explicitly as not enabled', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: {}, assertCurrent: () => true });
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.summary.isolated_execution, 'not_enabled');
  assert.equal(r.content.skill_runtime.backend, 'disabled');
  assert.equal(r.content.sandbox.enabled, false);
  assert.equal(r.content.summary.model, '');
  port.close();
});

test('empty status yields a complete structure with empty tool lists (no fabricated tools)', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: {}, assertCurrent: () => true });
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.content).sort(), ['ok', 'sandbox', 'skill_runtime', 'skill_space', 'summary', 'workspace']);
  assert.equal(r.content.ok, true);
  assert.deepEqual(r.content.skill_space.tools, []);
  assert.deepEqual(r.content.sandbox.tools, []);
  assert.deepEqual(r.content.workspace.tools, []);
  assert.ok(r.content.workspace.boundary.length > 0);
  port.close();
});

// --- snapshot immutability + secret/extra-field/nested rejection -------------

test('the bound status snapshot cannot be mutated through the original object', async () => {
  const statusObj = copy(FULL_STATUS);
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: statusObj, assertCurrent: () => true });
  statusObj.summary.model = 'MUTATED';
  statusObj.summary.secret_key = 'leak';
  statusObj.sandbox.tools.push('malicious');
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.summary.model, 'claude-test');
  assert.equal('secret_key' in r.content.summary, false);
  assert.deepEqual(r.content.sandbox.tools, FULL_STATUS.sandbox.tools);
  port.close();
});

test('construction rejects an extra top-level group (credentials smuggle)', () => {
  assert.throws(() => createNativeComponentTools({
    scope, sessionId: 'session', status: { summary: {}, credentials: { api_key: 'sk-leak' } }, assertCurrent: () => true,
  }), /component_status_unknown_field:credentials/);
});

test('construction rejects an unknown nested field (secret smuggle)', () => {
  assert.throws(() => createNativeComponentTools({
    scope, sessionId: 'session', status: { sandbox: { apiKey: 'secret' } }, assertCurrent: () => true,
  }), /component_status_unknown_field:sandbox\.apiKey/);
  assert.throws(() => createNativeComponentTools({
    scope, sessionId: 'session', status: { summary: { token: 'x' } }, assertCurrent: () => true,
  }), /component_status_unknown_field:summary\.token/);
  assert.throws(() => createNativeComponentTools({
    scope, sessionId: 'session', status: { workspace: { secret_path: '/etc' } }, assertCurrent: () => true,
  }), /component_status_unknown_field:workspace\.secret_path/);
});

test('construction rejects wrong-typed fields instead of coercing', () => {
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: { summary: { knowledge_base_bound: 'yes' } }, assertCurrent: () => true }), /component_status_field_invalid/);
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: { summary: { isolated_execution: 'maybe' } }, assertCurrent: () => true }), /component_status_field_invalid/);
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: { skill_space: { space_ids: 'not-an-array' } }, assertCurrent: () => true }), /component_status_field_invalid/);
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: { workspace: { root: 123 } }, assertCurrent: () => true }), /component_status_field_invalid/);
});

test('construction rejects a non-object or oversized status', () => {
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: 'string', assertCurrent: () => true }), /component_status_invalid/);
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: [], assertCurrent: () => true }), /component_status_invalid/);
  const huge = { skill_space: { space_ids: Array.from({ length: 100 }, () => 's'.repeat(700)) } };
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: huge, assertCurrent: () => true }), /component_status_oversized/);
});

// --- assertCurrent required + strictness -------------------------------------

test('assertCurrent is required — no default', () => {
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 'session', status: {} }), /component_status_assert_current_required/);
});

test('assertCurrent returning false rejects the call with authority_lost', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => false });
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'component_status_authority_lost');
  port.close();
});

test('assertCurrent returning a thenable fails closed and observes the rejection', async () => {
  let rejected = false;
  const unhandled = [];
  const listener = error => unhandled.push(error.message);
  process.on('unhandledRejection', listener);
  try {
    const port = createNativeComponentTools({
      scope, sessionId: 'session', status: copy(FULL_STATUS),
      assertCurrent: () => { const p = Promise.reject(new Error('auth-rejection')); p.then(() => {}, () => { rejected = true; }); return p; },
    });
    const r = await port.execute(makeExec(port.definitions[0]));
    assert.equal(r.status, 'error');
    assert.equal(r.content.code, 'component_status_assert_current_invalid');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(unhandled.length, 0, `unhandledRejection leaked: ${JSON.stringify(unhandled)}`);
    assert.equal(rejected, true);
    port.close();
  } finally { process.off('unhandledRejection', listener); }
});

test('assertCurrent returning a non-boolean or throwing fails closed', async () => {
  const portStr = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => 'yes' });
  assert.equal((await portStr.execute(makeExec(portStr.definitions[0]))).content.code, 'component_status_assert_current_invalid');
  portStr.close();
  const portThrow = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => { throw new Error('boom'); } });
  assert.equal((await portThrow.execute(makeExec(portThrow.definitions[0]))).content.code, 'component_status_assert_current_invalid');
  portThrow.close();
});

// --- the four parent-probe counterexamples -----------------------------------

test('counterexample 1: a foreign scope or session is rejected before authority', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: {}, assertCurrent: () => true });
  const foreignScope = { ...scope, agentId: 'evil' };
  const rScope = await port.execute({ ...makeExec(port.definitions[0]), scope: foreignScope });
  assert.equal(rScope.status, 'error');
  assert.equal(rScope.content.code, 'component_status_scope_mismatch');
  const rSession = await port.execute({ ...makeExec(port.definitions[0]), sessionId: 'other' });
  assert.equal(rSession.status, 'error');
  assert.equal(rSession.content.code, 'component_status_session_mismatch');
  port.close();
});

test('counterexample 2: a forged definition is rejected before authority', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: {}, assertCurrent: () => true });
  const r = await port.execute({ ...makeExec(port.definitions[0]), definition: { name: 'forged' } });
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'component_status_definition_mismatch');
  const r2 = await port.execute({ ...makeExec(port.definitions[0]), definition: { ...port.definitions[0], timeoutMs: 99999 } });
  assert.equal(r2.status, 'error');
  assert.equal(r2.content.code, 'component_status_definition_mismatch');
  port.close();
});

test('counterexample 3: body or signal drift during the second guard is caught', async () => {
  const foreignScope = { ...scope, agentId: 'evil' };
  const port = createNativeComponentTools({
    scope, sessionId: 'session', status: {},
    assertCurrent: req => { req.scope = foreignScope; req.signal = new AbortController().signal; return true; },
  });
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'error');
  assert.match(r.content.code, /component_status_(signal_drifted|body_drifted|scope_drifted)/);
  port.close();
});

test('counterexample 4: an unknown nested secret field is rejected at construction', () => {
  assert.throws(() => createNativeComponentTools({
    scope, sessionId: 'session', status: { sandbox: { apiKey: 'secret' } }, assertCurrent: () => true,
  }), /component_status_unknown_field:sandbox\.apiKey/);
});

// --- close/abort/definition+budget/signal drift in the final guard -----------

test('close during assertCurrent is caught by the final guard', async () => {
  const port = createNativeComponentTools({
    scope, sessionId: 'session', status: copy(FULL_STATUS),
    assertCurrent: () => { port.close(); return true; },
  });
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'component_status_closed');
});

test('abort during assertCurrent is caught by the final guard', async () => {
  const controller = new AbortController();
  const port = createNativeComponentTools({
    scope, sessionId: 'session', status: copy(FULL_STATUS),
    assertCurrent: () => { controller.abort(); return true; },
  });
  const r = await port.execute(makeExec(port.definitions[0], { signal: controller.signal }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'component_status_canceled');
  port.close();
});

test('definition or budget drift during assertCurrent is caught by the post-guard', async () => {
  const defPort = createNativeComponentTools({
    scope, sessionId: 'session', status: copy(FULL_STATUS),
    assertCurrent: request => { request.definition = copy({ ...request.definition, timeoutMs: 99999 }); return true; },
  });
  const defResult = await defPort.execute(makeExec(defPort.definitions[0]));
  assert.equal(defResult.status, 'error');
  assert.match(defResult.content.code, /component_status_body_drifted/);
  defPort.close();

  const budgetPort = createNativeComponentTools({
    scope, sessionId: 'session', status: copy(FULL_STATUS),
    assertCurrent: request => { request.budget = copy({ ...request.budget, maxToolCallsRemaining: 0 }); return true; },
  });
  const budgetResult = await budgetPort.execute(makeExec(budgetPort.definitions[0]));
  assert.equal(budgetResult.status, 'error');
  assert.match(budgetResult.content.code, /component_status_body_drifted/);
  budgetPort.close();

  const sigPort = createNativeComponentTools({
    scope, sessionId: 'session', status: copy(FULL_STATUS),
    assertCurrent: request => { request.signal = new AbortController().signal; return true; },
  });
  const sigResult = await sigPort.execute(makeExec(sigPort.definitions[0]));
  assert.equal(sigResult.status, 'error');
  assert.equal(sigResult.content.code, 'component_status_signal_drifted');
  sigPort.close();
});

// --- cancel / close / input validation ---------------------------------------

test('an aborted signal returns canceled and never reports ok', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => true });
  const controller = new AbortController();
  controller.abort();
  const r = await port.execute(makeExec(port.definitions[0], { signal: controller.signal }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'component_status_canceled');
  port.close();
});

test('close before execute returns closed', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => true });
  port.close();
  const r = await port.execute(makeExec(port.definitions[0]));
  assert.equal(r.status, 'error');
  assert.match(r.content.code, /component_status_closed/);
});

test('invalid arguments are rejected by toolInputRejection before authority', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => true });
  const exec = makeExec(port.definitions[0]);
  exec.call.arguments = { unexpected: true };
  const r = await port.execute(exec);
  assert.equal(r.status, 'error');
  assert.equal(r.content.code, 'invalid_arguments');
  port.close();
});

test('missing signal fails closed', async () => {
  const port = createNativeComponentTools({ scope, sessionId: 'session', status: copy(FULL_STATUS), assertCurrent: () => true });
  const exec = makeExec(port.definitions[0]);
  exec.signal = null;
  const r = await port.execute(exec);
  assert.equal(r.status, 'error');
  assert.match(r.content.code, /signal_missing/);
  port.close();
});

test('missing scope/session/assertCurrent at construction fails', () => {
  assert.throws(() => createNativeComponentTools({ sessionId: 's', status: {}, assertCurrent: () => true }), /component_status_scope_missing/);
  assert.throws(() => createNativeComponentTools({ scope, status: {}, assertCurrent: () => true }), /component_status_session_id_missing/);
  assert.throws(() => createNativeComponentTools({ scope, sessionId: 's', status: {}, assertCurrent: 'not-a-fn' }), /component_status_assert_current_required/);
  assert.throws(() => createNativeComponentTools({ scope: { tenantId: 't' }, sessionId: 's', status: {}, assertCurrent: () => true }), /invalid_scope/);
});

// --- does not read env/fs/network --------------------------------------------

test('the port never reads process.env for bindings', async () => {
  process.env.OPENAI_MODEL_NAME = 'SHOULD-NOT-APPEAR';
  process.env.KSADK_KB_DATASET_ID = 'SHOULD-NOT-APPEAR';
  try {
    const port = createNativeComponentTools({ scope, sessionId: 'session', status: {}, assertCurrent: () => true });
    const r = await port.execute(makeExec(port.definitions[0]));
    assert.equal(r.status, 'ok');
    assert.equal(r.content.summary.model, '');
    assert.equal(r.content.summary.knowledge_base_bound, false);
    assert.equal(r.content.summary.long_term_memory_bound, false);
    assert.equal(r.content.summary.skill_space_bound, false);
    port.close();
  } finally {
    delete process.env.OPENAI_MODEL_NAME;
    delete process.env.KSADK_KB_DATASET_ID;
  }
});
