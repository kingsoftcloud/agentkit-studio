import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNativeHookExecutor, nativeHookExecutionPolicyDigest } from '../src/native/hook-executor.mjs';
import { canonical, validateHookResult, validateHookInvocation, NativeError } from '../../agentkit-harness-core/dist/index.mjs';

// Canonical SHA-256 (hex, no prefix) — identical to the kernel/fixtures digest, so
// the executor's request revalidation matches what the Kernel seals into inputDigest.
const sha = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const CLEANUP = 1000;
const policyDigest = nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: CLEANUP });

// A binding's executionPolicyDigest must equal the executor's own cleanup policy
// digest, so definition() pairs the two: it hashes the same cleanupTimeoutMs the
// executor will declare (unless a test overrides executionPolicyDigest directly).
const definition = (overrides = {}, cleanupTimeoutMs = CLEANUP) => ({
  hookId: 'fixture.check', sourceRef: 'fixture://hook', bindingDigest: 'sha256:' + 'a'.repeat(64),
  executionPolicyDigest: nativeHookExecutionPolicyDigest({ cleanupTimeoutMs }), readOnly: true, events: ['PreToolUse', 'PostToolUse', 'Stop'],
  timeoutMs: 3000, maxInputBytes: 8192, maxOutputBytes: 1024, failureMode: 'block', ...overrides,
});
const identity = { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' };
const output = (overrides = {}) => ({ action: 'continue', additionalContext: [], updatedArguments: null, ...overrides });

function request(event = 'PreToolUse', overrides = {}) {
  const def = overrides.definition ?? definition();
  const input = { goal: 'Inspect the data.', toolCallCount: 0, stopContinuationCount: 0,
    call: { callId: 'call', name: 'read', arguments: { path: 'a' } }, toolResult: null, candidate: null, compaction: null };
  if (event === 'PostToolUse') input.toolResult = { status: 'ok', content: 'DATA_42' };
  else if (event === 'Stop') { input.call = null; input.candidate = { candidateId: 'candidate', text: 'A proposed answer.', goalRevision: 2, workspaceRevision: null }; }
  Object.assign(input, overrides.input ?? {});
  const base = { ...identity, schemaVersion: 'agentkit.native-hook/v1', operationKey: 'hook-op', goalRevision: 2,
    event, definition: def, inputDigest: sha({ definition: def, input }), input };
  return { ...base, ...(overrides.scope ? { scope: overrides.scope } : {}), ...(overrides.signal ? { signal: overrides.signal } : {}) };
}

const drain = async (exec, timeoutMs = 800) => {
  const end = Date.now() + timeoutMs;
  while (exec.pending.size > 0 && Date.now() < end) await new Promise((r) => setImmediate(r));
};
const blockFor = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* synchronous block */ } };

// --- Construction: bind definitions to the host policy, validate full unique bindings ---

test('a binding whose execution policy digest differs from the executor cleanup policy is rejected', () => {
  const foreign = nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: 2000 });
  assert.notEqual(foreign, policyDigest);
  assert.throws(() => createNativeHookExecutor({
    scope, bindings: [{ definition: definition({ executionPolicyDigest: foreign }), callback: async () => output() }],
    authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  }), /execution_policy/);
});

test('duplicate hook ids, non-function callbacks and non-function availability are rejected', () => {
  assert.throws(() => createNativeHookExecutor({
    scope, bindings: [
      { definition: definition(), callback: async () => output() },
      { definition: definition(), callback: async () => output() },
    ], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  }), /duplicate/);
  assert.throws(() => createNativeHookExecutor({
    scope, bindings: [{ definition: definition(), callback: 'nope' }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  }), /binding/);
  assert.throws(() => createNativeHookExecutor({
    scope, bindings: [{ definition: definition(), callback: async () => output(), available: 'nope' }],
    authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  }), /binding/);
});

test('nativeHookExecutionPolicyDigest is deterministic and varies with the cleanup policy', () => {
  assert.equal(nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: CLEANUP }), policyDigest);
  assert.match(policyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: CLEANUP + 1 }), policyDigest);
  assert.throws(() => nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: 0 }), /cleanup_timeout/);
  assert.throws(() => nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: NaN }), /cleanup_timeout/);
});

// --- Detachment: policy and callback receive detached input, output is sealed ---

