import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeKernel, MemoryRunStore, configure, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';
import { createNativeChildResultTools } from '../src/native/child-readers.mjs';

const childScope = { ...scope, agentId: 'child-agent' };
const definitions = nativeChildToolDefinitions(['worker', 'other']);
const write = tool({ name: 'write_evidence', readOnly: false, concurrentSafe: false });
const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const start = (extra = {}) => ({ name: 'native_start_child', arguments: { role: 'worker', task: 'Write initial evidence', background: false, ...extra } });

function setup(t, backend, { hold = false, unknown = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-continuation-')), database = join(dir, 'runs.sqlite');
  let store = backend === 'sqlite' ? new SqliteRunStore(database) : new MemoryRunStore();
  let owner, resolveCount = 0, release;
  const gate = new Promise(resolve => { release = resolve; }), requests = [], failures = [], models = new Map();
  const childPorts = { model: { generate: async request => {
    requests.push(structuredClone({ runId: request.runId, sessionId: request.sessionId, messages: request.messages }));
    const count = (models.get(request.runId) ?? 0) + 1; models.set(request.runId, count);
    if (hold && resolveCount === 1 && count === 1) await gate;
    return count === 1 ? response('', [{ callId: 'write', name: write.name, arguments: {} }]) : response(`Evidence ${request.runId}`);
  } }, tools: { execute: async request => {
    appendFileSync(join(dir, 'writes.txt'), request.runId + '\n');
    if (typeof unknown === 'function' ? unknown(resolveCount) : unknown) throw Error('lost reply after actual write');
    return { status: 'ok', content: 'Actual evidence written' };
  } } };
  const install = () => {
    owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async request => {
      resolveCount++;
      return { scope: childScope, configuration: configure({ profile: fixture().config.profile,
        contract: { objective: request.task }, instructions: `Fresh grants ${resolveCount}`, tools: [write],
        hostBindingDigest: `fresh-${resolveCount}`, limits: { maxModelCalls: 3, maxToolCalls: 2 } }), ports: childPorts };
    }, restoreChild: async () => childPorts });
  };
  install();
  t.after(async () => { release(); await owner.releaseRun({ scope, runId: 'parent' }); store.close?.(); rmSync(dir, { force: true, recursive: true }); });
  const run = async (runId, steps, { sessionId = 'parent-session' } = {}) => {
    const readers = createNativeChildResultTools({ scope, childScopes: [childScope], store, roles: ['worker', 'other'] });
    const config = fixture({ tools: [...definitions, ...readers.definitions], childLifecyclePolicy: 'owned-background/v2',
      limits: { maxModelCalls: 40, maxToolCalls: 40, effectTimeoutMs: 130000 } }).config;
    let index = 0;
    const kernel = new NativeKernel({ store, digest, owner: runId, ports: { children: owner,
      tools: { execute: async request => {
        try {
          const result = ['native_start_child', 'native_delegate'].includes(request.call.name) ? await owner.start(request)
            : request.call.name === 'native_child_control' ? await owner.control(request) : await readers.execute(request);
          if (result.content?.error_code) { failures.push(result.content.error_code); if (hold) release(); }
          return result;
        }
        catch (error) { failures.push(error.code); if (hold) release(); throw error; }
      } }, model: { generate: async request => {
        const step = steps[index++];
        const value = typeof step === 'function' ? await step(request) : step;
        return value ? response('', [{ callId: `call-${index}`, ...value }]) : response('Parent evidence delivered');
      } } } });
    kernel.start({ scope, runId, sessionId, turnId: runId, buildId: 'build', parentRunId: null, taskChainId: 'parent-chain' }, config);
    return kernel.runUntilIdle(scope, runId);
  };
  return { get store() { return store; }, run, release, requests, failures, resolves: () => resolveCount,
    writes: () => readFileSync(join(dir, 'writes.txt'), 'utf8').trim().split('\n'),
    reopen: async () => { assert.equal(backend, 'sqlite'); await owner.releaseRun({ scope, runId: 'parent' }); store.close(); store = new SqliteRunStore(database); install(); } };
}

