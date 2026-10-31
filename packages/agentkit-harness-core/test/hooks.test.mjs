import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryRunStore, NativeKernel, canonical, configure, currentHookState, emptyUsage, hookBytes, hookResult,
  plan, reduceCommand, validateContextMessages, validateHookDefinition, validateHookInvocation, validateHookOutput, validateHookResult } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { acceptance, digest, fixture, scope, tool, verificationReport } from './fixtures.mjs';

const definition = (overrides = {}) => ({ hookId: 'fixture', sourceRef: 'host://fixture', bindingDigest: `sha256:${'a'.repeat(64)}`,
  executionPolicyDigest: `sha256:${'b'.repeat(64)}`, readOnly: true, events: ['PreToolUse'], timeoutMs: 100,
  maxInputBytes: 64000, maxOutputBytes: 64000, failureMode: 'block', ...overrides });
const output = (overrides = {}) => ({ action: 'continue', additionalContext: [], updatedArguments: null, ...overrides });
const finish = () => ({ kind: 'final_candidate', text: 'Finished', toolCalls: [], usage: emptyUsage() });
const call = (id = 'call') => ({ callId: id, name: 'read', arguments: { path: 'original' } });
const toolsResult = calls => ({ ...finish(), kind: 'tool_calls', text: '', toolCalls: calls });
function setup(t, overrides = {}, backend = 'memory') {
  const { config, snapshot } = fixture({ tools: [tool({ parameters: { type: 'object', required: ['path'],
    properties: { path: { type: 'string' } }, additionalProperties: false } })], hooks: [definition()], ...overrides });
  const directory = mkdtempSync(join(tmpdir(), 'native-hooks-')), filename = join(directory, 'run.sqlite');
  let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
  store.create(config, snapshot);
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  let requests = 0;
  const ports = { model: { generate: async () => ++requests === 1 ? toolsResult([call()]) : finish() },
    tools: { execute: async () => ({ status: 'ok', content: 'read result' }) },
    hooks: { invoke: async request => hookResult(request, 'ok', output()) } };
  return { config, ports, directory, filename, get store() { return store; },
    reopen() { store.close?.(); store = new SqliteRunStore(filename); },
    worker(options = {}) { return new NativeKernel({ store, ports, digest, owner: 'worker', ...options }); } };
}

