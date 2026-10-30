import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNativeRuntimeRoute, nativeRuntimeRouteInput } from '../src/host/state/native-runtime-route.mjs';

const agent = (id, type) => ({ metadata: { id }, spec: { runtime: { type } } });
test('an empty projection store during history hydration never chooses a foreign renderer', () => {
  assert.equal(nativeRuntimeRouteInput(undefined,'loading').ready,false);
  assert.equal(nativeRuntimeRouteInput({projectionValues:{}},'loading').ready,false);
  assert.equal(nativeRuntimeRouteInput({projectionValues:{}},'error').ready,false);
  assert.equal(nativeRuntimeRouteInput({projectionValues:{}},'open').ready,false);
  assert.deepEqual(nativeRuntimeRouteInput({projectionValues:{agentPreset:'native-preset'}},'loading',undefined,'native-preset'),
    {presetId:'native-preset',ready:false});
  assert.equal(nativeRuntimeRouteInput({projectionValues:{agentPreset:''}},'loading').ready,false);
  assert.equal(nativeRuntimeRouteInput({projectionValues:{agentPreset:'native-preset'}},'open').ready,false);
  for (const state of ['idle','loading','error','migration-required'])
    assert.equal(nativeRuntimeRouteInput({projectionValues:{}},'open',{state,values:{}}).ready,false);
  assert.deepEqual(nativeRuntimeRouteInput({projectionValues:{}},'open',{state:'ready',values:{agentPreset:'native-preset'}},'native-preset'),
    {presetId:'native-preset',ready:true});
  assert.equal(nativeRuntimeRouteInput({projectionValues:{}},'open',{state:'ready',values:{}}).ready,true);
  assert.deepEqual(nativeRuntimeRouteInput({projectionValues:{agentPreset:'stale-native'}},'open',{state:'ready',values:{}}),
    {presetId:undefined,ready:true});
});
test('a batched catalog from the previous preset never overrides the current Session keyed projection', () => {
  const stale = {state:'ready',values:{agentPreset:'standard'}};
  assert.deepEqual(nativeRuntimeRouteInput({projectionValues:{agentPreset:'standard'}},'open',stale,'native-preset'),
    {presetId:'native-preset',ready:true});
  assert.deepEqual(nativeRuntimeRouteInput({projectionValues:{agentPreset:'native-preset'}},'open',
    {state:'ready',values:{agentPreset:'native-preset'}},undefined),{presetId:undefined,ready:true});
});
const route = (hostRemote, resolveAgentFromPreset = () => 'native') => resolveNativeRuntimeRoute({
  hostRemote, presetId: 'frozen-preset', resolveAgentFromPreset, signal: new AbortController().signal,
});
test('runtime routing resolves Native across complete pages and only selects fallback for a known other runtime', async () => {
  const host = { agents: async ({ page }) => page ? { items: [agent('native', 'harness')] }
    : { items: [agent('codex', 'codex')], total: 2 } };
  assert.deepEqual(await route(host), { kind: 'native', agentId: 'native' });
  assert.deepEqual(await route(host, () => 'codex'), { kind: 'other', agentId: 'codex' });
  assert.deepEqual(await route(host, () => null), { kind: 'other', agentId: null });
});
test('missing, failed or incomplete Native routing never silently selects the old renderer', async () => {
  await assert.rejects(route({ agents: async () => { throw Error('offline'); } }), /offline/);
  await assert.rejects(route({ agents: async () => ({ items: [] }) }), /暂不可用/);
  await assert.rejects(route({ agents: async () => ({ items: [], total: 1 }) }), /完整读取/);
  await assert.rejects(route({ agents: async () => ({}) }), /目录响应无效/);
});
test('a stale routing lookup cannot return after its session has been replaced', async () => {
  const controller = new AbortController(); let complete;
  const pending = resolveNativeRuntimeRoute({ hostRemote: { agents: () => new Promise(resolve => { complete = resolve; }) },
    presetId: 'old', resolveAgentFromPreset: () => 'native', signal: controller.signal });
  controller.abort(); complete({ items: [agent('native', 'harness')] });
  await assert.rejects(pending, { name: 'AbortError' });
});