test('a process death after continuation seals but before the parent receipt recovers the same new Run', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-continuation-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-child-continuation-crash-worker.mjs', import.meta.url)), dir],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(worker.status, 0, worker.stderr);
  const store = new SqliteRunStore(join(dir, 'runs.sqlite')); t.after(() => store.close());
  const before = JSON.parse(readFileSync(join(dir, 'sealed-source.json'), 'utf8'));
  assert.equal(store.list(childScope).length, 2); assert.equal(store.load(scope, 'later').snapshot.childRunIds.length, 0);
  const lease = store.load(scope, 'later').lease;
  if (lease?.expiresAt > Date.now()) await new Promise(resolve => setTimeout(resolve, lease.expiresAt - Date.now() + 10));
  let starts = 0;
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async () => { starts++; throw Error('must not relaunch'); } });
  const kernel = new NativeKernel({ store, owner: 'replacement', digest, ports: { children: owner,
    tools: { execute: async () => { throw Error('must reconcile original receipt'); } },
    model: { generate: async request => {
      assert.match(request.messages.filter(message => message.role === 'tool').at(-1).content, /Sealed child evidence/);
      return response('Recovered continuation');
    } } } });
  const result = await kernel.runUntilIdle(scope, 'later');
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Recovered continuation'); assert.equal(starts, 0);
  assert.equal(result.childBudgetReservations.length, 1); assert.ok(result.childBudgetReservations[0].settledUsageDigest);
  assert.equal(result.descendantUsage.modelCalls, 2); assert.equal(result.descendantUsage.toolCalls, 1);
  assert.equal(store.events(scope, 'later').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
  assert.deepEqual(store.load(scope, 'parent'), before.parent); assert.deepEqual(store.load(childScope, before.child.snapshot.runId), before.child);
  const child = store.load(childScope, result.childRunIds[0]);
  assert.equal(child.snapshot.sessionId, before.child.snapshot.sessionId); assert.equal(child.snapshot.parentRunId, before.child.snapshot.runId);
  assert.equal(child.configuration.childOwnerBinding.parent.runId, 'later');
  assert.deepEqual(readFileSync(join(dir, 'writes.txt'), 'utf8').trim().split('\n'), [before.child.snapshot.runId, child.snapshot.runId]);
});

