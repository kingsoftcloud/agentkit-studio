import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  symlinkSync, readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createDshNodeWorkspaceTools, DSH_NODE_WORKSPACE_CONTRACT } from '../src/providers/dsh-node-workspace-tools.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MODULE_PATH = resolve(REPO_ROOT, 'src/providers/dsh-node-workspace-tools.mjs');
const LOCK_PATH = resolve(REPO_ROOT, 'packages/agentkit-harness/src/native/workspace-mutation-lock.mjs');
const SCRIPT_DIR = join(process.env.CLAUDE_JOB_DIR || tmpdir(), 'tmp');
mkdirSync(SCRIPT_DIR, { recursive: true });

const TEN_NAMES = [
  'workspace_status', 'list_workspace_files', 'read_workspace_file',
  'write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
  'multi_edit_workspace_file', 'lint_workspace_file', 'search_workspace_files',
  'delete_workspace_file',
];

/** Build a fresh adapter harness over real temp dirs. */
function setup({ agentId = 'agent-1', mode = 'workspace-write', approvalOutcome } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const approvalRequests = [];
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode }) },
    approval: { request: async request => { approvalRequests.push(request); return approvalOutcome ?? 'allowed-once'; } },
  };
  const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId });
  let seq = 0;
  const exec = (name, args, { sessionId = 'session-1', signal } = {}) => ({
    callId: `call-${++seq}`, name, arguments: args,
    signal: signal ?? new AbortController().signal,
    agent: { session: { id: sessionId } },
  });
  const call = (name, args, opts = {}) => adapter.execute(name, args, exec(name, args, opts));
  return { base, workspaceRoot, stateDir, ctx, adapter, exec, call, approvalRequests,
    cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function waitForFile(path, timeoutMs = 8000) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function findNode22() {
  if (process.env.NODE22_BIN && existsSync(process.env.NODE22_BIN)) return process.env.NODE22_BIN;
  const nvmDir = join(homedir(), '.nvm/versions/node');
  if (existsSync(nvmDir)) {
    for (const name of readdirSync(nvmDir)) {
      if (name.startsWith('v22')) {
        const bin = join(nvmDir, name, 'bin', 'node');
        if (existsSync(bin)) return bin;
      }
    }
  }
  const nDir = join(homedir(), '.n');
  if (existsSync(nDir)) {
    for (const name of readdirSync(nDir)) {
      if (name.startsWith('node-v22')) {
        const bin = join(nDir, name, 'bin', 'node');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

// --- contract + definitions --------------------------------------------------

test('exposes the v1 contract and ten sealed definitions', () => {
  const h = setup();
  assert.equal(h.adapter.contract, DSH_NODE_WORKSPACE_CONTRACT);
  assert.equal(h.adapter.contract, 'agentkit.dsh-node-workspace/v1');
  assert.equal(h.adapter.definitions.length, 10);
  assert.deepEqual([...h.adapter.definitions.map(d => d.name)].sort(), [...TEN_NAMES].sort());
  for (const d of h.adapter.definitions) {
    assert.ok(Object.isFrozen(d), `${d.name} definition should be frozen`);
    assert.ok(Object.isFrozen(d.parameters), `${d.name} parameters should be frozen`);
  }
  for (const name of TEN_NAMES) assert.equal(h.adapter.supports(name), true);
  assert.equal(h.adapter.supports('not_a_real_tool'), false);
  h.cleanup();
});

// --- read -> edit -------------------------------------------------------------

test('read then edit succeeds and reports changed paths', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'f.txt'), 'hello world');
  const read = await h.call('read_workspace_file', { path: 'f.txt' });
  assert.equal(read.status, 'ok');
  const edit = await h.call('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' });
  assert.equal(edit.status, 'ok');
  assert.deepEqual(edit.workspaceChangedPaths, ['f.txt']);
  assert.equal(readFileSync(join(h.workspaceRoot, 'f.txt'), 'utf8'), 'goodbye world');
  h.cleanup();
});

test('edit without a prior read is rejected and writes nothing', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'f.txt'), 'hello world');
  const edit = await h.call('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' });
  assert.equal(edit.status, 'error');
  assert.match(edit.content.error_type || edit.content.code || '', /file_not_read|not_read/);
  assert.equal(readFileSync(join(h.workspaceRoot, 'f.txt'), 'utf8'), 'hello world');
  h.cleanup();
});

