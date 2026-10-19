/** Keyless verification against built, pinned DSH services; no model or local-computer calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantApprovalBridge } from '../src/assistant-approval-bridge.mjs';
import { createAssistantLocalHandoff, createSimulatedLocalExecutor } from '../src/assistant-local-handoff.mjs';

if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set AGENTKIT_DSH_ROOT to the isolated, built pinned DSH checkout');
const root = resolve(process.env.AGENTKIT_DSH_ROOT);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(commit, '687f282e8625c6b8d11ff58211a90524be2e4317', 'Verify the declared DSH revision');
const require = createRequire(join(root, 'packages/llm/llm-retry/package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load('cordis');
const { default: ApprovalService, setApprovalPolicy } = await import(pathToFileURL(join(root, 'packages/interaction/user-approval/lib/index.js')).href);
const report = { evidence: 'real-built-dsh-approval-and-session-projection', dshCommit: commit,
  dshSourceModified: Boolean(execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: root, encoding: 'utf8' }).trim()),
  modelCalls: 0, localComputerCalls: 0, productionPolicyChanged: false, cases: [] };
const sessionId = 'assistant-interaction-proof';

async function host(hostId, policy) {
  const ctx = new Context();
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await load(`dsh-${name}`)).default);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  await ctx.plugin(ApprovalService, { policy });
  const handle = await ctx.agents.create({ sessionId });
  // A real Host already has a generic owner-UI answerer before Studio loads.
  // It must not consume this exact cloud Session's questions first.
  let fallbackCalls = 0;
  ctx.on('approval/request', () => { fallbackCalls++; return Promise.resolve('unavailable'); });
  const scope = { ctx, hostId, ownsSession: value => value === sessionId };
  const bridge = createAssistantApprovalBridge({ ...scope, enabled: true, policyOf: () => 'ask' });
  let turn = 0;
  return { ctx, handle, bridge, scope, agent: handle.agent, fallbackCalls: () => fallbackCalls,
    open: () => handle.agent.session.append('turn/start', { turn: ++turn }),
    end: () => handle.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } }),
    request: signal => ctx.approval.request({ agent: handle.agent, toolName: 'read_file', callId: `call-${turn}`,
      reason: 'Read the selected verification report once.', ...(signal ? { signal } : {}) }),
    close: async () => { bridge.dispose(); await handle.dispose(); await ctx.fiber.dispose(); },
  };
}

async function question(subject) {
  await new Promise(setImmediate);
  const pending = subject.bridge.snapshot(sessionId).pending;
  assert.equal(pending.length, 1);
  return pending[0];
}

const left = await host('cloud-left', 'ask'), right = await host('cloud-right', 'ask'), never = await host('cloud-never', 'never');
try {
  left.open(); right.open();
  const leftResult = left.request(), rightResult = right.request();
  const leftQuestion = await question(left), rightQuestion = await question(right);
  assert.equal(leftQuestion.sessionId, rightQuestion.sessionId);
  assert.deepEqual(right.bridge.decide(sessionId, { ...leftQuestion, decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  assert.deepEqual(left.bridge.decide(sessionId, { ...leftQuestion, decision: 'allowed-once' }), { accepted: true, outcome: 'allowed-once' });
  assert.deepEqual(right.bridge.decide(sessionId, { ...rightQuestion, decision: 'rejected' }), { accepted: true, outcome: 'rejected' });
  assert.equal(await leftResult, 'allowed-once'); assert.equal(await rightResult, 'rejected');
  const audits = left.agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'));
  assert.deepEqual(audits.map(event => event.type), ['approval/asked', 'approval/decided']);
  assert.equal(audits[0].data.id, audits[1].data.id);
  assert.notEqual(audits[0].data.id, leftQuestion.requestId, 'transport correlation is never an audit replay key');
  assert.equal(audits[1].data.outcome, 'allowed-once');
  left.end(); right.end();
  report.cases.push({ name: 'two-real-hosts-same-session-id-one-shot-audited-outcomes', passed: true });
  assert.equal(left.fallbackCalls(), 0); assert.equal(right.fallbackCalls(), 0);
  const foreign = await left.ctx.agents.create({ sessionId: 'unowned-interaction-proof' });
  try {
    foreign.agent.session.append('turn/start', { turn: 1 });
    assert.equal(await left.ctx.approval.request({ agent: foreign.agent, toolName: 'read_file', reason: 'Foreign Session uses its existing answerer.' }), 'unavailable');
    assert.equal(left.fallbackCalls(), 1);
    assert.deepEqual(left.bridge.snapshot(foreign.agent.session.id).pending, []);
    foreign.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  } finally { await foreign.dispose(); }
  report.cases.push({ name: 'owned-live-bridge-precedes-generic-answerer-and-foreign-sessions-still-delegate', passed: true });


  never.open();
  assert.equal(await never.request(), 'rejected');
  assert.deepEqual(never.bridge.snapshot(sessionId).pending, []);
  never.end();
  report.cases.push({ name: 'native-never-policy-wins-before-enabled-answerer-dispatch', passed: true });

  left.open();
  const aborted = new AbortController(), cancelled = left.request(aborted.signal), withdrawn = await question(left);
  aborted.abort(); assert.equal(await cancelled, 'cancelled');
  assert.deepEqual(left.bridge.decide(sessionId, { ...withdrawn, decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  left.end();
  report.cases.push({ name: 'native-request-cancellation-rejects-late-answer', passed: true });

  left.open();
  const disconnected = left.request(), historical = await question(left);
  left.bridge.disconnect(sessionId); assert.equal(await disconnected, 'unavailable'); left.end();
  const replacement = createAssistantApprovalBridge({ ...left.scope, enabled: true, policyOf: () => 'ask' });
  try {
    assert.deepEqual(replacement.snapshot(sessionId).pending, []);
    assert.deepEqual(replacement.decide(sessionId, { ...historical, decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  } finally { replacement.dispose(); }
  report.cases.push({ name: 'disconnect-and-new-bridge-do-not-resurrect-native-audit', passed: true });

  left.open();
  const policyChanged = left.request(), beforeChange = await question(left);
  // This isolated test Session is deliberately modified; no deployment policy changes.
  setApprovalPolicy(left.agent.session, 'never');
  assert.deepEqual(left.bridge.decide(sessionId, { ...beforeChange, decision: 'allowed-once' }), { accepted: false, reason: 'request-stale' });
  assert.equal(await policyChanged, 'rejected'); left.end();
  report.cases.push({ name: 'native-never-override-withdraws-existing-question-despite-stale-callback', passed: true });

  left.open();
  const simulated = createSimulatedLocalExecutor();
  const handoff = createAssistantLocalHandoff({ ...left.scope, executor: simulated, requestConfirmation: async () => 'allowed-once' });
  const production = createAssistantLocalHandoff(left.scope);
  try {
    assert.equal(production.capabilities().supported, false);
    assert.equal(production.capabilities().executesLocally, false);
    const { offer } = handoff.offer(sessionId, { kind: 'read-file', path: 'report.txt', maxBytes: 512 });
    const result = await handoff.execute(sessionId, offer);
    assert.equal(result.status, 'simulated'); assert.equal(result.receipt.executed, false);
    assert.equal(simulated.calls().length, 1);
    assert.deepEqual(await handoff.execute(sessionId, offer), { accepted: false, reason: 'offer-stale' });
  } finally { handoff.dispose(); production.dispose(); }
  left.end();
  report.cases.push({ name: 'real-session-bound-handoff-remains-simulation-only', passed: true });
} finally { await Promise.all([left.close(), right.close(), never.close()]); }

const output = resolve(process.argv[2] || '.artifacts/assistant-interactions.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
