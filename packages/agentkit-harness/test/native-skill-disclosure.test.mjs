import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, emptyUsage, configure, scopeKey, canonical, copy } from '../../agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { fixture, scope, digest, acceptance, verificationReport } from '../../agentkit-harness-core/test/fixtures.mjs';
import {
  nativeSkillDisclosureDefinitions, createNativeSkillDisclosurePort,
  SKILL_CATALOG_TOOL, SKILL_MANIFEST_TOOL, SKILL_INSTRUCTIONS_TOOL, SKILL_RESOURCE_TOOL,
} from '../src/native/skill-disclosure.mjs';

// Import the REAL createNativeToolAuthority from main-line code.
import { createNativeToolAuthority } from '../../../src/providers/native-tool-authority.mjs';

for (const action of ['replace signal', 'close port']) {
  test(`actual final authority callback cannot ${action} and publish successful instructions`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'disc-last-guard-'));
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const actualAuthority = createNativeToolAuthority({ scope, sessionId: 's1', store });
    const source = makeSource(SKILLS);
    let returned = false, postReadChecks = 0, owner;
    source.fullText = () => { returned = true; return SKILLS['sk-a'].body; };
    await runKernelWithPause(store, SKILLS, [{ name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } }], {
      portOptions: { source, onCreate: port => { owner = port; }, assertCurrent(request) {
        const accepted = actualAuthority(request);
        if (returned && ++postReadChecks === 2) {
          if (action === 'close port') owner.close();
          else request.signal = new AbortController().signal;
        }
        return accepted;
      } },
    });
    const record = store.load(scope, 'run1');
    const results = record.receipts.filter(receipt => record.intents.some(intent => intent.kind === 'tool'
      && intent.operationKey === receipt.operationKey)).flatMap(receipt => receipt.result?.results ?? []);
    assert.equal(postReadChecks, 2, 'mutation happens in the last callback after the real ledger authority check');
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'error');
    assert.equal(results[0].content.code, action === 'close port' ? 'SKILL_AUTHORIZATION_EXPIRED' : 'NATIVE_SKILL_SIGNAL_DRIFT');
  });
}

const SKILLS = {
  'sk-a': { name: 'alpha', summary: 'Alpha skill', body: 'Use scripts/run.sh to deploy', resources: { 'scripts/run.sh': 'echo hi' } },
};

test('actual committed instructions cannot authorize a resource outside the canonical Skill namespace', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-resource-namespace-'));
  const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let resourceReads = 0;
  const source = { manifest: () => ({ name: 'alpha', summary: 's', resourceRefs: ['../secret'] }),
    fullText: () => 'Read ../secret', resource: () => { resourceReads++; return Buffer.from('must-not-be-read'); } };
  await runKernelWithPause(store, SKILLS, [
    { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
    { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: '../secret' } },
  ], { portOptions: { source } });
  const record = store.load(scope, 'run1');
  const results = record.receipts.filter(receipt => record.intents.some(intent => intent.kind === 'tool'
    && intent.operationKey === receipt.operationKey)).flatMap(receipt => receipt.result?.results ?? []);
  assert.equal(results[0].status, 'ok', 'the actual instruction receipt is committed');
  assert.equal(results[1].status, 'error');
  assert.equal(results[1].content.code, 'invalid_skill_resource_ref');
  assert.equal(resourceReads, 0);
});

function makeSource(skills) {
  return {
    manifest(id) { const s = skills[id]; if (!s) throw new Error('nf'); return { name: s.name, summary: s.summary, conditions: '', requiredTools: [], resourceRefs: null }; },
    fullText(id) { const s = skills[id]; if (!s) throw new Error('nf'); return s.body || ''; },
    resource(id, ref) { const s = skills[id]; if (!s) throw new Error('nf'); const c = s.resources?.[ref]; if (c === undefined) throw new Error('nf'); return typeof c === 'string' ? Buffer.from(c, 'utf-8') : c; },
  };
}

function makePort(store, skills, skillRefs, { authorize, assertCurrent, source = makeSource(skills), onCreate } = {}) {
  const port = createNativeSkillDisclosurePort({
    scope, sessionId: 's1', store, source, skillRefs: skillRefs || Object.keys(skills),
    authorize: authorize || (async () => 'allow'),
    assertCurrent: assertCurrent || createNativeToolAuthority({ scope, sessionId: 's1', store }),
  });
  onCreate?.(port);
  return port;
}

