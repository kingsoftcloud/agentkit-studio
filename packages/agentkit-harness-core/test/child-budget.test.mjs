// Behavior tests for child budget reservation and settlement.
// Imports from ../dist/index.mjs — built by scripts/build-native-harness.mjs.
// Run: node --test packages/agentkit-harness-core/test/child-budget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedToolBudget, outstandingChildCalls, reduceChildBudget, emptyUsage, canonical, scopeKey } from '../dist/index.mjs';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const CHILD_SCOPE = { ...scope, agentId: 'child-agent' };
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);
const C64 = 'c'.repeat(64);

// --- helpers ---
function config(overrides = {}) {
  const { config } = fixture({ limits: { maxModelCalls: 12, maxToolCalls: 16, finalizationReserveModelCalls: 1, ...overrides } });
  return config;
}
function snap(overrides = {}) {
  const { snapshot } = fixture();
  return { ...snapshot, usage: { ...emptyUsage(), modelCalls: 2, toolCalls: 1 }, childBudgetReservations: [], childRunIds: [], ...overrides };
}
function startDef() { return tool({ name: 'start_child', childBudgetPolicy: 'start/v1', readOnly: false, concurrentSafe: false }); }
function delegateDef() { return tool({ name: 'delegate', childBudgetPolicy: 'delegate/v1', readOnly: false, concurrentSafe: false }); }
function settleDef() { return tool({ name: 'collect_child', childBudgetPolicy: 'settle/v1' }); }
function plainDef() { return tool({ name: 'read' }); }
function call(callId, name) { return { callId, name, arguments: {} }; }
function reservation(overrides = {}) {
  return { childRunId: 'child-run', childScope: CHILD_SCOPE, parentOperationKey: 'start-op', parentToolCallId: 'start-call',
    childRequestDigest: A64, configurationDigest: B64, maxModelCalls: 5, maxToolCalls: 6, settledUsageDigest: null, ...overrides };
}
function started(overrides = {}) {
  return { status: 'ok', content: { child_run_id: 'child-run', status: 'running' }, childBudgetReservation: reservation(overrides) };
}
function settled(overrides = {}) {
  return { status: 'ok', content: { final_text: 'Findings' }, childRunIds: ['child-run'],
    childBudgetSettlement: { childRunId: 'child-run', parentOperationKey: 'start-op', childRequestDigest: A64, terminalSnapshotDigest: C64 },
    resourceUsage: { inputTokens: 13, outputTokens: 7, modelCalls: 2, toolCalls: 3, cost: 0 },
    ...overrides };
}
function foreground(overrides = {}) {
  return { ...settled(), childBudgetReservation: reservation({ deliveryMode: 'foreground' }), ...overrides };
}

for (const definition of [startDef(), delegateDef()]) {
  test(`${definition.childBudgetPolicy}: one foreground receipt admits and settles the original budget atomically`, () => {
    const s = snap(), output = foreground();
    const result = reduceChildBudget(s, output, definition, 'start-op', call('start-call', definition.name), admittedToolBudget(s, config()), canonical);
    assert.deepEqual(result.childRunIds, ['child-run']); assert.deepEqual(result.usage, output.resourceUsage);
    assert.equal(result.childBudgetReservations[0].deliveryMode, 'foreground');
    assert.ok(result.childBudgetReservations[0].settledUsageDigest);
    const after = { ...s, childRunIds: result.childRunIds, childBudgetReservations: result.childBudgetReservations };
    assert.equal(outstandingChildCalls(after, 'model'), 0); assert.equal(outstandingChildCalls(after, 'tool'), 0);
    const repeated = reduceChildBudget(after, settled(), settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(after, config()), canonical);
    assert.deepEqual(repeated.usage, emptyUsage());
    assert.deepEqual(s.childBudgetReservations, []);
  });
}

for (const [name, mutate] of [
  ['background delivery', value => { value.childBudgetReservation.deliveryMode = 'background'; }],
  ['unknown delivery mode', value => { value.childBudgetReservation.deliveryMode = 'detached'; }],
  ['uncertain result', value => { value.status = 'uncertain'; }],
  ['approval result', value => { value.status = 'approval_required'; }],
  ['foreign child settlement', value => { value.childBudgetSettlement.childRunId = 'foreign'; }],
  ['foreign parent settlement', value => { value.childBudgetSettlement.parentOperationKey = 'foreign'; }],
  ['foreign request digest', value => { value.childBudgetSettlement.childRequestDigest = C64; }],
  ['unsealed terminal snapshot', value => { delete value.childBudgetSettlement.terminalSnapshotDigest; }],
  ['overspent child budget', value => { value.resourceUsage.modelCalls = 6; }],
  ['unadmitted reservation', value => { value.childBudgetReservation.maxModelCalls = 50; }],
]) test(`atomic foreground rejects ${name} without changing the parent`, () => {
  const s = snap(), before = structuredClone(s), output = foreground(); mutate(output);
  assert.throws(() => reduceChildBudget(s, output, startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical));
  assert.deepEqual(s, before);
});
// (digest substitute: canonical is used directly in tests)

