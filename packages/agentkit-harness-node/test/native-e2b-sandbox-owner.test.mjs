import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNativeE2BSandboxOwner } from '../src/native/e2b-sandbox-owner.mjs';

const scope = { tenantId: 'tenant', userId: 'user', workspaceId: 'workspace', agentId: 'agent' };
const bindingDigest = 'a'.repeat(64);
const signal = () => new AbortController().signal;
const request = (changes = {}) => ({ scope, sessionId: 'session', runId: 'run', turnId: 'turn', buildId: 'build',
  parentRunId: null, taskChainId: 'chain', operationKey: 'launch', executionFence: 1,
  signal: signal(), definition: { name: 'run_command' }, call: { name: 'run_command', callId: 'call', arguments: { command: 'hello' } }, ...changes });
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function setup(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-e2b-owner-')));
  const workspaceRoot = join(root, 'workspace'), stateRoot = join(root, 'state'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = [], killed = [];
  const config = { workspaceRoot, stateRoot, scope, sessionId: 'session', bindingDigest, assertAuthority: () => true,
    createSandbox: async input => { created.push(input); return { sandboxId: 'remote-A' }; },
    killSandbox: async id => { killed.push(id); return true; }, ...extra };
  const owner = createNativeE2BSandboxOwner(config);
  return { root, config, owner, created, killed, reopen: changes => createNativeE2BSandboxOwner({ ...config, ...changes }) };
}

test('a synchronous authority cannot mutate the Native call or signal and then authorize creation; rejected thenables are observed', async t => {
  for (const authority of [value => { value.call.arguments.command = 'changed'; return true; },
    value => { value.signal = signal(); return true; }, () => Promise.reject(Error('observed async authority'))]) {
    const fixture = setup(t, { assertAuthority: authority });
    await assert.rejects(fixture.owner.ensure(request()));
    assert.deepEqual(fixture.created, []); assert.equal(fixture.owner.inspect(), null);
  }
});

test('creation has a durable intent before the API, then reopens the same sandbox without another API call', async t => {
  const fixture = setup(t);
  const owner = fixture.reopen({ createSandbox: async input => {
    fixture.created.push(input);
    const state = fixture.owner.inspect(); assert.equal(state.phase, 'creating'); assert.equal(state.sandboxId, null);
    assert.equal(state.createIdentity.operationKey, 'launch'); return { sandboxId: 'remote-A' };
  } });
  const input = request(); assert.deepEqual(await owner.ensure(input), { sandboxId: 'remote-A', created: true });
  assert.equal(fixture.created[0].signal, input.signal);
  assert.deepEqual(await fixture.reopen().ensure(request({ runId: 'next', operationKey: 'next-launch' })), { sandboxId: 'remote-A', created: false });
  assert.equal(fixture.created.length, 1); assert.equal(owner.inspect().phase, 'ready');
});

test('concurrent opens serialize around one actual creation', async t => {
  const entered = gate(), finish = gate(); let creations = 0;
  const fixture = setup(t, { createSandbox: async () => { creations++; entered.resolve(); await finish.promise; return { sandboxId: 'remote-A' }; } });
  const first = fixture.owner.ensure(request()); await entered.promise;
  const second = fixture.reopen().ensure(request({ operationKey: 'second' })); finish.resolve();
  assert.equal((await first).created, true); assert.equal((await second).created, false); assert.equal(creations, 1);
});

test('an uncertain create is persisted and never automatically retried after reopen', async t => {
  let creates = 0;
  const fixture = setup(t, { createSandbox: async () => { creates++; throw new Error('request lost after remote create'); } });
  await assert.rejects(fixture.owner.ensure(request()), { code: 'e2b_sandbox_outcome_unknown' });
  assert.equal(fixture.owner.inspect().phase, 'unknown');
  await assert.rejects(fixture.reopen().ensure(request({ operationKey: 'another-command' })), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
  assert.equal(creates, 1);
});

test('late cancellation retains the proven remote identity without granting a ready sandbox', async t => {
  const entered = gate(), finish = gate(), controller = new AbortController();
  const fixture = setup(t, { createSandbox: async () => { entered.resolve(); await finish.promise; return { sandboxId: 'remote-A' }; } });
  const pending = fixture.owner.ensure(request({ signal: controller.signal }));
  const expected = assert.rejects(pending, { code: 'e2b_sandbox_outcome_unknown' });
  await entered.promise; controller.abort(); finish.resolve(); await expected;
  assert.equal(fixture.owner.inspect().phase, 'unknown'); assert.equal(fixture.owner.inspect().sandboxId, 'remote-A');
  assert.deepEqual(fixture.killed, []);
});

test('scope, missing authority and pre-abort reject before any remote operation', async t => {
  const fixture = setup(t, { assertAuthority: () => false });
  await assert.rejects(fixture.owner.ensure(request()), /e2b_owner_authority_unproven/);
  await assert.rejects(fixture.owner.ensure(request({ scope: { ...scope, agentId: 'foreign' } })), /e2b_owner_scope_mismatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.owner.ensure(request({ signal: controller.signal })), { name: 'AbortError' });
  assert.equal(fixture.created.length, 0); assert.equal(fixture.owner.inspect(), null);
});

test('context drift during create remains unknown and prevents reusing it as a completed creation', async t => {
  const entered = gate(), finish = gate();
  const fixture = setup(t, { createSandbox: async () => { entered.resolve(); await finish.promise; return { sandboxId: 'remote-A' }; } });
  const input = request(), pending = fixture.owner.ensure(input);
  const expected = assert.rejects(pending, { code: 'e2b_sandbox_outcome_unknown' });
  await entered.promise; input.executionFence++; finish.resolve(); await expected;
  assert.equal(fixture.owner.inspect().outcomeReason, 'sandbox_create_authority_lost');
});

test('a changed backend binding or foreign Session cannot reuse the owner record', async t => {
  const fixture = setup(t); await fixture.owner.ensure(request());
  const changed = fixture.reopen({ bindingDigest: 'b'.repeat(64) });
  await assert.rejects(changed.ensure(request()), /e2b_owner_binding_changed/);
  const foreign = fixture.reopen({ sessionId: 'other-session' });
  assert.equal(foreign.inspect(), null);
  await assert.rejects(foreign.ensure(request()), /e2b_owner_scope_mismatch/);
});

test('cleanup persists its intent, awaits the exact original sandbox and becomes idempotently closed', async t => {
  const fixture = setup(t); await fixture.owner.ensure(request());
  const owner = fixture.reopen({ killSandbox: async (id, opts) => {
    assert.equal(fixture.owner.inspect().phase, 'closing'); assert.ok(opts.signal instanceof AbortSignal);
    fixture.killed.push(id); return true;
  } });
  assert.deepEqual(await owner.close(request({ operationKey: 'close' })), { confirmed: true, sandboxId: 'remote-A' });
  assert.equal(owner.inspect().phase, 'closed');
  assert.deepEqual(await fixture.reopen().close(request({ operationKey: 'close-again' })), { confirmed: true, sandboxId: 'remote-A' });
  assert.deepEqual(fixture.killed, ['remote-A']);
  await assert.rejects(owner.ensure(request()), /e2b_sandbox_owner_closed/);
});

test('unconfirmed cleanup or lost authority retains the original identity and blocks a replacement launch', async t => {
  for (const outcome of [false, 'true', new Error('transport lost')]) {
    const fixture = setup(t); await fixture.owner.ensure(request());
    const owner = fixture.reopen({ killSandbox: async () => { if (outcome instanceof Error) throw outcome; return outcome; } });
    const result = await owner.close(request({ operationKey: 'close' }));
    assert.equal(result.confirmed, false); assert.equal(result.uncertain, true);
    assert.equal(owner.inspect().sandboxId, 'remote-A'); assert.equal(owner.inspect().phase, 'unknown');
    await assert.rejects(fixture.reopen().ensure(request()), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
  }
});

test('process death during creation releases the lock and reopens as unknown without creating again', async t => {
  const fixture = setup(t);
  const moduleUrl = new URL('../src/native/e2b-sandbox-owner.mjs', import.meta.url).href;
  const code = `import {readFileSync} from 'node:fs';
    import {createNativeE2BSandboxOwner} from ${JSON.stringify(moduleUrl)};
    const {config,input}=JSON.parse(readFileSync(0,'utf8'));
    const owner=createNativeE2BSandboxOwner({...config,assertAuthority:()=>true,
      createSandbox:async()=>{process.exit(37)},killSandbox:async()=>true});
    await owner.ensure({...input,signal:new AbortController().signal});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    input: JSON.stringify({ config: { stateRoot: fixture.config.stateRoot, workspaceRoot: fixture.config.workspaceRoot,
      scope, sessionId: 'session', bindingDigest }, input: { ...request(), signal: undefined } }) });
  assert.equal(child.status, 37, child.stderr); assert.equal(fixture.owner.inspect().phase, 'creating');
  await assert.rejects(fixture.reopen().ensure(request({ runId: 'recovered' })), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
  assert.equal(fixture.owner.inspect().phase, 'unknown'); assert.equal(fixture.created.length, 0);
});

test('state inside the model workspace is refused before any directory is created', t => {
  const fixture = setup(t), inside = join(fixture.config.workspaceRoot, 'must-not-exist');
  assert.throws(() => fixture.reopen({ stateRoot: inside }), /e2b_owner_state_inside_workspace/);
  assert.equal(existsSync(inside), false);
  assert.equal(fixture.owner.inspect(), null);
});

test('an asynchronous authority predicate is never treated as synchronous proof', async t => {
  const fixture = setup(t, { assertAuthority: async () => true });
  await assert.rejects(fixture.owner.ensure(request()), /e2b_owner_authority_unproven/);
  assert.equal(fixture.created.length, 0); assert.equal(fixture.owner.inspect(), null);
});

test('a confirmed kill arriving after its fence was revoked stays unknown', async t => {
  const entered = gate(), finish = gate(); let current = true;
  const fixture = setup(t, { assertAuthority: () => current,
    killSandbox: async () => { entered.resolve(); await finish.promise; return true; } });
  await fixture.owner.ensure(request());
  const pending = fixture.owner.close(request({ operationKey: 'close' }));
  await entered.promise; current = false; finish.resolve();
  assert.deepEqual(await pending, { confirmed: false, sandboxId: 'remote-A', uncertain: true });
  assert.equal(fixture.owner.inspect().phase, 'unknown');
  assert.equal(fixture.owner.inspect().outcomeReason, 'sandbox_kill_authority_lost');
});

async function uncertainCreation(t, { knownId = false } = {}) {
  let metadata, createAttempts = 0;
  const fixture = setup(t, { createSandbox: async input => {
    createAttempts++; metadata = input.metadata;
    throw Object.assign(new Error('remote create reply lost'), knownId ? { sandboxId: 'remote-A' } : {});
  } });
  await assert.rejects(fixture.owner.ensure(request()), { code: 'e2b_sandbox_outcome_unknown' });
  const observations = [];
  const owner = fixture.reopen({ assertReconciliationAuthority: () => true,
    inspectSandbox: async (sandboxId, options) => {
      observations.push({ sandboxId, options }); return { sandboxId, state: 'running', metadata: { ...metadata } };
    } });
  const decision = () => ({ sandboxId: 'remote-A', expectedRecordDigest: owner.inspectReconciliation().recordDigest });
  return { ...fixture, owner, observations, decision, metadata, createAttempts: () => createAttempts };
}

test('explicit recovery adopts only a remotely verified original creation without creating or replaying a command', async t => {
  const fixture = await uncertainCreation(t);
  const decision = fixture.decision(), input = request({ operationKey: 'manual-reconcile' });
  assert.deepEqual(await fixture.owner.reconcileAdoption(input, decision), {
    sandboxId: 'remote-A', adopted: true, commandsReconciled: false,
  });
  assert.equal(fixture.observations.length, 1); assert.equal(fixture.observations[0].options.signal, input.signal);
  const record = fixture.reopen().inspect();
  assert.equal(record.phase, 'ready'); assert.equal(record.reconciliation.previousRecordDigest, decision.expectedRecordDigest);
  assert.equal(record.reconciliation.previousOutcomeReason, 'sandbox_create_outcome_unknown');
  assert.equal(record.reconciliation.identity.operationKey, 'manual-reconcile');
  assert.deepEqual(await fixture.reopen().ensure(request({ operationKey: 'after-adoption' })), { sandboxId: 'remote-A', created: false });
  assert.equal(fixture.createAttempts(), 1); assert.deepEqual(fixture.killed, []);
});

test('an ordinary tool authorizer cannot grant recovery and a stale reviewed record cannot trigger an API read', async t => {
  const fixture = await uncertainCreation(t);
  await assert.rejects(fixture.reopen().reconcileAdoption(request(), fixture.decision()), /e2b_owner_reconciliation_unavailable/);
  for (const authority of [() => false, async () => true]) {
    const owner = fixture.reopen({ assertReconciliationAuthority: authority,
      inspectSandbox: async () => { assert.fail('no inspection without exact recovery authority'); } });
    await assert.rejects(owner.reconcileAdoption(request(), fixture.decision()), /e2b_owner_authority_unproven/);
  }
  await assert.rejects(fixture.owner.reconcileAdoption(request(), { ...fixture.decision(), expectedRecordDigest: 'b'.repeat(64) }),
    /e2b_owner_reconciliation_record_changed/);
  assert.equal(fixture.observations.length, 0); assert.equal(fixture.owner.inspect().phase, 'unknown');
});

test('recovery verifies remote owner, original create operation, identity and running state rather than trusting the supplied ID', async t => {
  for (const change of [{ metadata: { nativeOwner: 'foreign', nativeCreateOperation: 'foreign' } },
    { state: 'paused' }, { sandboxId: 'foreign' }, { wrongOperation: true }]) {
    const fixture = await uncertainCreation(t);
    const owner = fixture.reopen({ assertReconciliationAuthority: () => true, inspectSandbox: async sandboxId => ({
      sandboxId, state: 'running', metadata: fixture.metadata, ...change,
      ...(change.wrongOperation ? { metadata: { ...fixture.metadata, nativeCreateOperation: 'foreign' } } : {}),
    }) });
    await assert.rejects(owner.reconcileAdoption(request(), fixture.decision()), /e2b_owner_reconciliation_proof_invalid/);
    assert.equal(owner.inspect().phase, 'unknown');
  }
});

test('a proven sandbox ID cannot be replaced by a recovery candidate even before inspection', async t => {
  const fixture = await uncertainCreation(t, { knownId: true });
  await assert.rejects(fixture.owner.reconcileAdoption(request(), { ...fixture.decision(), sandboxId: 'foreign' }),
    /e2b_owner_reconciliation_sandbox_mismatch/);
  assert.equal(fixture.observations.length, 0); assert.equal(fixture.owner.inspect().sandboxId, 'remote-A');
});

test('unknown cleanup cannot be converted into a ready sandbox by adopting an old creation', async t => {
  const fixture = setup(t); await fixture.owner.ensure(request());
  const owner = fixture.reopen({ killSandbox: async () => false, assertReconciliationAuthority: () => true,
    inspectSandbox: async () => { assert.fail('cleanup requires its own reconciliation'); } });
  await owner.close(request({ operationKey: 'close' }));
  await assert.rejects(owner.reconcileAdoption(request(), { sandboxId: 'remote-A',
    expectedRecordDigest: owner.inspectReconciliation().recordDigest }), /e2b_owner_reconciliation_phase_invalid/);
  assert.equal(owner.inspect().phase, 'unknown');
});

test('authority or exact-decision drift after the backend read keeps the record unknown', async t => {
  for (const drift of ['authority', 'decision', 'signal', 'request']) {
    const fixture = await uncertainCreation(t), entered = gate(), finish = gate(); let authorized = true;
    const owner = fixture.reopen({ assertReconciliationAuthority: () => authorized,
      inspectSandbox: async sandboxId => { entered.resolve(); await finish.promise;
        return { sandboxId, state: 'running', metadata: fixture.metadata }; } });
    const input = request(), decision = fixture.decision();
    const pending = owner.reconcileAdoption(input, decision), expected = assert.rejects(pending);
    await entered.promise;
    if (drift === 'authority') authorized = false;
    if (drift === 'decision') decision.sandboxId = 'replacement';
    if (drift === 'signal') input.signal = signal();
    if (drift === 'request') input.executionFence++;
    finish.resolve(); await expected;
    assert.equal(owner.inspect().phase, 'unknown'); assert.equal(owner.inspect().sandboxId, null);
  }
});

test('an unavailable backend observation remains unknown without allowing another create', async t => {
  const fixture = await uncertainCreation(t);
  const owner = fixture.reopen({ assertReconciliationAuthority: () => true,
    inspectSandbox: async () => { throw new Error('control-plane unavailable'); } });
  await assert.rejects(owner.reconcileAdoption(request(), fixture.decision()), {
    code: 'e2b_owner_reconciliation_observation_unknown', uncertain: true,
  });
  await assert.rejects(owner.ensure(request()), { code: 'e2b_sandbox_outcome_unknown', uncertain: true });
  assert.equal(owner.inspect().phase, 'unknown');
});

test('process death while observing recovery leaves the original unknown record intact', async t => {
  const fixture = await uncertainCreation(t);
  const moduleUrl = new URL('../src/native/e2b-sandbox-owner.mjs', import.meta.url).href;
  const code = `import {readFileSync} from 'node:fs';
    import {createNativeE2BSandboxOwner} from ${JSON.stringify(moduleUrl)};
    const {config,input,decision}=JSON.parse(readFileSync(0,'utf8'));
    const owner=createNativeE2BSandboxOwner({...config,assertAuthority:()=>true,
      assertReconciliationAuthority:()=>true,createSandbox:async()=>{throw Error('must not create')},
      killSandbox:async()=>{throw Error('must not kill')},inspectSandbox:async()=>{process.exit(38)}});
    await owner.reconcileAdoption({...input,signal:new AbortController().signal},decision);`;
  const before = fixture.owner.inspectReconciliation();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    input: JSON.stringify({ config: { stateRoot: fixture.config.stateRoot, workspaceRoot: fixture.config.workspaceRoot,
      scope, sessionId: 'session', bindingDigest }, input: { ...request(), signal: undefined }, decision: fixture.decision() }) });
  assert.equal(child.status, 38, child.stderr);
  assert.deepEqual(fixture.owner.inspectReconciliation(), before);
  assert.equal((await fixture.owner.reconcileAdoption(request(), fixture.decision())).adopted, true);
});
