import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_HOST_CONTEXT_OWNERSHIP as policy, nativeHostInputRows, nativeHostInputIsRefresh } from '../src/providers/native-context-ownership.mjs';
import { nativeRecoveryBinding, readNativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { digest, scope } from './fixtures/native-core.mjs';

const user = (id, kind, content) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text: content }] });

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