// --- 1. Start reserves budget without fabricating actual usage ---
test('start reserves budget and does not fabricate usage', () => {
  const s = snap();
  const result = reduceChildBudget(s, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical);
  assert.equal(result.childRunIds.length, 1);
  assert.equal(result.childRunIds[0], 'child-run');
  assert.deepEqual(result.usage, emptyUsage()); // start must report zero usage
  assert.equal(result.childBudgetReservations.length, 1);
  assert.equal(result.childBudgetReservations[0].settledUsageDigest, null);
});

// --- 2. Outstanding child calls: settled reservations excluded ---
test('outstanding child calls exclude settled reservations', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.equal(outstandingChildCalls(s2, 'model'), 5);
  assert.equal(outstandingChildCalls(s2, 'tool'), 6);
  // After settlement, the reservation is sealed
  const r2 = reduceChildBudget(s2, settled(), settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical);
  const s3 = { ...snap(), childBudgetReservations: r2.childBudgetReservations, childRunIds: r2.childRunIds };
  assert.equal(outstandingChildCalls(s3, 'model'), 0);
  assert.equal(outstandingChildCalls(s3, 'tool'), 0);
  // Descendant usage is the delta from the settlement
  assert.deepEqual(r2.usage, { inputTokens: 13, outputTokens: 7, modelCalls: 2, toolCalls: 3, cost: 0 });
});

// --- 3. admittedToolBudget reserves finalization model calls ---
test('admittedToolBudget subtracts child reservations and finalization reserve', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  const budget = admittedToolBudget(s2, config());
  // 12 max - 2 used - 5 reserved - 1 finalization = 4
  assert.equal(budget.maxModelCallsRemaining, 4);
  assert.equal(budget.parentFinalizationReserved, true);
  // 16 max - 1 used - 6 reserved - 1 invoking = 8
  assert.equal(budget.maxToolCallsRemaining, 8);
});

// --- 4. Unlimited budget (null limits) ---
test('unlimited budget stays null after child reservation', () => {
  const s = snap();
  const c = config({ maxModelCalls: null, maxToolCalls: null });
  const budget = admittedToolBudget(s, c);
  assert.equal(budget.maxModelCallsRemaining, null);
  assert.equal(budget.maxToolCallsRemaining, null);
  // With a reservation
  const r = reduceChildBudget(s, started(), startDef(), 'start-op', call('start-call', 'start_child'), budget, canonical);
  const s2 = { ...snap(), childBudgetReservations: r.childBudgetReservations, childRunIds: r.childRunIds };
  const budget2 = admittedToolBudget(s2, c);
  assert.equal(budget2.maxModelCallsRemaining, null);
  assert.equal(budget2.maxToolCallsRemaining, null);
});

// --- 5. start vs delegate: start/v1 needs one more tool slot than delegate/v1 ---
test('start/v1 is rejected when budget is exactly child maxToolCalls but delegate/v1 is accepted', () => {
  const s = snap(); // usage: toolCalls=1
  // Config: maxToolCalls=8, so remaining = 8 - 1 used - 1 invoking = 6
  // start/v1: child maxToolCalls=6 + 1 collection = 7 > 6 → rejected
  // delegate/v1: child maxToolCalls=6 + 0 = 6 <= 6 → accepted
  const tightConfig = config({ maxToolCalls: 8 });
  const budget = admittedToolBudget(s, tightConfig);
  assert.equal(budget.maxToolCallsRemaining, 6);
  // start/v1 rejects: 6 + 1 = 7 > 6
  assert.throws(() => reduceChildBudget(s, started({ maxToolCalls: 6 }), startDef(), 'start-op', call('start-call', 'start_child'), budget, canonical),
    /child_budget_start_exceeds_admission/);
  // delegate/v1 accepts: 6 + 0 = 6 <= 6
  const delResult = reduceChildBudget(s,
    { ...started(), childBudgetReservation: { ...reservation(), parentOperationKey: 'del-op', parentToolCallId: 'del-call' } },
    delegateDef(), 'del-op', call('del-call', 'delegate'), budget, canonical);
  assert.equal(delResult.childRunIds[0], 'child-run');
});

// --- 6. Parent operation key / call id mismatch ---
test('start receipt with wrong parent operation key is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ parentOperationKey: 'foreign-op' }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_exceeds_admission/);
});
test('start receipt with wrong parent tool call id is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ parentToolCallId: 'foreign-call' }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_exceeds_admission/);
});