// Real Kernel: passes raw req directly. Uses onCheckpoint to pause after first tool.
async function runKernelWithPause(store, skills, toolCalls, { onCheckpoint, portOptions } = {}) {
  const port = makePort(store, skills, Object.keys(skills), portOptions);
  const defs = port.definitions;
  const baseConfig = fixture().config;
  const config = configure({
    ...baseConfig, contract: { ...baseConfig.contract, objective: 'Read skill', acceptance: [acceptance()] },
    tools: defs, inputMessages: [{ role: 'user', content: 'Read skill' }],
  });
  let mc = 0;
  const ports = {
    model: { generate: async () => {
      mc++;
      if (mc <= toolCalls.length) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: `tc${mc}`, ...toolCalls[mc - 1] }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async (req) => {
      const result = await port.execute(req);
      if (result.status === 'approval_required') return result;
      return { status: result.status === 'ok' ? 'ok' : 'error', content: result.content };
    } },
    context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
    verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
  };
  const kernel = new NativeKernel({ store, ports, digest, owner: 'test', onCheckpoint });
  kernel.start({ ...fixture().snapshot, runId: 'run1', parentRunId: null, sessionId: 's1', buildId: 'b1', taskChainId: 'c1' }, config);
  return kernel.runUntilIdle(scope, 'run1');
}

// --- definitions ---
test('4 formal tools, all readOnly', () => {
  const defs = nativeSkillDisclosureDefinitions();
  assert.equal(defs.length, 4);
  for (const d of defs) assert.equal(d.readOnly, true);
});

// --- real kernel: instructions → resource in same active Run (real authority) ---
test('real kernel: instructions → resource in same active Run → completed (real authority)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-k1-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const result = await runKernelWithPause(store, SKILLS, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
      { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } },
    ]);
    assert.equal(result.phase, 'completed', `phase=${result.phase} reason=${result.reason}`);
    const rec = store.load(scope, 'run1');
    const preparedToolEvents = (rec.events ?? []).filter(e => e.kind === 'effect.prepared' && e.payload?.kind === 'tool');
    assert.ok(preparedToolEvents.length > 0, 'effect.prepared events exist');
    const toolReceipts = rec.receipts.filter(r => r.status === 'committed' && rec.intents.some(i => i.operationKey === r.operationKey && i.kind === 'tool'));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.resource_ref === 'scripts/run.sh' && res.status === 'ok');
    assert.ok(resourceResult, 'resource granted');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- real kernel: resource before instructions → rejected ---
test('real kernel: resource before instructions → tool error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-k2-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const result = await runKernelWithPause(store, SKILLS, [
      { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } },
    ]);
    assert.equal(result.phase, 'completed');
    const rec = store.load(scope, 'run1');
    const toolIntents = rec.intents.filter(i => i.kind === 'tool');
    const toolReceipts = rec.receipts.filter(r => toolIntents.some(i => i.operationKey === r.operationKey));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.code === 'skill_disclosure_order_invalid');
    assert.ok(resourceResult, 'resource denied with order_invalid');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- real kernel: Run isolation with unique runIds ---
