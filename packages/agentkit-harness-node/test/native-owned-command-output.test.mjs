import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { createOwnedCommandOutputReader, OWNED_COMMAND_OUTPUT_CONTRACT } from '../src/native/owned-command.mjs';
import { LocalCommandStore, createLocalBackgroundReader } from '../src/native/local-background.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

async function launch({ store = new MemoryRunStore(), execute } = {}) {
  const definition = tool({ name: 'run_command', readOnly: false, concurrentSafe: false,
    backgroundCommandPolicy: 'owned-command-launch/v1', timeoutMs: 10000 });
  const { config, snapshot } = fixture({ tools: [definition] });
  let launches = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'fixture-owner', ports: {
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: { command: 'original launch command' } }] }) },
    tools: { execute: async request => {
      launches++;
      const taskId = execute ? await execute(request) : 'a'.repeat(64);
      return { status: 'ok', content: { backend: 'sandbox/local_process' },
        backgroundCommandRef: { taskId, sourceRunId: 'run', operationKey: request.operationKey } };
    } },
  }, onCheckpoint: async snapshot => {
    if (snapshot.backgroundCommands.length && snapshot.phase !== 'paused')
      kernel.submit(scope, 'run', { commandId: 'pause-after-launch', kind: 'pause', payload: {} });
  } });
  kernel.start(snapshot, config); const state = await kernel.runUntilIdle(scope, 'run');
  assert.equal(state.phase, 'paused'); assert.equal(launches, 1);
  return { store, launches, request: { contract: OWNED_COMMAND_OUTPUT_CONTRACT, scope, runId: 'run', sessionId: 'session',
    taskId: state.backgroundCommands[0].ref.taskId, stdoutCursor: 0, stderrCursor: 0, maxBytes: 64,
    signal: new AbortController().signal } };
}
const output = (overrides = {}) => ({ status: 'running', stdout: 'actual', stderr: '', stdoutCursor: 6, stderrCursor: 0,
  exitCode: null, ...overrides });

test('operator reads resolve the committed backend and do not change the ledger or launch count', async () => {
  const f = await launch(), before = f.store.load(scope, 'run'); let reads = 0;
  const reader = createOwnedCommandOutputReader({ scope, store: f.store, readers: {
    local_process: async request => { reads++; assert.equal(request.waitSeconds, 0);
      assert.equal(Object.hasOwn(request, 'command'), false); return output(); }, e2b: () => assert.fail('wrong backend') } });
  const result = await reader.read(f.request);
  assert.equal(result.status, 'running'); assert.equal(result.stdout, 'actual'); assert.equal(result.exitCode, null);
  assert.equal(result.command, 'original launch command');
  assert.deepEqual(f.store.load(scope, 'run'), before); assert.equal(reads, 1); assert.equal(f.launches, 1);
});
for (const field of ['scope', 'sessionId', 'runId', 'taskId', 'maxBytes', 'stdoutCursor', 'extra'])
  test(`forged ${field} cannot touch a backend`, async () => {
    const f = await launch(); let reads = 0;
    const reader = createOwnedCommandOutputReader({ scope, store: f.store,
      readers: { local_process: async () => { reads++; return output(); } } });
    const request = { ...f.request };
    if (field === 'scope') request.scope = { ...scope, tenantId: 'foreign' };
    else if (field === 'maxBytes') request.maxBytes = 65537;
    else if (field === 'stdoutCursor') request.stdoutCursor = -1;
    else request[field] = 'foreign';
    await assert.rejects(reader.read(request)); assert.equal(reads, 0);
  });
