import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDshBrowserTools } from '../src/providers/native-dsh-browser.mjs';

const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const request = (sessionId = 'session', extra = {}) => ({ sessionId, scope, runId: 'run',
  signal: new AbortController().signal, ...extra });
function setup(t, createOwner) {
  const root = mkdtempSync(join(tmpdir(), 'native-dsh-browser-')), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  const gateway = createNativeDshBrowserTools({ workspaceRoot, createOwner });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  return { gateway, workspaceRoot, root };
}
function owner(options, trace) {
  trace.push({ kind: 'create', options });
  return { execute: async input => { trace.push({ kind: 'execute', input }); return { status: 'ok' }; },
    recoverSessions: async input => { trace.push({ kind: 'recover', input }); return []; },
    close: async () => { trace.push({ kind: 'close' }); } };
}
test('browser owners are lazy and survive new agent wrappers while keeping sessions and scopes separate', async t => {
  const trace = [], { gateway } = setup(t, options => owner(options, trace));
  assert.equal(gateway.definition.observationRole, 'browser');
  const first = gateway.forSession('session');
  assert.equal(trace.length, 0);
  await first.recoverSessions(request('session', { refs: [] }));
  await gateway.forSession('session').execute(request());
  assert.deepEqual(trace.map(item => item.kind), ['create', 'recover', 'execute']);
  assert.equal(trace[0].options.reobserveAfterLoss, true);
  await gateway.forSession('other').execute(request('other'));
  await first.execute(request('session', { scope: { ...scope, tenantId: 'other' } }));
  const ids = trace.filter(item => item.kind === 'create').map(item => item.options.runtimeId);
  assert.equal(new Set(ids).size, 3);
  await assert.rejects(first.execute(request('other')), /studio_native_tool_not_bound/);
  assert.equal(trace.filter(item => item.kind === 'create').length, 3);
});
test('a replacement process uses the same owner identity for read-only recovery', async t => {
  const trace = [], { gateway, workspaceRoot } = setup(t, options => owner(options, trace));
  await gateway.forSession('session').execute(request());
  const replacement = createNativeDshBrowserTools({ workspaceRoot, createOwner: options => owner(options, trace) });
  t.after(() => replacement.close());
  await replacement.forSession('session').recoverSessions(request('session', { refs: [] }));
  const created = trace.filter(item => item.kind === 'create');
  assert.equal(created[0].options.runtimeId, created[1].options.runtimeId);
  assert.equal(trace.filter(item => item.kind === 'execute').length, 1);
});
test('disposal waits for a creating owner, closes it once and rejects its late dispatch', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const trace = [], { gateway } = setup(t, options => {
    started(); return new Promise(resolve => { release = () => resolve(owner(options, trace)); });
  });
  const pending = assert.rejects(gateway.forSession('session').execute(request()), /scope closed/);
  await ready;
  const closing = gateway.close();
  assert.equal(gateway.close(), closing);
  release(); await pending; await closing;
  assert.deepEqual(trace.map(item => item.kind), ['create', 'close']);
  await assert.rejects(gateway.forSession('session').execute(request()), /studio_native_browser_closed/);
});
test('disposal cancels an active invocation before closing its resources', async t => {
  let started, received;
  const ready = new Promise(resolve => { started = resolve; });
  const { gateway } = setup(t, () => ({ recoverSessions: async () => [], close: async () => {},
    execute: async input => { received = input.signal; started();
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
      input.signal.throwIfAborted(); },
  }));
  const pending = assert.rejects(gateway.forSession('session').execute(request()), /scope closed/);
  await ready; await gateway.close(); await pending;
  assert.equal(received.aborted, true);
});
test('failed owner creation does not poison a later safe admission', async t => {
  let attempts = 0;
  const trace = [], { gateway } = setup(t, options => {
    if (++attempts === 1) throw new Error('creation failed');
    return owner(options, trace);
  });
  await assert.rejects(gateway.forSession('session').recoverSessions(request()), /creation failed/);
  await gateway.forSession('session').recoverSessions(request());
  assert.equal(attempts, 2); assert.equal(trace.at(-1).kind, 'recover');
});
test('a changed workspace alias cannot borrow the existing browser owner', async t => {
  const trace = [], { gateway, root, workspaceRoot } = setup(t, options => owner(options, trace));
  const alias = join(root, 'alias'), other = join(root, 'other');
  mkdirSync(other); symlinkSync(workspaceRoot, alias);
  const bounded = createNativeDshBrowserTools({ workspaceRoot: alias, createOwner: options => owner(options, trace) });
  t.after(() => bounded.close());
  await bounded.forSession('session').execute(request());
  unlinkSync(alias); symlinkSync(other, alias);
  await assert.rejects(bounded.forSession('session').execute(request()), /workspace_root_changed/);
  assert.equal(trace.filter(item => item.kind === 'execute').length, 1);
});
test('Host browser executable configuration must be an absolute path', t => {
  const { workspaceRoot } = setup(t, () => {});
  assert.throws(() => createNativeDshBrowserTools({ workspaceRoot, browserExecutablePath: 'from-model' }),
    /studio_native_browser_executable_invalid/);
});
test('activation release closes only the selected session and scope, without allocating unused owners', async t => {
  const trace = [], { gateway } = setup(t, options => owner(options, trace));
  await gateway.releaseSession({ sessionId: 'unused', scope });
  assert.equal(trace.length, 0);
  await gateway.forSession('session').execute(request());
  await gateway.forSession('other').execute(request('other'));
  await gateway.forSession('session').execute(request('session', { scope: { ...scope, tenantId: 'other' } }));
  const firstId = trace[0].options.runtimeId;
  await gateway.releaseSession({ sessionId: 'session', scope });
  assert.equal(trace.filter(row => row.kind === 'close').length, 1);
  await gateway.forSession('other').execute(request('other'));
  await gateway.forSession('session').execute(request('session', { scope: { ...scope, tenantId: 'other' } }));
  assert.equal(trace.filter(row => row.kind === 'create').length, 3);
  await gateway.forSession('session').recoverSessions(request('session', { refs: [] }));
  assert.equal(trace.filter(row => row.kind === 'create').length, 4);
  assert.equal(trace.filter(row => row.kind === 'create').at(-1).options.runtimeId, firstId);
});
test('activation release waits for creation, rejects overlap and drains canceled invocations exactly once', async t => {
  let started, finish;
  const ready = new Promise(resolve => { started = resolve; });
  const trace = [], { gateway } = setup(t, options => {
    started(); return new Promise(resolve => { finish = () => resolve(owner(options, trace)); });
  });
  const call = assert.rejects(gateway.forSession('session').execute(request()), /session released/);
  await ready;
  const releasing = gateway.releaseSession({ sessionId: 'session', scope });
  assert.equal(gateway.releaseSession({ sessionId: 'session', scope }), releasing);
  await assert.rejects(gateway.forSession('session').execute(request()), /session_releasing/);
  finish(); await call; await releasing;
  assert.deepEqual(trace.map(row => row.kind), ['create', 'close']);
});
test('cleanup failure fences a session instead of silently creating a replacement', async t => {
  let creates = 0, closes = 0;
  const root = mkdtempSync(join(tmpdir(), 'native-dsh-browser-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gateway = createNativeDshBrowserTools({ workspaceRoot: root, createOwner: () => {
    creates++;
    return { execute: async () => ({ status: 'ok' }), close: async () => { closes++; throw new Error('close failed'); } };
  } });
  await gateway.forSession('session').execute(request());
  await assert.rejects(gateway.releaseSession({ sessionId: 'session', scope }), /close failed/);
  await assert.rejects(gateway.forSession('session').execute(request()), /session_releasing/);
  await assert.rejects(gateway.close(), /close failed/);
  assert.equal(creates, 1); assert.equal(closes, 1);
});
test('activation release aborts active input and waits for its drain before admitting another owner', async t => {
  let started, drain, received, settled = false;
  const ready = new Promise(resolve => { started = resolve; });
  const draining = new Promise(resolve => { drain = resolve; });
  const { gateway } = setup(t, () => ({
    execute: async input => {
      received = input.signal; started();
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
      await draining; input.signal.throwIfAborted();
    },
    close: async () => { assert.equal(received.aborted, true); },
  }));
  const call = assert.rejects(gateway.forSession('session').execute(request()), /session released/);
  await ready;
  const releasing = gateway.releaseSession({ sessionId: 'session', scope });
  void releasing.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.aborted, true); assert.equal(settled, false);
  await assert.rejects(gateway.forSession('session').execute(request()), /session_releasing/);
  drain(); await call; await releasing; assert.equal(settled, true);
});
test('an already canceled request allocates no browser owner', async t => {
  const trace = [], { gateway } = setup(t, options => owner(options, trace));
  await assert.rejects(gateway.forSession('session').execute(request('session', {
    signal: AbortSignal.abort(new Error('canceled before admission')),
  })), /canceled before admission/);
  assert.deepEqual(trace, []);
});