// --- 7. Cross tenant/workspace/user rejected; different agentId allowed ---
test('start receipt with wrong tenant is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ childScope: { ...CHILD_SCOPE, tenantId: 'foreign' } }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_identity_conflict/);
});
test('start receipt with wrong workspace is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ childScope: { ...CHILD_SCOPE, workspaceId: 'foreign' } }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_identity_conflict/);
});
test('start receipt with wrong user is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ childScope: { ...CHILD_SCOPE, userId: 'foreign' } }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_identity_conflict/);
});
test('start receipt with different agentId is allowed', () => {
  const s = snap();
  // agentId differs — child is a different agent, same tenant/workspace/user
  const result = reduceChildBudget(s, started({ childScope: { ...CHILD_SCOPE, agentId: 'another-agent' } }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical);
  assert.equal(result.childRunIds[0], 'child-run');
});

// --- 8. Parent/child run id conflict ---
test('start receipt with child run id equal to parent run id is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ childRunId: s.runId }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_identity_conflict/);
});

// --- 9. Duplicate reservation rejected ---
test('duplicate child run id is rejected', () => {
  const s1 = snap();
  const bigConfig = config({ maxModelCalls: 100, maxToolCalls: 100 });
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, bigConfig), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  // Same child run id, different op key AND call id — identity conflict on childRunId
  assert.throws(() => reduceChildBudget(s2, started({ parentOperationKey: 'start-op-2', parentToolCallId: 'start-call-2' }), startDef(), 'start-op-2', call('start-call-2', 'start_child'), admittedToolBudget(s2, bigConfig), canonical),
    /child_budget_start_identity_conflict/);
});
test('duplicate parent operation key is rejected', () => {
  const s1 = snap();
  const bigConfig = config({ maxModelCalls: 100, maxToolCalls: 100 });
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, bigConfig), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  // Same op key, different child AND call id — identity conflict on parentOperationKey
  assert.throws(() => reduceChildBudget(s2, started({ childRunId: 'child-2', parentToolCallId: 'start-call-2' }), startDef(), 'start-op', call('start-call-2', 'start_child'), admittedToolBudget(s2, bigConfig), canonical),
    /child_budget_start_identity_conflict/);
});

// --- 10. Reservation cannot directly report usage ---
test('start receipt with non-zero usage is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, { ...started(), resourceUsage: { ...emptyUsage(), modelCalls: 1 } }, startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /invalid_child_budget_start_receipt/);
});

// --- 11. Settlement identity: unbound settlement rejected ---
test('settlement without a prior reservation is rejected', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, settled(), settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 12. Settlement identity: wrong parent operation key ---
test('settlement with wrong parent operation key is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), childBudgetSettlement: { ...settled().childBudgetSettlement, parentOperationKey: 'foreign-op' } }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 13. Settlement identity: wrong child request digest ---
test('settlement with wrong child request digest is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), childBudgetSettlement: { ...settled().childBudgetSettlement, childRequestDigest: 'd'.repeat(64) } }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 14. Settlement limit: usage exceeds reservation ---
test('settlement with model calls exceeding reservation is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), resourceUsage: { ...settled().resourceUsage, modelCalls: 6 } }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 15. Settlement terminal digest required ---
test('settlement without terminal snapshot digest is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), childBudgetSettlement: { ...settled().childBudgetSettlement, terminalSnapshotDigest: '' } }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 16. Repeated identical settlement: zero descendant increment ---
test('repeated identical settlement produces zero usage delta', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  const r2 = reduceChildBudget(s2, settled(), settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical);
  assert.deepEqual(r2.usage, { inputTokens: 13, outputTokens: 7, modelCalls: 2, toolCalls: 3, cost: 0 });
  const s3 = { ...snap(), childBudgetReservations: r2.childBudgetReservations, childRunIds: r2.childRunIds, descendantUsage: r2.usage };
  const r3 = reduceChildBudget(s3, settled(), settleDef(), 'collect-again', call('collect-again-call', 'collect_child'), admittedToolBudget(s3, config()), canonical);
  assert.deepEqual(r3.usage, emptyUsage()); // zero delta on repeat
});

// --- 17. Changed settlement usage is rejected ---
test('settlement with changed usage on repeat is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  const r2 = reduceChildBudget(s2, settled(), settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical);
  const s3 = { ...snap(), childBudgetReservations: r2.childBudgetReservations, childRunIds: r2.childRunIds, descendantUsage: r2.usage };
  assert.throws(() => reduceChildBudget(s3, { ...settled(), resourceUsage: { ...settled().resourceUsage, modelCalls: 1 } }, settleDef(), 'collect-again', call('collect-again-call', 'collect_child'), admittedToolBudget(s3, config()), canonical),
    /child_budget_settlement_changed/);
});

// --- 18. Failed/canceled terminal states can be settled ---
test('settlement with error status is accepted', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  const result = reduceChildBudget(s2, { ...settled(), status: 'error' }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical);
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 7, modelCalls: 2, toolCalls: 3, cost: 0 });
});

