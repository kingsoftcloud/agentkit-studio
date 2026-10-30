import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILD_ALLOCATION_POLICY,
  roleAllocationDefaults, resolveChildCallLimits, createNativeChildOwner } from '@kingsoftcloud/agentkit-harness-node/native/child-owner';
import { nativeChildRoles } from '../src/providers/native-subagents.mjs';
import { canonical, configure, MemoryRunStore, admittedToolBudget, emptyUsage,
  prepareEffect, transition, initialSnapshot } from '@kingsoftcloud/agentkit-harness-core';
import { createHash } from 'node:crypto';

const POLICY = CHILD_ALLOCATION_POLICY;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const childScope = { ...scope, agentId: 'agent:child:reader' };
const budget = (maxModel, maxTool, depth = 0, maxDepth = 3) => ({ maxModelCallsRemaining: maxModel,
  maxToolCallsRemaining: maxTool, depth, maxDepth, parentFinalizationReserved: true });
const startDef = (policy = 'start/v1') => ({ name: 'native_start_child', description: 'Start', parameters: { type: 'object', properties: {} },
  readOnly: false, concurrentSafe: false, childBudgetPolicy: policy, timeoutMs: 1000 });
const profile = { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' };
const tool = startDef();

function baseConfig(overrides = {}) {
  const { limits: limitOverride, ...rest } = overrides;
  return configure({ profile, contract: { objective: 'Complete the task' }, hostBindingDigest: 'fixture-host/v1',
    tools: [tool], childLifecyclePolicy: 'owned-background/v2',
    limits: { maxModelCalls: 20, maxToolCalls: 20, ...(limitOverride ?? {}) }, ...rest });
}

// ---- helper: roleAllocationDefaults ----
test('roleAllocationDefaults: policy omits -> 16/null/900, legacy -> 4/null/120, explicit preserved upstream', () => {
  assert.deepEqual(roleAllocationDefaults(POLICY), { maxTurns: 16, maxToolCalls: null, timeoutSeconds: 900 });
  assert.deepEqual(roleAllocationDefaults(undefined), { maxTurns: 4, maxToolCalls: null, timeoutSeconds: 120 });
});

test('roleAllocationDefaults rejects unknown policy', () => {
  assert.throws(() => roleAllocationDefaults('bogus'), { code: 'studio_native_child_allocation_policy_invalid' });
});

// ---- helper: resolveChildCallLimits ----
test('resolveChildCallLimits: legacy unlimited parent omits -> 4/8 (not 0)', () => {
  const r = resolveChildCallLimits({ policy: undefined, budget: budget(null, null), childBudgetPolicy: 'start/v1' });
  assert.deepEqual(r, { maxModelCalls: 4, maxToolCalls: 8 });
});

test('resolveChildCallLimits: legacy unlimited parent explicit 6/2 -> 6/2', () => {
  const r = resolveChildCallLimits({ policy: undefined, modelCallLimit: 6, toolCallLimit: 2, budget: budget(null, null), childBudgetPolicy: 'start/v1' });
  assert.deepEqual(r, { maxModelCalls: 6, maxToolCalls: 2 });
});

test('resolveChildCallLimits: policy unlimited parent omits -> 16/64 (finite, no Infinity)', () => {
  const r = resolveChildCallLimits({ policy: POLICY, budget: budget(null, null), childBudgetPolicy: 'start/v1' });
  assert.deepEqual(r, { maxModelCalls: 16, maxToolCalls: 64 });
  assert.ok(Number.isSafeInteger(r.maxModelCalls) && Number.isSafeInteger(r.maxToolCalls));
});

test('resolveChildCallLimits: policy default allowance is capped by remaining parent budget', () => {
  const r = resolveChildCallLimits({ policy: POLICY, budget: budget(20, 20), childBudgetPolicy: 'start/v1' });
  assert.deepEqual(r, { maxModelCalls: 16, maxToolCalls: 19 });
});

test('resolveChildCallLimits: policy explicit 6/2 honored, unlimited parent -> 6/2', () => {
  const r = resolveChildCallLimits({ policy: POLICY, modelCallLimit: 6, toolCallLimit: 2, budget: budget(null, null), childBudgetPolicy: 'delegate/v1' });
  assert.deepEqual(r, { maxModelCalls: 6, maxToolCalls: 2 });
});

test('resolveChildCallLimits: policy explicit clamp by bounded remaining', () => {
  const r = resolveChildCallLimits({ policy: POLICY, modelCallLimit: 30, toolCallLimit: 30, budget: budget(10, 10), childBudgetPolicy: 'start/v1' });
  assert.deepEqual(r, { maxModelCalls: 10, maxToolCalls: 9 });
});

test('resolveChildCallLimits: start/v1 with maxToolCallsRemaining 0 -> negative tools (exhausted, owner must refuse)', () => {
  const r = resolveChildCallLimits({ policy: POLICY, budget: budget(5, 0), childBudgetPolicy: 'start/v1' });
  assert.equal(r.maxModelCalls, 5);
  assert.equal(r.maxToolCalls, -1, 'availableTools stays signed so admission refuses before a child starts');
});

test('resolveChildCallLimits: delegate/v1 with maxToolCallsRemaining 0 -> 0 tools (delegate does not reserve)', () => {
  const r = resolveChildCallLimits({ policy: POLICY, budget: budget(5, 0), childBudgetPolicy: 'delegate/v1' });
  assert.deepEqual(r, { maxModelCalls: 5, maxToolCalls: 0 });
});

test('resolveChildCallLimits rejects unknown policy', () => {
  assert.throws(() => resolveChildCallLimits({ policy: 'bogus', budget: budget(null, null), childBudgetPolicy: 'start/v1' }),
    { code: 'studio_native_child_allocation_policy_invalid' });
});

test('resolveChildCallLimits rejects bad budget and bad explicit limits', () => {
  assert.throws(() => resolveChildCallLimits({ policy: POLICY, budget: null, childBudgetPolicy: 'start/v1' }), { code: 'child_budget_invalid' });
  assert.throws(() => resolveChildCallLimits({ policy: POLICY, modelCallLimit: 0, budget: budget(null, null), childBudgetPolicy: 'start/v1' }), { code: 'child_budget_invalid' });
  assert.throws(() => resolveChildCallLimits({ policy: POLICY, toolCallLimit: -1, budget: budget(null, null), childBudgetPolicy: 'start/v1' }), { code: 'child_budget_invalid' });
});

// ---- nativeChildRoles: omitted vs explicit defaults + digest stability ----
test('nativeChildRoles: policy omits -> maxTurns 16 / timeout 900; explicit maxTurns 4 stays 4', () => {
  const policy = nativeChildRoles({ subAgents: [{ name: 'r', instructions: 'x', tools: [] }] }, { childAllocationPolicy: POLICY });
  assert.equal(policy[0].maxTurns, 16);
  assert.equal(policy[0].timeoutSeconds, 900);
  assert.equal(policy[0].maxToolCalls, null);
  const explicit = nativeChildRoles({ subAgents: [{ name: 'r', instructions: 'x', tools: [], maxTurns: 4 }] }, { childAllocationPolicy: POLICY });
  assert.equal(explicit[0].maxTurns, 4, 'explicit 4 preserved under policy');
  assert.equal(explicit[0].timeoutSeconds, 900);
});

test('nativeChildRoles: legacy omits -> 4/120 (byte-identical to historical)', () => {
  const legacy = nativeChildRoles({ subAgents: [{ name: 'r', instructions: 'x', tools: [] }] });
  assert.equal(legacy[0].maxTurns, 4);
  assert.equal(legacy[0].timeoutSeconds, 120);
  assert.equal(legacy[0].maxToolCalls, null);
});

test('nativeChildRoles: legacy digest stable across absent policy (regression)', () => {
  const a = nativeChildRoles({ subAgents: [{ name: 'r', instructions: 'x', tools: [] }] });
  const b = nativeChildRoles({ subAgents: [{ name: 'r', instructions: 'x', tools: [] }] }, {});
  assert.equal(canonical(a), canonical(b));
});

test('nativeChildRoles rejects unknown policy', () => {
  assert.throws(() => nativeChildRoles({ subAgents: [] }, { childAllocationPolicy: 'bogus' }),
    { code: 'studio_native_child_allocation_policy_invalid' });
});

// ---- owner: createNativeChildOwner policy validation ----
test('createNativeChildOwner rejects unknown allocation policy', () => {
  const store = new MemoryRunStore();
  assert.throws(() => createNativeChildOwner({ scope, childScopes: [childScope], store, childAllocationPolicy: 'bogus',
    resolveChild: async () => ({}) }), { code: 'invalid_child_owner_allocation_policy' });
});

// ---- owner.start: end-to-end admission budget under policy vs legacy ----
// A minimal harness that drives owner.start against an in-memory store. The parent
// record is set up exactly like the existing child-owner tests, then we assert the
// child's reserved/binding limits reflect the policy-aware defaults.
function ownerHarness({ policy, parentLimits = { maxModelCalls: 20, maxToolCalls: 20 }, resolveChildLimits = null, sharedStore = null }) {
  const store = sharedStore ?? new MemoryRunStore();
  const seed = store.list(scope).length === 0;
  const config = baseConfig({ limits: parentLimits });
  if (seed) {
    const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 'session', turnId: 'turn',
      buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config, digest(config));
    store.create(config, snapshot);
  }
  const lease = seed ? store.acquire(scope, 'run', 'expired-parent', 10, 100) : store.load(scope, 'run').lease;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, now: () => 22,
    ...(policy ? { childAllocationPolicy: policy } : {}),
    resolveChild: async request => {
      // Mimic resolveChild's role-cap clamp: an omitted/null role cap keeps the
      // requested limit (a standalone resolver that returns null caps).
      const limits = { maxModelCalls: resolveChildLimits?.maxModelCalls ?? request.maxModelCalls,
        maxToolCalls: resolveChildLimits?.maxToolCalls ?? request.maxToolCalls };
      const childConfig = configure({ profile, contract: { objective: request.task }, hostBindingDigest: 'discovery-fixture',
        tools: [], limits });
      return { scope: childScope, configuration: childConfig,
        ports: { model: { generate: async () => ({ kind: 'final_candidate', text: 'done', toolCalls: [], usage: emptyUsage() }) },
          tools: { execute: async () => ({ status: 'ok', content: { ok: true } }) } } };
    } });
  return { store, lease, config, owner, release: async () => owner.releaseRun({ scope, runId: 'run' }) };
}

