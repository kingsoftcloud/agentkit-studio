import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createNativeWorkspaceTools } from '../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { acquireWorkspaceMutationLock, workspaceMutationLockPath } from '../packages/agentkit-harness/src/native/workspace-mutation-lock.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { createNativeToolAuthority } from '../src/providers/native-tool-authority.mjs';
import { NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-workspace-publication-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir: join(root, 'state'), sessionId: 'session', authorize: async () => 'allow' });
  const request = () => ({ sessionId: 'session', operationKey: 'op', signal: new AbortController().signal,
    call: { name: 'write_workspace_file', callId: 'write', arguments: { path: 'file.txt', content: 'parent-proposal' } },
    definition: tools.definitions.find(tool => tool.name === 'write_workspace_file') });
  return { root, workspaceRoot, tools, request };
}

const lockModule = new URL('../packages/agentkit-harness/src/native/workspace-mutation-lock.mjs', import.meta.url).href;
async function competingProcess(t, workspaceRoot, mode) {
  const code = `import {writeFileSync} from 'node:fs';
    const {acquireWorkspaceMutationLock}=await import(process.argv[1]);
    const release=acquireWorkspaceMutationLock(process.argv[2]);
    process.send('locked');
    if(process.argv[3]==='crash')setInterval(()=>{},1000);
    else setTimeout(()=>{if(process.argv[3]==='publish')writeFileSync(process.argv[2]+'/file.txt','child-publication');
      release();process.disconnect();},400);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, lockModule, workspaceRoot, mode],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message, 'locked'); return { child, exited };
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

function gateway(t, f, limits = {}) {
  const store = new SqliteRunStore(join(f.root, 'ledger.sqlite')), registry = new Map(), agent = { session: { id: 'session' } };
  t.after(() => store.close());
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    execute: async input => { const tool = registry.get(input.name), result = await tool.execute(input.arguments, input);
      return { isError: false, content: tool.output.render(input.arguments, result) }; },
  } };
  const bound = createNativeDshTools({ ctx, config: { toolBindings: ['write_workspace_file'] }, workspaceRoot: f.workspaceRoot,
    stateDir: join(f.root, 'gateway-state') }); t.after(() => bound.close());
  assert.equal(bound.workspaceMutationContract, 'agentkit.workspace-mutation-lock/v1');
  const tools = bound.definitions(agent, [...registry.values()]), { config, snapshot } = fixture({ tools, limits });
  snapshot.sessionId = 'session';
  let calls = 0;
  const kernel = new NativeKernel({ store, owner: 'host', digest, ports: { ...bound.forAgent(agent, { scope, store }), model: {
    generate: async () => !calls++ ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
      callId: 'write', name: 'write_workspace_file', arguments: { path: 'file.txt', content: 'Native actual write' },
    }] } : { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] },
  } } }); kernel.start(snapshot, config);
  return { store, kernel, snapshot };
}

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
  const f = setup(t), host = gateway(t, f, { leaseMs: 100 });
  const peer = await competingProcess(t, f.workspaceRoot, 'wait');
  await assert.rejects(host.kernel.runUntilIdle(scope, host.snapshot.runId), { code: 'stale_fence' }); await peer.exited;
  assert.equal(existsSync(join(f.workspaceRoot, 'file.txt')), false);
  const loaded = host.store.load(scope, host.snapshot.runId);
  const intent = loaded.intents.find(intent => intent.operationKey === loaded.snapshot.pendingIntent);
  assert.equal(intent.status, 'running'); assert.equal(intent.payload.calls[0].name, 'write_workspace_file');
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
