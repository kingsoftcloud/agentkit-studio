import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { mountRuntimeBridge } from '../src/host/runtime-bridge.mjs';

// Cordis-level finite evidence for the ephemeral agentkit/native-recovery-binding
// capability. Real DSH Agent-scope isolation (dsh-scope createScope/scopeTarget,
// independent fibers, cross-preset non-leak) is verified separately by
// scripts/verify-native-recovery-capability.mjs against a built DSH source.
// These tests do NOT claim to verify real Agent scope; they cover the binding
// contract, refusal paths, and plugin-fiber retirement using ctx.plugin.

const harnessConfig = (overrides = {}) => ({
  agentId: 'native-agent', agentRevision: 7, runtime: 'harness', local: true,
  nativeEngineContract: NATIVE_DSH_TURN_CONTRACT, ...overrides,
});

function setupRoot() {
  const root = new Context();
  mountRuntimeBridge(root);
  const bridge = root.get('studioRuntimeBridge');
  return { root, bridge };
}

test('native-recovery-binding returns the frozen binding facts without starting execution', async () => {
  const { root, bridge } = setupRoot();
  const nativeTools = { id: 'alpha', definitions: () => [] };
  bridge.setNativeToolsFactory(() => nativeTools);
  let plugCtx;
  const fiber = await root.plugin({ apply(ctx) { plugCtx = ctx; applyPreset(ctx, harnessConfig({ agentId: 'alpha', buildId: 'build-aaa' })); } });
  try {
    const result = await plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'alpha' } });
    assert.deepEqual(result, { agentId: 'alpha', runtime: 'harness', local: true, agentRevision: 7,
      buildId: 'build-aaa', boundToolPolicy: null, nativeEngineContract: NATIVE_DSH_TURN_CONTRACT, nativeTools });
    assert.equal(result.nativeTools, nativeTools, 'nativeTools is the frozen binding object, not a request copy');
  } finally { await fiber.dispose(); await root.fiber.dispose(); }
});

test('resourcesUnavailable degrades the recovery binding until strict admission', async () => {
  const mount = async overrides => {
    const { root, bridge } = setupRoot();
    bridge.setNativeToolsFactory(() => ({}));
    let plugCtx;
    const fiber = await root.plugin({ apply(ctx) { plugCtx = ctx;
      applyPreset(ctx, harnessConfig({ agentId: 'delta', resourcesUnavailable: true, ...overrides })); } });
    return { root, fiber, plugCtx };
  };
  const degraded = await mount();
  try {
    const binding = await degraded.plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'delta' } });
    assert.equal(binding.agentId, 'delta', 'a degraded admission keeps the Agent conversational');
  } finally { await degraded.fiber.dispose(); await degraded.root.fiber.dispose(); }
  const strict = await mount({ strictResources: true });
  try {
    // The recovery binding refuses exactly like the turn boundary does.
    await assert.rejects(
      strict.plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'delta' } }),
      { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' },
    );
    await assert.rejects(
      strict.plugCtx.serial({}, 'agent/execute-turn', { agent: { id: 'delta' } }),
      { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' },
    );
  } finally { await strict.fiber.dispose(); await strict.root.fiber.dispose(); }
});

test('non-harness presets do not register the recovery binding and return nothing', async () => {
  const { root, bridge } = setupRoot();
  bridge.setNativeToolsFactory(() => ({}));
  let plugCtx;
  const fiber = await root.plugin({ apply(ctx) { plugCtx = ctx;
    applyPreset(ctx, { agentId: 'epsilon', agentRevision: 1, runtime: 'dsh-native', local: true }); } });
  try {
    const result = await plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'epsilon' } });
    assert.equal(result, undefined, 'non-harness must not expose a recovery binding');
  } finally { await fiber.dispose(); await root.fiber.dispose(); }
});

test('a retired plugin fiber returns strictly undefined for the recovery binding', async () => {
  const { root, bridge } = setupRoot();
  bridge.setNativeToolsFactory(() => ({ id: 'gamma', definitions: () => [] }));
  let plugCtx;
  const fiber = await root.plugin({ apply(ctx) { plugCtx = ctx; applyPreset(ctx, harnessConfig({ agentId: 'gamma' })); } });
  try {
    const before = await plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'gamma' } });
    assert.equal(before.agentId, 'gamma');
    await fiber.dispose();
    const after = await plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'gamma' } });
    assert.equal(after, undefined, 'a retired scope must return strictly undefined, never another preset binding');
  } finally { await root.fiber.dispose(); }
});

for (const event of ['agent/created', 'system-prompt/assemble', 'agentkit/native-recovery-binding']) {
  test(`Native preset initializes its Session tools before ${event}, once per scope`, async () => {
    const { root, bridge } = setupRoot();
    const agent = { session: { id: 'owning-session' } }; let calls = 0, plugCtx;
    const nativeTools = { definitions: () => [] };
    bridge.setNativeToolsFactory(request => { assert.equal(request.agent, agent); calls++; return nativeTools; });
    const fiber = await root.plugin({ apply(ctx) { plugCtx = ctx; applyPreset(ctx, harnessConfig()); } });
    try {
      assert.equal(calls, 0, 'preset mount has no Session and must not capture the process directory');
      if (event === 'agent/created') await plugCtx.parallel('agent/created', { agent });
      if (event === 'system-prompt/assemble') {
        const assembly = { tools: [] };
        await plugCtx.waterfall({}, 'system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly));
      }
      const result = await plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent });
      assert.equal(result.nativeTools, nativeTools); assert.equal(calls, 1);
    } finally { await fiber.dispose(); await root.fiber.dispose(); }
  });
}