async function admit(harness, { callArgs = {}, callName = 'native_start_child', childBudgetPolicy = 'start/v1' } = {}) {
  const { store, lease, config } = harness;
  const parent = store.load(scope, 'run').snapshot;
  const call = { callId: 'call-1', name: callName, arguments: { role: 'reader', task: 'Do work', ...callArgs } };
  const definition = startDef(childBudgetPolicy);
  const executing = store.commit(scope, 'run', lease, 22, parent.revision, transition(parent,
    { phase: 'executing_tools', pendingTools: [call], messages: [...parent.messages, { role: 'assistant', content: '', toolCalls: [call] }] }));
  const batch = prepareEffect(executing, 'tool', 'executing_tools', { calls: [call], interaction: null });
  store.commit(scope, 'run', lease, 22, executing.revision, batch);
  const intent = store.claim(scope, 'run', lease, 22, batch.snapshot.pendingIntent);
  const snap = store.load(scope, 'run').snapshot;
  const receipt = await harness.owner.start({
    ...Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, snap[key]])),
    operationKey: intent.operationKey, executionFence: lease.fence, signal: new AbortController().signal,
    call, definition, interaction: null, budget: admittedToolBudget(snap, config) });
  return { receipt, intent };
}

// Re-issue owner.start for the same parent operation against an existing pending
// intent, without re-doing the parent ledger setup. The replay path in start runs when
// the child locator (derived from scope/runId/operationKey) already exists in the store.
async function reStart(harness, prior) {
  const { store, lease, config } = harness;
  const snap = store.load(scope, 'run').snapshot;
  const call = { callId: 'call-1', name: 'native_start_child', arguments: { role: 'reader', task: 'Do work' } };
  return harness.owner.start({
    ...Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, snap[key]])),
    operationKey: prior.intent.operationKey, executionFence: lease.fence, signal: new AbortController().signal,
    call, definition: startDef('start/v1'), interaction: null, budget: admittedToolBudget(snap, config) });
}

