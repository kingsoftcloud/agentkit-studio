import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
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
      buildId: 'build-aaa', nativeEngineContract: NATIVE_DSH_TURN_CONTRACT, nativeTools });
    assert.equal(result.nativeTools, nativeTools, 'nativeTools is the frozen binding object, not a request copy');
  } finally { await fiber.dispose(); await root.fiber.dispose(); }
});

test('resourcesUnavailable rejects identically to execute-turn', async () => {
  const { root, bridge } = setupRoot();
  bridge.setNativeToolsFactory(() => ({}));
  let plugCtx;
  const fiber = await root.plugin({ apply(ctx) { plugCtx = ctx; applyPreset(ctx, harnessConfig({ agentId: 'delta', resourcesUnavailable: true })); } });
  try {
    await assert.rejects(
      plugCtx.serial({}, 'agentkit/native-recovery-binding', { agent: { id: 'delta' } }),
      { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' },
    );
  } finally { await fiber.dispose(); await root.fiber.dispose(); }
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
