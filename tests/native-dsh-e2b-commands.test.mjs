// The real Studio gateway + NativeKernel + SQLite + E2B lifecycle/command
// store. DSH registry and remote E2B SDK are explicit deterministic doubles;
// these tests do not claim a cloud service or packed-SDK integration proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, canonical, BACKGROUND_NOTIFICATION_ADMISSION } from '@kingsoftcloud/agentkit-harness-core';
import { scope, fixture, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';

const names = ['sandbox_status', 'run_command', 'read_command_output', 'stop_command'];
const environment = () => ({ KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'fixed-template',
  E2B_API_URL: 'https://original.fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'private-e2b-key', HOST_SECRET: 'private-host-env' });
const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const call = (name, args) => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'call', name, arguments: args }] });
const last = request => JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = performance.now() + 8000;
  for (;;) { const value = await fn(); if (value) return value;
    assert.ok(performance.now() < deadline, 'observation timed out'); await delay(20); }
}

function setup(t, { hold = false, env = environment(), denied = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-dsh-e2b-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot);
  const filename = join(root, 'ledger.sqlite'); let ledger = new SqliteRunStore(filename), gateway, currentRun, currentScope = scope;
  const registry = new Map(), agent = { session: { id: 'session' } }, calls = [], pending = [];
  let loads = 0, rejectPolicy = denied, createHook, sandboxMode = 'workspace-write';
  function claimed() {
    const saved = ledger.load(currentScope, currentRun), intent = saved.intents.find(row => row.operationKey === saved.snapshot.pendingIntent);
    assert.equal(saved.snapshot.phase, 'executing_tools'); assert.equal(intent.status, 'running');
    assert.equal(saved.lease.fence, intent.claimedFence);
  }
  function durableLaunch() {
    const saved = ledger.load(currentScope, currentRun);
    const intent = saved.intents.find(row => row.kind === 'tool' && row.payload.calls?.some(call => call.name === 'run_command'));
    assert.ok(Number.isSafeInteger(intent?.claimedFence) && intent.claimedFence > 0);
    // A detached supervisor can legitimately enter the remote SDK after the
    // launch receipt committed and the original turn completed. Its durable
    // command record, rather than a still-running model turn, owns that work.
    assert.ok(intent.status === 'running' || saved.receipts.some(row => row.operationKey === intent.operationKey && row.status === 'committed'));
    const owner = digest([workspaceRoot, 'e2b', saved.snapshot.sessionId]), taskId = digest([owner, intent.operationKey]);
    const record = JSON.parse(readFileSync(join(stateDir, 'e2b-commands', digest(currentScope),
      'background', 'commands', owner, taskId, 'record.json'), 'utf8'));
    assert.equal(record.commandId, taskId); assert.equal(record.owner, owner); assert.equal(record.backend, 'e2b');
  }
  const sdk = { CommandExitError: class extends Error {}, Sandbox: {
    async create(template, options) {
      claimed(); calls.push({ method: 'create', template, options });
      if (createHook) await createHook();
      return { sandboxId: `sandbox-${calls.filter(row => row.method === 'create').length}` };
    },
    async connect(id, options) {
      durableLaunch(); calls.push({ method: 'connect', id, options });
      return { sandboxId: id, commands: {
        async run(command, input) {
          durableLaunch(); calls.push({ method: 'run', command, input, id });
          const completed = Promise.withResolvers(), task = { completed, input, finished: false };
          pending.push(task);
          const finish = () => {
            if (task.finished) return; task.finished = true;
            input.onStdout('远程😀\n'); input.onStderr('remote diagnostic'); completed.resolve({ exitCode: 0 });
          };
          task.finish = finish;
          if (!hold) queueMicrotask(finish);
          return { pid: 100 + pending.length, wait: () => completed.promise, disconnect: async () => {} };
        },
        async kill(pid) {
          calls.push({ method: 'kill', pid, id }); pending[pid - 101]?.finish(); return true;
        },
      } };
    },
    async kill() { assert.fail('turn release must not kill the Session sandbox'); },
  } };
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: sandboxMode }) }, tools: {
    argumentEncodings: ['dsh.raw-json-number/v1'],
    register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name); },
    async execute(input) {
      if (rejectPolicy) return { isError: true, content: [{ type: 'text', text: 'DSH policy denied' }] };
      claimed(); const definition = registry.get(input.name);
      // Like the real DSH ToolRegistry, catch a rejected builtin body and
      // return an error result. A raw rejection would exercise a different
      // unknown-effect path instead of the gateway's known permission denial.
      try {
        const value = await definition.execute(input.arguments, input);
        return { isError: false, value, content: definition.output.render(input.arguments, value) };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.code ?? error.message }] }; }
    },
  } };
  function bind(changedEnv = env) {
    gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, toolBindings: names }, workspaceRoot, stateDir,
      commandEnvironment: changedEnv, e2bLoadSdk: async () => { loads++; return sdk; } });
  }
  bind();
  async function run(runId, model, { sessionId = 'session', selectedScope = scope } = {}) {
    currentRun = runId; currentScope = selectedScope; agent.session.id = sessionId;
    const tools = gateway.definitions(agent, [...registry.values()]);
    const { config, snapshot } = fixture({ tools, limits: { effectTimeoutMs: Math.max(630000, ...tools.map(tool => tool.timeoutMs + 10000)) } });
    const kernel = new NativeKernel({ store: ledger, digest, owner: 'host', ports: {
      ...gateway.forAgent(agent, { scope: selectedScope, store: ledger }), model: { generate: model },
    } });
    kernel.start({ ...snapshot, scope: selectedScope, runId, sessionId, turnId: runId }, config);
    return kernel.runUntilIdle(selectedScope, runId);
  }
  t.after(async () => {
    for (const task of pending) task.finish();
    await until(() => pending.every(task => task.finished)); await delay(50);
    await gateway.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, workspaceRoot, stateDir, agent, calls, env, run,
    get gateway() { return gateway; }, get ledger() { return ledger; }, get loads() { return loads; },
    deny(value) { rejectPolicy = value; }, onCreate(fn) { createHook = fn; }, complete() { for (const task of pending) task.finish(); },
    readOnly(approval) { sandboxMode = 'read-only'; ctx.approval = { request: approval }; },
    async reopen(changedEnv) { await gateway.close(); ledger.close(); ledger = new SqliteRunStore(filename); bind(changedEnv); },
    notification(runId) {
      const source = ledger.load(scope, runId), head = ledger.sessionHead(scope, source.snapshot.sessionId);
      return { contract: BACKGROUND_NOTIFICATION_ADMISSION, scope, sessionId: source.snapshot.sessionId,
        sourceRunId: runId, sourceRevision: source.snapshot.revision, sourceConfigDigest: source.snapshot.configDigest,
        headRunId: head.runId, ref: source.snapshot.backgroundCommands[0].ref, signal: new AbortController().signal };
    },
  };
}