for (const change of ['abort', 'close', 'head', 'request', 'receipt'])
  test(`a late backend result is withheld after ${change}`, async () => {
    const f = await launch(); let resolve, closed = false;
    let headChanged = false, receiptChanged = false;
    const store = { sessionHead: (...args) => {
      const head = f.store.sessionHead(...args); return headChanged ? { ...head, runId: 'new-head' } : head;
    }, load: (...args) => {
      const record = f.store.load(...args);
      if (receiptChanged) record.receipts.find(row => row.operationKey === record.snapshot.backgroundCommands[0].ref.operationKey).status = 'uncertain'; return record;
    } };
    const controller = new AbortController(), request = { ...f.request, signal: controller.signal };
    const reader = createOwnedCommandOutputReader({ scope, store, isClosed: () => closed,
      readers: { local_process: () => new Promise(done => { resolve = done; }) } });
    const pending = reader.read(request);
    if (change === 'abort') controller.abort();
    if (change === 'close') closed = true;
    if (change === 'head') headChanged = true;
    if (change === 'request') request.stdoutCursor = 1;
    if (change === 'receipt') receiptChanged = true;
    resolve(output()); await assert.rejects(pending);
  });
test('unknown evidence cannot manufacture an exit verdict; invalid byte cursors fail closed', async () => {
  const f = await launch(); let value = output({ status: 'unknown', exitCode: 0, observedExitCode: 137, evidenceIncomplete: true });
  const reader = createOwnedCommandOutputReader({ scope, store: f.store, readers: { local_process: async () => value } });
  const unknown = await reader.read(f.request);
  assert.equal(unknown.exitCode, null); assert.equal(unknown.observedExitCode, 137); assert.equal(unknown.evidenceIncomplete, true);
  value = output({ stdoutCursor: 1 }); await assert.rejects(reader.read(f.request), { code: 'command_output_cursor_invalid' });
});
test('cold SQLite and command-store owners page one real process without relaunching it', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-owned-output-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  const stateRoot = join(root, 'commands'), file = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(file), handle, operationKey;
  t.after(async () => {
    try { if (handle) await handle.wait({ timeoutMs: 5000 }); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  const commands = new LocalCommandStore({ stateRoot, workspaceRoot, sessionId: 'session' });
  const f = await launch({ store, execute: async request => {
    operationKey = request.operationKey;
    handle = await commands.start({ operationKey, cwd: workspaceRoot, env: { PATH: '/bin:/usr/bin' }, timeoutMs: 5000,
      command: "printf 'once\\n' >> launches; printf 'first😀\\n'; printf 'diagnostic\\n' >&2; sleep 0.5; printf '%0200d' 0; printf '\\nlast\\n'" });
    return commands.commandId(operationKey);
  } });
  store.close(); store = new SqliteRunStore(file);
  const coldCommands = new LocalCommandStore({ stateRoot, workspaceRoot, sessionId: 'session' });
  const reader = createOwnedCommandOutputReader({ scope, store, readers: { local_process: createLocalBackgroundReader(coldCommands) } });
  const before = store.load(scope, 'run');
  let stdout = '', stderr = '', request = { ...f.request, maxBytes: 16 }, sawRunning = false;
  const deadline = Date.now() + 5000;
  for (;;) {
    const chunk = await reader.read(request); sawRunning ||= chunk.status === 'running';
    stdout += chunk.stdout; stderr += chunk.stderr;
    const advanced = chunk.stdoutCursor > request.stdoutCursor || chunk.stderrCursor > request.stderrCursor;
    request = { ...request, stdoutCursor: chunk.stdoutCursor, stderrCursor: chunk.stderrCursor };
    if (chunk.status === 'completed' && !advanced) { assert.equal(chunk.exitCode, 0); break; }
    assert.ok(Date.now() < deadline, JSON.stringify(chunk));
    if (!advanced) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(stdout, 'first😀\n' + '0'.repeat(200) + '\nlast\n'); assert.equal(stderr, 'diagnostic\n'); assert.equal(sawRunning, true);
  assert.equal(readFileSync(join(workspaceRoot, 'launches'), 'utf8'), 'once\n');
  assert.deepEqual(store.load(scope, 'run'), before, 'operator reads never acknowledge notifications or append receipts');
});