for (const backend of ['memory', 'sqlite']) {
  for (const continuationTool of ['native_start_child', 'native_delegate'])
  test(`${backend}/${continuationTool}: continuation reuses Session, carries history and reserves fresh usage without changing source`, async t => {
    const f = setup(t, backend); let original, source;
    const result = await f.run('parent', [start(), () => {
      source = f.store.list(childScope)[0]; original = f.store.load(childScope, source.runId);
      assert.ok(f.store.load(scope, 'parent').snapshot.childBudgetReservations[0].settledUsageDigest);
      return { ...start({ continuation_of: source.runId, task: 'Continue with new evidence' }), name: continuationTool };
    }, () => ({ name: 'native_child_tasks', arguments: {} })]);
    assert.equal(result.phase, 'completed'); assert.deepEqual(f.failures, []); assert.equal(f.resolves(), 2);
    assert.equal(result.childRunIds.length, 2); assert.equal(result.childBudgetReservations.length, 2);
    assert.ok(result.childBudgetReservations.every(item => item.settledUsageDigest));
    assert.equal(result.descendantUsage.modelCalls, 4); assert.equal(result.descendantUsage.toolCalls, 2);
    assert.deepEqual(f.store.load(childScope, source.runId), original);
    const next = f.store.load(childScope, result.childRunIds[1]);
    assert.equal(next.snapshot.sessionId, source.sessionId); assert.equal(next.snapshot.parentRunId, source.runId);
    assert.equal(next.configuration.childOwnerBinding.parent.runId, 'parent');
    assert.equal(next.configuration.childOwnerBinding.continuationParentRunId, 'parent');
    assert.equal(next.configuration.childOwnerBinding.continuationOf, source.runId);
    assert.equal(next.configuration.instructions, 'Fresh grants 2'); assert.equal(next.configuration.hostBindingDigest, 'fresh-2');
    assert.equal(f.store.sessionHead(childScope, source.sessionId).runId, next.snapshot.runId);
    assert.ok(f.requests.filter(item => item.runId === next.snapshot.runId)[0].messages.some(message => message.content.includes(`Evidence ${source.runId}`)));
    assert.deepEqual(f.writes(), result.childRunIds);
    assert.match(result.messages.filter(message => message.role === 'tool').at(-1).content, /Continue with new evidence/);
  });

  test(`${backend}: superseded head and changed role create no extra child`, async t => {
    const f = setup(t, backend); let source;
    const result = await f.run('parent', [start(), () => {
      source = f.store.list(childScope)[0]; return start({ continuation_of: source.runId, role: 'other' });
    }, () => start({ continuation_of: source.runId, task: 'First follow-up' }),
    () => start({ continuation_of: source.runId, task: 'Stale follow-up' })]);
    assert.equal(result.phase, 'completed'); assert.deepEqual(f.failures, ['child_followup_role_mismatch', 'child_followup_source_not_current']);
    assert.equal(f.store.list(childScope).length, 2); assert.equal(f.writes().length, 2);
    assert.equal(result.descendantUsage.modelCalls, 4); assert.equal(result.descendantUsage.toolCalls, 2);
  });

  test(`${backend}: unfinished source must be collected before continuation`, async t => {
    const f = setup(t, backend, { hold: true });
    const result = await f.run('parent', [start({ background: true }), () => start({ continuation_of: f.store.list(childScope)[0].runId })]);
    assert.equal(result.phase, 'completed'); assert.deepEqual(f.failures, ['child_followup_requires_result_collection']);
    assert.equal(f.resolves(), 1); assert.equal(f.store.list(childScope).length, 1); assert.equal(f.writes().length, 1);
  });

  test(`${backend}: a different parent Session cannot continue the source`, async t => {
    const f = setup(t, backend);
    const first = await f.run('parent', [start()]), source = first.childRunIds[0];
    const result = await f.run('foreign', [start({ continuation_of: source })], { sessionId: 'foreign-session' });
    assert.equal(result.phase, 'completed'); assert.deepEqual(f.failures, ['child_followup_not_available']);
    assert.equal(f.resolves(), 1); assert.equal(result.childRunIds.length, 0); assert.equal(f.writes().length, 1);
  });

  test(`${backend}: continuation cannot replay an unknown source write`, async t => {
    const f = setup(t, backend, { unknown: true });
    const first = await f.run('parent', [start()]), source = first.childRunIds[0];
    assert.equal(first.phase, 'interrupted');
    const result = await f.run('later', [start({ continuation_of: source })]);
    assert.equal(result.phase, 'completed'); assert.deepEqual(f.failures, ['child_followup_requires_result_collection']);
    assert.equal(f.resolves(), 1); assert.equal(f.writes().length, 1); assert.equal(result.childRunIds.length, 0);
  });

  test(`${backend}: an unknown write in the new continuation keeps its own liability and cannot be continued again`, async t => {
    const f = setup(t, backend, { unknown: count => count === 2 });
    const first = await f.run('parent', [start()]), original = f.store.load(childScope, first.childRunIds[0]);
    const next = await f.run('later', [start({ continuation_of: original.snapshot.runId, task: 'New uncertain write' })]);
    assert.equal(next.phase, 'interrupted'); assert.equal(next.childBudgetReservations.length, 1);
    assert.equal(next.childBudgetReservations[0].settledUsageDigest, null);
    const failed = f.store.load(childScope, next.childRunIds[0]);
    assert.equal(failed.snapshot.phase, 'interrupted'); assert.equal(failed.snapshot.parentRunId, original.snapshot.runId);
    const third = await f.run('third', [start({ continuation_of: failed.snapshot.runId })]);
    assert.equal(third.phase, 'completed'); assert.deepEqual(f.failures, ['child_followup_requires_result_collection']);
    assert.equal(f.resolves(), 2); assert.deepEqual(f.writes(), [original.snapshot.runId, failed.snapshot.runId]);
    assert.deepEqual(f.store.load(childScope, original.snapshot.runId), original);
    assert.deepEqual(f.store.load(childScope, failed.snapshot.runId), failed);
  });

  test(`${backend}: later parent turn continues accounted source with a fresh owner and charges only its new work`, async t => {
    const f = setup(t, backend);
    const first = await f.run('parent', [start()]), source = first.childRunIds[0];
    const sealed = f.store.load(scope, 'parent'), sourceRecord = f.store.load(childScope, source);
    if (backend === 'sqlite') await f.reopen();
    const next = await f.run('later', [start({ continuation_of: source, task: 'New parent turn follow-up' })]);
    assert.equal(next.phase, 'completed'); assert.deepEqual(f.failures, []); assert.equal(f.resolves(), 2);
    assert.equal(next.childBudgetReservations.length, 1); assert.equal(next.descendantUsage.modelCalls, 2); assert.equal(next.descendantUsage.toolCalls, 1);
    assert.deepEqual(f.store.load(scope, 'parent'), sealed); assert.deepEqual(f.store.load(childScope, source), sourceRecord);
    const child = f.store.load(childScope, next.childRunIds[0]);
    assert.equal(child.snapshot.sessionId, sourceRecord.snapshot.sessionId); assert.equal(child.snapshot.parentRunId, source);
    assert.equal(child.configuration.childOwnerBinding.parent.runId, 'later'); assert.equal(child.configuration.childOwnerBinding.continuationParentRunId, 'parent');
    assert.deepEqual(f.writes(), [source, child.snapshot.runId]);
  });
}
