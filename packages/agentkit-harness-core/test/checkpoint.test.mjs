import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const final = () => ({ kind: 'final_candidate', text: 'Delivered', toolCalls: [], usage: emptyUsage() });
const neverTool = { execute: async () => { throw Error('Unexpected tool dispatch'); } };

for (const backend of ['memory', 'sqlite']) {
  function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'native-checkpoint-'));
    const filename = join(directory, 'run.sqlite');
    let store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
    const value = { get store() { return store; }, reopen() {
      if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); }
      return store;
    } };
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    return value;
  }

  test(`${backend}: committed model and tool events are delivered before the next effect`, async t => {
    const { store } = setup(t), { config, snapshot } = fixture({ tools: [tool()] });
    store.create(config, snapshot);
    const delivered = new Set();
    let modelCalls = 0, tools = 0;
    const worker = new NativeKernel({ store, digest, owner: 'worker',
      onCheckpoint: async state => {
        await Promise.resolve();
        for (const event of store.events(scope, 'run')) delivered.add(event.kind);
        assert.equal(state.eventSeq, store.load(scope, 'run').snapshot.eventSeq);
      },
      ports: {
        model: { generate: async () => {
          modelCalls++;
          assert.ok(delivered.has('effect.prepared'));
          if (modelCalls === 1) return { ...final(), kind: 'tool_calls', text: '', toolCalls: [{ callId: 'read-1', name: 'read', arguments: {} }] };
          assert.ok(delivered.has('tool.completed'));
          return final();
        } },
        tools: { execute: async () => {
          tools++;
          assert.ok(delivered.has('model.completed'));
          return { status: 'ok', content: 'Actual observation' };
        } },
      },
    });
    const result = await worker.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(modelCalls, 2); assert.equal(tools, 1);
    assert.ok(delivered.has('run.terminal'));
  });

  test(`${backend}: failed delivery after a committed write resumes without executing it again`, async t => {
    const storage = setup(t), { config, snapshot } = fixture({ tools: [tool({ readOnly: false, concurrentSafe: false })] });
    storage.store.create(config, snapshot);
    let models = 0, writes = 0;
    const ports = {
      model: { generate: async () => ++models === 1
        ? { ...final(), kind: 'tool_calls', toolCalls: [{ callId: 'write-1', name: 'read', arguments: {} }] } : final() },
      tools: { execute: async () => { writes++; return { status: 'ok', content: 'Published once' }; } },
    };
    const worker = new NativeKernel({ store: storage.store, ports, digest, owner: 'before-restart',
      onCheckpoint: async () => {
        if (storage.store.events(scope, 'run').some(event => event.kind === 'tool.completed')) throw Error('Session persistence unavailable');
      },
    });
    await assert.rejects(worker.runUntilIdle(scope, 'run'), /Session persistence unavailable/);
    assert.equal(writes, 1); assert.equal(models, 1);
    const store = storage.reopen();
    const delivered = [];
    const result = await new NativeKernel({ store, ports, digest, owner: 'after-restart',
      onCheckpoint: async state => { delivered.push(state.eventSeq); },
    }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(writes, 1); assert.equal(models, 2);
    assert.equal(delivered.at(-1), result.eventSeq);
  });

  test(`${backend}: delivery is awaited before claiming and a persisted cancel wins`, async t => {
    const { store } = setup(t), { config, snapshot } = fixture();
    store.create(config, snapshot);
    let calls = 0, worker;
    worker = new NativeKernel({ store, digest, owner: 'worker',
      ports: { model: { generate: async () => { calls++; return final(); } }, tools: neverTool },
      onCheckpoint: async state => {
        if (state.pendingIntent) {
          await Promise.resolve();
          worker.submit(scope, 'run', { commandId: 'cancel-at-delivery', kind: 'cancel', payload: {} });
        }
      },
    });
    const result = await worker.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'canceled'); assert.equal(calls, 0); assert.equal(result.usage.modelCalls, 0);
  });

  test(`${backend}: terminal replay delivers again without model or tool execution`, async t => {
    const storage = setup(t), { config, snapshot } = fixture();
    storage.store.create(config, snapshot);
    await new NativeKernel({ store: storage.store, digest, owner: 'first', ports: { model: { generate: async () => final() }, tools: neverTool } })
      .runUntilIdle(scope, 'run');
    const store = storage.reopen();
    let delivery = 0;
    const result = await new NativeKernel({ store, digest, owner: 'replay',
      ports: { model: { generate: async () => { throw Error('Terminal replay must not infer'); } }, tools: neverTool },
      onCheckpoint: async state => { delivery++; assert.equal(state.phase, 'completed'); },
    }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(delivery, 1);
  });
}

test('checkpoint values cannot mutate the ledger or the next effect input', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture(); store.create(config, snapshot);
  const result = await new NativeKernel({ store, digest, owner: 'worker',
    onCheckpoint: async state => { state.messages[0].content = 'Injected'; state.phase = 'canceled'; state.usage.modelCalls = 999; },
    ports: { model: { generate: async request => { assert.equal(request.messages[0].content, config.contract.objective); return final(); } }, tools: neverTool },
  }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.usage.modelCalls, 1);
});

test('lease replacement during asynchronous delivery fences the old worker before dispatch', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture({ limits: { leaseMs: 30 } }); store.create(config, snapshot);
  let now = 1, calls = 0;
  const worker = new NativeKernel({ store, digest, owner: 'old', now: () => now,
    ports: { model: { generate: async () => { calls++; return final(); } }, tools: neverTool },
    onCheckpoint: async state => {
      if (state.pendingIntent) { now = 100; store.acquire(scope, 'run', 'replacement', now, 30); }
    },
  });
  await assert.rejects(worker.runUntilIdle(scope, 'run'), { code: 'stale_fence' }); assert.equal(calls, 0);
});
