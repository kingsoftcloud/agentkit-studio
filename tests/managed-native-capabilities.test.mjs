import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { loadManagedRuntimeDefinition } from '../src/managed-runtime-definition.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { nativeLocalToolContract } from '../src/native-tool-catalog.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { NativeKernel, MemoryRunStore, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { nativeDshBatchPeer } from './fixtures/native-dsh-batch-peer.mjs';

async function definition(t, framework, extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'managed-native-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'agentengine.yaml');
  const raw = stringify({ name: 'managed-capabilities', framework, artifact_type: 'ManagedRuntime',
    runtime: { name: framework, version: 'fixture.1' }, model: 'fixture-model', prompt: 'Complete the task.' });
  await writeFile(manifest, raw);
  return loadManagedRuntimeDefinition({ manifest, env: {
    AGENTENGINE_AGENT_ID: 'ar-managed-capabilities', AGENTENGINE_AGENT_VERSION_ID: 'v1',
    AGENTENGINE_MANAGED_RUNTIME_NAME: framework, AGENTENGINE_MANAGED_RUNTIME_VERSION: 'fixture.1',
    AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1',
    AGENTENGINE_MANIFEST_SHA256: createHash('sha256').update(raw).digest('hex'),
    OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1', AGENTKIT_MODEL_API_KEY: 'fixture-only',
    ...extraEnv,
  } });
}

test('managed Harness admits usable workspace and command tools into its real preset composition', async t => {
  const runtime = await definition(t, 'harness');
  let preset;
  const admission = new DshPresetAdmission({ getAgent: async () => runtime.agent,
    getToolContracts: async agent => (agent.spec.bindings.tools ?? []).map(ref => {
      const contract = nativeLocalToolContract(ref.resourceId);
      assert.ok(contract, `managed binding must have a concrete builtin: ${ref.resourceId}`);
      return contract;
    }), registry: { register: async value => { preset = value; return () => {}; } } });
  t.after(() => admission.dispose());
  await admission.ensure(runtime.identity.agentId);
  const plugin = preset.plugins.find(item => item.id === 'studio-runtime');
  assert.equal(plugin.config.nativeEngineContract, 'agentkit.native-dsh-turn/v1');
  for (const name of ['read_workspace_file', 'write_workspace_file', 'run_command', 'read_command_output']) {
    assert.ok(plugin.config.toolBindings?.includes(name), `cloud Harness must receive ${name}`);
    assert.ok(plugin.config.toolContracts?.some(item => item.name === name && item.executor === 'builtin'));
  }
  assert.ok(!plugin.config.toolBindings.includes('web_search'), 'unconfigured search is not advertised');
  assert.ok(!plugin.config.toolBindings.includes('skill_install'), 'defaults do not grant installation');
  assert.deepEqual(runtime.agent.bindings, runtime.agent.spec.bindings);
});

test('a managed Harness declaration can select its independent service without changing platform identity', async t => {
  const remote = { AGENTKIT_ENGINE_SERVICE_URL: 'https://harness-service.agent-fixture.svc:8787',
    AGENTKIT_ENGINE_SERVICE_TOKEN: 'fixture-service-credential', AGENTKIT_ENGINE_SERVICE_WORKSPACE: '/data/workspace' };
  const runtime = await definition(t, 'harness', remote);
  assert.equal(runtime.identity.runtimeName, 'harness');
  assert.equal(runtime.agent.spec.runtime.type, 'native-engine');
  assert.equal(runtime.agent.spec.bindings.tools, undefined, 'independent engine owns the workspace tools');
  let preset;
  const admission = new DshPresetAdmission({ getAgent: async () => runtime.agent,
    registry: { register: async value => { preset = value; return () => {}; } } });
  t.after(() => admission.dispose());
  await admission.ensure(runtime.identity.agentId);
  const plugin = preset.plugins.find(item => item.id === 'studio-runtime');
  assert.equal(plugin.config.runtime, 'native-engine');
  assert.equal(plugin.config.nativeEngineContract, undefined);
  await assert.rejects(definition(t, 'harness', { ...remote, AGENTKIT_ENGINE_SERVICE_TOKEN: '' }),
    { code: 'MANAGED_HARNESS_SERVICE_BINDING_INVALID' });
});

test('managed defaults never replace an explicitly selected remote command backend with local execution', async t => {
  const runtime = await definition(t, 'harness', { KSADK_SANDBOX_BACKEND: 'e2b' });
  const names = runtime.agent.spec.bindings.tools.map(ref => ref.resourceId);
  assert.ok(names.includes('read_workspace_file'));
  assert.ok(!names.includes('run_command'));
});

for (const framework of ['dsh-native', 'codex']) {
  test(`managed ${framework} retains its existing capability owner`, async t => {
    const runtime = await definition(t, framework);
    assert.equal(runtime.agent.spec.bindings.tools, undefined);
  });
}

test('managed defaults reach the Native kernel and write, execute, then read an actual workspace file', async t => {
  // Controlled model and registry; filesystem, Python process and Native kernel are real.
  const runtime = await definition(t, 'harness');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-native-tools-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
  const registry = new Map(), called = [];
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    tools: nativeDshBatchPeer({ resultRetentions: ['caller/v1'], register(tool) {
      registry.set(tool.name, tool); return () => registry.delete(tool.name);
    }, async execute(input) {
      called.push(input.name);
      const tool = registry.get(input.name), value = await tool.execute(input.arguments, input);
      return { isError: false, value, content: tool.output.render(input.arguments, value) };
    } }) };
  const toolBindings = runtime.agent.spec.bindings.tools.map(ref => ref.resourceId);
  const gateway = createNativeDshTools({ ctx, config: { agentId: runtime.identity.agentId, toolBindings,
    toolContracts: toolBindings.map(nativeLocalToolContract) }, workspaceRoot, stateDir: join(root, 'state') });
  t.after(() => gateway.close());
  const agent = { session: { id: 'session' } };
  const store = new MemoryRunStore(), localScope = { ...scope, tenantId: 'local', userId: 'local-user', agentId: runtime.identity.agentId };
  const data = fixture({ tools: gateway.definitions(agent, [...registry.values()]), limits: { effectTimeoutMs: 1000000 } });
  data.snapshot.scope = localScope;
  const content = 'import json\nfrom pathlib import Path\nnums = range(1, 101)\ndata = {"count": len(nums), "sum": sum(nums), "sum_of_squares": sum(n*n for n in nums)}\nassert data == {"count": 100, "sum": 5050, "sum_of_squares": 338350}\nPath(__file__).with_name("report.json").write_text(json.dumps(data) + "\\n", encoding="utf-8")\nprint("verified")\n';
  const calls = [
    { name: 'write_workspace_file', arguments: { path: 'native-smoke/verify.py', content } },
    { name: 'run_command', arguments: { command: 'python3 native-smoke/verify.py' } },
    { name: 'read_workspace_file', arguments: { path: 'native-smoke/report.json' } },
  ];
  let step = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'managed-native-proof', ports: {
    ...gateway.forAgent(agent, { scope: localScope, store }), model: { async generate() {
      const call = calls[step++];
      return call ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `call-${step}`, ...call }] }
        : { kind: 'final_candidate', text: 'Verified', usage: emptyUsage(), toolCalls: [] };
    } } } });
  kernel.start(data.snapshot, data.config);
  const ended = await kernel.runUntilIdle(localScope, 'run');
  assert.equal(ended.phase, 'completed', JSON.stringify(store.load(localScope, 'run').receipts));
  assert.deepEqual(called, calls.map(call => call.name));
  const raw = await readFile(join(workspaceRoot, 'native-smoke/report.json'));
  assert.deepEqual(JSON.parse(raw), { count: 100, sum: 5050, sum_of_squares: 338350 });
  assert.equal(raw.at(-1), 10);
  assert.notEqual(raw.at(-2), 10);
});