test('policy and callback receive detached input and the output is sealed against late mutation', async () => {
  const observed = [];
  const authorize = async (value) => {
    observed.push(['policy', { ...value.input.call.arguments }]);
    value.input.call.arguments.path = 'not-authorized'; // must not reach the callback or original
    return 'allow';
  };
  const retained = [];
  const callback = async (value) => {
    observed.push(['callback', { ...value.input.call.arguments }]);
    const produced = output({ updatedArguments: { path: 'new-proposal' } });
    retained.push(produced);
    return produced;
  };
  const original = request();
  const exec = createNativeHookExecutor({ scope, bindings: [{ definition: definition(), callback }], authorize, cleanupTimeoutMs: CLEANUP });
  const result = await exec.invoke(original);
  assert.deepEqual(observed, [['policy', { path: 'a' }], ['callback', { path: 'a' }]]);
  assert.deepEqual(original.input.call.arguments, { path: 'a' }); // caller's original is never mutated
  retained[0].updatedArguments.path = 'late-mutation'; // late mutation of the returned object
  assert.deepEqual(result.output.updatedArguments, { path: 'new-proposal' }); // result holds a sealed copy
  assert.equal(validateHookResult(original, result).status, 'ok');
  await exec.close();
});

test('a callback cannot mutate the sealed original invocation', async () => {
  const original = request();
  const exec = createNativeHookExecutor({
    scope, bindings: [{ definition: definition(), callback: async (value) => {
      value.input.call.arguments.path = 'tampered';
      value.input.goal = 'tampered-goal';
      return output();
    } }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  });
  const result = await exec.invoke(original);
  assert.equal(result.status, 'ok');
  assert.deepEqual(original.input.call.arguments, { path: 'a' }); // original intact
  assert.equal(original.input.goal, 'Inspect the data.');
  await exec.close();
});

// --- Authorization: absent authorizer denies; only an explicit current allow dispatches ---

for (const decision of [undefined, 'deny', 'ALLOW', { approved: true }, 1]) {
  test(`only an explicit current allow reaches the callback (decision=${JSON.stringify(decision)})`, async () => {
    const calls = [];
    const exec = createNativeHookExecutor({
      scope, bindings: [{ definition: definition(), callback: async () => { calls.push('executed'); return output(); } }],
      authorize: decision === undefined ? null : async () => decision, cleanupTimeoutMs: CLEANUP,
    });
    const r = await exec.invoke(request());
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, decision === undefined || decision === 'deny' ? 'policy_denied' : 'policy_error');
    assert.deepEqual(calls, []);
    await exec.close();
  });
}

test('authorizer exceptions and invalid answers are definite policy errors, never uncertain', async () => {
  for (const readOnly of [true, false]) {
    const exec = createNativeHookExecutor({
      scope, bindings: [{ definition: definition({ readOnly }), callback: async () => output() }],
      authorize: async () => { throw Error('auth boom'); }, cleanupTimeoutMs: CLEANUP,
    });
    const r = await exec.invoke(request('PreToolUse', { definition: definition({ readOnly }) }));
    assert.equal(r.status, 'failed', `readOnly=${readOnly}`); // policy errors are always definite
    assert.equal(r.reason, 'policy_error');
    await exec.close();
  }
});

// --- Pre-execution checks: scope, binding and input budget precede policy and execution ---

test('scope, binding and input budget are checked before policy or execution', async () => {
  const calls = [];
  const authorize = async () => { calls.push('policy'); return 'allow'; };
  const callback = async () => { calls.push('callback'); return output(); };
  const exec = createNativeHookExecutor({ scope, bindings: [{ definition: definition(), callback }], authorize, cleanupTimeoutMs: CLEANUP });

  await assert.rejects(() => exec.invoke(request('PreToolUse', { scope: { ...scope, tenantId: 'other' } })), /scope/);
  // A different definition (different maxInputBytes) with the same hook id is a binding mismatch.
  await assert.rejects(() => exec.invoke(request('PreToolUse', { definition: definition({ maxInputBytes: 4096 }) })), /definition/);

  const small = definition({ maxInputBytes: 1 });
  const smallExec = createNativeHookExecutor({ scope, bindings: [{ definition: small, callback }], authorize, cleanupTimeoutMs: CLEANUP });
  const r = await smallExec.invoke(request('PreToolUse', { definition: small }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'input_budget_exceeded');
  assert.deepEqual(calls, []); // neither authorizer nor callback ran
  await exec.close();
  await smallExec.close();
});

// --- Read-only vs mutation classification for missing/invalid outcomes ---

for (const readOnly of [true, false]) for (const failure of ['exception', 'invalid', 'oversized']) {
  test(`missing mutating outcome stays uncertain only for mutating hooks (readOnly=${readOnly}, failure=${failure})`, async () => {
    const def = definition({ readOnly, maxOutputBytes: 128 });
    const callback = async () => {
      if (failure === 'exception') throw Error('FIXTURE_SECRET_CALLBACK_ERROR');
      if (failure === 'invalid') return { verified: true };
      return output({ additionalContext: ['汉'.repeat(64)] });
    };
    const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP });
    const r = await exec.invoke(request('PreToolUse', { definition: def }));
    assert.equal(r.status, readOnly ? 'failed' : 'uncertain');
    assert.equal(r.reason, { exception: 'producer_failed', invalid: 'producer_invalid', oversized: 'output_budget_exceeded' }[failure]);
    assert.equal(r.output, null);
    assert.equal(JSON.stringify(r).includes('FIXTURE_SECRET'), false); // errors are sanitized
    await exec.close();
  });
}