// --- state persistence + isolation --------------------------------------------

test('same session reopens in-process with persisted read state', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'f.txt'), 'hello world');
  const read = await h.adapter.execute('read_workspace_file', { path: 'f.txt' },
    h.exec('read_workspace_file', { path: 'f.txt' }));
  assert.equal(read.status, 'ok');
  h.adapter.close();
  const adapter2 = createDshNodeWorkspaceTools({ ctx: h.ctx, workspaceRoot: h.workspaceRoot, stateDir: h.stateDir, agentId: 'agent-1' });
  const edit = await adapter2.execute('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' },
    h.exec('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' }));
  assert.equal(edit.status, 'ok');
  assert.equal(readFileSync(join(h.workspaceRoot, 'f.txt'), 'utf8'), 'goodbye world');
  adapter2.close();
  h.cleanup();
});

test('a new process retains the read state on disk', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-restart-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(workspaceRoot, 'f.txt'), 'hello world');
  const reader = join(SCRIPT_DIR, 'dsh-nws-reader.mjs');
  writeFileSync(reader, `import { createDshNodeWorkspaceTools } from ${JSON.stringify(MODULE_PATH)};
const [workspaceRoot, stateDir, agentId, sessionId, file] = process.argv.slice(2);
const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId });
const exec = { callId: 'sub-read', name: 'read_workspace_file', arguments: { path: file }, signal: new AbortController().signal, agent: { session: { id: sessionId } } };
const r = await adapter.execute('read_workspace_file', { path: file }, exec);
if (r.status !== 'ok') { console.error('READ FAIL', JSON.stringify(r)); process.exit(1); }
adapter.close();`);
  const child = spawnSync(process.execPath, ['--experimental-sqlite', reader, workspaceRoot, stateDir, 'agent-1', 'session-1', 'f.txt'], { encoding: 'utf8' });
  assert.equal(child.status, 0, `reader failed: ${child.stderr || child.stdout}`);
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
  const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId: 'agent-1' });
  const edit = await adapter.execute('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' },
    { callId: 'main-edit', name: 'edit_workspace_file', arguments: { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' }, signal: new AbortController().signal, agent: { session: { id: 'session-1' } } });
  assert.equal(edit.status, 'ok');
  assert.equal(readFileSync(join(workspaceRoot, 'f.txt'), 'utf8'), 'goodbye world');
  adapter.close();
  rmSync(base, { recursive: true, force: true });
});

test('cross-session isolation: session B cannot edit on session A read', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'f.txt'), 'hello world');
  await h.call('read_workspace_file', { path: 'f.txt' }, { sessionId: 'session-A' });
  const edit = await h.call('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' }, { sessionId: 'session-B' });
  assert.equal(edit.status, 'error');
  assert.match(edit.content.error_type || edit.content.code || '', /file_not_read|not_read/);
  assert.equal(readFileSync(join(h.workspaceRoot, 'f.txt'), 'utf8'), 'hello world');
  h.cleanup();
});

test('cross-agent isolation: agent B cannot edit on agent A read', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-xagent-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(workspaceRoot, 'f.txt'), 'hello world');
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
  const adapterA = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId: 'agent-A' });
  const read = await adapterA.execute('read_workspace_file', { path: 'f.txt' },
    { callId: 'a-read', name: 'read_workspace_file', arguments: { path: 'f.txt' }, signal: new AbortController().signal, agent: { session: { id: 's1' } } });
  assert.equal(read.status, 'ok');
  const adapterB = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId: 'agent-B' });
  const edit = await adapterB.execute('edit_workspace_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' },
    { callId: 'b-edit', name: 'edit_workspace_file', arguments: { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' }, signal: new AbortController().signal, agent: { session: { id: 's1' } } });
  assert.equal(edit.status, 'error');
  assert.match(edit.content.error_type || edit.content.code || '', /file_not_read|not_read/);
  assert.equal(readFileSync(join(workspaceRoot, 'f.txt'), 'utf8'), 'hello world');
  adapterA.close(); adapterB.close();
  rmSync(base, { recursive: true, force: true });
});

