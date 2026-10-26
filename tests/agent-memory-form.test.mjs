import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentForm } from '../src/client/pages/agent-form.mjs';
import { createExpertCatalog } from '../packages/expert-catalog/src/catalog.mjs';
import { createTemplateAuthoring } from '../src/template-authoring.mjs';
import {
  readAgentMemoryConfig, writeAgentMemoryConfig, validateAgentMemoryConfig,
  memorySourceContext, memoryRequiresCloudBinding, clampInt, clampFloat,
  MEMORY_PROVIDER_LOCAL, MEMORY_PROVIDER_CLOUD,
} from '../src/client/state/agent-memory-config.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
const findBy = (nodes, predicate) => nodes.find(predicate);
const findAll = (nodes, predicate) => nodes.filter(predicate);
const byAria = label => node => node.props?.['aria-label'] === label;
const byButtonText = text => node => node.type === 'button' && node.children.includes(text);

// ---------------------------------------------------------------------------
// Pure helper: source gating per runtime / path
// ---------------------------------------------------------------------------
test('memorySourceContext: local-default is harness-only; template seeds now allowed, cloudEditing excluded', () => {
  assert.deepEqual(memorySourceContext({ runtime: 'harness', cloudEditing: false, creationSeed: null }), { canLocal: true, canCloud: true });
  assert.deepEqual(memorySourceContext({ runtime: 'dsh-native', cloudEditing: false, creationSeed: null }), { canLocal: false, canCloud: true });
  assert.deepEqual(memorySourceContext({ runtime: 'codex', cloudEditing: false, creationSeed: null }), { canLocal: false, canCloud: true });
  // A harness template seed may now use local-default memory (the template
  // authoring service accepts it); local is still harness-only, never widened.
  assert.deepEqual(memorySourceContext({ runtime: 'harness', cloudEditing: false, creationSeed: {} }), { canLocal: true, canCloud: true });
  assert.deepEqual(memorySourceContext({ runtime: 'dsh-native', cloudEditing: false, creationSeed: {} }), { canLocal: false, canCloud: true });
  assert.deepEqual(memorySourceContext({ runtime: 'harness', cloudEditing: true, creationSeed: null }), { canLocal: false, canCloud: false });
});

// ---------------------------------------------------------------------------
// Pure helper: read backfills every Native memory field from the original spec
// ---------------------------------------------------------------------------
test('readAgentMemoryConfig backfills providerRef/scopes/recall/write/rollout from the original spec', () => {
  const spec = {
    memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      recall: { enabled: false, maxTokens: 999, topK: 5, minScore: 0.6 },
      write: { mode: 'candidate', flushBeforeCompaction: false, flushAfterTurn: false } },
    context: { rollout: { memoryWrite: 'enabled' } },
  };
  const state = readAgentMemoryConfig({ spec, runtime: 'harness', cloudEditing: false, creationSeed: null, editing: true });
  assert.equal(state.enabled, true);
  assert.equal(state.source, 'local');
  assert.deepEqual(state.scopes, ['user']);
  assert.equal(state.recallEnabled, false);
  assert.equal(state.recallMaxTokens, 999);
  assert.equal(state.recallTopK, 5);
  assert.equal(state.recallMinScore, 0.6);
  assert.equal(state.writeMode, 'candidate');
  assert.equal(state.writeFlushBeforeCompaction, false);
  assert.equal(state.writeFlushAfterTurn, false);
  assert.equal(state.rollout, 'enabled');
});

test('readAgentMemoryConfig applies policy defaults for a blank harness Agent', () => {
  const state = readAgentMemoryConfig({ spec: {}, runtime: 'harness', cloudEditing: false, creationSeed: null, editing: false });
  assert.equal(state.enabled, false);
  assert.equal(state.source, 'local');
  assert.equal(state.recallEnabled, true);            // policy default, independent of enabled
  assert.equal(state.recallMaxTokens, 1600);
  assert.equal(state.recallTopK, 8);
  assert.equal(state.recallMinScore, 0.45);
  assert.equal(state.writeMode, 'explicit_only');      // current form default for new Agents
  assert.equal(state.writeFlushBeforeCompaction, true);
  assert.equal(state.writeFlushAfterTurn, true);
  assert.equal(state.rollout, 'shadow');              // policy default, no implicit privilege escalation
});

