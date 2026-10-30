import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_HOST_CONTEXT_OWNERSHIP as policy, NATIVE_EXECUTION_CONTEXT_OWNERSHIP,
  NATIVE_WORKSPACE_CONTEXT_OWNERSHIP, NATIVE_CURRENT_INSTRUCTION_OWNERSHIP, nativeHostInputRows, nativeHostInputIsRefresh } from '../src/providers/native-context-ownership.mjs';
import { nativeRecoveryBinding, readNativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { digest, scope } from './fixtures/native-core.mjs';

const user = (id, kind, content) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text: content }] });

test('current-file ownership removes historical Host rule projections at every boundary and preserves direct user input', () => {
  const messages = [user('root', 'agent-instructions', 'Old file snapshot'), user('direct', 'user', 'My explicit instruction'),
    user('event', 'enterprise-custom-input', 'Authorized event'), user('cwd', 'working-directory', 'Old root')];
  for (const initial of [false, true]) assert.deepEqual(nativeHostInputRows(messages,
    NATIVE_CURRENT_INSTRUCTION_OWNERSHIP, { initial }).map(row => row.sourceIndex), [1, 2]);
  assert.equal(nativeHostInputIsRefresh(nativeHostInputRows([messages[0]], NATIVE_CURRENT_INSTRUCTION_OWNERSHIP),
    NATIVE_CURRENT_INSTRUCTION_OWNERSHIP), true);
  assert.throws(() => nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
    input: { messages: [messages[1]] }, source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: '',
    inputContextPolicy: NATIVE_CURRENT_INSTRUCTION_OWNERSHIP,
    workspaceContext: { contract: 'agentkit.native-workspace-context/v1', workspaceRoot: '/workspace', sourceRoot: '/workspace' } }),
  /recovery_binding_invalid/);
});

test('bound workspace ownership defers only initial instruction projections and retains subsequent scoped updates', () => {
  const messages = [user('rules', 'agent-instructions', 'AGENTS from a Session container'),
    user('user', 'user', 'Follow my AGENTS.md requirement'),
    user('directory', 'working-directory', 'Old Session directory'),
    user('external', 'enterprise-custom-input', 'An authorized event')];
  const original = structuredClone(messages);
  const initial = nativeHostInputRows(messages, NATIVE_WORKSPACE_CONTEXT_OWNERSHIP, { initial: true });
  assert.deepEqual(initial.map(row => row.sourceIndex), [1, 3]);
  const refreshed = nativeHostInputRows(messages, NATIVE_WORKSPACE_CONTEXT_OWNERSHIP);
  assert.deepEqual(refreshed.map(row => row.sourceIndex), [0, 1, 3]);
  assert.equal(refreshed[0].message, messages[0]);
  assert.equal(nativeHostInputIsRefresh(refreshed, NATIVE_WORKSPACE_CONTEXT_OWNERSHIP), false);
  for (const historical of [undefined, policy, NATIVE_EXECUTION_CONTEXT_OWNERSHIP])
    assert.deepEqual(nativeHostInputRows(messages, historical, { initial: true }).map(row => row.sourceIndex), [0, 1, 2, 3]);
  assert.deepEqual(messages, original);
});

test('Native resource ownership removes the host catalog without moving attachment identities or dropping unknown host work', () => {
  const catalog = user('catalog', 'skill-catalog', 'Unbound host skill descriptions');
  const first = user('first', 'user', 'Research files');
  const second = { ...user('image', 'user', 'Look at the attached image'), content: [{ type: 'image', attachment: { attachmentId: 'stable-image' } }] };
  const external = user('external', 'enterprise-custom-input', 'A real queued business event');
  const messages = [catalog, first, second, external];
  const rows = nativeHostInputRows(messages, policy);
  assert.deepEqual(rows.map(row => row.sourceIndex), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.message), [first, second, external]);
  assert.equal(rows[1].message.content[0].attachment.attachmentId, 'stable-image');
  assert.equal(nativeHostInputIsRefresh(rows, policy), false);
  assert.equal(messages[0], catalog);
  assert.equal(nativeHostInputRows(messages, undefined).length, 4);
});

test('a candidate survives owned catalog and environment refresh, but real user input remains actionable', () => {
  const updates = [user('skills', 'skill-catalog', 'Catalog'), user('cwd', 'runtime-context', 'cwd'), user('clock', 'time-context', 'time')];
  assert.equal(nativeHostInputIsRefresh(nativeHostInputRows(updates, policy), policy), true);
  assert.equal(nativeHostInputIsRefresh(nativeHostInputRows(updates, undefined), undefined), false);
  updates.push(user('steer', 'user', 'Also write a CSV'));
  assert.equal(nativeHostInputIsRefresh(nativeHostInputRows(updates, policy), policy), false);
  assert.throws(() => nativeHostInputRows(updates, 'unbound-policy'), { code: 'studio_native_context_ownership_invalid' });
});

test('input ownership is sealed in the recovery capsule and cannot be activated on a legacy run by defaults', () => {
  const input = { messages: [user('input', 'user', 'Original task')] };
  const args = { binding: { agentId: scope.agentId, agentRevision: 1 }, input, source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: 'Unchanged' };
  const current = nativeRecoveryBinding({ ...args, inputContextPolicy: policy });
  const legacy = nativeRecoveryBinding(args);
  assert.equal(Object.hasOwn(legacy, 'inputContextPolicy'), false);
  const configuration = { hostRecoveryBinding: current };
  const identity = { agentId: scope.agentId, sessionId: 'session', runId: 'run' };
  const snapshot = { scope, sessionId: 'session', runId: 'run', configDigest: digest(configuration) };
  assert.equal(readNativeRecoveryBinding({ configuration, snapshot }, identity).inputContextPolicy, policy);
  assert.throws(() => readNativeRecoveryBinding({ configuration: { hostRecoveryBinding: legacy }, snapshot }, identity), /stored_configuration_mismatch/);
  assert.throws(() => nativeRecoveryBinding({ ...args, inputContextPolicy: 'other' }), /recovery_binding_invalid/);
});
