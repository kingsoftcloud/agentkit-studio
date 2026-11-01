import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeBoundPolicy, hasNativeBoundApproval } from '../src/providers/native-bound-policy.mjs';
import { authorizeNativeBuiltin } from '../src/providers/native-tool-policy.mjs';
import { NATIVE_AGENT_POLICY_CONTRACT, nativeAgentPolicyFromSpec, nativeAgentPolicyDecision } from '../src/native-agent-policy.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { nativeRecoveryBinding, assertNativeRecoveryPreset } from '../src/providers/native-recovery-binding.mjs';

const policy = (mode, rules = {}) => ({ contract: NATIVE_AGENT_POLICY_CONTRACT, mode, rules });
function setup(value, { mode = 'workspace-write', outcome = 'allowed-once' } = {}) {
  let listener, guard, approvals = 0;
  const reasons = [];
  const session = { id: 'session' };
  const ctx = { approval: { request: async request => { approvals++; reasons.push(request.reason); return outcome; } },
    sandboxPolicy: { resolve: () => ({ mode }) },
    tools: { guard: callback => { guard = callback; return () => { guard = null; }; } },
    on: (_event, callback) => { listener = callback; return () => { listener = null; }; } };
  const stop = installNativeBoundPolicy(ctx, value, (_agent, name) => name === 'read_workspace_file' ? { readOnly: true }
    : name === 'manage_memory' ? { readOnly: false, permissions: ['memory:write'] } : null);
  const exec = (name = 'save_crm', signal = new AbortController().signal) => ({ name, agent: { session },
    callId: 'call-1', arguments: { value: 1 }, signal });
  const admit = async (call, downstream = { kind: 'allow' }) => {
    const decision = listener ? await listener(call, async () => downstream) : downstream;
    if (decision.kind !== 'allow') return decision;
    const refusal = guard?.(call);
    return refusal ? { kind: 'deny', reason: refusal } : decision;
  };
  return { ctx, stop, exec, admit, reasons, guard: call => guard?.(call), get approvals() { return approvals; } };
}

test('strict asks once for the exact builtin call even in a permissive session', async () => {
  const f = setup(policy('strict')), exec = f.exec('write_workspace_file');
  assert.deepEqual(await f.admit(exec), { kind: 'allow' });
  await authorizeNativeBuiltin(f.ctx, exec, { readOnly: false }, { requireApproval: true });
  assert.equal(f.approvals, 1);
  assert.match(f.reasons[0], /参数摘要/);
  assert.doesNotMatch(f.reasons[0], /"value"/);
  assert.equal(hasNativeBoundApproval(f.ctx, { ...exec, arguments: { value: 2 } }), false);
  assert.equal(hasNativeBoundApproval(f.ctx, { ...exec }), false);
  assert.equal(await f.admit(f.exec('read_workspace_file')).then(result => result.kind), 'allow');
  assert.equal(f.approvals, 1);
  f.stop();
  assert.equal(hasNativeBoundApproval(f.ctx, exec), false);
});

test('strict asks for unknown MCP and Skill shell effects; denial and cancellation never dispatch', async () => {
  for (const name of ['save_crm', 'bash']) {
    const f = setup(policy('strict'));
    assert.equal((await f.admit(f.exec(name))).kind, 'allow');
    assert.equal(f.approvals, 1);
    f.stop();
  }
  const denied = setup(policy('strict'), { outcome: 'rejected' });
  assert.equal((await denied.admit(denied.exec())).kind, 'deny');
  denied.stop();
  const canceled = setup(policy('strict'));
  const controller = new AbortController(); controller.abort(Error('stopped'));
  assert.equal((await canceled.admit(canceled.exec('save_crm', controller.signal))).kind, 'deny');
  canceled.stop();
});

test('the monotonic guard rejects an unapproved call even when another listener allows it', async () => {
  const f = setup(policy('strict')), exec = f.exec();
  assert.match(f.guard(exec), /不可用/);
  // A newly forged registry execution cannot reuse another call's approval.
  assert.equal((await f.admit(exec)).kind, 'allow');
  assert.equal((await f.admit(exec)).kind, 'deny');
  f.stop();
});