test('real kernel: instructions in run1, resource in run2 → rejected (unique runIds)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-k3-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    // Run 1: instructions only.
    const result1 = await runKernelWithPause(store, SKILLS, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
    ]);
    assert.equal(result1.phase, 'completed');
    // Run 2: resource only (unique runId).
    const port = makePort(store, SKILLS, Object.keys(SKILLS));
    const defs = port.definitions;
    const config = configure({ ...fixture().config, contract: { ...fixture().config.contract, objective: 'Read skill', acceptance: [acceptance()] }, tools: defs, inputMessages: [{ role: 'user', content: 'Read' }] });
    let mc2 = 0;
    const ports2 = {
      model: { generate: async () => { mc2++; if (mc2 === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc1', name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } }], usage: emptyUsage() }; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: async (req) => { const result = await port.execute(req); return { status: result.status === 'ok' ? 'ok' : 'error', content: result.content }; } },
      context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
      verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
    };
    const kernel2 = new NativeKernel({ store, ports: ports2, digest, owner: 'test' });
    kernel2.start({ ...fixture().snapshot, runId: 'run2', parentRunId: null, sessionId: 's1', buildId: 'b1', taskChainId: 'c1' }, config);
    const result2 = await kernel2.runUntilIdle(scope, 'run2');
    assert.equal(result2.phase, 'completed');
    assert.ok(store.load(scope, 'run1'), 'run1 record exists');
    assert.ok(store.load(scope, 'run2'), 'run2 record exists');
    const rec2 = store.load(scope, 'run2');
    const toolIntents2 = rec2.intents.filter(i => i.kind === 'tool');
    const toolReceipts2 = rec2.receipts.filter(r => toolIntents2.some(i => i.operationKey === r.operationKey));
    const allResults2 = toolReceipts2.flatMap(r => r.result?.results ?? []);
    const resourceResult2 = allResults2.find(res => res.content?.code === 'skill_disclosure_order_invalid');
    assert.ok(resourceResult2, 'resource denied in run2');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- SQLite reopen: instructions committed, pause, reopen, resume → resource ---
test('pause after instructions, reopen store, resume → resource succeeds (real authority)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-k5-'));
  try {
    const dbPath = join(dir, 'runs.sqlite');
    let toolCompleted = false;
    const store1 = new SqliteRunStore(dbPath);
    const port1 = makePort(store1, SKILLS, Object.keys(SKILLS));
    const defs1 = port1.definitions;
    const config1 = configure({ ...fixture().config, contract: { ...fixture().config.contract, objective: 'Read skill', acceptance: [acceptance()] }, tools: defs1, inputMessages: [{ role: 'user', content: 'Read skill' }] });
    let mc1 = 0;
    const ports1 = {
      model: { generate: async () => { mc1++; if (mc1 === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc1', name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } }], usage: emptyUsage() }; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: async (req) => { const result = await port1.execute(req); return { status: result.status === 'ok' ? 'ok' : 'error', content: result.content }; } },
      context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
      verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
    };
    const kernel1 = new NativeKernel({ store: store1, ports: ports1, digest, owner: 'test',
      onCheckpoint: async (snapshot) => {
        if (!toolCompleted && snapshot.usage.toolCalls > 0) {
          toolCompleted = true;
          kernel1.submit(scope, 'run1', { commandId: 'pause1', kind: 'pause', payload: {} });
        }
      } });
    kernel1.start({ ...fixture().snapshot, runId: 'run1', parentRunId: null, sessionId: 's1', buildId: 'b1', taskChainId: 'c1' }, config1);
    const paused = await kernel1.runUntilIdle(scope, 'run1');
    assert.equal(paused.phase, 'paused', `phase=${paused.phase} reason=${paused.reason}`);
    // Verify the instructions receipt is committed.
    const rec1 = store1.load(scope, 'run1');
    const instructionsReceipt = rec1.receipts.find(r => r.status === 'committed' && rec1.intents.some(i => i.operationKey === r.operationKey && i.kind === 'tool' && i.payload?.calls?.some(c => c.name === SKILL_INSTRUCTIONS_TOOL)));
    assert.ok(instructionsReceipt, 'instructions receipt committed before pause');
    // Close port and store (simulating process exit).
    store1.close();
    // Reopen store.
    const store2 = new SqliteRunStore(dbPath);
    // Create new port with real ToolAuthority pointing to reopened store.
    const port2 = makePort(store2, SKILLS, Object.keys(SKILLS));
    const defs2 = port2.definitions;
    // Resume the paused run with a new kernel that calls resource.
    let mc2 = 0;
    const ports2 = {
      model: { generate: async () => { mc2++; if (mc2 === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc2', name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } }], usage: emptyUsage() }; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: async (req) => { const result = await port2.execute(req); return { status: result.status === 'ok' ? 'ok' : 'error', content: result.content }; } },
      context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
      verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
    };
    // Resume the paused run.
    const kernel2 = new NativeKernel({ store: store2, ports: ports2, digest, owner: 'test-resume' });
    kernel2.submit(scope, 'run1', { commandId: 'resume1', kind: 'resume', payload: {} });
    const result2 = await kernel2.runUntilIdle(scope, 'run1');
    assert.equal(result2.phase, 'completed', `phase=${result2.phase} reason=${result2.reason}`);
    // Verify resource was granted (L2 restored from committed instructions receipt).
    const rec2 = store2.load(scope, 'run1');
    const toolReceipts2 = rec2.receipts.filter(r => r.status === 'committed' && rec2.intents.some(i => i.operationKey === r.operationKey && i.kind === 'tool'));
    const allResults2 = toolReceipts2.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults2.find(res => res.content?.resource_ref === 'scripts/run.sh' && res.status === 'ok');
    assert.ok(resourceResult, 'resource granted after pause→reopen→resume');
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- events-stripped no-grant ---
test('restoreRun without effect.prepared events → no L2 grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-noevents-'));
  try {
    const dbPath = join(dir, 'runs.sqlite');
    const store1 = new SqliteRunStore(dbPath);
    const result1 = await runKernelWithPause(store1, SKILLS, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
    ]);
    assert.equal(result1.phase, 'completed');
    store1.close();
    // Create a wrapped store that strips events.
    const store2 = new SqliteRunStore(dbPath);
    const originalLoad = store2.load.bind(store2);
    store2.load = (s, runId) => {
      const record = originalLoad(s, runId);
      return { ...record, events: [] };
    };
    const port = createNativeSkillDisclosurePort({
      scope, sessionId: 's1', store: store2, source: makeSource(SKILLS), skillRefs: ['sk-a'],
      authorize: async () => 'allow', assertCurrent: () => true,
    });
    const rec = originalLoad(scope, 'run1');
    const toolIntent = rec.intents.find(i => i.kind === 'tool' && i.payload?.calls?.some(c => c.name === SKILL_INSTRUCTIONS_TOOL));
    const def = port.definitions.find(d => d.name === SKILL_RESOURCE_TOOL);
    const r = await port.execute({
      call: { callId: 'c2', name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } },
      signal: new AbortController().signal,
      scope: rec.snapshot.scope, runId: 'run1', sessionId: rec.snapshot.sessionId, turnId: rec.snapshot.turnId,
      buildId: rec.snapshot.buildId, parentRunId: rec.snapshot.parentRunId, taskChainId: rec.snapshot.taskChainId,
      operationKey: toolIntent.operationKey, executionFence: 1, definition: def,
    });
    assert.equal(r.status, 'error', 'resource must NOT be granted without events');
    assert.equal(r.content.code, 'skill_disclosure_order_invalid');
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- approval_required: real Kernel awaiting_interaction → submit interaction ---
test('real kernel: approval_required → awaiting_interaction → allow → resource succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-appr-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    // Phase 1: Kernel calls instructions, authorize returns approval_required.
    let authorizeCallCount = 0;
    const port1 = createNativeSkillDisclosurePort({
      scope, sessionId: 's1', store, source: makeSource(SKILLS), skillRefs: ['sk-a'],
      authorize: async () => { authorizeCallCount++; return { status: 'approval_required', interactionId: 'actual-i' }; },
      assertCurrent: () => true, // For approval test, assertCurrent passes (no real lease needed for this path)
    });
    const defs1 = port1.definitions;
    const config1 = configure({ ...fixture().config, contract: { ...fixture().config.contract, objective: 'Read skill', acceptance: [acceptance()] }, tools: defs1, inputMessages: [{ role: 'user', content: 'Read skill' }] });
    let mc1 = 0;
    const ports1 = {
      model: { generate: async () => { mc1++; if (mc1 === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc1', name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } }], usage: emptyUsage() }; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: async (req) => { const result = await port1.execute(req); return result; } },
      context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
      verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
    };
    const kernel1 = new NativeKernel({ store, ports: ports1, digest, owner: 'test' });
    kernel1.start({ ...fixture().snapshot, runId: 'run1', parentRunId: null, sessionId: 's1', buildId: 'b1', taskChainId: 'c1' }, config1);
    const result1 = await kernel1.runUntilIdle(scope, 'run1');
    assert.equal(result1.phase, 'awaiting_interaction', `phase=${result1.phase} reason=${result1.reason}`);
    // Verify the interaction ID matches.
    const pendingInteraction = result1.pendingInteraction;
    assert.ok(pendingInteraction, 'pendingInteraction exists');
    assert.equal(pendingInteraction.hostInteractionId, 'actual-i');
    // Phase 2: Submit interaction allow.
    kernel1.submit(scope, 'run1', { commandId: 'resp1', kind: 'submit_interaction', payload: { interactionId: pendingInteraction.interactionId, decision: 'allow' } });
    // Now create a port with allow authorize for the resumed run.
    let mc2 = 0;
    const port2 = createNativeSkillDisclosurePort({
      scope, sessionId: 's1', store, source: makeSource(SKILLS), skillRefs: ['sk-a'],
      authorize: async () => 'allow', assertCurrent: createNativeToolAuthority({ scope, sessionId: 's1', store }),
    });
    const ports2 = {
      model: { generate: async () => { mc2++; if (mc2 === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc2', name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } }], usage: emptyUsage() }; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: async (req) => { const result = await port2.execute(req); return { status: result.status === 'ok' ? 'ok' : 'error', content: result.content }; } },
      context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
      verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
    };
    // Can't swap ports on existing kernel. Need new kernel.
    const kernel2 = new NativeKernel({ store, ports: ports2, digest, owner: 'test-resume' });
    const result2 = await kernel2.runUntilIdle(scope, 'run1');
    assert.equal(result2.phase, 'completed', `phase=${result2.phase} reason=${result2.reason}`);
    // Verify resource was granted (instructions was approved → L2 → resource ok).
    const rec = store.load(scope, 'run1');
    const toolReceipts = rec.receipts.filter(r => r.status === 'committed' && rec.intents.some(i => i.operationKey === r.operationKey && i.kind === 'tool'));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.resource_ref === 'scripts/run.sh' && res.status === 'ok');
    assert.ok(resourceResult, 'resource granted after approval allow');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- approval_required: deny → tool error ---
test('real kernel: approval_required → awaiting_interaction → allow → resource succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-appr-allow-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    let authorizeCallCount = 0;
    // Phase 1: authorize returns approval_required on first call.
    const port1 = createNativeSkillDisclosurePort({
      scope, sessionId: 's1', store, source: makeSource(SKILLS), skillRefs: ['sk-a'],
      authorize: async () => { authorizeCallCount++; if (authorizeCallCount === 1) return { status: 'approval_required', interactionId: 'allow-i' }; return 'allow'; },
      assertCurrent: () => true,
    });
    const defs1 = port1.definitions;
    const config1 = configure({ ...fixture().config, contract: { ...fixture().config.contract, objective: 'Read skill', acceptance: [acceptance()] }, tools: defs1, inputMessages: [{ role: 'user', content: 'Read skill' }] });
    let mc1 = 0;
    const ports1 = {
      model: { generate: async () => { mc1++; if (mc1 === 1) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc1', name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } }], usage: emptyUsage() }; if (mc1 === 2) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'tc2', name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'scripts/run.sh' } }], usage: emptyUsage() }; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
      tools: { execute: async (req) => { const result = await port1.execute(req); return result; } },
      context: { prepare: async (req) => ({ messages: req.snapshot.messages, context: {} }) },
      verification: { verify: async (req) => verificationReport(req, { workspaceDependency: 'none' }) },
    };
    const kernel1 = new NativeKernel({ store, ports: ports1, digest, owner: 'test' });
    kernel1.start({ ...fixture().snapshot, runId: 'run1', parentRunId: null, sessionId: 's1', buildId: 'b1', taskChainId: 'c1' }, config1);
    const result1 = await kernel1.runUntilIdle(scope, 'run1');
    assert.equal(result1.phase, 'awaiting_interaction');
    assert.equal(result1.pendingInteraction.hostInteractionId, 'allow-i');
    // Submit allow.
    kernel1.submit(scope, 'run1', { commandId: 'resp1', kind: 'submit_interaction', payload: { interactionId: result1.pendingInteraction.interactionId, decision: 'allow' } });
    const result2 = await kernel1.runUntilIdle(scope, 'run1');
    assert.equal(result2.phase, 'completed', `phase=${result2.phase} reason=${result2.reason}`);
    // Verify resource was granted (instructions approved → L2 → resource ok).
    const rec = store.load(scope, 'run1');
    const toolReceipts = rec.receipts.filter(r => r.status === 'committed' && rec.intents.some(i => i.operationKey === r.operationKey && i.kind === 'tool'));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.resource_ref === 'scripts/run.sh' && res.status === 'ok');
    assert.ok(resourceResult, 'resource granted after approval allow');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- budget drift ---
test('budget drift after authorize → rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-budget-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { authorize: async (req) => { req.budget = 1; return 'allow'; }, assertCurrent: () => true });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def, budget: 1000 });
    assert.equal(r.status, 'error');
    assert.match(r.content.code, /DRIFT|EXPIRED|CANCELLED/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- missing definition ---
test('missing definition → rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-nodef-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { assertCurrent: () => true });
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1 });
    assert.equal(r.content.code, 'NATIVE_SKILL_DEFINITION_MISSING');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- store mandatory ---
test('createNativeSkillDisclosurePort requires store', () => {
  assert.throws(() => createNativeSkillDisclosurePort({ scope, sessionId: 's1', source: makeSource({}), skillRefs: ['a'], authorize: async () => 'allow', assertCurrent: () => true }), /store_required/);
});

// --- foreign scope ---
test('foreign scope → rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-fscope-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { assertCurrent: () => true });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope: { ...scope, agentId: 'EVIL' }, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.content.code, 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- assertCurrent false ---
test('assertCurrent false → rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-acf-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { assertCurrent: () => false });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.content.code, 'SKILL_AUTHORIZATION_EXPIRED');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- assertCurrent changes false after authorize ---
test('assertCurrent changes false after authorize → rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-aca-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    let live = true;
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { authorize: async () => { live = false; return 'allow'; }, assertCurrent: () => live });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.match(r.content.code, /EXPIRED|DRIFT|CANCELLED/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- async source non-string ---
test('async fullText returning non-string → error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-async-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const source = { manifest: () => ({ name: 'a', summary: 's', conditions: '', requiredTools: [], resourceRefs: null }), fullText: async () => ({ not: 'string' }), resource: () => Buffer.from('') };
    const port = createNativeSkillDisclosurePort({ scope, sessionId: 's1', store, source, skillRefs: ['sk-a'], authorize: async () => 'allow', assertCurrent: () => true });
    const def = port.definitions.find(d => d.name === SKILL_INSTRUCTIONS_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.content.code, 'skill_source_unavailable');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- resource edge cases via real kernel ---
test('real kernel: resource exceeds 32768 → error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-big-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const bigSkills = { 'sk-a': { name: 'a', summary: 's', body: 'uses big.txt', resources: { 'big.txt': Buffer.alloc(32769, 0x41) } } };
    const result = await runKernelWithPause(store, bigSkills, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
      { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'big.txt' } },
    ]);
    assert.equal(result.phase, 'completed');
    const rec = store.load(scope, 'run1');
    const toolIntents = rec.intents.filter(i => i.kind === 'tool');
    const toolReceipts = rec.receipts.filter(r => toolIntents.some(i => i.operationKey === r.operationKey));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.code === 'skill_resource_too_large');
    assert.ok(resourceResult, 'resource too large error');
    assert.equal(resourceResult.status, 'error');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real kernel: resource exactly 32768 → ok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-exact-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const exactSkills = { 'sk-a': { name: 'a', summary: 's', body: 'uses exact.txt', resources: { 'exact.txt': Buffer.alloc(32768, 0x41) } } };
    const result = await runKernelWithPause(store, exactSkills, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
      { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'exact.txt' } },
    ]);
    assert.equal(result.phase, 'completed');
    const rec = store.load(scope, 'run1');
    const toolIntents = rec.intents.filter(i => i.kind === 'tool');
    const toolReceipts = rec.receipts.filter(r => toolIntents.some(i => i.operationKey === r.operationKey));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.resource_ref === 'exact.txt');
    assert.equal(resourceResult?.status, 'ok');
    assert.equal(resourceResult.content.text.length, 32768);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real kernel: binary resource → base64', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-bin-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const binSkills = { 'sk-a': { name: 'a', summary: 's', body: 'uses icon.png', resources: { 'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) } } };
    const result = await runKernelWithPause(store, binSkills, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
      { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'icon.png' } },
    ]);
    assert.equal(result.phase, 'completed');
    const rec = store.load(scope, 'run1');
    const toolIntents = rec.intents.filter(i => i.kind === 'tool');
    const toolReceipts = rec.receipts.filter(r => toolIntents.some(i => i.operationKey === r.operationKey));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.resource_ref === 'icon.png');
    assert.equal(resourceResult?.status, 'ok');
    assert.equal(resourceResult.content.encoding, 'base64');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real kernel: undeclared resource ref when locked → error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-lock-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const lockedSkills = { 'sk-a': { name: 'a', summary: 's', body: 'body', resourceRefs: ['allowed.txt'], resources: { 'allowed.txt': 'ok', 'evil.sh': 'evil' } } };
    const result = await runKernelWithPause(store, lockedSkills, [
      { name: SKILL_INSTRUCTIONS_TOOL, arguments: { skill_id: 'sk-a' } },
      { name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a', resource_ref: 'evil.sh' } },
    ]);
    assert.equal(result.phase, 'completed');
    const rec = store.load(scope, 'run1');
    const toolIntents = rec.intents.filter(i => i.kind === 'tool');
    const toolReceipts = rec.receipts.filter(r => toolIntents.some(i => i.operationKey === r.operationKey));
    const allResults = toolReceipts.flatMap(r => r.result?.results ?? []);
    const resourceResult = allResults.find(res => res.content?.code === 'skill_resource_unavailable');
    assert.ok(resourceResult, 'resource unavailable error');
    assert.equal(resourceResult.status, 'error');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- pre-aborted ---
test('pre-aborted signal → rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-abort-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { assertCurrent: () => true });
    const controller = new AbortController(); controller.abort();
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: controller.signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.content.code, 'REQUEST_CANCELLED');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- authorization denial ---
test('authorization denial → error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-denied-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { authorize: async () => ({ code: 'DENIED', message: 'no' }), assertCurrent: () => true });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.content.code, 'DENIED');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- schema validation ---
test('skill_read_resource missing resource_ref → schema rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-schema-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { assertCurrent: () => true });
    const def = port.definitions.find(d => d.name === SKILL_RESOURCE_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_RESOURCE_TOOL, arguments: { skill_id: 'sk-a' } }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.content.code, 'invalid_arguments');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- catalog stops after assertCurrent fails ---
test('catalog stops reading after assertCurrent fails mid-recommend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-cat-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    let manifestCalls = 0;
    let live = true;
    const source = {
      manifest(id) { manifestCalls++; return { name: id, summary: 's', conditions: '', requiredTools: [], resourceRefs: null }; },
      fullText: () => '', resource: () => Buffer.from(''),
    };
    const port = createNativeSkillDisclosurePort({
      scope, sessionId: 's1', store, source, skillRefs: ['sk-one', 'sk-two'],
      authorize: async () => 'allow',
      assertCurrent: () => { if (manifestCalls >= 1) live = false; return live; },
    });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: { query: '' } }, signal: new AbortController().signal, scope, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.status, 'error');
    assert.ok(manifestCalls < 2, `only ${manifestCalls} manifest calls`);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- port validation ---
test('rejects invalid skill_refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-refs-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    assert.throws(() => createNativeSkillDisclosurePort({ scope, sessionId: 's1', store, source: makeSource({}), skillRefs: [''], authorize: async () => 'allow', assertCurrent: () => true }), /skill_refs/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requires source and assertCurrent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-req-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    assert.throws(() => createNativeSkillDisclosurePort({ scope, sessionId: 's1', store, skillRefs: ['a'], authorize: async () => 'allow', assertCurrent: () => true }), /source_required/);
    assert.throws(() => createNativeSkillDisclosurePort({ scope, sessionId: 's1', store, source: makeSource({}), skillRefs: ['a'], authorize: async () => 'allow' }), /assert_current_required/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- definitions isolated ---
test('definitions are isolated between calls', () => {
  const d1 = nativeSkillDisclosureDefinitions();
  const d2 = nativeSkillDisclosureDefinitions();
  assert.notStrictEqual(d1, d2);
  assert.notStrictEqual(d1[0], d2[0]);
});

// --- safe error messages ---
test('error messages are bounded diagnostics (no raw paths)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-errsafe-'));
  try {
    const store = new SqliteRunStore(join(dir, 'runs.sqlite'));
    const port = makePort(store, SKILLS, Object.keys(SKILLS), { assertCurrent: () => true });
    const def = port.definitions.find(d => d.name === SKILL_CATALOG_TOOL);
    const r = await port.execute({ call: { callId: 'c1', name: SKILL_CATALOG_TOOL, arguments: {} }, signal: new AbortController().signal, scope: { ...scope, agentId: 'EVIL' }, runId: 'run1', sessionId: 's1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'op1', executionFence: 1, definition: def });
    assert.equal(r.status, 'error');
    assert.equal(r.content.message.includes('/'), false, 'no paths in message');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