test('malformed explicit E2B configuration rejects before registering any command or importing the SDK', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2b-invalid-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  let registered = 0, loads = 0;
  const ctx = { effect: install => install(), tools: { register: () => { registered++; }, execute: () => assert.fail('not admitted') } };
  for (const change of [{ E2B_API_KEY: '' }, { E2B_API_URL: 'http://wrong.invalid' },
    { KSADK_SANDBOX_TEMPLATE_ID: '' }, { KSADK_SANDBOX_BACKEND: 'pod_process' }]) {
    assert.throws(() => createNativeDshTools({ ctx, config: { toolBindings: names }, workspaceRoot,
      stateDir: join(root, 'state'), commandEnvironment: { ...environment(), ...change },
      e2bLoadSdk: async () => { loads++; assert.fail('invalid config cannot load SDK'); } }));
  }
  assert.equal(registered, 0); assert.equal(loads, 0);
});

test('explicit E2B executes through a claimed Native intent and SDK port with no Host process or environment leakage', async t => {
  const h = setup(t), binding = h.gateway.commandBinding;
  assert.equal(binding.backend, 'e2b'); assert.equal(h.loads, 0);
  h.env.KSADK_SANDBOX_BACKEND = 'local'; h.env.E2B_API_KEY = 'changed'; h.env.KSADK_SANDBOX_TEMPLATE_ID = 'changed';
  let step = 0;
  const done = await h.run('remote-run', async request => {
    if (!step++) return call('run_command', { command: 'touch must-not-exist-locally', cwd: '/remote/work', env: { ONLY: 'explicit' }, timeout: 999999 });
    const result = last(request);
    assert.equal(result.ok, true, canonical(result)); assert.equal(result.backend, 'sandbox/e2b');
    assert.equal(result.stdout, '远程😀\n'); assert.equal(result.exit_code, 0); return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(existsSync(join(h.workspaceRoot, 'must-not-exist-locally')), false);
  assert.deepEqual(h.calls.map(row => row.method), ['create', 'connect', 'run']);
  const created = h.calls[0], executed = h.calls[2];
  assert.equal(created.template, 'fixed-template'); assert.equal(created.options.apiKey, 'private-e2b-key');
  assert.deepEqual(created.options.envs, {}); assert.equal(executed.input.cwd, '/remote/work');
  assert.deepEqual(executed.input.envs, { ONLY: 'explicit' });
  assert.equal(executed.input.timeoutMs, 900000, 'foreground deadline clamps to the pinned sandbox limit');
  const definition = h.ledger.load(scope, 'remote-run').configuration.tools.find(tool => tool.name === 'run_command');
  assert.ok(definition.timeoutMs > executed.input.timeoutMs + 15000, 'formal deadline includes the entire foreground wait');
  assert.equal(JSON.stringify(h.ledger.load(scope, 'remote-run')).includes('private-e2b-key'), false);
  const before = canonical(h.ledger.load(scope, 'remote-run'));
  await h.run('remote-run', async () => assert.fail('completed delivery must not re-enter model'));
  assert.equal(canonical(h.ledger.load(scope, 'remote-run')), before);
  assert.equal(h.calls.filter(row => row.method === 'run').length, 1);
});

test('background observation is read-only and owned output survives gateway/SQLite reopen without another remote call', async t => {
  const h = setup(t, { hold: true }); let step = 0, taskId;
  const done = await h.run('background', async request => {
    if (!step++) return call('run_command', { command: 'remote background', background: true, background_timeout: 30 });
    taskId = last(request).task_id; assert.equal(last(request).backend, 'sandbox/e2b'); return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(done.backgroundCommands.length, 1);
  await until(() => h.calls.some(row => row.method === 'run'));
  const observer = h.gateway.backgroundObserver(h.agent, { scope, store: h.ledger });
  assert.deepEqual(Object.keys(observer).sort(), ['contract', 'observeCompletion']);
  const probe = h.notification('background'); assert.equal(await observer.observeCompletion(probe), null);
  h.complete();
  const output = await until(() => observer.observeCompletion(probe));
  assert.equal(output.status, 'completed'); assert.equal(output.stdout, '远程😀\n');
  const source = canonical(h.ledger.load(scope, 'background')), count = h.calls.length;
  await h.gateway.releaseSession({ sessionId: 'session', scope }); await h.reopen();
  const cold = h.gateway.backgroundObserver(h.agent, { scope, store: h.ledger });
  assert.deepEqual(await cold.observeCompletion(h.notification('background')), output);
  step = 0;
  const next = await h.run('read-after-reopen', async request => {
    if (!step++) return call('read_command_output', { task_id: taskId });
    assert.equal(last(request).ok, true); assert.equal(last(request).stdout, '远程😀\n'); return final();
  });
  assert.equal(next.phase, 'completed'); assert.equal(h.calls.length, count);
  assert.equal(canonical(h.ledger.load(scope, 'background')), source);
});

test('DSH policy denial and unowned read/stop have no remote effects or local fallback', async t => {
  const h = setup(t, { denied: true }); let step = 0;
  await h.run('denied', async () => !step++ ? call('run_command', { command: 'forbidden' }) : final());
  assert.equal(h.loads, 0); assert.deepEqual(h.calls, []); h.deny(false);
  for (const name of ['read_command_output', 'stop_command']) {
    step = 0;
    const done = await h.run(name, async request => {
      if (!step++) return call(name, { task_id: 'a'.repeat(64) });
      assert.equal(last(request).ok, false); return final();
    });
    assert.equal(done.phase, 'completed');
  }
  assert.deepEqual(h.calls, []);
});

test('remote command still requires the actual Host one-shot approval under read-only policy', async t => {
  const h = setup(t), approvals = []; let allowed = false;
  h.readOnly(async request => { approvals.push(request); return allowed ? 'allowed-once' : 'denied'; });
  let step = 0;
  const rejected = await h.run('read-only-denied', async request => {
    if (!step++) return call('run_command', { command: 'requires approval' });
    assert.ok(request.messages.filter(message => message.role === 'tool').at(-1).content.includes('STUDIO_NATIVE_PERMISSION_DENIED'));
    return final();
  });
  assert.equal(rejected.phase, 'completed'); assert.deepEqual(h.calls, []); assert.equal(h.loads, 0);
  const denial = h.ledger.load(scope, 'read-only-denied').receipts.flatMap(row => row.result.results ?? []);
  assert.equal(denial.length, 1); assert.equal(denial[0].status, 'error');
  assert.deepEqual(denial[0].content, { code: 'STUDIO_NATIVE_PERMISSION_DENIED', executed: false });
  allowed = true; step = 0;
  const accepted = await h.run('read-only-once', async request => {
    if (!step++) return call('run_command', { command: 'approved remote command' });
    assert.equal(last(request).ok, true); return final();
  });
  assert.equal(accepted.phase, 'completed'); assert.equal(approvals.length, 2);
  assert.ok(approvals.every(row => row.toolName === 'run_command' && row.signal instanceof AbortSignal));
  assert.equal(h.calls.filter(row => row.method === 'run').length, 1);
});

test('full Native scope and Session isolate remote sandbox ownership even in one shared Host state directory', async t => {
  const h = setup(t);
  for (const [i, options] of [{}, { sessionId: 'other-session' }, { selectedScope: { ...scope, userId: 'other-user' } }].entries()) {
    let step = 0;
    const done = await h.run(`owner-${i}`, async () => !step++ ? call('run_command', { command: 'separate' }) : final(), options);
    assert.equal(done.phase, 'completed');
  }
  assert.equal(h.calls.filter(row => row.method === 'create').length, 3);
  assert.equal(new Set(h.calls.filter(row => row.method === 'create').map(row => row.options.metadata.nativeOwner)).size, 3);
});

test('a changed connection cannot borrow a prior Session sandbox, read its task or silently run locally', async t => {
  const h = setup(t); let step = 0, taskId;
  await h.run('original', async request => {
    if (!step++) return call('run_command', { command: 'original', background: true });
    taskId = last(request).task_id; return final();
  });
  await until(() => h.calls.some(row => row.method === 'run')); await delay(100);
  const count = h.calls.length;
  await h.reopen({ ...environment(), E2B_API_URL: 'https://changed.fixture.invalid' }); step = 0;
  const read = await h.run('changed-read', async request => {
    if (!step++) return call('read_command_output', { task_id: taskId });
    assert.ok(request.messages.filter(message => message.role === 'tool').at(-1).content.includes('e2b_owner_binding_changed'));
    return final();
  });
  assert.equal(read.phase, 'completed'); assert.equal(step, 2);
  const reads = h.ledger.load(scope, 'changed-read').receipts.flatMap(row => row.result.results ?? []);
  assert.equal(reads.length, 1); assert.equal(reads[0].status, 'error');
  step = 0;
  const changed = await h.run('changed-launch', async () => !step++ ? call('run_command', { command: 'must not run' }) : final());
  assert.equal(changed.phase, 'completed'); assert.equal(h.calls.length, count);
  const results = h.ledger.load(scope, 'changed-launch').receipts.flatMap(row => row.result.results ?? []);
  assert.equal(results.length, 1); assert.equal(results[0].status, 'error');
  assert.ok(canonical(results[0].content).includes('e2b_owner_binding_changed'));
});

test('Host close during sandbox creation retains the proven remote identity as unknown and never starts a command', async t => {
  const h = setup(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  h.onCreate(async () => { entered.resolve(); await release.promise; });
  let step = 0;
  const pending = h.run('close-during-create', async () => !step++ ? call('run_command', { command: 'must not start' }) : assert.fail('unknown effect cannot continue model'));
  await entered.promise; await h.gateway.close(); release.resolve();
  const done = await pending;
  assert.notEqual(done.phase, 'completed'); assert.deepEqual(h.calls.map(row => row.method), ['create']);
  const owners = join(h.stateDir, 'e2b-commands', digest(scope), 'owners');
  const record = JSON.parse(readFileSync(join(owners, readdirSync(owners)[0], 'owner.json'), 'utf8'));
  assert.equal(record.phase, 'unknown'); assert.equal(record.sandboxId, 'sandbox-1');
  assert.equal(record.outcomeReason, 'sandbox_create_authority_lost');
  const before = canonical(h.ledger.load(scope, 'close-during-create'));
  await h.reopen();
  assert.equal(canonical(h.ledger.load(scope, 'close-during-create')), before);
  assert.equal(h.calls.length, 1);
});
