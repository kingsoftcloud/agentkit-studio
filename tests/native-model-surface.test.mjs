import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeModelSurface } from '../src/providers/native-model-surface.mjs';
import { nativeChildModelSurface } from '../src/providers/native-child-surface.mjs';
import { bindNativeContext } from '../src/providers/native-context.mjs';
import { NATIVE_EXECUTION_CONTEXT_OWNERSHIP as policy, nativeHostInputRows, nativeHostInputIsRefresh } from '../src/providers/native-context-ownership.mjs';
import { nativeRecoveryBinding, readNativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { fixture, digest, scope } from './fixtures/native-core.mjs';
import { nativeLocalExecutionMethods } from '../src/providers/native-local-execution.mjs';
import { workspaceBrowserCapability } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace-policy';
const description = { protocol: 'openai-chat', modelName: 'test', parameters: {}, input: ['text', 'image'],
  contextWindow: 128000, maxOutputTokens: 8192 };
const environment = { workspaceRoot: '/execution/workspace', cwd: '/execution/workspace', platform: 'linux', commandBackend: 'local_process',
  commandCwd: '/execution/workspace', environmentNames: ['HOME', 'PATH'] };
const message = (id, kind) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text: `${kind} data` }] });

test('Studio removes stale ambient environment rows only under the admitted v2 ownership policy', () => {
  const messages = [message('old-cwd', 'runtime-context'), message('date', 'time-context'), message('skills', 'skill-catalog'),
    message('user', 'user'), message('custom', 'business-event')];
  const rows = nativeHostInputRows(messages, policy);
  assert.deepEqual(rows.map(row => row.sourceIndex), [3, 4]); assert.equal(nativeHostInputIsRefresh(rows, policy), false);
  assert.equal(nativeHostInputIsRefresh(nativeHostInputRows(messages.slice(0, 3), policy), policy), true);
  assert.equal(nativeHostInputRows(messages, 'agentkit.native-context-ownership/v1').length, 4);
  assert.equal(nativeHostInputRows(messages, undefined).length, 5);
});

test('Studio freezes actual execution facts, image capability and the summary protocol through configuration recovery', () => {
  const surface = bindNativeModelSurface({ description, environment });
  assert.equal(surface.verificationProjection,'readable-evidence/v1');
  const legacy={...surface};delete legacy.verificationProjection;
  assert.equal(Object.hasOwn(bindNativeModelSurface({description,environment,original:legacy}),'verificationProjection'),false);
  const bound = bindNativeContext({ description, structuredContinuityDefaults: true });
  assert.equal(bound.policy.summaryFormatPolicy, 'task-continuity/v1');
  assert.equal(bindNativeContext({ description }).policy.summaryFormatPolicy, undefined);
  const { config, snapshot } = fixture({ modelSurface: surface });
  assert.equal(JSON.parse(snapshot.messages.find(message => message.kind === 'runtime_environment').content).cwd, environment.cwd);
  const restored = bindNativeModelSurface({ description, environment, original: { ...surface,
    environment: { ...surface.environment, date: '2026-01-01' } } });
  assert.equal(restored.environment.date, '2026-01-01');
  const changed = bindNativeModelSurface({ description, environment: { ...environment, cwd: '/other' }, original: surface });
  assert.notEqual(digest(changed), digest(surface));
  assert.equal(config.modelSurface.environment.supportsImages, true);
  assert.throws(() => bindNativeModelSurface({ description, environment: { ...environment, secret: 'must-not-persist' } }), /invalid_model_environment/);
});

test('environment ownership is bound in the recovery capsule without changing legacy admission', () => {
  const input = { messages: [message('user', 'user')] };
  const capsule = nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 }, input,
    source: { provider: 'fixture', model: 'test' }, selection: {}, systemPrompt: 'original', inputContextPolicy: policy });
  const configuration = { hostRecoveryBinding: capsule };
  const snapshot = { scope, sessionId: 'session', runId: 'run', configDigest: digest(configuration) };
  const read = readNativeRecoveryBinding({ configuration, snapshot }, { agentId: scope.agentId, sessionId: 'session', runId: 'run' });
  assert.equal(read.inputContextPolicy, policy);
});