test('owner.start: policy with enough budget admits >4 model calls (16) and 64 tools', async () => {
  const h = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 } });
  try {
    const { receipt } = await admit(h);
    assert.equal(receipt.status, 'ok');
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 16);
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 64);
    const record = h.store.load(childScope, receipt.childBudgetReservation.childRunId);
    assert.equal(record.configuration.childOwnerBinding.childAllocationPolicy, POLICY);
    assert.equal(record.configuration.limits.maxModelCalls, 16);
    assert.equal(record.configuration.limits.maxToolCalls, 64);
  } finally { await h.release(); }
});

test('owner.start: policy explicit per-call model limit 4 stays 4', async () => {
  const h = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 } });
  try {
    const { receipt } = await admit(h, { callArgs: { model_call_limit: 4 } });
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 4);
  } finally { await h.release(); }
});

test('owner.start: policy user tool_call_limit honored', async () => {
  const h = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 } });
  try {
    const { receipt } = await admit(h, { callArgs: { tool_call_limit: 3 } });
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 3);
  } finally { await h.release(); }
});

test('owner.start: policy caps by parent remaining budget (parent finalization reserve protected by core)', async () => {
  // Parent maxModelCalls 6 with finalizationReserveModelCalls 1 (default) => model remaining 5.
  // admittedToolBudget reserves 1 tool for the invoking call, and start/v1 reserves 1 more
  // for the admission itself, so tool remaining = 7 - 1 - 1 = 5. Policy allowance 16/64
  // is capped to these remaining values.
  const h = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 6, maxToolCalls: 7 } });
  try {
    const { receipt } = await admit(h);
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 5, 'capped by parent remaining incl. finalization reserve');
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 5);
  } finally { await h.release(); }
});