// --- Availability rechecks: binding loss never means permission ---

test('availability is rechecked before publishing callback data and never means permission', async () => {
  let available = true;
  const callback = async () => { available = false; return output({ additionalContext: ['must not be published'] }); };
  const exec = createNativeHookExecutor({
    scope, bindings: [{ definition: definition(), callback, available: () => available }],
    authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  });
  const r = await exec.invoke(request());
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'binding_unavailable');
  assert.equal(r.output, null); // the callback's data was not published
  await exec.close();
});

test('a binding unavailable before authorization is a clean failure, not permission', async () => {
  const calls = [];
  const exec = createNativeHookExecutor({
    scope, bindings: [{ definition: definition(), callback: async () => { calls.push('callback'); return output(); }, available: () => false }],
    authorize: async () => { calls.push('policy'); return 'allow'; }, cleanupTimeoutMs: CLEANUP,
  });
  const r = await exec.invoke(request());
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'binding_unavailable');
  assert.deepEqual(calls, []); // neither authorizer nor callback reached
  await exec.close();
});

// --- Timeout ownership: uncooperative callbacks remain owned, late values ignored ---

for (const readOnly of [true, false]) {
  test(`timeout owns an uncooperative callback and never accepts its late output (readOnly=${readOnly})`, async () => {
    const entered = {}, canceled = {}, release = {};
    const enteredP = new Promise((r) => { entered.resolve = r; });
    const canceledP = new Promise((r) => { canceled.resolve = r; });
    const releaseP = new Promise((r) => { release.resolve = r; });
    const callback = async (req) => {
      entered.resolve();
      req.signal.addEventListener('abort', () => canceled.resolve());
      await releaseP; // uncooperative: ignores the abort, blocks until released
      return output({ additionalContext: ['late output'] });
    };
    const def = definition({ readOnly, timeoutMs: 10 }, 40);
    const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback }], authorize: async () => 'allow', cleanupTimeoutMs: 40 });
    const r = await exec.invoke(request('PreToolUse', { definition: def }));
    await enteredP;
    assert.equal(r.status, readOnly ? 'failed' : 'uncertain');
    assert.equal(r.reason, 'producer_timeout');
    assert.equal(r.output, null);
    assert.equal(exec.pending.size, 1, 'uncooperative callback remains owned until terminal');
    await canceledP; // the scoped abort reached the callback even though it could not cancel it
    release.resolve(); // let the late value land; it must be discarded
    await drain(exec);
    await exec.close();
    assert.equal(exec.pending.size, 0);
    assert.equal(r.output, null); // late output never replaced the settled result
  });
}

// --- Late policy answers cannot dispatch a callback after the invocation ended ---

for (const reason of ['timeout', 'caller_cancel']) {
  test(`an uncooperative late authorizer allow never dispatches a callback (${reason})`, async () => {
    const entered = {}, release = {};
    const enteredP = new Promise((r) => { entered.resolve = r; });
    const releaseP = new Promise((r) => { release.resolve = r; });
    const calls = [];
    const authorize = async (_req, _signal) => { entered.resolve(); await releaseP; return 'allow'; };
    const callback = async () => { calls.push('side effect'); return output(); };
    const def = definition({ readOnly: false, timeoutMs: reason === 'timeout' ? 10 : 5000 }, 40);
    const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback }], authorize, cleanupTimeoutMs: 40 });
    const ctrl = new AbortController();
    const pending = exec.invoke(request('PreToolUse', { definition: def, signal: ctrl.signal }));
    await enteredP;
    if (reason === 'caller_cancel') {
      ctrl.abort(new Error('caller-cancel'));
      await assert.rejects(pending, /caller-cancel/);
    } else {
      const r = await pending;
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, 'producer_timeout');
    }
    release.resolve(); // the late allow lands after the invocation ended
    await drain(exec);
    assert.deepEqual(calls, [], 'late allow dispatched a callback after the invocation ended');
    await exec.close();
  });
}