// ---------------------------------------------------------------------------
// Pure helper: write — create roundtrip, local-default needs no cloud binding
// ---------------------------------------------------------------------------
test('writeAgentMemoryConfig: harness local memory enables without a cloud binding and writes rollout into context', () => {
  const state = { ...readAgentMemoryConfig({ spec: {}, runtime: 'harness', editing: false }), enabled: true, source: 'local', writeMode: 'candidate', rollout: 'enabled' };
  const built = writeAgentMemoryConfig({ state, originalSpec: {}, platformBindings: [], runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.equal(built.useLocal, true);
  assert.equal(built.memory.enabled, true);
  assert.equal(built.memory.providerRef, MEMORY_PROVIDER_LOCAL);
  assert.deepEqual(built.memory.scopes, ['workspace', 'agent', 'user']);
  assert.equal(built.memory.recall.enabled, true);     // independent of memory.enabled
  assert.equal(built.memory.recall.maxTokens, 1600);
  assert.equal(built.memory.write.mode, 'candidate');
  assert.equal(built.memory.write.flushBeforeCompaction, true);
  assert.equal(built.memory.write.flushAfterTurn, true);
  assert.equal(built.rollout, 'enabled');
  assert.deepEqual(built.plugins, []);                  // no dangling memory-instance binding
});

test('writeAgentMemoryConfig: recall.enabled stays independent of memory.enabled on save', () => {
  const state = { ...readAgentMemoryConfig({ spec: {}, runtime: 'harness', editing: false }), enabled: true, source: 'local', recallEnabled: false, writeMode: 'candidate', rollout: 'shadow' };
  const built = writeAgentMemoryConfig({ state, originalSpec: {}, platformBindings: [], runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.equal(built.memory.enabled, true);
  assert.equal(built.memory.recall.enabled, false);     // NOT forced to equal memory.enabled
});

// ---------------------------------------------------------------------------
// Pure helper: edit roundtrip preserves untouched config (no overwrite)
// ---------------------------------------------------------------------------
test('writeAgentMemoryConfig: edit roundtrip preserves providerRef/scopes/recall/write/rollout the user did not change', () => {
  const originalSpec = {
    memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      recall: { enabled: false, maxTokens: 2048, topK: 12, minScore: 0.5 },
      write: { mode: 'candidate', flushBeforeCompaction: false, flushAfterTurn: true } },
    context: { rollout: { memoryWrite: 'shadow' }, contributors: { memoryRecall: true } },
  };
  const state = readAgentMemoryConfig({ spec: originalSpec, runtime: 'harness', cloudEditing: false, creationSeed: null, editing: true });
  // User only changes the rollout; everything else is backfilled and must survive.
  const built = writeAgentMemoryConfig({ state: { ...state, rollout: 'enabled' }, originalSpec, platformBindings: [], runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.equal(built.memory.providerRef, MEMORY_PROVIDER_LOCAL);
  assert.deepEqual(built.memory.scopes, ['user']);
  assert.equal(built.memory.recall.enabled, false);
  assert.equal(built.memory.recall.maxTokens, 2048);
  assert.equal(built.memory.recall.topK, 12);
  assert.equal(built.memory.recall.minScore, 0.5);
  assert.equal(built.memory.write.mode, 'candidate');
  assert.equal(built.memory.write.flushBeforeCompaction, false);
  assert.equal(built.memory.write.flushAfterTurn, true);
  assert.equal(built.rollout, 'enabled');
  // Other context contributors are preserved (not clobbered by the rollout write).
  assert.equal(built.useLocal, true);
});

// ---------------------------------------------------------------------------
// Pure helper: cloud path requires a binding and preserves its own rollout
// ---------------------------------------------------------------------------
test('writeAgentMemoryConfig: cloud path keeps providerRef cloud with a binding and leaves context rollout untouched', () => {
  const memoryInstance = { ecosystem: 'dsh', pluginRef: 'p', components: ['c'], enabled: true, config: { schemaVersion: 1, binding: { id: 'platform-memory-instance', connectionRef: 'conn', resource: { kind: 'memory-instance', id: 'mem-1', name: 'Mem', region: 'cn' }, required: true } } };
  const originalSpec = { memory: { enabled: false, providerRef: 'local-default', recall: { enabled: true }, write: { mode: 'explicit_only' } }, context: { rollout: { memoryWrite: 'shadow' } } };
  const state = { ...readAgentMemoryConfig({ spec: originalSpec, runtime: 'dsh-native', editing: false }), enabled: true, source: 'cloud', writeMode: 'candidate' };
  const built = writeAgentMemoryConfig({ state, originalSpec, platformBindings: [memoryInstance], runtime: 'dsh-native', cloudEditing: false, creationSeed: null });
  assert.equal(built.useLocal, false);
  assert.equal(built.memory.providerRef, MEMORY_PROVIDER_CLOUD);
  assert.equal(built.memory.write.mode, 'candidate');
  assert.equal(built.rollout, 'shadow');                 // preserved from original, not taken from local state
  assert.deepEqual(built.plugins, [memoryInstance]);      // cloud keeps the memory-instance binding
});

// ---------------------------------------------------------------------------
// Pure helper: disabled memory preserves everything (no silent source switch)
// ---------------------------------------------------------------------------
test('writeAgentMemoryConfig: disabled preserves provider/scopes/recall/write/rollout and keeps a cloud binding', () => {
  const memoryInstance = { ecosystem: 'dsh', pluginRef: 'p', components: ['c'], enabled: true, config: { schemaVersion: 1, binding: { id: 'platform-memory-instance', connectionRef: 'conn', resource: { kind: 'memory-instance', id: 'mem-1', name: 'Mem', region: 'cn' }, required: true } } };
  const originalSpec = {
    memory: { enabled: true, providerRef: MEMORY_PROVIDER_CLOUD, scopes: ['user'],
      recall: { enabled: false, maxTokens: 2048, topK: 12, minScore: 0.5 },
      write: { mode: 'candidate', flushBeforeCompaction: false, flushAfterTurn: true } },
    context: { rollout: { memoryWrite: 'enabled' }, contributors: { memoryRecall: true } },
  };
  const state = { ...readAgentMemoryConfig({ spec: originalSpec, runtime: 'harness', editing: true }), enabled: false };
  const built = writeAgentMemoryConfig({ state, originalSpec, platformBindings: [memoryInstance], runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.equal(built.useLocal, false);
  assert.equal(built.memory.enabled, false);
  assert.equal(built.memory.providerRef, MEMORY_PROVIDER_CLOUD, 'disabling does not switch the cloud provider to local');
  assert.deepEqual(built.memory.scopes, ['user'], 'scopes preserved');
  assert.equal(built.memory.recall.enabled, false, 'recall preserved');
  assert.equal(built.memory.recall.maxTokens, 2048);
  assert.equal(built.memory.write.mode, 'candidate', 'write preserved');
  assert.equal(built.rollout, 'enabled', 'rollout preserved');
  assert.deepEqual(built.plugins, [memoryInstance], 'cloud binding kept, not stripped');
});

test('writeAgentMemoryConfig: an explicit scopes:[] survives instead of being widened to defaults', () => {
  const originalSpec = { memory: { enabled: true, providerRef: MEMORY_PROVIDER_LOCAL, scopes: [],
    recall: { enabled: true, maxTokens: 500, topK: 4, minScore: 0.3 }, write: { mode: 'off' } },
    context: { rollout: { memoryWrite: 'shadow' } } };
  const state = readAgentMemoryConfig({ spec: originalSpec, runtime: 'harness', editing: true });
  assert.deepEqual(state.scopes, [], 'read preserves the empty scopes array');
  const built = writeAgentMemoryConfig({ state, originalSpec, platformBindings: [], runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.deepEqual(built.memory.scopes, [], 'empty scopes not widened to defaults');
  assert.equal(built.memory.write.mode, 'off');
  assert.equal(built.memory.recall.enabled, true);
  assert.equal(built.useLocal, true);
});

test('writeAgentMemoryConfig: disabled preserves an explicit scopes:[] and the local provider', () => {
  const originalSpec = { memory: { enabled: true, providerRef: MEMORY_PROVIDER_LOCAL, scopes: [], recall: { enabled: true }, write: { mode: 'candidate' } }, context: { rollout: { memoryWrite: 'shadow' } } };
  const state = { ...readAgentMemoryConfig({ spec: originalSpec, runtime: 'harness', editing: true }), enabled: false };
  const built = writeAgentMemoryConfig({ state, originalSpec, platformBindings: [], runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.deepEqual(built.memory.scopes, [], 'disabled preserves empty scopes');
  assert.equal(built.memory.providerRef, MEMORY_PROVIDER_LOCAL, 'disabled preserves local provider');
});

test('memoryRequiresCloudBinding: local needs no binding; dsh-native does', () => {
  const harnessLocal = { enabled: true, source: 'local' };
  const harnessCloud = { enabled: true, source: 'cloud' };
  const harnessCtx = memorySourceContext({ runtime: 'harness', cloudEditing: false, creationSeed: null });
  assert.equal(memoryRequiresCloudBinding({ state: harnessLocal, ctx: harnessCtx, memoryInstanceBound: false }), false);
  assert.equal(memoryRequiresCloudBinding({ state: harnessCloud, ctx: harnessCtx, memoryInstanceBound: false }), true);
  const dshCtx = memorySourceContext({ runtime: 'dsh-native', cloudEditing: false, creationSeed: null });
  assert.equal(memoryRequiresCloudBinding({ state: { enabled: true, source: 'cloud' }, ctx: dshCtx, memoryInstanceBound: false }), true);
  assert.equal(memoryRequiresCloudBinding({ state: { enabled: false }, ctx: dshCtx, memoryInstanceBound: false }), false);
});

// ---------------------------------------------------------------------------
// Pure helper: numeric validation + clamp
// ---------------------------------------------------------------------------
test('validateAgentMemoryConfig rejects out-of-range recall numbers and invalid enums', () => {
  const bad = validateAgentMemoryConfig({ recallMaxTokens: -1, recallTopK: 99, recallMinScore: 1.5, writeMode: 'nope', rollout: 'nope' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(e => e.field), ['recallMaxTokens', 'recallTopK', 'recallMinScore', 'writeMode', 'rollout']);
  const ok = validateAgentMemoryConfig({ recallMaxTokens: 0, recallTopK: 1, recallMinScore: 0, writeMode: 'off', rollout: 'shadow' });
  assert.equal(ok.ok, true);
});

test('clampInt/clampFloat coerce invalid input back into the policy range', () => {
  assert.equal(clampInt('abc', 0, 64, 8), 8);
  assert.equal(clampInt(99, 0, 64, 8), 64);
  assert.equal(clampInt(2.9, 0, 64, 8), 2);
  assert.equal(clampFloat('xyz', 0, 1, 0.45), 0.45);
  assert.equal(clampFloat(1.2, 0, 1, 0.45), 1);
});

// ===========================================================================
// Form rendering: a minimal React double with lazy useState + dep-tracked useEffect
// ===========================================================================
function formHarness(props = {}, options = {}) {
  const states = []; let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    const setter = value => { states[index] = typeof value === 'function' ? value(states[index]) : value; };
    return [states[index], setter];
  };
  const effectState = []; let effectCursor = 0;
  const useEffect = (fn, deps) => {
    const index = effectCursor++;
    const prev = effectState[index]?.deps;
    const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev[i]));
    if (changed) { if (effectState[index]?.cleanup) effectState[index].cleanup(); effectState[index] = { deps: deps ? [...deps] : undefined, cleanup: fn() }; }
  };
  const h = (type, p, ...children) => ({ type, props: p || {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) });
  const ui = { React: { createElement: h, useState, useEffect, Fragment: 'fragment' },
    BRAND: { border: '#b', surface: '#s', canvas: '#c', ink: '#i', inkMuted: '#m', accentStrong: '#a', accentSoft: '#ao', primaryText: '#pt', primaryFill: '#pf', danger: '#d' },
    ALLOWED_RUNTIME_TYPES: ['dsh-native', 'harness', 'codex'], RUNTIME_LABELS: {}, buttonStyle: () => ({}), inputStyle: () => ({}),
    SectionHeading: 'heading', PlatformResourcePicker: 'platform', Pill: 'pill' };
  const captured = options.captured || {};
  const hostRemote = options.hostRemote || {
    resources: kind => Promise.resolve(kind === 'model' ? { items: [{ resourceId: 'model-1', displayName: 'Model 1' }], defaultModel: 'model-1' } : { items: [] }),
    codexModels: () => Promise.resolve({ items: [{ resourceId: 'model-1', displayName: 'Model 1' }], defaultModel: 'model-1' }),
    quickAuthorAgent: async payload => { captured.create = payload; return { metadata: { id: payload.slug, name: payload.name, revision: 1 } }; },
    updateAgent: async (id, spec, revision, name) => { captured.update = { id, spec, revision, name }; return { metadata: { id, name, revision: (revision || 1) + 1 } }; },
  };
  const Form = createAgentForm({ ui, hostRemote });
  const render = () => { cursor = 0; effectCursor = 0; return walk(Form(props)); };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { render, flush, captured, hostRemote };
}

const advance = (harness, tree) => {
  const next = findBy(tree, byButtonText('下一步'));
  assert.ok(next, '下一步 button present');
  next.props.onClick();
  return harness.render();
};
// New local authoring defaults to Native. Keep this assertion in the actual
// form paths so a UI-only default cannot drift from the creation payload.
const switchToHarness = (harness, tree) => {
  const runtimeSelect = findBy(tree, node => node.type === 'select' && node.props.value === 'harness');
  assert.ok(runtimeSelect, 'new local Agent defaults to Native on step 0');
  return tree;
};

test('form: harness blank create offers the local memory source and needs no binding', async () => {
  const harness = formHarness({ onBack: () => {}, onCreated: () => {} });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = switchToHarness(harness, tree); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree);   // step 0 -> 1
  tree = advance(harness, tree);   // step 1 -> 2
  // enable memory, then the local source radio must be available
  const enabled = findBy(tree, byAria('启用跨会话记忆'));
  enabled.props.onChange({ target: { checked: true } });
  tree = harness.render();
  assert.ok(findBy(tree, byAria('记忆来源-本地记忆')), 'local source radio shown for harness');
  assert.ok(findBy(tree, byAria('记忆写入开关')), 'rollout selector shown for local memory');
  assert.ok(findBy(tree, byAria('召回最大 token 数')), 'recall maxTokens input shown for local memory');
});

test('form: dsh-native blank create does not offer the local memory source', async () => {
  const harness = formHarness({ initialAgent: null, creationSeed: null, onBack: () => {}, onCreated: () => {} });
  // force runtime to dsh-native via the step-0 runtime select is awkward; instead render an
  // editing dsh-native Agent so step 2 reflects the dsh-native gating directly.
  const initialAgent = { metadata: { id: 'a1', name: 'Agent', revision: 1 }, source: 'local',
    spec: { runtime: { type: 'dsh-native' }, bindings: { modelProfileId: 'model-1', plugins: [] }, memory: { enabled: false } } };
  const h2 = formHarness({ initialAgent, onBack: () => {}, onCreated: () => {} });
  let tree = h2.render(); await h2.flush(); tree = h2.render();
  tree = advance(h2, tree); tree = advance(h2, tree);
  const enabled = findBy(tree, byAria('启用跨会话记忆'));
  enabled.props.onChange({ target: { checked: true } });
  tree = h2.render();
  assert.equal(findBy(tree, byAria('记忆来源-本地记忆')), undefined, 'no local source radio for dsh-native');
  assert.ok(findBy(tree, byAria('记忆写入方式')), 'cloud write-mode select shown for dsh-native');
});

test('form: editing a harness Agent backfills the full memory config into step 2', async () => {
  const initialAgent = { metadata: { id: 'a1', name: 'Agent', revision: 3 }, source: 'local', spec: {
    runtime: { type: 'harness' },
    bindings: { modelProfileId: 'model-1', plugins: [] },
    memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
      recall: { enabled: true, maxTokens: 2048, topK: 12, minScore: 0.5 },
      write: { mode: 'candidate', flushBeforeCompaction: false, flushAfterTurn: true } },
    context: { rollout: { memoryWrite: 'shadow' } },
  } };
  const harness = formHarness({ initialAgent, onBack: () => {}, onCreated: () => {} });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);
  assert.equal(findBy(tree, byAria('启用召回')).props.checked, true);
  assert.equal(findBy(tree, byAria('召回最大 token 数')).props.value, 2048);
  assert.equal(findBy(tree, byAria('召回条数')).props.value, 12);
  assert.equal(findBy(tree, byAria('召回最低相似度')).props.value, 0.5);
  assert.equal(findBy(tree, byAria('记忆写入方式')).props.value, 'candidate');
  assert.equal(findBy(tree, byAria('压缩前刷新记忆')).props.checked, false);
  assert.equal(findBy(tree, byAria('轮次后刷新记忆')).props.checked, true);
  assert.equal(findBy(tree, byAria('记忆写入开关')).props.value, 'shadow');
});

test('form: cloudEditing keeps the memory enable checkbox read-only', async () => {
  const initialAgent = { metadata: { id: 'cloud-1', name: 'Cloud', revision: 2 }, source: 'agentengine-server',
    spec: { runtime: { type: 'langgraph' }, bindings: { plugins: [] }, memory: { enabled: true, providerRef: 'binding://platform-memory-instance' } } };
  const harness = formHarness({ initialAgent, onBack: () => {}, onCreated: () => {} });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);
  const enabled = findBy(tree, byAria('启用跨会话记忆'));
  assert.equal(enabled.props.disabled, true, 'cloud edit memory toggle is read-only');
  assert.ok(findBy(tree, node => node.props?.['data-memory-cloud-edit'] === true), 'cloud-edit read-only note shown');
});

// ---------------------------------------------------------------------------
// End-to-end create(): the form wires memory state -> spec via the helper
// ---------------------------------------------------------------------------
test('form create(): harness local memory with recall off, candidate write, enabled rollout produces the right spec', async () => {
  const captured = {};
  const harness = formHarness({ onBack: () => {}, onCreated: () => {} }, { captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = switchToHarness(harness, tree); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree);   // -> step 1
  tree = advance(harness, tree);   // -> step 2
  findBy(tree, byAria('启用跨会话记忆')).props.onChange({ target: { checked: true } });
  tree = harness.render();
  assert.ok(findBy(tree, byAria('记忆来源-本地记忆')), 'local source is the default for harness blank');
  findBy(tree, byAria('启用召回')).props.onChange({ target: { checked: false } });
  tree = harness.render();
  findBy(tree, byAria('记忆写入方式')).props.onChange({ target: { value: 'candidate' } });
  tree = harness.render();
  findBy(tree, byAria('记忆写入开关')).props.onChange({ target: { value: 'enabled' } });
  tree = harness.render();
  tree = advance(harness, tree);   // -> step 3
  const save = findBy(tree, byButtonText('创建 Agent'));
  assert.ok(save, 'create button present at step 3');
  await save.props.onClick();
  assert.ok(captured.create, 'quickAuthorAgent was invoked');
  const spec = captured.create.spec;
  assert.equal(spec.memory.enabled, true);
  assert.equal(spec.memory.providerRef, MEMORY_PROVIDER_LOCAL);
  assert.equal(spec.memory.recall.enabled, false, 'recall.enabled independent of memory.enabled');
  assert.equal(spec.memory.recall.maxTokens, 1600);
  assert.equal(spec.memory.recall.topK, 8);
  assert.equal(spec.memory.write.mode, 'candidate');
  assert.equal(spec.memory.write.flushBeforeCompaction, true);
  assert.equal(spec.memory.write.flushAfterTurn, true);
  assert.equal(spec.context.rollout.memoryWrite, 'enabled');
  assert.equal((spec.bindings.plugins || []).some(b => b?.config?.binding?.resource?.kind === 'memory-instance'), false, 'no memory-instance binding carried for local memory');
});

test('form create(): disabling memory does not fabricate a rollout or a cloud binding', async () => {
  const captured = {};
  const harness = formHarness({ onBack: () => {}, onCreated: () => {} }, { captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);
  // leave memory disabled (default for blank)
  tree = advance(harness, tree);   // -> step 3
  await findBy(tree, byButtonText('创建 Agent')).props.onClick();
  const spec = captured.create.spec;
  assert.equal(spec.memory.enabled, false);
  // Disabled memory preserves the original (empty) memory block; it does not
  // fabricate a providerRef, a rollout, or a cloud binding.
  assert.equal(spec.memory.providerRef, undefined, 'disabled blank create does not fabricate a providerRef');
  assert.equal(spec.context?.rollout?.memoryWrite, undefined, 'disabled memory does not synthesize a rollout');
  assert.equal((spec.bindings.plugins || []).some(b => b?.config?.binding?.resource?.kind === 'memory-instance'), false);
});

test('form create persists opt-in model extraction and restores it for editing without cloud bindings', async () => {
  const captured = {};
  const harness = formHarness({ onBack: () => {}, onCreated: () => {} }, { captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = switchToHarness(harness, tree); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);
  findBy(tree, byAria('启用跨会话记忆')).props.onChange({ target: { checked: true } }); tree = harness.render();
  assert.equal(findBy(tree, byAria('启用模型记忆提炼')).props.checked, false);
  findBy(tree, byAria('启用模型记忆提炼')).props.onChange({ target: { checked: true } }); tree = harness.render();
  findBy(tree, byAria('记忆提炼累计字符数')).props.onChange({ target: { value: '128' } });
  findBy(tree, byAria('记忆写入方式')).props.onChange({ target: { value: 'candidate' } });
  tree = harness.render(); tree = advance(harness, tree);
  await findBy(tree, byButtonText('创建 Agent')).props.onClick();
  assert.deepEqual(captured.create.spec.memory.extraction, { enabled: true, minUserCharacters: 128 });
  const restored = readAgentMemoryConfig({ spec: captured.create.spec, runtime: 'harness', editing: true });
  assert.equal(restored.extractionEnabled, true); assert.equal(restored.extractionMinUserCharacters, 128);
  assert.equal(captured.create.spec.context.rollout.memoryWrite, 'shadow');
});

test('form create(): local memory with shadow rollout never claims a write', async () => {
  const captured = {};
  const harness = formHarness({ onBack: () => {}, onCreated: () => {} }, { captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = switchToHarness(harness, tree); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);
  findBy(tree, byAria('启用跨会话记忆')).props.onChange({ target: { checked: true } });
  tree = harness.render();
  // keep default rollout = shadow
  tree = advance(harness, tree);
  await findBy(tree, byButtonText('创建 Agent')).props.onClick();
  assert.equal(captured.create.spec.context.rollout.memoryWrite, 'shadow');
  assert.equal(captured.create.spec.memory.write.mode, 'explicit_only');
});

const memoryInstanceBinding = (id = 'mem-1') => ({ ecosystem: 'dsh', pluginRef: 'p', components: ['c'], enabled: true,
  config: { schemaVersion: 1, binding: { id: 'platform-memory-instance', connectionRef: 'conn', resource: { kind: 'memory-instance', id, name: 'Mem', region: 'cn' }, required: true } } });

test('form edit save: disabling a cloud memory Agent preserves provider/scopes/recall/write/rollout and the binding', async () => {
  const initialAgent = { metadata: { id: 'a1', name: 'Agent', revision: 2 }, source: 'local', spec: {
    runtime: { type: 'harness' },
    bindings: { modelProfileId: 'model-1', plugins: [memoryInstanceBinding()] },
    memory: { enabled: true, providerRef: MEMORY_PROVIDER_CLOUD, scopes: ['user'],
      recall: { enabled: false, maxTokens: 2048, topK: 12, minScore: 0.5 },
      write: { mode: 'candidate', flushBeforeCompaction: false, flushAfterTurn: true } },
    context: { rollout: { memoryWrite: 'enabled' }, contributors: { memoryRecall: true } },
  } };
  const captured = {};
  const harness = formHarness({ initialAgent, onBack: () => {}, onCreated: () => {} }, { captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);   // -> step 2
  findBy(tree, byAria('启用跨会话记忆')).props.onChange({ target: { checked: false } });
  tree = harness.render();
  tree = advance(harness, tree);   // -> step 3
  await findBy(tree, byButtonText('保存 Agent')).props.onClick();
  const spec = captured.update.spec;
  assert.equal(spec.memory.enabled, false);
  assert.equal(spec.memory.providerRef, MEMORY_PROVIDER_CLOUD, 'disabling does not switch the cloud provider');
  assert.deepEqual(spec.memory.scopes, ['user'], 'scopes preserved');
  assert.equal(spec.memory.recall.enabled, false, 'recall preserved');
  assert.equal(spec.memory.recall.maxTokens, 2048);
  assert.equal(spec.memory.write.mode, 'candidate', 'write preserved');
  assert.equal(spec.context.rollout.memoryWrite, 'enabled', 'rollout preserved');
  assert.equal(spec.context.contributors.memoryRecall, true, 'other context contributors preserved');
  assert.ok((spec.bindings.plugins || []).some(b => b?.config?.binding?.resource?.kind === 'memory-instance'), 'cloud binding kept');
});

test('form edit save: an explicit scopes:[] survives a local memory edit', async () => {
  const initialAgent = { metadata: { id: 'a1', name: 'Agent', revision: 2 }, source: 'local', spec: {
    runtime: { type: 'harness' },
    bindings: { modelProfileId: 'model-1', plugins: [] },
    memory: { enabled: true, providerRef: MEMORY_PROVIDER_LOCAL, scopes: [],
      recall: { enabled: true, maxTokens: 500, topK: 4, minScore: 0.3 }, write: { mode: 'off' } },
    context: { rollout: { memoryWrite: 'shadow' } },
  } };
  const captured = {};
  const harness = formHarness({ initialAgent, onBack: () => {}, onCreated: () => {} }, { captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);   // -> step 2 (memory already enabled + local)
  tree = advance(harness, tree);   // -> step 3, no changes
  await findBy(tree, byButtonText('保存 Agent')).props.onClick();
  const spec = captured.update.spec;
  assert.deepEqual(spec.memory.scopes, [], 'empty scopes not widened to defaults');
  assert.equal(spec.memory.providerRef, MEMORY_PROVIDER_LOCAL);
  assert.equal(spec.memory.write.mode, 'off');
  assert.equal(spec.memory.recall.enabled, true);
  assert.equal(spec.memory.recall.maxTokens, 500);
  assert.equal(spec.context.rollout.memoryWrite, 'shadow');
});

// Real form -> template authoring service -> store roundtrip for a harness
// memory template seed using local-default memory without a cloud binding.
test('form seed roundtrip: a harness memory template seed supports local-default without a cloud binding through the real authoring service', async () => {
  const catalog = createExpertCatalog();
  const seed = catalog.prepare('personal-writer');   // memory template, requires memory-instance
  seed.spec.runtime.type = 'harness';
  seed.spec.bindings.modelProfileId = 'model-1';
  seed.spec.memory = { enabled: true, providerRef: MEMORY_PROVIDER_LOCAL, scopes: [],
    recall: { enabled: false, maxTokens: 500, topK: 4, minScore: 0.3 }, write: { mode: 'off', flushBeforeCompaction: true, flushAfterTurn: false } };
  seed.spec.context = { rollout: { memoryWrite: 'enabled' } };
  const captured = {};
  const store = { create: async value => { captured.store = value; return { metadata: { id: value.slug || 'seed-agent', name: value.name, revision: 1 }, spec: value.spec }; } };
  const service = createTemplateAuthoring({ catalog, store,
    resources: async () => ({ items: [{ resourceId: 'model-1' }] }),
    platformResources: async kind => ({ connectionRef: 'conn', pluginRef: 'p', componentId: kind, pluginSnapshotDigest: 's', items: [] }) });
  const hostRemote = {
    resources: kind => Promise.resolve(kind === 'model' ? { items: [{ resourceId: 'model-1', displayName: 'Model 1' }], defaultModel: 'model-1' } : { items: [] }),
    codexModels: () => Promise.resolve({ items: [{ resourceId: 'model-1' }], defaultModel: 'model-1' }),
    quickAuthorAgent: async payload => service.create({ templateSource: payload.templateSource, name: payload.name, runtimeType: payload.runtimeType, description: payload.description, spec: payload.spec, bindings: payload.spec?.bindings || {} }),
    updateAgent: async (id, spec, revision, name) => ({ metadata: { id, name, revision: (revision || 1) + 1 } }),
  };
  const harness = formHarness({ creationSeed: seed, onBack: () => {}, onCreated: () => {} }, { hostRemote, captured });
  let tree = harness.render(); await harness.flush(); tree = harness.render();
  tree = advance(harness, tree); tree = advance(harness, tree);   // -> step 2
  assert.ok(findBy(tree, byAria('记忆来源-本地记忆')), 'harness memory seed offers local source without a binding');
  tree = advance(harness, tree);   // -> step 3
  await findBy(tree, byButtonText('创建 Agent')).props.onClick();
  assert.ok(captured.store, 'template authoring service created the Agent');
  const spec = captured.store.spec;
  assert.equal(spec.memory.enabled, true);
  assert.equal(spec.memory.providerRef, MEMORY_PROVIDER_LOCAL, 'local-default preserved through the service');
  assert.deepEqual(spec.memory.scopes, [], 'empty scopes preserved through the service');
  assert.equal(spec.memory.write.mode, 'off', 'write.mode off preserved');
  assert.equal(spec.memory.recall.enabled, false, 'recall.enabled independent of memory.enabled');
  assert.equal(spec.context.rollout.memoryWrite, 'enabled', 'rollout preserved');
  assert.equal((spec.bindings.plugins || []).some(b => b?.config?.binding?.resource?.kind === 'memory-instance'), false, 'no cloud binding required');
});