test('child context describes its isolated workspace and selected model without inheriting ungranted command capability', () => {
  const parent = bindNativeModelSurface({ description, environment });
  const child = nativeChildModelSurface(parent, { workspaceRoot: '/child/isolated', supportsImages: false,
    tools: [{ name: 'read_workspace_file' }] });
  assert.equal(child.environment.cwd, '/child/isolated'); assert.equal(child.environment.supportsImages, false);
  assert.equal(child.environment.commandBackend, 'none'); assert.equal(child.environment.commandCwd, undefined);
  assert.equal(child.environment.environmentNames, undefined); assert.equal(parent.environment.cwd, environment.cwd);
  assert.equal(nativeChildModelSurface(undefined, {}), undefined);
});

test('requested command resources are frozen runtime facts; a child without commands never advertises them', () => {
  const owner = nativeLocalExecutionMethods({ enabled: true, settings: { maxFileBytes: 789000 },
    sourceEnv: { PATH: '/usr/bin:/bin' }, workspaceRoot: '/workspace', commandBackend: 'local_process' });
  const environment = owner.executionEnvironment({ modern: true, resourceProfile: 'local-development/v1' });
  const parent = bindNativeModelSurface({ description, environment });
  const { config, snapshot } = fixture({ modelSurface: parent });
  const projected = JSON.parse(snapshot.messages.find(x => x.kind === 'runtime_environment').content);
  assert.equal(projected.commandResources.requestedLimits.maxFileBytes, 789000);
  assert.deepEqual(config.modelSurface.environment.commandResources, projected.commandResources);
  const child = nativeChildModelSurface(parent, { workspaceRoot: '/child', supportsImages: false, tools: [{ name: 'run_command' }] });
  assert.deepEqual(child.environment.commandResources, parent.environment.commandResources);
  const readOnly = nativeChildModelSurface(parent, { workspaceRoot: '/reader', supportsImages: false, tools: [{ name: 'read_workspace_file' }] });
  assert.equal(readOnly.environment.commandResources, undefined);
  for (const patch of [{ profile: 'unlimited' }, { requestedLimits: { maxFileBytes: 1 } },
    { requestedLimits: { ...projected.commandResources.requestedLimits, cpuSeconds: 0 } }, { extra: 'secret' }])
    assert.throws(() => bindNativeModelSurface({ description, environment: { ...environment,
      commandResources: { ...projected.commandResources, ...patch } } }), /invalid_model_command_resources/);
});

test('browser owner facts join the frozen capability directory only for granted tools and do not leak to a reader child', () => {
  const capability = workspaceBrowserCapability();
  const surface = bindNativeModelSurface({ description, environment, executionCapabilities: [capability] });
  const browser = { name: capability.toolName, description: 'Inspect the bound workspace', parameters: { type: 'object', properties: {} },
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 110000,
    contextRole: 'none', observationRole: 'browser', progressObservation: true, contextRetention: 'normal' };
  const { snapshot } = fixture({ modelSurface: surface, tools: [browser] });
  const directory = JSON.parse(snapshot.messages.find(message => message.kind === 'capability_directory').content);
  assert.deepEqual(directory.executionCapabilities, [capability]);
  assert.equal(directory.executionCapabilities[0].externalNetwork, false);
  const hidden = fixture({ modelSurface: surface }).snapshot;
  assert.deepEqual(JSON.parse(hidden.messages.find(message => message.kind === 'capability_directory').content).executionCapabilities, []);
  const child = nativeChildModelSurface(surface, { workspaceRoot: '/reader', supportsImages: false, tools: [{ name: 'read_workspace_file' }] });
  assert.deepEqual(child.executionCapabilities, []);
  const legacy = bindNativeModelSurface({ description, environment, original: { ...surface, executionCapabilities: undefined } });
  assert.equal(Object.hasOwn(legacy, 'executionCapabilities'), false);
  for (const change of [{ networkPolicy: 'internet' }, { externalNetwork: true }, { viewport: [1920, 1080] },
    { availability: 'certainly-running' }, { privateUrl: 'http://private/' }, { toolName: 'unbound' }])
    assert.throws(() => bindNativeModelSurface({ description, environment, executionCapabilities: [{ ...capability, ...change }] }),
      /invalid_execution_capabilities/);
  assert.throws(() => bindNativeModelSurface({ description, environment, executionCapabilities: [capability, capability] }), /invalid_execution_capabilities/);
});