test('a later declarative ask shares one approval while a later deny asks none', async () => {
  const f = setup(policy('strict'));
  assert.equal((await f.admit(f.exec(), { kind: 'ask', reason: 'Host requires approval' })).kind, 'allow');
  assert.equal(f.approvals, 1);
  assert.match(f.reasons[0], /其他策略/);
  assert.equal((await f.admit(f.exec(), { kind: 'deny', reason: 'Host denied' })).kind, 'deny');
  assert.equal(f.approvals, 1);
  f.stop();
});

test('loose only inherits Host policy; custom defaults to deny and has exact rules', async () => {
  const loose = setup(policy('loose'));
  assert.equal((await loose.admit(loose.exec())).kind, 'allow');
  assert.equal(loose.approvals, 0);
  const readonly = setup(policy('loose'), { mode: 'read-only' });
  assert.equal((await readonly.admit(readonly.exec('save_crm'))).kind, 'allow');
  assert.equal(readonly.approvals, 1, 'Unknown external effect escalates through the live read-only session');
  readonly.stop();
  await assert.rejects(authorizeNativeBuiltin({ sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } },
    loose.exec('write_workspace_file'), { readOnly: false }), { code: 'STUDIO_NATIVE_PERMISSION_DENIED' });
  loose.stop();
  const custom = setup(policy('custom', { save_crm: 'ask', read_workspace_file: 'deny' }));
  assert.equal((await custom.admit(custom.exec('save_crm'))).kind, 'allow');
  assert.equal((await custom.admit(custom.exec('bash'))).kind, 'deny');
  assert.equal((await custom.admit(custom.exec('read_workspace_file'))).kind, 'deny');
  assert.equal(custom.approvals, 1);
  custom.stop();
  assert.equal(nativeAgentPolicyDecision(policy('custom', { save_crm: 'inherit' }), 'save_crm', false), 'inherit');
  assert.equal(nativeAgentPolicyDecision(policy('custom'), 'toString', false), 'deny');
});

test('legacy labels preserve old behavior; malformed versioned rules fail closed', () => {
  assert.equal(nativeAgentPolicyFromSpec({ bindings: {} }), null);
  assert.equal(nativeAgentPolicyFromSpec({ bindings: { policyTemplate: 'strict' } }), null);
  assert.equal(nativeAgentPolicyFromSpec({ bindings: { policyTemplate: 'custom' } }), null);
  assert.throws(() => nativeAgentPolicyFromSpec({ bindings: { nativeAgentPolicy: policy('custom', { save_crm: 'allow' }) } }),
    { code: 'STUDIO_NATIVE_AGENT_POLICY_INVALID' });
});

test('the admitted Revision and cold recovery capsule pin the same policy', async () => {
  let preset;
  const bound = policy('custom', { save_crm: 'deny' });
  const record = { metadata: { id: 'agent', revision: 3, local: true }, source: 'local-studio',
    spec: { runtime: { type: 'harness' }, bindings: { nativeAgentPolicy: bound } } };
  const admission = new DshPresetAdmission({ nativeEngineContract: 'agentkit.native-dsh-turn/v1',
    getAgent: async () => record, registry: { register: async value => { preset = value; } } });
  await admission.ensure('agent');
  const pinned = preset.plugins.find(item => item.id === 'studio-runtime').config.boundToolPolicy;
  assert.deepEqual(pinned, bound);
  record.spec.bindings.nativeAgentPolicy.rules.save_crm = 'inherit';
  assert.equal(pinned.rules.save_crm, 'deny');
  const binding = { agentId: 'agent', agentRevision: 3, buildId: 'build-3', runtime: 'harness', local: true,
    nativeEngineContract: 'agentkit.native-dsh-turn/v1', boundToolPolicy: pinned };
  const capsule = nativeRecoveryBinding({ binding, input: { messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'do it' }] }] },
    source: { provider: 'provider', model: 'model' }, selection: { maxTokens: 100 }, systemPrompt: 'Pinned' });
  assertNativeRecoveryPreset(capsule, binding);
  assert.throws(() => assertNativeRecoveryPreset(capsule, { ...binding, boundToolPolicy: policy('loose') }),
    /recovery_preset_changed/);
});
