import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPresetRegistry } from '../src/preset-registry-binding.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';

test('retiring an old registry scope cannot dispose the replacement admission', async () => {
  let connect, current;
  const record = { metadata: { id: 'ar-local-0123456789abcdef', local: true, revision: 1 },
    spec: { runtime: { type: 'harness' } } };
  const disposed = [], registered = [];
  bindPresetRegistry({ inject(_deps, callback) { connect = callback; } }, {
    createAdmission: registry => new DshPresetAdmission({ registry, getAgent: async () => record }),
    publishAdmission: admission => { current = admission; }, reconcile: async () => {},
  });
  async function scope(id) {
    let retire;
    await connect({ agentPresets: { async register() {
      registered.push(id); return () => { disposed.push(id); };
    } }, effect(factory) { retire = factory(); } });
    return retire;
  }
  const retireOld = await scope('old');
  await current.ensure(record.metadata.id);
  const retireNew = await scope('new');
  await retireOld();
  await current.ensure(record.metadata.id);
  assert.deepEqual(registered, ['old', 'new']);
  assert.deepEqual(disposed, ['old']);
  await retireNew();
  assert.deepEqual(disposed, ['old', 'new']);
});

test('startup readiness waits for actual delayed definition registration, independently of the injection fork', async () => {
  let connect, release, settled = false;
  const pending = new Promise(resolve => { release = resolve; }), registry = new Map();
  const fork = {};
  const binding = bindPresetRegistry({ inject(_deps, callback) { connect = callback; return fork; } }, {
    createAdmission: () => ({ dispose() {} }), publishAdmission() {},
    reconcile: async () => { await pending; registry.set('original-preset', { ready: true }); },
  });
  assert.equal(binding.scope, fork);
  void binding.ready.then(() => { settled = true; });
  const activation = connect({ agentPresets: registry, effect: factory => factory() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(registry.has('original-preset'), false);
  release(); await binding.ready;
  assert.equal(registry.has('original-preset'), true); await activation;
});

test('failed or retired reconciliation cannot publish false startup readiness', async () => {
  for (const retire of [false, true]) {
    let connect, cleanup, release;
    const pending = new Promise(resolve => { release = resolve; }); let disposed = 0;
    const binding = bindPresetRegistry({ inject(_deps, callback) { connect = callback; } }, {
      createAdmission: () => ({ dispose() { disposed++; } }), publishAdmission() {},
      reconcile: async () => { await pending; if (!retire) throw new Error('definition failed'); },
    });
    const failedReady = assert.rejects(binding.ready, retire ? { code: 'STUDIO_PRESET_REGISTRY_RETIRED' } : /definition failed/);
    const activation = connect({ agentPresets: {}, effect: factory => { cleanup = factory(); } });
    const activated = retire ? activation : assert.rejects(activation, /definition failed/);
    if (retire) cleanup();
    release(); await failedReady; await activated;
    assert.equal(disposed, retire ? 1 : 0);
  }
});

test('admission creation or publication failure rejects readiness instead of hanging startup', async () => {
  for (const failCreation of [true, false]) {
    let connect, cleanup;
    const failure = new Error(failCreation ? 'creation failed' : 'publication failed');
    const binding = bindPresetRegistry({ inject(_deps, callback) { connect = callback; } }, {
      createAdmission: () => { if (failCreation) throw failure; return { dispose() {} }; },
      publishAdmission() { throw failure; }, reconcile() { assert.fail('cannot reconcile failed admission'); },
    });
    const readiness = assert.rejects(binding.ready, error => error === failure);
    await assert.rejects(connect({ agentPresets: {}, effect(factory) { cleanup = factory(); } }), error => error === failure);
    await readiness; cleanup?.();
  }
});
