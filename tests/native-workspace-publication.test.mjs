import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { acquireWorkspaceMutationLock, workspaceMutationLockPath } from '@kingsoftcloud/agentkit-harness-node/native/workspace-mutation-lock';
import { createNativeDshTools } from './fixtures/retired-native/providers/native-dsh-tools.mjs';
import { createNativeToolAuthority } from './fixtures/retired-native/providers/native-tool-authority.mjs';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { scope, fixture, digest } from './fixtures/native-core.mjs';
import { nativeDshBatchPeer } from './fixtures/native-dsh-batch-peer.mjs';

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-workspace-publication-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir: join(root, 'state'), sessionId: 'session', authorize: async () => 'allow' });
  const request = () => ({ sessionId: 'session', operationKey: 'op', signal: new AbortController().signal,
    call: { name: 'write_workspace_file', callId: 'write', arguments: { path: 'file.txt', content: 'parent-proposal' } },
    definition: tools.definitions.find(tool => tool.name === 'write_workspace_file') });
  return { root, workspaceRoot, tools, request };
}

const lockModule = import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/workspace-mutation-lock');
async function competingProcess(t, workspaceRoot, mode, { holdMs = 400 } = {}) {
  const code = `import {writeFileSync} from 'node:fs';
    const {acquireWorkspaceMutationLock}=await import(process.argv[1]);
    const release=acquireWorkspaceMutationLock(process.argv[2]);
    process.send('locked');
    if(process.argv[3]==='crash')setInterval(()=>{},1000);
    else setTimeout(()=>{if(process.argv[3]==='publish')writeFileSync(process.argv[2]+'/file.txt','child-publication');
      release();process.disconnect();},Number(process.argv[4]));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, lockModule, workspaceRoot, mode, String(holdMs)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message, 'locked'); return { child, exited };
}

/** Controllable wall clock for the Host lease.
 *
 * `NativeKernel` reads every lease deadline through `options.now` (default
 * `Date.now`), so freezing it removes the wall-clock race between the
 * `leaseMs / 3` heartbeat renewal and the first claim. On a loaded CI runner
 * the driver loop can be starved for longer than `leaseMs`; with a real-time
 * lease the heartbeat then renews first and the run rejects with `stale_fence`
 * while the intent is still `prepared` — a property this test never meant to
 * assert. Here the test advances the clock itself, so the expiry is caused
 * rather than raced.
 *
 * The Host's tool authority still reads the real `Date.now()` (it lives in the
 * published `@kingsoftcloud/agentkit-harness-node`), so the real lock wait is
 * what makes the post-lock authority read fail: both clocks agree the lease is
 * gone before the write can be published. */
function controllableClock(start = Date.now()) {
  let current = start;
  const now = () => current;
  now.advance = milliseconds => { current += milliseconds; return current; };
  return now;
}

/** Expire the lease as soon as the kernel has durably claimed the *tool*
 * intent, instead of hoping the 33 ms heartbeat loses a race with the claim.
 * Production reaches the same state from the other side: the tool then blocks
 * on the cross-process lock for longer than the lease, so every later fenced
 * read — the post-lock authority read and the commit — sees an expired lease.
 * Advancing at the claim makes the expiry independent of how long the driver
 * loop is starved, which is exactly what made this test flaky. */
function expireLeaseAfterToolClaim(store, clock, milliseconds) {
  const claim = store.claim.bind(store);
  store.claim = (...args) => {
    const claimed = claim(...args);
    if (claimed?.kind === 'tool') clock.advance(milliseconds);
    return claimed;
  };
  return store;
}

test('parent writer waits for the competing publication then rejects its stale create proposal', async t => {
  const f = setup(t), peer = await competingProcess(t, f.workspaceRoot, 'publish');
  const result = await f.tools.execute(f.request()); await peer.exited;
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'file_not_read');
  assert.equal(readFileSync(join(f.workspaceRoot, 'file.txt'), 'utf8'), 'child-publication');
});

test('a process killed while holding the publication lock cannot block the next actual writer', async t => {
  const f = setup(t), peer = await competingProcess(t, f.workspaceRoot, 'crash');
  peer.child.kill('SIGKILL'); const [code, signal] = await peer.exited;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.equal((await f.tools.execute(f.request())).status, 'ok');
  assert.equal(readFileSync(join(f.workspaceRoot, 'file.txt'), 'utf8'), 'parent-proposal');
});

test('the lock key follows canonical aliases and refuses a symlinked SQLite target', t => {
  const f = setup(t), alias = join(f.root, 'alias'); symlinkSync(f.workspaceRoot, alias);
  assert.equal(workspaceMutationLockPath(alias), workspaceMutationLockPath(f.workspaceRoot));
  assert.match(workspaceMutationLockPath(alias), /lock-[a-f0-9]{64}\.sqlite$/u);
  const release = acquireWorkspaceMutationLock(f.workspaceRoot); release(); release();
  const filename = workspaceMutationLockPath(f.workspaceRoot); rmSync(filename);
  symlinkSync(join(f.root, 'unrelated'), filename);
  assert.throws(() => acquireWorkspaceMutationLock(f.workspaceRoot));
  assert.equal(existsSync(join(f.root, 'unrelated')), false);
});

test('permission-wait identity replacement and asynchronous authority cannot publish', async t => {
  const f = setup(t), input = f.request(); let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { entered = resolve; });
  const tools = createNativeWorkspaceTools({ workspaceRoot: f.workspaceRoot, stateDir: join(f.root, 'second-state'),
    sessionId: 'session', authorize: async () => { entered(); await wait; return 'allow'; } });
  const output = tools.execute(input); await pending; input.call = { ...input.call, arguments: { ...input.call.arguments, content: 'changed' } }; release();
  assert.equal((await output).content.error_type, 'workspace_execution_context_changed');
  assert.equal(existsSync(join(f.workspaceRoot, 'file.txt')), false);
  const rejected = await f.tools.execute(f.request(), { assertCurrent: async () => true });
  assert.equal(rejected.content.error_type, 'workspace_execution_authority_changed');
  assert.equal(existsSync(join(f.workspaceRoot, 'file.txt')), false);
});

function gateway(t, f, limits = {}, { now, expireAfterClaimMs } = {}) {
  const store = expireAfterClaimMs === undefined
    ? new SqliteRunStore(join(f.root, 'ledger.sqlite'))
    : expireLeaseAfterToolClaim(new SqliteRunStore(join(f.root, 'ledger.sqlite')), now, expireAfterClaimMs);
  const registry = new Map(), agent = { session: { id: 'session' } };
  t.after(() => store.close());
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: nativeDshBatchPeer({
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    execute: async input => { const tool = registry.get(input.name), result = await tool.execute(input.arguments, input);
      return { isError: false, content: tool.output.render(input.arguments, result) }; },
  }) };
  const bound = createNativeDshTools({ ctx, config: { toolBindings: ['write_workspace_file'] }, workspaceRoot: f.workspaceRoot,
    stateDir: join(f.root, 'gateway-state') }); t.after(() => bound.close());
  assert.equal(bound.workspaceMutationContract, 'agentkit.workspace-mutation-lock/v1');
  const tools = bound.definitions(agent, [...registry.values()]), { config, snapshot } = fixture({ tools, limits });
  snapshot.sessionId = 'session';
  let calls = 0;
  const kernel = new NativeKernel({ store, owner: 'host', digest, ...(now ? { now } : {}), ports: { ...bound.forAgent(agent, { scope, store }), model: {
    generate: async () => !calls++ ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
      callId: 'write', name: 'write_workspace_file', arguments: { path: 'file.txt', content: 'Native actual write' },
    }] } : { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] },
  } } }); kernel.start(snapshot, config);
  return { store, kernel, snapshot, bound, agent, registry };
}

test('Host reconstruction preserves pre-checkpoint and pre-receipt frozen writer policies', t => {
  const f = setup(t), host = gateway(t, f), assembly = [...host.registry.values()];
  const current = host.bound.definitions(host.agent, assembly);
  assert.equal(current[0].workspaceCheckpointPolicy, 'file-preimages/v1'); assert.equal(current[0].recoveryPolicy, 'receipt-observation/v1');
  for (const checkpoint of [false, true]) {
    const original = structuredClone(current); delete original[0].recoveryPolicy; delete original[0].workspaceRepairPolicy;
    if (!checkpoint) delete original[0].workspaceCheckpointPolicy;
    assert.deepEqual(host.bound.definitions(host.agent, assembly, { workspaceCheckpointDefinitions: original }), original);
  }
  const preRepair = structuredClone(current); delete preRepair[0].workspaceRepairPolicy;
  assert.deepEqual(host.bound.definitions(host.agent, assembly, { workspaceCheckpointDefinitions: preRepair }), preRepair);
  assert.deepEqual(host.bound.definitions(host.agent, assembly), current, 'restoration cannot mutate defaults for other Sessions');
});

test('production gateway publishes only against its actual current SQLite tool intent', async t => {
  const f = setup(t), host = gateway(t, f);
  const result = await host.kernel.runUntilIdle(scope, host.snapshot.runId);
  assert.equal(result.phase, 'completed');
  assert.equal(readFileSync(join(f.workspaceRoot, 'file.txt'), 'utf8'), 'Native actual write');
  const loaded = host.store.load(scope, host.snapshot.runId), intent = loaded.intents.find(intent => intent.kind === 'tool');
  const receipt = loaded.receipts.find(receipt => receipt.operationKey === intent.operationKey);
  assert.equal(receipt.status, 'committed'); assert.equal(intent.payload.calls[0].callId, 'write');
  assert.equal(receipt.result.results[0].status, 'ok');
});

test('actual lease expiry while waiting for the shared lock prevents the production Host write', async t => {
  const f = setup(t), clock = controllableClock();
  const host = gateway(t, f, { leaseMs: 100 }, { now: clock, expireAfterClaimMs: 101 });
  const peer = await competingProcess(t, f.workspaceRoot, 'wait');
  await assert.rejects(host.kernel.runUntilIdle(scope, host.snapshot.runId), { code: 'stale_fence' });
  await peer.exited;
  assert.equal(existsSync(join(f.workspaceRoot, 'file.txt')), false);
  const loaded = host.store.load(scope, host.snapshot.runId);
  const intent = loaded.intents.find(intent => intent.operationKey === loaded.snapshot.pendingIntent);
  assert.equal(intent.status, 'running');
  assert.deepEqual(intent.payload.calls.map(call => call.name), ['write_workspace_file']);
  assert.ok(intent.claimedFence > 0, 'the publication was claimed before the lease was lost');
  assert.equal(loaded.receipts.some(receipt => receipt.operationKey === intent.operationKey), false);
  assert.notEqual(loaded.snapshot.phase, 'completed');
});

test('an event-loop stall longer than the lease cannot turn the expiry into a prepared intent', async t => {
  const f = setup(t), clock = controllableClock();
  const host = gateway(t, f, { leaseMs: 100 }, { now: clock, expireAfterClaimMs: 101 });
  const peer = await competingProcess(t, f.workspaceRoot, 'wait', { holdMs: 1200 });
  const run = host.kernel.runUntilIdle(scope, host.snapshot.runId);
  const rejected = assert.rejects(run, { code: 'stale_fence' });
  // Reproduce the loaded-runner shape: block the event loop synchronously for
  // five times the lease before the driver can claim, while the peer keeps the
  // shared lock. A real-time lease used to renew-expire here and reject with
  // the intent still `prepared`; the frozen clock keeps the lease valid across
  // the stall, so the claim still happens and the expiry stays a lease loss
  // while the publication is in flight.
  const until = Date.now() + 500;
  while (Date.now() < until) { /* starve the driver loop */ }
  await rejected;
  peer.child.kill('SIGKILL'); await peer.exited;
  assert.equal(existsSync(join(f.workspaceRoot, 'file.txt')), false);
  const loaded = host.store.load(scope, host.snapshot.runId);
  const intent = loaded.intents.find(intent => intent.operationKey === loaded.snapshot.pendingIntent);
  assert.equal(intent.status, 'running');
  assert.deepEqual(intent.payload.calls.map(call => call.name), ['write_workspace_file']);
  assert.equal(loaded.receipts.some(receipt => receipt.operationKey === intent.operationKey), false);
});

test('a terminal Run cannot authorize a new publication even with its original complete request', async t => {
  const f = setup(t), host = gateway(t, f); await host.kernel.runUntilIdle(scope, host.snapshot.runId);
  const loaded = host.store.load(scope, host.snapshot.runId), intent = loaded.intents.find(intent => intent.kind === 'tool');
  const assertCurrent = createNativeToolAuthority({ scope, sessionId: 'session', store: host.store });
  assert.equal(assertCurrent({ ...loaded.snapshot, scope, operationKey: intent.operationKey,
    executionFence: intent.claimedFence, signal: new AbortController().signal,
    call: intent.payload.calls[0], definition: loaded.configuration.tools[0] }), false);
});