test('hook contracts reject malformed definitions and contextual authority proposals', () => {
  for (const invalid of [{ readOnly: 'true' }, { events: [] }, { events: ['Stop'], toolNames: ['read'] },
    { bindingDigest: 'unbound' }, { maxInputBytes: 0 }, { failureMode: 'ignore' }, { arbitraryAuthority: true }]) {
    assert.throws(() => validateHookDefinition(definition(invalid)));
  }
  assert.throws(() => configure({ ...fixture().config, stopHookContinuationLimit: -1 }));
  assert.throws(() => validateHookOutput(output({ action: 'repair' }), 'Stop'));
  assert.throws(() => validateHookOutput(output({ updatedArguments: {} }), 'PostToolUse'));
  assert.throws(() => validateHookOutput(output({ action: 'deny', updatedArguments: {} }), 'PreToolUse'));
  assert.throws(() => validateHookOutput({ ...output(), approved: true }, 'PreToolUse'));
});

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: hooks preserve original protocol arguments, revalidate effective arguments, and serialize feedback after tool results`, async t => {
    const run = setup(t, { hooks: [definition({ events: ['PreToolUse', 'PostToolUse'] })] }, backend), seen = [];
    run.ports.hooks.invoke = async request => {
      const { signal, ...sealed } = request;
      validateHookInvocation(sealed, digest);
      seen.push(request.event);
      if (request.event === 'PostToolUse') assert.equal(request.input.toolResult.content, 'actual rewritten');
      return hookResult(request, 'ok', output({ additionalContext: ['Untrusted hook information'],
        ...(request.event === 'PreToolUse' ? { updatedArguments: { path: 'rewritten' } } : {}) }));
    };
    run.ports.tools.execute = async request => {
      assert.equal(request.call.arguments.path, 'rewritten');
      return { status: 'ok', content: 'actual rewritten' };
    };
    let models = 0;
    run.ports.model.generate = async request => {
      if (++models === 1) return toolsResult([call()]);
      validateContextMessages(request.messages);
      const original = request.messages.find(message => message.toolCalls)?.toolCalls[0];
      assert.equal(original.arguments.path, 'original');
      const resultIndex = request.messages.findIndex(message => message.role === 'tool');
      const hookIndexes = request.messages.flatMap((message, index) => message.kind === 'hook_context' ? [index] : []);
      assert.equal(hookIndexes.length, 2); assert.ok(hookIndexes.every(index => index > resultIndex));
      return finish();
    };
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.deepEqual(seen, ['PreToolUse', 'PostToolUse']);
    assert.equal(result.messages.filter(message => message.kind === 'hook_context').length, 2);
    assert.deepEqual(currentHookState(result).feedback, []);
  });

  test(`${backend}: changed arguments require approval against the effective call and hooks are not repeated on approval`, async t => {
    const run = setup(t, {}, backend); let hooks = 0, actualWrites = 0;
    run.ports.hooks.invoke = async request => { hooks++; return hookResult(request, 'ok', output({ updatedArguments: { path: 'sensitive' } })); };
    run.ports.tools.execute = async request => {
      assert.equal(request.call.arguments.path, 'sensitive');
      if (!request.interaction) return { status: 'approval_required', interactionId: 'host-owned', content: null };
      assert.equal(request.interaction.decision, 'allow'); actualWrites++;
      return { status: 'ok', content: 'approved effect' };
    };
    let result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'awaiting_interaction'); assert.equal(actualWrites, 0);
    if (backend === 'sqlite') run.reopen();
    run.worker().submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction',
      payload: { interactionId: result.pendingInteraction.interactionId, decision: 'allow' } });
    result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(actualWrites, 1); assert.equal(hooks, 1);
  });

  test(`${backend}: hook parameter proposals cannot bypass schema validation or invoke another pre hook`, async t => {
    const run = setup(t, { hooks: [definition(), definition({ hookId: 'second' })] }, backend); let hooks = 0, calls = 0;
    run.ports.hooks.invoke = async request => { hooks++; return hookResult(request, 'ok', output({ updatedArguments: { path: 12 } })); };
    run.ports.tools.execute = async () => { calls++; return { status: 'ok', content: 'unexpected' }; };
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(calls, 0); assert.equal(hooks, 1);
    const rejection = JSON.parse(result.messages.find(message => message.role === 'tool').content);
    assert.equal(rejection.code, 'invalid_arguments'); assert.equal(rejection.executed, false);
    assert.ok(rejection.errors.some(error => error.keyword === 'type' && error.path === '/path'));
  });
}

test('pre hook denial closes only the denied call; post hooks run for actual results in parallel group order', async t => {
  const run = setup(t, { hooks: [definition({ events: ['PreToolUse', 'PostToolUse'] })] });
  const events = [], executed = [];
  let models = 0;
  run.ports.model.generate = async () => ++models === 1 ? toolsResult([call('denied'), call('allowed')]) : finish();
  run.ports.hooks.invoke = async request => {
    events.push(`${request.event}:${request.input.call.callId}`);
    return hookResult(request, 'ok', output({ action: request.input.call.callId === 'denied' ? 'deny' : 'continue' }));
  };
  run.ports.tools.execute = async request => { executed.push(request.call.callId); return { status: 'ok', content: 'actual' }; };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.deepEqual(executed, ['allowed']);
  assert.deepEqual(events, ['PreToolUse:denied', 'PreToolUse:allowed', 'PostToolUse:allowed']);
  validateContextMessages(result.messages);
});

test('post hook denial blocks further tools without retracting an actual completed result', async t => {
  const run = setup(t, { tools: [tool({ readOnly: false, concurrentSafe: false })], hooks: [definition({ events: ['PostToolUse'] })] });
  let writes = 0, models = 0;
  run.ports.model.generate = async () => ++models === 1 ? toolsResult([call('one'), call('two')]) : finish();
  run.ports.tools.execute = async () => { writes++; return { status: 'ok', content: 'already happened' }; };
  run.ports.hooks.invoke = async request => hookResult(request, 'ok', output({ action: 'deny' }));
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'post_tool_hook_denied'); assert.equal(writes, 1);
  assert.ok(result.messages.some(message => message.role === 'tool' && message.callId === 'one' && message.content.includes('already happened')));
  assert.ok(result.messages.some(message => message.role === 'tool' && message.callId === 'two' && message.content.includes('not_dispatched')));
  validateContextMessages(result.messages);
});

for (const [status, reason, mode, expected] of [
  ['failed', 'producer_failed', 'warn', null], ['failed', 'producer_timeout', 'block', 'hook_producer_timeout'],
  ['failed', 'policy_denied', 'warn', 'hook_policy_denied'], ['failed', 'binding_unavailable', 'warn', 'effect_outcome_unknown'],
  ['uncertain', 'producer_invalid', 'warn', 'effect_outcome_unknown'],
]) test(`hook failure ${status}/${reason}/${mode} respects policy and uncertainty`, async t => {
  const run = setup(t, { hooks: [definition({ failureMode: mode })] }); let tools = 0;
  run.ports.hooks.invoke = async request => hookResult(request, status, null, reason);
  run.ports.tools.execute = async () => { tools++; return { status: 'ok', content: 'actual' }; };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(tools, expected ? 0 : 1);
  if (expected) assert.equal(result.reason, expected);
  else assert.equal(result.phase, 'completed');
});

test('input budget is measured as UTF8 JSON bytes before a hook is dispatched', async t => {
  const run = setup(t, { hooks: [definition({ maxInputBytes: 2 })] }); let hooks = 0;
  run.ports.hooks.invoke = async () => { hooks++; throw Error('Unexpected callback'); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(hooks, 0); assert.equal(result.reason, 'hook_input_budget_exceeded');
  assert.equal(hookBytes('中'), 5);
});

test('forged or oversized hook receipts cannot grant execution authority', async t => {
  for (const forgery of ['identity', 'inputDigest', 'output']) {
    const run = setup(t, { hooks: [definition({ maxOutputBytes: 100 })] }); let tools = 0;
    run.ports.hooks.invoke = async request => {
      const result = hookResult(request, 'ok', output());
      if (forgery === 'identity') result.identity.runId = 'foreign';
      if (forgery === 'inputDigest') result.inputDigest = 'foreign';
      if (forgery === 'output') result.output.additionalContext = ['中'.repeat(100)];
      assert.throws(() => validateHookResult(request, result)); return result;
    };
    run.ports.tools.execute = async () => { tools++; return { status: 'ok', content: 'unexpected' }; };
    const result = await run.worker().runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(tools, 0);
  }
});

test('Stop feedback stays untrusted and does not replace actual acceptance verification', async t => {
  const run = setup(t, { hooks: [definition({ events: ['Stop'] })], stopHookContinuationLimit: 2,
    contract: { objective: 'Complete', acceptance: [acceptance()] } });
  run.ports.model.generate = async () => finish();
  let hooks = 0, verifies = 0;
  run.ports.hooks.invoke = async request => { hooks++; return hookResult(request, 'ok', output({ additionalContext: ['I declare success'] })); };
  run.ports.verification = { verify: async request => {
    verifies++; assert.equal(hooks, 1); assert.ok(request.snapshot.messages.at(-1).content.includes('untrusted'));
    return verificationReport(request, { checks: [], status: 'unverified' });
  } };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.outcome, 'unverified'); assert.equal(verifies, 1);
});

test('Stop repair continues the model loop with a persisted independent continuation cap', async t => {
  const run = setup(t, { hooks: [definition({ events: ['Stop'] })], stopHookContinuationLimit: 1 }, 'sqlite');
  let models = 0, hooks = 0;
  run.ports.model.generate = async request => {
    if (++models === 2) assert.ok(request.messages.some(message => message.kind === 'hook_context' && message.content.includes('Fix missing work')));
    return finish();
  };
  run.ports.hooks.invoke = async request => { hooks++; return hookResult(request, 'ok', output({ action: 'repair', additionalContext: ['Fix missing work'] })); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'stop_hook_continuation_exhausted'); assert.equal(result.stopHookContinuations, 1);
  assert.equal(models, 2); assert.equal(hooks, 2);
});

test('mutating Stop hooks invalidate the workspace observation before verifying the candidate', async t => {
  const run = setup(t, { hooks: [definition({ events: ['Stop'], readOnly: false })], stopHookContinuationLimit: 1,
    limits: { maxRepairs: 0 } });
  let revision = 'before', observes = 0, verifies = 0;
  run.ports.workspace = { observe: async () => { observes++; return { status: 'ok', revision, changedPaths: [], reason: null }; } };
  run.ports.model.generate = async () => finish();
  run.ports.hooks.invoke = async request => { revision = 'after'; return hookResult(request, 'ok', output()); };
  run.ports.verification = { verify: async request => { verifies++; return verificationReport(request); } };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'candidate_workspace_changed'); assert.equal(observes, 2); assert.equal(verifies, 0);
});

for (const crash of ['prepared', 'executed', 'committed']) test(`actual process restart after ${crash} hook preserves effect ownership`, async t => {
  const run = setup(t, { tools: [tool({ readOnly: false, concurrentSafe: false })], hooks: [definition({ readOnly: false })] }, 'sqlite');
  const sideEffect = join(run.directory, 'hook-effect.txt'); run.store.close();
  const script = `
    import { writeFileSync } from 'node:fs';
    import { NativeKernel, emptyUsage, hookResult } from './packages/agentkit-harness-core/dist/index.mjs';
    import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
    import { digest, scope } from './packages/agentkit-harness-core/test/fixtures.mjs';
    const store = new SqliteRunStore(${JSON.stringify(run.filename)});
    const worker = new NativeKernel({ store, digest, owner: 'exiting-worker', ports: {
      model: { generate: async () => ({kind:'tool_calls',text:'',toolCalls:[${JSON.stringify(call())}],usage:emptyUsage()}) },
      tools: {execute:async()=>{throw Error('must not reach tool')}},
      hooks: {invoke:async request=>{writeFileSync(${JSON.stringify(sideEffect)},'once');
        if (${JSON.stringify(crash)} === 'executed') process.exit(0);
        return hookResult(request,'ok',${JSON.stringify(output({ updatedArguments: { path: 'durable' } }))}); } }
    }, onCheckpoint: async snapshot => {
      const record=store.load(scope,'run');
      const pending=record.intents.find(intent=>intent.operationKey===snapshot.pendingIntent);
      if (${JSON.stringify(crash)} === 'prepared' && pending?.kind==='hook') process.exit(0);
      if (${JSON.stringify(crash)} === 'committed' && record.receipts.some(receipt=>receipt.result.schemaVersion==='agentkit.native-hook-result/v1')) process.exit(0);
    }});
    await worker.runUntilIdle(scope,'run'); throw Error('Expected abrupt process exit');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-'], { input: script, cwd: new URL('../../../', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  run.reopen();
  // An executed hook owns a live lease until expiry; use a deterministic future lease clock for takeover.
  let hooks = 0, tools = 0;
  run.ports.model.generate = async () => finish();
  run.ports.hooks.invoke = async request => { hooks++; return hookResult(request, 'ok', output({ updatedArguments: { path: 'durable' } })); };
  run.ports.tools.execute = async request => { tools++; assert.equal(request.call.arguments.path, 'durable'); return { status: 'ok', content: 'once' }; };
  const result = await run.worker({ owner: 'takeover', now: () => Date.now() + 120000 }).runUntilIdle(scope, 'run');
  if (crash === 'executed') {
    assert.equal(readFileSync(sideEffect, 'utf8'), 'once'); assert.equal(result.phase, 'interrupted');
    assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(hooks, 0); assert.equal(tools, 0);
  } else {
    assert.equal(result.phase, 'completed'); assert.equal(hooks, crash === 'prepared' ? 1 : 0); assert.equal(tools, 1);
  }
});

