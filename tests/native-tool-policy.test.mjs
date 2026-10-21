import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeNativeBuiltin } from '../src/providers/native-tool-policy.mjs';

const execution = signal => ({ agent: { session: { id: 'owned-session' } }, name: 'run_command', callId: 'owned-call', signal });
test('Native mutation needs a real Host policy and only a one-shot Host approval can escalate read-only', async () => {
  const exec = execution(new AbortController().signal), definition = { readOnly: false };
  await assert.rejects(authorizeNativeBuiltin({}, exec, definition), { code: 'STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE' });
  for (const mode of ['workspace-write', 'danger-full-access'])
    await authorizeNativeBuiltin({ sandboxPolicy: { resolve: ({ session }) => { assert.equal(session, exec.agent.session); return { mode }; } } }, exec, definition);
  for (const outcome of ['rejected', 'cancelled', 'unavailable', true, 'allow', { approved: true }, undefined, 'allowed-once']) {
    const requests = [], ctx = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) }, approval: { request: async request => { requests.push(request); return outcome; } } };
    const authorization = authorizeNativeBuiltin(ctx, exec, definition);
    if (outcome === 'allowed-once') await authorization;
    else await assert.rejects(authorization, { code: 'STUDIO_NATIVE_PERMISSION_DENIED' });
    assert.equal(requests.length, 1); assert.equal(requests[0].agent, exec.agent);
    assert.equal(requests[0].toolName, exec.name); assert.equal(requests[0].callId, exec.callId); assert.equal(requests[0].signal, exec.signal);
  }
});
test('safe reads do not escalate and unavailable policies or answerers fail closed', async () => {
  const exec = execution(new AbortController().signal);
  await authorizeNativeBuiltin({ approval: { request: () => assert.fail('read cannot ask') } }, exec, { readOnly: true });
  await assert.rejects(authorizeNativeBuiltin({ sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } }, exec, {}), { code: 'STUDIO_NATIVE_PERMISSION_DENIED' });
  for (const mode of [undefined, null, 'unknown'])
    await assert.rejects(authorizeNativeBuiltin({ sandboxPolicy: { resolve: () => ({ mode }) } }, exec, {}), { code: 'STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE' });
});
test('canceled approval and a disappeared policy cannot grant later dispatch authority', async () => {
  const controller = new AbortController(), exec = execution(controller.signal);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { finish = resolve; });
  const authorization = authorizeNativeBuiltin({ sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: () => { entered(); return pending; } } }, exec, {});
  await started; controller.abort(Error('cancel-owned-call')); finish('allowed-once');
  await assert.rejects(authorization, /cancel-owned-call/);
  let available = true;
  await assert.rejects(authorizeNativeBuiltin({ sandboxPolicy: { resolve: () => ({ mode: available ? 'read-only' : 'invalid' }) },
    approval: { request: async () => { available = false; return 'allowed-once'; } } }, execution(new AbortController().signal), {}),
  { code: 'STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE' });
  const replacement = { resolve: () => ({ mode: 'invalid' }) };
  const replaced = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: async () => { replaced.sandboxPolicy = replacement; return 'allowed-once'; } } };
  await assert.rejects(authorizeNativeBuiltin(replaced, execution(new AbortController().signal), {}), { code: 'STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE' });
  const scoped = { get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only' }) }
    : name === 'approval' ? { request: async () => 'allowed-once' } : undefined };
  await authorizeNativeBuiltin(scoped, execution(new AbortController().signal), {});
});
