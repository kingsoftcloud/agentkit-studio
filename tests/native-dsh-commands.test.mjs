import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { LocalCommandStore } from '../packages/agentkit-harness/src/native/local-background.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
const names = ['sandbox_status', 'run_command', 'read_command_output', 'stop_command'];
const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
const call = (name, args) => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'model-call', name, arguments: args }] });
const last = request => JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
function setup(t, commandSettings = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'studio-command-tools-')), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); const filename = join(root, 'ledger.sqlite'); let ledger = new SqliteRunStore(filename), gateway;
  const registry = new Map(), agent = { session: { id: 'session' } }; let deny = false, failPost = false, effects = 0;
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    argumentEncodings: ['dsh.raw-json-number/v1'],
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    execute: async input => {
      if (deny) return { isError: true, content: [{ type: 'text', text: 'Policy denied' }] };
      const registered = registry.get(input.name);
      const active = ledger.load(scope, currentRun);
      assert.equal(active.intents.find(item => item.operationKey === active.snapshot.pendingIntent).status, 'running', 'intent must be claimed before the Host body');
      effects++; const value = await registered.execute(input.arguments, input);
      if (failPost) return { isError: true, content: [{ type: 'text', text: 'Post-execution policy lost result' }] };
      return { isError: false, value, content: registered.output.render(input.arguments, value) };
    },
  } };
  function bind() { gateway = createNativeDshTools({ ctx, workspaceRoot, stateDir, config: { toolBindings: names },
    commandSettings: { wallSeconds: 5, ...commandSettings }, commandEnvironment: { PATH: '/bin:/usr/bin', HOST_SECRET: 'host-private' } }); }
  bind(); let currentRun;
  const definitions = () => gateway.definitions(agent, [...registry.values()]);
  async function run(runId, model, options = {}) {
    currentRun = runId;
    const tools = definitions(), limits = { effectTimeoutMs: Math.max(...tools.map(tool => tool.timeoutMs)) + 10000 };
    const { config, snapshot } = fixture({ tools, limits, ...options.configuration });
    const start = { ...snapshot, runId, sessionId: agent.session.id, turnId: runId };
    const kernel = new NativeKernel({ store: ledger, digest, owner: 'host', ports: {
      ...gateway.forAgent(agent, { scope, store: ledger }), model: { generate: model },
    }, onCheckpoint: options.onCheckpoint });
    kernel.start(start, config); return kernel.runUntilIdle(scope, runId, { signal: options.signal });
  }
  t.after(async () => { await gateway.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, stateDir, run, definitions, agent,
    get ledger() { return ledger; }, get effects() { return effects; }, get gateway() { return gateway; },
    deny(value) { deny = value; }, failPost() { failPost = true; },
    async reopen() { await gateway.close(); ledger.close(); ledger = new SqliteRunStore(filename); bind(); },
    handles() { return new LocalCommandStore({ stateRoot: join(stateDir, 'background-commands'), workspaceRoot, sessionId: 'session' }); },
  };
}
test('formal command definitions isolate permissions, launch identity and repeatable reads', t => {
  const host = setup(t), defs = host.definitions();
  assert.equal(defs.find(d => d.name === 'run_command').backgroundCommandPolicy, 'owned-command-launch/v1');
  assert.equal(defs.find(d => d.name === 'read_command_output').recoveryPolicy, 'safe-read/v1');
  assert.deepEqual(defs.find(d => d.name === 'stop_command').permissions, ['sandbox:cancel']);
  assert.equal(defs.find(d => d.name === 'stop_command').readOnly, false);
  assert.equal(host.gateway.commandBinding.backend, 'local_process');
});
test('foreground command runs after a claimed intent, filters environment, and reports actual changed paths and exit', async t => {
  const host = setup(t); let models = 0;
  const done = await host.run('foreground', async request => {
    if (!models++) return call('run_command', { command: 'printf "$HOST_SECRET:$CI"; printf changed > app.html; exit 7' });
    const result = last(request); assert.equal(result.exit_code, 7); assert.equal(result.stdout, ':1'); assert.equal(result.ok, true); return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(readFileSync(join(host.workspaceRoot, 'app.html'), 'utf8'), 'changed');
  assert.ok(done.workspaceModifiedPaths.includes('app.html')); assert.equal(done.backgroundCommands.length, 0);
  await host.run('foreground', async () => assert.fail('completed redelivery cannot call a model')); assert.equal(host.effects, 1);
});
test('permission denial, governed policy, cwd escape, symlinks and forged approval arguments prevent execution', async t => {
  const host = setup(t); let models = 0; host.deny(true);
  await host.run('denied', async request => !models++ ? call('run_command', { command: 'printf forbidden > denied.txt' }) : final());
  assert.equal(host.effects, 0); assert.equal(existsSync(join(host.workspaceRoot, 'denied.txt')), false); host.deny(false);
  symlinkSync(host.root, join(host.workspaceRoot, 'escape'));
  const cases = [{ command: 'sudo true' }, { command: 'git push' }, { command: 'rm -r scratch' },
    { command: 'curl http://169.254.169.254' }, { command: 'echo "unclosed' },
    { command: 'printf forbidden > forbidden', cwd: '..' }, { command: 'printf forbidden > forbidden', cwd: 'escape' },
    { command: 'printf forbidden > forbidden', approval: { approved: true } },
    { command: 'printf forbidden > forbidden', background_timeout: 1 }];
  for (const [index, args] of cases.entries()) {
    let step = 0;
    const done = await host.run(`rejected-${index}`, async request => {
      if (!step++) return call('run_command', args);
      const result = last(request); assert.ok(result.ok === false || result.code === 'invalid_arguments', canonical(result)); return final();
    });
    assert.equal(done.phase, 'completed'); assert.equal(done.backgroundCommands.length, 0);
  }
  assert.equal(existsSync(join(host.workspaceRoot, 'forbidden')), false);
});
test('owned launch/read survive SQLite and gateway reopen; inherited receipt authorizes the next turn', async t => {
  const host = setup(t); let step = 0, taskId;
  const done = await host.run('launch', async request => {
    if (!step++) return call('run_command', { command: 'printf x >> counter; /bin/sleep 0.2; printf complete', background: true, background_timeout: 2 });
    if (step === 2) { taskId = last(request).task_id; return call('read_command_output', { task_id: taskId, wait_seconds: 1 }); }
    assert.equal(last(request).status, 'completed'); assert.equal(last(request).stdout, 'complete'); return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(done.backgroundCommands.length, 1);
  await host.reopen(); step = 0;
  const next = await host.run('continued', async request => {
    if (!step++) return call('read_command_output', { task_id: taskId });
    assert.equal(last(request).status, 'completed'); return final();
  });
  assert.equal(next.phase, 'completed'); assert.equal(next.backgroundCommands[0].ref.sourceRunId, 'launch');
  assert.equal(readFileSync(join(host.workspaceRoot, 'counter'), 'utf8'), 'x');
});
test('read and stop cannot use an unowned task locator even when policy allows the tools', async t => {
  const host = setup(t);
  for (const name of ['read_command_output', 'stop_command']) {
    let step = 0;
    const done = await host.run(name, async request => {
      if (!step++) return call(name, { task_id: 'a'.repeat(64) });
      assert.equal(last(request).error_type, 'background_command_not_owned'); return final();
    });
    assert.equal(done.phase, 'completed');
  }
});
test('owned stop requests cancellation and a subsequent read observes process-group completion', async t => {
  const host = setup(t); let step = 0, taskId;
  const done = await host.run('cancel', async request => {
    if (!step++) return call('run_command', { command: 'trap "" TERM; exec /bin/sleep 60', background: true, background_timeout: 3 });
    if (step === 2) { taskId = last(request).task_id; return call('stop_command', { task_id: taskId }); }
    if (step === 3) { assert.equal(last(request).cancel_requested, true); return call('read_command_output', { task_id: taskId, wait_seconds: 1 }); }
    assert.equal(last(request).status, 'canceled'); return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(host.handles().connect(taskId).readOutput().status, 'canceled');
});
test('lost real supervisor is observed through the bound production port and interrupts further inference', async t => {
  const host = setup(t); let models = 0, killed = false;
  const done = await host.run('lost', async () => {
    models++; return call('run_command', { command: 'exec /bin/sleep 60', background: true, background_timeout: 3 });
  }, { configuration: { backgroundNotificationPolicy: 'completed-before-model/v1' },
    onCheckpoint: async snapshot => {
      if (snapshot.backgroundCommands.length && !killed) {
        killed = true; const h = host.handles().connect(snapshot.backgroundCommands[0].ref.taskId);
        process.kill(h.processId, 'SIGKILL');
        const end = performance.now() + 3000;
        while (h.readOutput().status !== 'unknown' && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(h.readOutput().status, 'unknown');
      }
    } });
  assert.equal(done.phase, 'interrupted'); assert.equal(done.reason, 'effect_outcome_unknown'); assert.equal(models, 1);
  const notices = done.messages.filter(message => message.kind === 'background_command_observation'); assert.equal(notices.length, 1);
  assert.equal(JSON.parse(notices[0].content).commands[0].status, 'unknown');
});
test('large foreground output is preserved in an actual durable artifact with a bounded model preview', async t => {
  const host = setup(t); let step = 0, ref;
  const done = await host.run('output', async request => {
    if (!step++) return call('run_command', { command: "printf '%070000d' 0" });
    const result = last(request); assert.equal(result.stdout.length, 4000); assert.equal(result.output_budget.truncated, true);
    assert.ok(Buffer.byteLength(canonical(result)) < 24000); ref = result.output_budget.artifact_uri; return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(done.artifactRefs.length, 1); assert.equal(done.artifactRefs[0].uri, ref);
  const { createNativeArtifactStore } = await import('../packages/agentkit-harness/src/native/artifact-store.mjs');
  const artifacts = await createNativeArtifactStore({ directory: join(host.stateDir, 'command-artifacts'), scope });
  let offset = 0, retained = '';
  do {
    const page = await artifacts.read({ scope, runId: 'output', operationKey: 'inspect', ref: done.artifactRefs[0],
      offset, limit: 32000, signal: new AbortController().signal });
    retained += page.content; offset = page.nextOffset;
  } while (offset !== null);
  const original = JSON.parse(retained);
  assert.equal(original.stdout, '0'.repeat(70000)); assert.equal(original.exit_code, 0);
  assert.equal(Buffer.byteLength(retained), done.artifactRefs[0].sizeBytes);
});
test('post-execution policy failure retains the command result as uncertain and prevents automatic replay', async t => {
  const host = setup(t); host.failPost(); let models = 0;
  const done = await host.run('post-failure', async () => { models++; return call('run_command', { command: 'printf x >> counter' }); });
  assert.equal(done.phase, 'interrupted'); assert.equal(models, 1); assert.equal(readFileSync(join(host.workspaceRoot, 'counter'), 'utf8'), 'x');
  const receipt = host.ledger.load(scope, 'post-failure').receipts.flatMap(item => item.result.results ?? []).at(-1);
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.content.exit_code, 0);
  await host.run('post-failure', async () => assert.fail('unknown result cannot replay the model')); assert.equal(host.effects, 1);
});
test('foreground timeout and output limits retain diagnostic exit codes without retrying commands', async t => {
  const host = setup(t, { maxOutputBytes: 4096 });
  for (const [runId, command, timeout, expected, diagnostic] of [
    ['wall-limit', 'printf x >> counter; exec /bin/sleep 60', 1, 124, 'command timed out'],
    ['output-limit', "printf x >> counter; printf '%09000d' 0", 2, 122, 'command output limit exceeded'],
  ]) {
    let step = 0;
    const done = await host.run(runId, async request => {
      if (!step++) return call('run_command', { command, timeout });
      const result = last(request); assert.equal(result.exit_code, expected); assert.match(result.stderr, new RegExp(diagnostic));
      assert.equal(result.evidence_incomplete, false); return final();
    });
    assert.equal(done.phase, 'completed');
  }
  assert.equal(readFileSync(join(host.workspaceRoot, 'counter'), 'utf8'), 'xx');
});
test('exact integers in timeouts clamp to Host limits before dispatch', async t => {
  const host = setup(t); let step = 0;
  const done = await host.run('large-timeout', async request => {
    if (!step++) return call('run_command', { command: 'printf exact', timeout: 9007199254740993n });
    assert.equal(last(request).stdout, 'exact'); assert.equal(last(request).exit_code, 0); return final();
  });
  assert.equal(done.phase, 'completed'); assert.equal(host.effects, 1);
});