// --- Event-loop-blocking policy/callback cannot beat the declared deadline ---

for (const stage of ['policy', 'callback']) {
  test(`event-loop-blocking ${stage} cannot beat the declared deadline`, async () => {
    const calls = [];
    const authorize = async () => { if (stage === 'policy') blockFor(50); return 'allow'; };
    const callback = async () => { calls.push('callback'); blockFor(50); return output({ additionalContext: ['late value must not be accepted'] }); };
    const def = definition({ readOnly: false, timeoutMs: 10 });
    const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback }], authorize, cleanupTimeoutMs: CLEANUP });
    const r = await exec.invoke(request('PreToolUse', { definition: def }));
    assert.equal(r.reason, 'producer_timeout');
    assert.equal(r.output, null);
    assert.equal(r.status, stage === 'policy' ? 'failed' : 'uncertain');
    assert.deepEqual(calls, stage === 'policy' ? [] : ['callback']);
    await exec.close();
  });
}

// --- Caller abort and close ---

test('caller abort propagates and a closed executor cannot invoke a callback', async () => {
  const entered = {}, release = {};
  const enteredP = new Promise((r) => { entered.resolve = r; });
  const releaseP = new Promise((r) => { release.resolve = r; });
  let calls = 0;
  const callback = async (_req) => { calls += 1; entered.resolve(); await releaseP; return output(); };
  const def = definition({ timeoutMs: 5000 }, 40);
  const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback }], authorize: async () => 'allow', cleanupTimeoutMs: 40 });
  const ctrl = new AbortController();
  const pending = exec.invoke(request('PreToolUse', { definition: def, signal: ctrl.signal }));
  await enteredP;
  ctrl.abort(new Error('caller-cancel'));
  await assert.rejects(pending, /caller-cancel/);
  release.resolve();
  await drain(exec);
  await exec.close();
  const r2 = await exec.invoke(request('PreToolUse', { definition: def })); // closed -> binding loss
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, 'binding_unavailable');
  assert.equal(calls, 1); // only the first invocation entered the callback
});

test('close during authorization is binding loss, not an optional hook failure', async () => {
  const entered = {}, release = {};
  const enteredP = new Promise((r) => { entered.resolve = r; });
  const releaseP = new Promise((r) => { release.resolve = r; });
  const calls = [];
  const authorize = async (_req, _signal) => { entered.resolve(); await releaseP; return 'allow'; };
  const callback = async () => { calls.push('callback'); return output(); };
  const def = definition({ failureMode: 'warn' }, 40);
  const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback }], authorize, cleanupTimeoutMs: 40 });
  const pending = exec.invoke(request('PreToolUse', { definition: def }));
  await enteredP;
  await exec.close();
  const r = await pending;
  assert.equal(r.status, 'failed'); // warn mode, but close is binding loss, not an optional failure
  assert.equal(r.reason, 'binding_unavailable');
  assert.deepEqual(calls, []);
  release.resolve();
  await drain(exec);
});

// --- Output validation: proposed permissions and invalid outputs are rejected ---

test('callback outputs cannot propose permissions, repair on non-Stop, or arguments off PreToolUse-continue', async () => {
  const cases = [
    { name: 'extra field (proposed permission)', out: { action: 'continue', additionalContext: [], updatedArguments: null, approved: true }, expected: 'producer_invalid' },
    { name: 'repair on PreToolUse', out: { action: 'repair', additionalContext: ['ctx'], updatedArguments: null }, event: 'PreToolUse', expected: 'producer_invalid' },
    { name: 'updatedArguments on PostToolUse', out: { action: 'continue', additionalContext: [], updatedArguments: { path: 'x' } }, event: 'PostToolUse', expected: 'producer_invalid' },
    { name: 'updatedArguments on deny (PreToolUse)', out: { action: 'deny', additionalContext: [], updatedArguments: { path: 'x' } }, event: 'PreToolUse', expected: 'producer_invalid' },
  ];
  for (const { name, out, event = 'PreToolUse', expected } of cases) {
    const def = definition({ events: ['PreToolUse', 'PostToolUse', 'Stop'] });
    const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback: async () => out }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP });
    const r = await exec.invoke(request(event, { definition: def }));
    assert.equal(r.reason, expected, name);
    assert.equal(r.output, null, name);
    await exec.close();
  }
});