// --- path escape + symlink rejection ------------------------------------------

test('path escape is rejected for read and write', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'f.txt'), 'inside');
  writeFileSync(join(h.base, 'secret.txt'), 'outside');
  const read = await h.call('read_workspace_file', { path: '../secret.txt' });
  assert.equal(read.status, 'error');
  const write = await h.call('write_workspace_file', { path: '../escape.txt', content: 'x' });
  assert.equal(write.status, 'error');
  assert.equal(existsSync(join(h.base, 'escape.txt')), false);
  h.cleanup();
});

test('a symlink pointing outside the workspace is rejected', async () => {
  const h = setup();
  writeFileSync(join(h.base, 'outside.txt'), 'secret');
  symlinkSync(join(h.base, 'outside.txt'), join(h.workspaceRoot, 'link.txt'));
  const read = await h.call('read_workspace_file', { path: 'link.txt' });
  assert.equal(read.status, 'error');
  const write = await h.call('write_workspace_file', { path: 'link.txt', content: 'x', overwrite: true });
  assert.equal(write.status, 'error');
  h.cleanup();
});

// --- approval / cancel / close / drift -> zero writes ------------------------

function deferredApproval() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve: () => resolve('allowed-once') };
}

test('cancel after the approval wait writes nothing', async () => {
  const h = setup({ mode: 'read-only' });
  const deferred = deferredApproval();
  h.ctx.approval = { request: () => deferred.promise };
  const controller = new AbortController();
  const args = { path: 'new.txt', content: 'data' };
  const promise = h.adapter.execute('write_workspace_file', args,
    h.exec('write_workspace_file', args, { signal: controller.signal }));
  controller.abort();
  deferred.resolve();
  const result = await promise;
  assert.equal(result.status, 'error');
  assert.equal(existsSync(join(h.workspaceRoot, 'new.txt')), false);
  h.cleanup();
});

test('close after the approval wait writes nothing', async () => {
  const h = setup({ mode: 'read-only' });
  const deferred = deferredApproval();
  h.ctx.approval = { request: () => deferred.promise };
  const args = { path: 'new.txt', content: 'data' };
  const promise = h.adapter.execute('write_workspace_file', args, h.exec('write_workspace_file', args));
  h.adapter.close();
  deferred.resolve();
  const result = await promise;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_closed/);
  assert.equal(existsSync(join(h.workspaceRoot, 'new.txt')), false);
  h.cleanup();
});

test('args drift after the approval wait writes nothing', async () => {
  const h = setup({ mode: 'read-only' });
  const deferred = deferredApproval();
  h.ctx.approval = { request: () => deferred.promise };
  const args = { path: 'new.txt', content: 'data' };
  const promise = h.adapter.execute('write_workspace_file', args, h.exec('write_workspace_file', args));
  args.content = 'drifted';
  deferred.resolve();
  const result = await promise;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_args_drifted/);
  assert.equal(existsSync(join(h.workspaceRoot, 'new.txt')), false);
  h.cleanup();
});

test('original signal drift after the approval wait writes nothing', async () => {
  const h = setup({ mode: 'read-only' });
  const deferred = deferredApproval();
  h.ctx.approval = { request: () => deferred.promise };
  const controller = new AbortController();
  const args = { path: 'new.txt', content: 'data' };
  const exec = h.exec('write_workspace_file', args, { signal: controller.signal });
  const promise = h.adapter.execute('write_workspace_file', args, exec);
  exec.signal = new AbortController().signal;
  deferred.resolve();
  const result = await promise;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_signal_drifted/);
  assert.equal(existsSync(join(h.workspaceRoot, 'new.txt')), false);
  h.cleanup();
});