// --- 19. Content JSON cannot forge reservation ---
test('tool without child budget policy cannot create a reservation', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started(), plainDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /child_budget_start_not_admitted/);
});
test('content JSON containing a reservation object does not create a budget reservation', () => {
  const s = snap();
  // The reservation is embedded in content, NOT in the childBudgetReservation field.
  // reduceChildBudget must not treat content data as a host authority.
  const result = reduceChildBudget(s,
    { status: 'ok', content: { childBudgetReservation: { ...reservation() } }, resourceUsage: emptyUsage() },
    plainDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical);
  assert.equal(result.childBudgetReservations.length, 0);
  assert.equal(result.childRunIds.length, 0);
  assert.deepEqual(result.usage, emptyUsage());
});

// --- 29. Settlement with changed terminalSnapshotDigest on repeat is rejected ---
test('settlement with changed terminalSnapshotDigest on repeat is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  const r2 = reduceChildBudget(s2, settled(), settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical);
  const s3 = { ...snap(), childBudgetReservations: r2.childBudgetReservations, childRunIds: r2.childRunIds, descendantUsage: r2.usage };
  // Same settlement but different terminalSnapshotDigest → sealed digest differs → rejected
  assert.throws(() => reduceChildBudget(s3,
    { ...settled(), childBudgetSettlement: { ...settled().childBudgetSettlement, terminalSnapshotDigest: 'd'.repeat(64) } },
    settleDef(), 'collect-again', call('collect-again-call', 'collect_child'), admittedToolBudget(s3, config()), canonical),
    /child_budget_settlement_changed/);
});

// --- 30. toolCalls exceeding reservation rejected ---
test('settlement with tool calls exceeding reservation is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started({ maxToolCalls: 2 }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), resourceUsage: { ...settled().resourceUsage, toolCalls: 3 } }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 20. Settlement without settle/v1 policy rejected ---
test('settlement without settle/v1 policy is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, settled(), startDef(), 'collect-op', call('collect-call', 'start_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_not_admitted/);
});

// --- 21. Settlement with approval_required status rejected ---
test('settlement with approval_required status is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), status: 'approval_required' }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /invalid_child_budget_settlement_receipt/);
});

// --- 22. Settlement with uncertain status rejected ---
test('settlement with uncertain status is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), status: 'uncertain' }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /invalid_child_budget_settlement_receipt/);
});

// --- 23. Budget exceeds admission: model calls ---
test('start reservation exceeding model budget is rejected', () => {
  const s = snap();
  const c = config({ maxModelCalls: 5 }); // 5 - 2 used - 1 final = 2 remaining
  assert.throws(() => reduceChildBudget(s, started({ maxModelCalls: 3 }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, c), canonical),
    /child_budget_start_exceeds_admission/);
});

// --- 24. Budget exceeds admission: tool calls ---
test('start reservation exceeding tool budget is rejected', () => {
  const s = snap();
  const c = config({ maxToolCalls: 5 }); // 5 - 1 used - 1 invoking = 3 remaining; child wants 6 + 1 collection = 7
  assert.throws(() => reduceChildBudget(s, started({ maxToolCalls: 6 }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, c), canonical),
    /child_budget_start_exceeds_admission/);
});

// --- 25. Settlement child run id not in result.childRunIds ---
test('settlement without child run id in result is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), childRunIds: [] }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 26. Reservation with settled digest already set is invalid ---
test('reservation with pre-set settled usage digest is invalid', () => {
  const s = snap();
  assert.throws(() => reduceChildBudget(s, started({ settledUsageDigest: 'pre-set' }), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s, config()), canonical),
    /invalid_child_budget_reservation/);
});

// --- 27. Settlement identity: child run ids count must be exactly 1 ---
test('settlement with duplicate child run id in result is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { ...settled(), childRunIds: ['child-run', 'child-run'] }, settleDef(), 'collect-op', call('collect-call', 'collect_child'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_or_limit_conflict/);
});

// --- 28. Non-settlement result with child run id matching a reservation requires settlement ---
test('result with child run id matching a reservation but no settlement is rejected', () => {
  const s1 = snap();
  const r1 = reduceChildBudget(s1, started(), startDef(), 'start-op', call('start-call', 'start_child'), admittedToolBudget(s1, config()), canonical);
  const s2 = { ...snap(), childBudgetReservations: r1.childBudgetReservations, childRunIds: r1.childRunIds };
  assert.throws(() => reduceChildBudget(s2, { status: 'ok', content: {}, childRunIds: ['child-run'], resourceUsage: emptyUsage() }, plainDef(), 'op', call('call', 'read'), admittedToolBudget(s2, config()), canonical),
    /child_budget_settlement_identity_required/);
});