test('oversized output is rejected and stays uncertain only for mutating hooks', async () => {
  for (const readOnly of [true, false]) {
    const def = definition({ readOnly, maxOutputBytes: 8 });
    const exec = createNativeHookExecutor({ scope, bindings: [{ definition: def, callback: async () => ({ action: 'continue', additionalContext: ['汉汉汉汉'], updatedArguments: null }) }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP });
    const r = await exec.invoke(request('PreToolUse', { definition: def }));
    assert.equal(r.reason, 'output_budget_exceeded');
    assert.equal(r.status, readOnly ? 'failed' : 'uncertain');
    assert.equal(r.output, null);
    await exec.close();
  }
});

// --- Receipt binding: executor results are sealed and pass full revalidation ---

test('executor results pass full receipt revalidation for ok and every classified failure', async () => {
  const okExec = createNativeHookExecutor({ scope, bindings: [{ definition: definition(), callback: async () => output({ additionalContext: ['ctx'] }) }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP });
  const okReq = request('PreToolUse', { definition: definition() });
  const okRes = await okExec.invoke(okReq);
  assert.equal(validateHookResult(okReq, okRes).status, 'ok');
  await okExec.close();
  const deniedExec = createNativeHookExecutor({ scope, bindings: [{ definition: definition(), callback: async () => output() }], authorize: async () => 'deny', cleanupTimeoutMs: CLEANUP });
  const deniedReq = request('PreToolUse', { definition: definition() });
  const deniedRes = await deniedExec.invoke(deniedReq);
  assert.equal(validateHookResult(deniedReq, deniedRes).status, 'failed');
  assert.equal(deniedRes.reason, 'policy_denied');
  await deniedExec.close();
});

test('every request the executor accepts is itself a fully valid HookInvocation', async () => {
  const exec = createNativeHookExecutor({ scope, bindings: [{ definition: definition(), callback: async () => output() }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP });
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const req = request(event, { definition: definition() });
    // does not throw — the executor revalidates this internally
    const r = await exec.invoke(req);
    assert.equal(r.status, 'ok');
    const { signal, ...rest } = req;
    assert.doesNotThrow(() => validateHookInvocation(rest, sha));
  }
  await exec.close();
});

test('NativeError codes are exported for the documented failure classifications', () => {
  assert.ok(NativeError);
  const e = new NativeError('hook_scope_mismatch');
  assert.equal(e.code, 'hook_scope_mismatch');
});

test('an already canceled invocation never reaches availability, authorization, or callback', async () => {
  const calls = [];
  const controller = new AbortController(); controller.abort(new Error('already-canceled'));
  const exec = createNativeHookExecutor({ scope, cleanupTimeoutMs: CLEANUP,
    bindings: [{ definition: definition(), available: async () => { calls.push('available'); return true; },
      callback: async () => { calls.push('callback'); return output(); } }],
    authorize: async () => { calls.push('authorize'); return 'allow'; },
  });
  await assert.rejects(exec.invoke(request('PreToolUse', { signal: controller.signal })), /already-canceled/);
  assert.deepEqual(calls, []);
  assert.equal(exec.pending.size, 0);
  await exec.close();
});

test('a backward wall-clock correction cannot extend a callback deadline', async () => {
  const originalNow = Date.now;
  const def = definition({ readOnly: false, timeoutMs: 10 });
  const exec = createNativeHookExecutor({ scope, cleanupTimeoutMs: CLEANUP,
    bindings: [{ definition: def, callback: async () => {
      Date.now = () => originalNow() - 60_000;
      const until = performance.now() + 30;
      while (performance.now() < until) { /* synchronous work delays timer callbacks */ }
      return output({ additionalContext: ['expired output'] });
    } }], authorize: async () => 'allow',
  });
  try {
    const result = await exec.invoke(request('PreToolUse', { definition: def }));
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'producer_timeout');
    assert.equal(result.output, null);
  } finally { Date.now = originalNow; await exec.close(); }
});