// --- shared workspace lock ---------------------------------------------------

test('a contended shared lock then root invalidation writes nothing', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-lock-'));
  const workspaceRoot = join(base, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, 'seed.txt'), 'seed');
  const readyFile = join(base, 'ready');
  const holder = join(SCRIPT_DIR, 'dsh-nws-lock-holder.mjs');
  writeFileSync(holder, `import { acquireWorkspaceMutationLock } from ${JSON.stringify(LOCK_PATH)};
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const [workspaceRoot, readyFile] = process.argv.slice(2);
const release = acquireWorkspaceMutationLock(resolve(workspaceRoot));
writeFileSync(readyFile, 'ready');
await new Promise(r => setTimeout(r, 300));
rmSync(workspaceRoot, { recursive: true, force: true });
release();`);
  const child = spawn(process.execPath, ['--experimental-sqlite', holder, workspaceRoot, readyFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { try { child.kill(); } catch {} rmSync(base, { recursive: true, force: true }); });
  waitForFile(readyFile);
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
  const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir: join(base, 'state'), agentId: 'agent-lock' });
  const exec = { callId: 'lock-write', name: 'write_workspace_file',
    arguments: { path: 'new.txt', content: 'x' }, signal: new AbortController().signal, agent: { session: { id: 's1' } } };
  const result = await adapter.execute('write_workspace_file', { path: 'new.txt', content: 'x' }, exec);
  assert.equal(result.status, 'error');
  assert.match(result.content.error_type || result.content.code || '', /workspace_missing|workspace_root/);
  assert.equal(existsSync(join(workspaceRoot, 'new.txt')), false);
  await new Promise((res, rej) => { child.once('exit', res); child.once('error', rej); });
  // Node 22 prints an ExperimentalWarning for node:sqlite; only a real error
  // (not that warning) is a subprocess failure.
  const realStderr = stderr.split('\n')
    .filter(line => line && !/ExperimentalWarning|trace-warnings/.test(line))
    .join('\n').trim();
  assert.equal(realStderr, '');
  adapter.close();
});

// --- permission pipeline -----------------------------------------------------

test('read-only mode requires a one-shot approval and denies without it', async () => {
  const h = setup({ mode: 'read-only', approvalOutcome: 'rejected' });
  const result = await h.call('write_workspace_file', { path: 'new.txt', content: 'x' });
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /STUDIO_NATIVE_PERMISSION_DENIED/);
  assert.equal(existsSync(join(h.workspaceRoot, 'new.txt')), false);
  assert.equal(h.approvalRequests.length, 1);
  h.cleanup();
});

test('a one-shot approval is not reusable for a later call', async () => {
  const h = setup({ mode: 'read-only' });
  let outcome = 'allowed-once';
  h.ctx.approval = { request: async () => outcome };
  const r1 = await h.call('write_workspace_file', { path: 'a.txt', content: 'x' });
  assert.equal(r1.status, 'ok');
  outcome = 'rejected';
  const r2 = await h.call('write_workspace_file', { path: 'b.txt', content: 'y' });
  assert.equal(r2.status, 'error');
  assert.equal(existsSync(join(h.workspaceRoot, 'b.txt')), false);
  h.cleanup();
});

test('read-only tools are blocked after close', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'f.txt'), 'hello');
  h.adapter.close();
  const result = await h.call('read_workspace_file', { path: 'f.txt' });
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_closed/);
  h.cleanup();
});

// --- unbound / fail-closed / input validation --------------------------------

test('an unbound tool never accesses the workspace', async () => {
  const h = setup();
  const result = await h.adapter.execute('not_a_real_tool', {}, h.exec('not_a_real_tool', {}));
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_unbound/);
  h.cleanup();
});