test('guidance before a prepared PostTool hook re-admits the hook and preserves its result', async t => {
  const run = setup(t, { hooks: [definition({ events: ['PostToolUse'] })] }); let sent = false, hooks = 0;
  run.ports.hooks.invoke = async request => { hooks++; assert.equal(request.input.toolResult.content, 'read result'); return hookResult(request, 'ok', output()); };
  const worker = run.worker({ onCheckpoint: async snapshot => {
    const pending = run.store.load(scope, 'run').intents.find(item => item.operationKey === snapshot.pendingIntent);
    if (!sent && pending?.kind === 'hook') { sent = true; run.worker().submit(scope, 'run', { commandId: 'guide', kind: 'guide', payload: { text: 'More detail please' } }); }
  } });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(hooks, 1);
  assert.ok(run.store.load(scope, 'run').receipts.some(receipt => receipt.status === 'not_dispatched'));
});

test('unacknowledged hook feedback survives provider retries and cannot be omitted by a prepared context view', async t => {
  const run = setup(t, { hooks: [definition({ events: ['PostToolUse'] })],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1', retryInitialDelayMs: 0 } });
  let models = 0;
  run.ports.hooks.invoke = async request => hookResult(request, 'ok', output({ additionalContext: ['Pending input'] }));
  run.ports.model.generate = async request => {
    if (++models === 1) return toolsResult([call()]);
    assert.equal(request.messages.filter(message => message.kind === 'hook_context').length, 1);
    assert.equal(currentHookState(run.store.load(scope, 'run').snapshot).feedback.length, 1);
    if (models === 2) return { ...finish(), kind: 'provider_retryable_error', text: '', usageReported: false };
    return finish();
  };
  let prepares = 0;
  run.ports.context = { prepare: async request => {
    prepares++;
    return { messages: prepares === 3 ? request.snapshot.messages.filter(message => message.kind !== 'hook_context') : request.snapshot.messages,
      context: {} };
  } };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(models, 2); assert.equal(result.reason, 'context_hook_feedback_missing');
  assert.equal(result.outcome, 'blocked'); assert.equal(currentHookState(result).feedback.length, 1);
});

test('Stop repair feedback is pending until a meaningful task response and then releases its retention debt', async t => {
  const run = setup(t, { hooks: [definition({ events: ['Stop'] })], stopHookContinuationLimit: 1 });
  let hooks = 0, models = 0;
  run.ports.model.generate = async request => {
    if (++models === 2) {
      assert.ok(request.messages.some(message => message.kind === 'hook_context'));
      assert.equal(currentHookState(run.store.load(scope, 'run').snapshot).feedback.length, 1);
    }
    return finish();
  };
  run.ports.hooks.invoke = async request => hookResult(request, 'ok', output(++hooks === 1
    ? { action: 'repair', additionalContext: ['Complete missing evidence'] } : {}));
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(models, 2);
  assert.equal(currentHookState(result).feedback.length, 0);
  assert.equal(result.messages.filter(message => message.kind === 'hook_context').length, 1);
});
