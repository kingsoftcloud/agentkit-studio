import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NativeKernel, MemoryRunStore, configure, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../src/native/child-tools.mjs';
import { createNativeChildResultTools } from '../src/native/child-readers.mjs';

const childScope = { ...scope, agentId: 'child-agent' };
const finalText = '子😀任务 findings complete';
const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const sha = text => createHash('sha256').update(text).digest('hex');

function setup(t, backend, { pending = false, onQuery, childIdOverride, staleInventory = false, promoted = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-child-readers-'));
  const store = backend === 'sqlite' ? new SqliteRunStore(join(dir, 'runs.sqlite')) : new MemoryRunStore();
  const [start, control] = nativeChildToolDefinitions(['worker']);
  const readers = createNativeChildResultTools({ scope, childScopes: [childScope], store, roles: ['worker'] });
  const write = tool({ name: 'write_proof', readOnly: false, concurrentSafe: false });
  let release, writes = 0, starts = 0, models = 0, rounds = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const childConfig = configure({ profile: fixture().config.profile, contract: { objective: 'Produce findings' },
    hostBindingDigest: 'reader-child-fixture', tools: [write], limits: { maxModelCalls: 3, maxToolCalls: 2 } });
  const childPorts = {
    model: { generate: async request => { models++; return request.messages.some(message => message.role === 'tool')
      ? response(finalText) : response('', [{ callId: 'write', name: write.name, arguments: {} }]); } },
    tools: { execute: async request => { await gate; request.signal.throwIfAborted(); writes++; return { status: 'ok', content: 'Written' }; } },
  };
  const owner = createNativeChildOwner({ scope, childScopes: [childScope], store,
    resolveChild: async () => { starts++; return { scope: childScope, configuration: childConfig, ports: childPorts }; },
    restoreChild: async () => childPorts });
  t.after(async () => { release(); await owner.releaseRun({ scope, runId: 'run' }); store.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const { snapshot, config } = fixture({ tools: [start, control, ...readers.definitions],
    limits: { maxModelCalls: 20, maxToolCalls: 20, effectTimeoutMs: 130000 }, childLifecyclePolicy: 'owned-background/v2',
    ...(promoted ? { childPromotionPolicy: 'owned-child-promotion/v1' } : {}) });
  const observations = [], captured = [];
  const kernel = new NativeKernel({ store, digest, owner: 'parent', ports: { children: owner,
    tools: { execute: async request => {
      if (request.call.name === start.name) return owner.start(request);
      if (request.call.name === control.name) { release(); return owner.control(request); }
      captured.push(request); await onQuery?.(request, { store, readers });
      const value = await readers.execute(request); observations.push({ name: request.call.name, value }); return value;
    } },
    model: { generate: async () => {
      rounds++;
      const id = store.load(scope, 'run').snapshot.childRunIds[0];
      const query = () => response('', [
        { callId: `result-${rounds}`, name: 'native_child_result', arguments: { child_run_id: childIdOverride ?? id, limit_chars: 5 } },
        { callId: `tasks-${rounds}`, name: 'native_child_tasks', arguments: { limit: 1 } },
      ]);
      const wait = () => response('', [{ callId: 'wait', name: control.name,
        arguments: { child_run_id: id, action: 'wait', wait_seconds: 1 } }]);
      if (rounds === 1) return response('', [{ callId: 'start', name: start.name, arguments: { role: 'worker', task: 'Produce findings',
        ...(promoted ? { background: false } : {}) } }]);
      if (rounds === 2) return pending ? query() : wait();
      if (rounds === 3) return pending ? wait() : query();
      if (rounds === 4 && !pending) {
        const inventory = observations.find(item => item.name === 'native_child_tasks').value.content;
        return response('', [
          { callId: 'page', name: 'native_child_result', arguments: { child_run_id: id, offset_chars: 5, limit_chars: 16000 } },
          { callId: 'inventory-end', name: 'native_child_tasks', arguments: { offset: 1,
            inventory_digest: staleInventory ? '0'.repeat(64) : inventory.inventory_digest } },
        ]);
      }
      return response('Parent consumed the original child delivery');
    } },
  } });
  kernel.start(snapshot, config);
  return { kernel, store, readers, observations, captured, counts: () => ({ starts, writes, models }) };
}

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: query tools display the persisted promotion and live controls of the original child`, async t => {
    const f = setup(t, backend, { pending: true, promoted: true });
    const running = f.kernel.runUntilIdle(scope, 'run');
    let task;
    for (let index = 0; index < 500; index++) {
      task = f.kernel.childTasks(scope, 'run').find(item => item.phase === 'executing_tools');
      if (task) break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(task); assert.equal(task.canPromote, true);
    f.kernel.promoteChild(scope, 'run', task.childRunId, 'reader-promote');
    assert.equal((await running).phase, 'completed');
    const row = f.observations.find(item => item.name === 'native_child_tasks').value.content.tasks[0];
    assert.equal(row.child_run_id, task.childRunId); assert.equal(row.delivery, 'background');
    assert.equal(row.can_promote, false); assert.equal(row.can_cancel, true); assert.equal(row.can_send_input, true);
    assert.deepEqual(f.counts(), { starts: 1, writes: 1, models: 2 });
  });
  test(`${backend}: actual parallel child reads page the original delivery and inventory without restarting or accounting twice`, async t => {
    const f = setup(t, backend);
    const result = await f.kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.deepEqual(f.counts(), { starts: 1, writes: 1, models: 2 });
    assert.deepEqual([result.descendantUsage.modelCalls, result.descendantUsage.toolCalls], [2, 1]);
    assert.equal(f.store.events(scope, 'run').filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
    assert.equal(f.captured.length, 4); assert.ok(f.captured.every(request => /:call:[12]$/.test(request.operationKey)));
    const pages = f.observations.filter(item => item.name === 'native_child_result').map(item => item.value);
    assert.ok(pages.every(value => value.status === 'ok'));
    assert.ok(pages.every(value => value.content.result_available === true));
    assert.equal(pages.map(value => value.content.final_text).join(''), finalText);
    assert.equal(pages[0].content.next_offset_chars, 5); assert.equal(pages[1].content.total_chars, [...finalText].length);
    assert.equal(pages[1].content.complete, true); assert.equal(pages[1].content.final_text_digest, sha(finalText));
    assert.equal(pages[0].content.parent_acceptance, 'not_evaluated'); assert.equal(pages[0].resourceUsage, undefined);
    const inventories = f.observations.filter(item => item.name === 'native_child_tasks').map(item => item.value.content);
    assert.equal(inventories[0].total_tasks, 1); assert.equal(inventories[0].tasks[0].role, 'worker');
    assert.equal(inventories[0].tasks[0].goal_preview_trust, 'untrusted');
    assert.equal(inventories[1].inventory_digest, inventories[0].inventory_digest);
    assert.deepEqual(inventories[1].tasks, []); assert.equal(inventories[1].complete, true);
  });

  test(`${backend}: active child is discoverable but unsettled findings cannot be consumed`, async t => {
    const f = setup(t, backend, { pending: true });
    await f.kernel.runUntilIdle(scope, 'run');
    const result = f.observations.find(item => item.name === 'native_child_result').value;
    assert.equal(result.status, 'ok'); assert.equal(result.content.result_available, false);
    assert.equal(result.content.terminal, false); assert.equal(result.content.final_text, '');
    const tasks = f.observations.find(item => item.name === 'native_child_tasks').value;
    assert.equal(tasks.status, 'ok'); assert.equal(tasks.content.tasks.length, 1); assert.equal(tasks.content.tasks[0].terminal, false);
    assert.equal(tasks.content.tasks[0].delivery, 'background'); assert.equal(tasks.content.tasks[0].can_promote, false);
    assert.equal(tasks.content.tasks[0].can_cancel, true); assert.equal(tasks.content.tasks[0].can_send_input, true);
    assert.deepEqual(f.counts(), { starts: 1, writes: 1, models: 2 });
  });

  test(`${backend}: guessed IDs and stale inventory digests do not expose another delivery or silently change pages`, async t => {
    const f = setup(t, backend, { childIdOverride: 'foreign-child', staleInventory: true });
    assert.equal((await f.kernel.runUntilIdle(scope, 'run')).phase, 'completed');
    const unavailable = f.observations.find(item => item.name === 'native_child_result').value;
    assert.deepEqual(unavailable, { status: 'error', content: { error_code: 'child_result_not_available' } });
    const page = f.observations.filter(item => item.name === 'native_child_tasks').at(-1).value;
    assert.deepEqual(page, { status: 'error', content: { error_code: 'child_tasks_inventory_changed' } });
    assert.deepEqual(f.counts(), { starts: 1, writes: 1, models: 2 });
  });

  test(`${backend}: real running queries reject changed authority, calls, scopes and revoked execution fences`, async t => {
    let checked = false;
    const f = setup(t, backend, { onQuery: async (request, { store, readers }) => {
      if (checked || request.call.name !== 'native_child_result') return; checked = true;
      for (const field of ['tenantId', 'workspaceId', 'userId']) {
        const value = await readers.execute({ ...request, scope: { ...request.scope, [field]: 'foreign' } });
        assert.equal(value.status, 'error'); assert.equal(value.content.error_code, 'child_reader_scope_mismatch');
      }
      for (const field of ['sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']) {
        const value = await readers.execute({ ...request, [field]: 'foreign' });
        assert.equal(value.content.error_code, 'child_reader_identity_mismatch');
      }
      for (const patch of [
        { executionFence: request.executionFence + 1 },
        { call: { ...request.call, callId: 'wrong' } },
        { definition: { ...request.definition, readOnly: false } },
        { operationKey: request.operationKey.replace(/:call:\d+$/, '') },
      ]) assert.equal((await readers.execute({ ...request, ...patch })).status, 'error');
      const expired = createNativeChildResultTools({ scope, childScopes: [childScope], store, roles: ['worker'], now: () => Date.now() + 1e9 });
      assert.equal((await expired.execute(request)).content.error_code, 'child_reader_fence_lost');
      const revoked = createNativeChildResultTools({ scope, childScopes: [childScope], store, roles: ['other-role'] });
      assert.equal((await revoked.execute(request)).content.error_code, 'child_result_not_available');
      const canceled = new AbortController(); canceled.abort(new Error('Reader canceled'));
      await assert.rejects(readers.execute({ ...request, signal: canceled.signal }), /Reader canceled/);
    } });
    assert.equal((await f.kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(checked, true);
    const value = await f.readers.execute({ ...f.captured[0], signal: new AbortController().signal });
    assert.equal(value.status, 'error');
  });
}