test('invalid arguments are rejected by toolInputRejection before any effect', async () => {
  const h = setup();
  const result = await h.call('read_workspace_file', {});
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'invalid_arguments');
  assert.equal(result.content.executed, false);
  h.cleanup();
});

test('fail-closed without a real Session, callId or AbortSignal', async () => {
  const h = setup();
  const noSession = await h.adapter.execute('read_workspace_file', { path: 'x' },
    { callId: 'c', name: 'read_workspace_file', arguments: { path: 'x' }, signal: new AbortController().signal, agent: {} });
  assert.equal(noSession.status, 'error');
  assert.match(noSession.content.code, /session/);
  const noCallId = await h.adapter.execute('read_workspace_file', { path: 'x' },
    { name: 'read_workspace_file', arguments: { path: 'x' }, signal: new AbortController().signal, agent: { session: { id: 's' } } });
  assert.equal(noCallId.status, 'error');
  assert.match(noCallId.content.code, /call_id_missing/);
  const noSignal = await h.adapter.execute('read_workspace_file', { path: 'x' },
    { callId: 'c', name: 'read_workspace_file', arguments: { path: 'x' }, signal: null, agent: { session: { id: 's' } } });
  assert.equal(noSignal.status, 'error');
  assert.match(noSignal.content.code, /signal_missing/);
  const nameMismatch = await h.adapter.execute('read_workspace_file', { path: 'x' },
    { callId: 'c', name: 'write_workspace_file', arguments: { path: 'x' }, signal: new AbortController().signal, agent: { session: { id: 's' } } });
  assert.equal(nameMismatch.status, 'error');
  assert.match(nameMismatch.content.code, /exec_name_mismatch/);
  h.cleanup();
});

// --- parent probe regressions: async close, thenable isClosed, exec.arguments --

test('a read-only async lint that resolves after close is not reported ok', async () => {
  const h = setup();
  writeFileSync(join(h.workspaceRoot, 'proof.py'), 'x = 1\n');
  const args = { path: 'proof.py' };
  const pending = h.adapter.execute('lint_workspace_file', args, h.exec('lint_workspace_file', args));
  h.adapter.close();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_closed/);
  assert.equal(result.content.executed, false);
  h.cleanup();
});

test('a thenable isClosed is not treated as closed and its rejection is observed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-thenable-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
  let rejected = false;
  const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId: 'a',
    isClosed: () => { const p = Promise.reject(new Error('guard-rejection-probe')); p.then(() => {}, () => { rejected = true; }); return p; } });
  const unhandled = [];
  const listener = error => unhandled.push(error.message);
  process.on('unhandledRejection', listener);
  try {
    const result = await adapter.execute('workspace_status', {},
      { callId: 'c', name: 'workspace_status', arguments: {}, signal: new AbortController().signal, agent: { session: { id: 's1' } } });
    // A Promise must not be coerced to closed via truthiness; a non-boolean
    // closed signal is a contract violation that fails closed.
    assert.equal(result.status, 'error');
    assert.match(result.content.code, /dsh_node_workspace_is_closed_invalid/);
  } finally { process.off('unhandledRejection', listener); }
  // Let the microtask drain so the rejection handler runs.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(unhandled.length, 0, `unhandledRejection leaked: ${JSON.stringify(unhandled)}`);
  assert.equal(rejected, true);
  adapter.close();
  rmSync(base, { recursive: true, force: true });
});

test('exec.arguments swapped during the approval wait writes nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-execargs-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } };
  let allow;
  ctx.approval = { request: () => new Promise(resolve => { allow = resolve; }) };
  const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId: 'a' });
  const writeArgs = { path: 'new.txt', content: 'original' };
  const execution = { callId: 'c', name: 'write_workspace_file', arguments: writeArgs,
    signal: new AbortController().signal, agent: { session: { id: 's1' } } };
  const writing = adapter.execute('write_workspace_file', writeArgs, execution);
  execution.arguments = { path: 'other.txt', content: 'changed' };
  allow('allowed-once');
  const result = await writing;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_exec_arguments_drifted/);
  assert.equal(result.content.executed, false);
  assert.equal(existsSync(join(workspaceRoot, 'new.txt')), false);
  assert.equal(existsSync(join(workspaceRoot, 'other.txt')), false);
  adapter.close();
  rmSync(base, { recursive: true, force: true });
});

