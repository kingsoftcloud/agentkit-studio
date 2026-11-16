import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
import { mountRuntimeBridge } from '../src/host/runtime-bridge.mjs';

const event = 'agentkit/harness-resource-binding';
const legacyEvent = 'agentkit/native-recovery-binding';
async function mount(t, overrides = {}) {
  const root = new Context();
  mountRuntimeBridge(root);
  let scope;
  const fiber = await root.plugin({ apply(ctx) {
    scope = ctx;
    applyPreset(ctx, { agentId: 'native-agent', agentRevision: 7, runtime: 'native-engine', local: true,
      buildId: 'build-aaa', scopedPresetId: 'native-preset', ...overrides });
  } });
  t.after(() => root.fiber.dispose());
  return { fiber, query: (name = event) => scope.serial({}, name, {}) };
}

test('independent Harness exposes its frozen resource identity and no old recovery binding', async t => {
  const { query } = await mount(t);
  assert.deepEqual(await query(), { agentId: 'native-agent', agentRevision: 7, buildId: 'build-aaa', scopedPresetId: 'native-preset' });
  assert.equal(await query(legacyEvent), undefined);
});

test('strict resource admission refuses the independent Harness resource binding', async t => {
  const { query } = await mount(t, { resourcesUnavailable: true, strictResources: true });
  await assert.rejects(query(), { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
});

test('a retired preset scope and non-Harness presets expose no independent resource binding', async t => {
  const local = await mount(t);
  await local.fiber.dispose();
  assert.equal(await local.query(), undefined);
  assert.equal(await (await mount(t, { runtime: 'dsh-native' })).query(), undefined);
});