test('owner.start: legacy omits -> 4/8 stacked default (unchanged behavior)', async () => {
  const h = ownerHarness({ policy: undefined, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 } });
  try {
    const { receipt } = await admit(h);
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 4);
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 8);
    const record = h.store.load(childScope, receipt.childBudgetReservation.childRunId);
    assert.equal(record.configuration.childOwnerBinding.childAllocationPolicy, undefined);
  } finally { await h.release(); }
});

test('owner.start: legacy unlimited parent omits -> 4/8 (not 0)', async () => {
  const h = ownerHarness({ policy: undefined, parentLimits: { maxModelCalls: null, maxToolCalls: null } });
  try {
    const { receipt } = await admit(h);
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 4);
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 8);
  } finally { await h.release(); }
});

test('owner.start: start/v1 with exhausted parent tool budget is refused before a child starts', async () => {
  // maxToolCalls 0 => remaining tools 0 => start/v1 reserve makes availableTools -1.
  const h = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 5, maxToolCalls: 0 } });
  try {
    await assert.rejects(() => admit(h), { code: 'child_budget_exhausted' });
  } finally { await h.release(); }
});

test('owner.start: policy with null parent budget and standalone null role cap admits finite 16/64 (no Infinity in binding)', async () => {
  // A standalone resolver returns null role caps; parent budget is null (unlimited).
  // The finite policy fallback must produce 16/64, never Infinity crossing the binding.
  const h = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: null, maxToolCalls: null },
    resolveChildLimits: { maxModelCalls: null, maxToolCalls: null } });
  try {
    const { receipt } = await admit(h);
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 16);
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 64);
    const record = h.store.load(childScope, receipt.childBudgetReservation.childRunId);
    const binding = record.configuration.childOwnerBinding;
    assert.ok(Number.isSafeInteger(binding.maxModelCalls) && Number.isSafeInteger(binding.maxToolCalls),
      'binding holds finite integers, no Infinity serialized');
    // The persisted configuration JSON must not contain the token "Infinity".
    assert.ok(!JSON.stringify(record.configuration).includes('Infinity'));
  } finally { await h.release(); }
});

test('owner.start: legacy with null parent budget and standalone null role cap admits 4/8 (no Infinity)', async () => {
  const h = ownerHarness({ policy: undefined, parentLimits: { maxModelCalls: null, maxToolCalls: null },
    resolveChildLimits: { maxModelCalls: null, maxToolCalls: null } });
  try {
    const { receipt } = await admit(h);
    assert.equal(receipt.childBudgetReservation.maxModelCalls, 4);
    assert.equal(receipt.childBudgetReservation.maxToolCalls, 8);
    const record = h.store.load(childScope, receipt.childBudgetReservation.childRunId);
    assert.ok(!JSON.stringify(record.configuration).includes('Infinity'));
  } finally { await h.release(); }
});

// ---- recoverable identity: stored child is not silently upgraded across policies ----
test('owner.start: a stored legacy child is not re-admitted under the policy (cross-policy refusal)', async () => {
  // Admit a legacy child into a shared store, then build a policy owner over the same
  // store and re-issue start for the same operation. The child locator already exists,
  // so the replay path runs and must refuse the cross-policy upgrade.
  const store = new MemoryRunStore();
  const hLegacy = ownerHarness({ policy: undefined, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 }, sharedStore: store });
  try {
    const first = await admit(hLegacy, { callArgs: { task: 'Do work' } });
    assert.equal(first.receipt.status, 'ok');
    assert.equal(first.receipt.childBudgetReservation.maxModelCalls, 4);
    const hPolicy = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 }, sharedStore: store });
    try {
      await assert.rejects(() => reStart(hPolicy, first), { code: 'child_start_identity_conflict' });
    } finally { await hPolicy.release(); }
  } finally { await hLegacy.release(); }
});

test('owner.start: a stored policy child is not re-admitted as legacy (cross-policy refusal)', async () => {
  const store = new MemoryRunStore();
  const hPolicy = ownerHarness({ policy: POLICY, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 }, sharedStore: store });
  try {
    const first = await admit(hPolicy, { callArgs: { task: 'Do work' } });
    assert.equal(first.receipt.status, 'ok');
    assert.equal(first.receipt.childBudgetReservation.maxModelCalls, 16);
    const hLegacy = ownerHarness({ policy: undefined, parentLimits: { maxModelCalls: 100, maxToolCalls: 100 }, sharedStore: store });
    try {
      await assert.rejects(() => reStart(hLegacy, first), { code: 'child_start_identity_conflict' });
    } finally { await hLegacy.release(); }
  } finally { await hPolicy.release(); }
});