test('seal rejects when exec.arguments disagrees with the function args', async () => {
  const h = setup();
  const writeArgs = { path: 'new.txt', content: 'original' };
  const result = await h.adapter.execute('write_workspace_file', writeArgs,
    { callId: 'c', name: 'write_workspace_file', arguments: { path: 'new.txt', content: 'different' },
      signal: new AbortController().signal, agent: { session: { id: 's1' } } });
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /dsh_node_workspace_arguments_mismatch/);
  assert.equal(existsSync(join(h.workspaceRoot, 'new.txt')), false);
  h.cleanup();
});

// --- construction-time state/workspace boundary -------------------------------

test('construction rejects a state root inside the workspace', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-b1-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(workspaceRoot, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  assert.throws(() => createDshNodeWorkspaceTools({ ctx: {}, workspaceRoot, stateDir, agentId: 'a' }), /state_root_inside_workspace/);
  rmSync(base, { recursive: true, force: true });
});

test('construction rejects a workspace inside the state root', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-b2-'));
  const stateDir = join(base, 'state');
  const workspaceRoot = join(stateDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  assert.throws(() => createDshNodeWorkspaceTools({ ctx: {}, workspaceRoot, stateDir, agentId: 'a' }), /workspace_inside_state_root/);
  rmSync(base, { recursive: true, force: true });
});

test('construction rejects state root equal to the workspace', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-b3-'));
  const dir = join(base, 'same');
  mkdirSync(dir, { recursive: true });
  assert.throws(() => createDshNodeWorkspaceTools({ ctx: {}, workspaceRoot: dir, stateDir: dir, agentId: 'a' }), /conflicts_with_workspace/);
  rmSync(base, { recursive: true, force: true });
});

// --- cross-version execution -------------------------------------------------

test('the module executes a read->edit cycle on Node 22', { skip: !findNode22() && 'Node 22 binary not found' }, async () => {
  const node22 = findNode22();
  const base = mkdtempSync(join(tmpdir(), 'dsh-nws-n22-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(workspaceRoot, 'f.txt'), 'hello world');
  const script = join(SCRIPT_DIR, 'dsh-nws-n22.mjs');
  writeFileSync(script, `import { createDshNodeWorkspaceTools } from ${JSON.stringify(MODULE_PATH)};
import { writeFileSync, readFileSync } from 'node:fs';
const [workspaceRoot, stateDir] = process.argv.slice(2);
writeFileSync(workspaceRoot + '/f.txt', 'hello world');
const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } };
const adapter = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId: 'n22' });
const exec = (n, a) => ({ callId: 'c', name: n, arguments: a, signal: new AbortController().signal, agent: { session: { id: 's' } } });
const read = await adapter.execute('read_workspace_file', { path: 'f.txt' }, exec('read_workspace_file', { path: 'f.txt' }));
if (read.status !== 'ok') { console.error('READ', JSON.stringify(read)); process.exit(1); }
const editArgs = { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' };
const edit = await adapter.execute('edit_workspace_file', editArgs, exec('edit_workspace_file', editArgs));
if (edit.status !== 'ok') { console.error('EDIT', JSON.stringify(edit)); process.exit(1); }
if (readFileSync(workspaceRoot + '/f.txt', 'utf8') !== 'goodbye world') { console.error('CONTENT'); process.exit(1); }
adapter.close(); console.log('NODE22 OK');`);
  const child = spawnSync(node22, ['--experimental-sqlite', script, workspaceRoot, stateDir], { encoding: 'utf8' });
  assert.equal(child.status, 0, `node22 failed: ${child.stderr || child.stdout}`);
  assert.match(child.stdout, /NODE22 OK/);
  rmSync(base, { recursive: true, force: true });
});
