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
