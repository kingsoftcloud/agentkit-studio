import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostModuleAnchor, importHostModule, createHostCompatibility, loadHostCompatibility } from '../src/host/compatibility.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { createNativeAutomationRunner } from '../src/native-automation-runner.mjs';
import { createStudioRoutes } from '../src/host/routes/index.mjs';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';
import { bindFrozenRuntime } from '../src/host/frozen-runtime-lifecycle.mjs';

function host(options = {}) {
  const unused = () => { throw new Error('Inspection must not invoke a Host operation'); };
  const services = {
    agentPresets: { register: unused, pluginsFor: unused },
    sessionController: { promptFingerprintVersion: 1, ...Object.fromEntries(['create', 'selectModel', 'resolveAgent', 'prompt', 'page', 'projections'].map(name => [name, unused])) },
    agents: { withoutInitiator: unused }, commands: { execute: unused }, permissionPresets: { set: unused }, approval: { setPolicy: unused },
  };
  return { services, compatibility: createHostCompatibility({ getService: name => services[name], requiredDsh: '0.2.0-rc.2', dshVersion: '0.2.0-rc.2', requestIsAgentLoop: () => true, ...options }) };
}

test('the running Host must supply its public request-origin marker before native execution', () => {
  const { compatibility } = host({ requestIsAgentLoop: undefined });
  for (const feature of ['agent-presets', 'automation', 'frozen-runtime']) {
    assert.equal(compatibility.inspect().features[feature].available, false);
    assert.ok(compatibility.inspect().features[feature].missingCapabilities.includes('agent-loop-origin'));
    assert.throws(() => compatibility.require(feature), { code: 'STUDIO_HOST_INCOMPATIBLE' });
  }
});

test('request origin is decided by the Host helper, not serialized request fields', () => {
  const owned = new WeakSet();
  const request = Object.freeze({ sessionId: 'same-session' }); owned.add(request);
  const { compatibility } = host({ requestIsAgentLoop: value => owned.has(value) });
  assert.equal(compatibility.isAgentLoopRequest(request), true);
  assert.equal(compatibility.isAgentLoopRequest({ ...request, isAgentLoopRequest: true }), false);
});

test('same-version Host missing patched API disables only its dependent features', () => {
  const { services, compatibility } = host();
  delete services.sessionController.promptFingerprintVersion;
  const report = compatibility.inspect();
  assert.equal(report.baseline.compatible, true);
  assert.equal(report.contract.actual, 1);
  assert.equal(report.features['agent-presets'].available, true);
  assert.equal(report.features.automation.available, true);
  assert.deepEqual(report.features['frozen-runtime'].missingCapabilities, ['request-fingerprint']);
  assert.throws(() => compatibility.require('frozen-runtime'), { code: 'STUDIO_HOST_INCOMPATIBLE', status: 503 });
});

test('missing, different baseline or unsupported integration contract cannot authorize execution', () => {
  for (const options of [{ dshVersion: undefined }, { dshVersion: '0.2.1' }, { requiredContractVersion: 2 }, { requiredContractVersion: null }]) {
    const { compatibility } = host(options);
    for (const feature of ['agent-presets', 'automation', 'frozen-runtime']) {
      assert.throws(() => compatibility.require(feature), { code: 'STUDIO_HOST_INCOMPATIBLE' });
    }
  }
});

test('service removal and replacement are observed without caching across Host scopes', () => {
  const first = host(), second = host();
  const registry = first.services.agentPresets;
  first.services.agentPresets = undefined;
  assert.throws(() => first.compatibility.require('agent-presets'), { code: 'STUDIO_HOST_INCOMPATIBLE' });
  assert.doesNotThrow(() => second.compatibility.require('frozen-runtime'));
  first.services.agentPresets = { ...registry, pluginsFor: undefined };
  assert.equal(first.compatibility.inspect().features['agent-presets'].available, false);
  first.services.agentPresets = registry;
  assert.doesNotThrow(() => first.compatibility.require('frozen-runtime'));
});

test('a version marker does not authorize an absent prompt implementation', () => {
  const { services, compatibility } = host();
  services.sessionController.prompt = undefined;
  assert.deepEqual(compatibility.inspect().features['frozen-runtime'].missingCapabilities, ['session-controller', 'request-fingerprint']);
});

test('incompatible admission rejects before model lookup or preset registration', async () => {
  const { services, compatibility } = host({ dshVersion: '0.2.1' });
  const admission = new DshPresetAdmission({ registry: services.agentPresets,
    assertHostCompatible: () => compatibility.require('agent-presets'),
    getAgent: () => { throw new Error('No catalog lookup on incompatible admission'); } });
  await assert.rejects(admission.ensure('test-agent'), { code: 'STUDIO_HOST_INCOMPATIBLE' });
  const local = { metadata: { id: 'test-agent', local: true } };
  const route = createAgentRoutes({ agentStorePromise: Promise.resolve({ get: async () => local }), getAdmission: () => admission });
  const result = await route('agents/ensure-preset', { agentId: 'test-agent' });
  assert.equal(result.error.code, 'STUDIO_HOST_INCOMPATIBLE');
  assert.equal(result.error.details.status, 503);
});

test('incompatible automation rejects before Session, permission or model operations', async () => {
  const { services, compatibility } = host();
  services.permissionPresets = undefined;
  const run = createNativeAutomationRunner({ getService: name => services[name], assertHostCompatible: () => compatibility.require('automation') });
  await assert.rejects(run({ sessionId: 'test-session' }), { code: 'STUDIO_HOST_INCOMPATIBLE' });
});

test('compatibility diagnostic remains available when the optional server cannot initialize', async () => {
  const { compatibility } = host({ dshVersion: undefined });
  const serverClientPromise = Promise.reject(new Error('optional server unavailable'));
  serverClientPromise.catch(() => {});
  const routes = createStudioRoutes({ get: () => undefined }, { hostCompatibility: compatibility });
  const dispatch = createControlPlaneDispatcher({ bridge: { signal: new AbortController().signal }, serverClientPromise, routes });
  const result = await dispatch('host/compatibility', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.baseline.actual, null);
  assert.equal(result.value.features.automation.available, false);
});

test('unattended execution requires the public preset setter instead of issuing a user command', () => {
  const { services, compatibility } = host();
  delete services.permissionPresets;
  assert.equal(compatibility.inspect().features['agent-presets'].available, true);
  assert.throws(() => compatibility.require('automation'), { code: 'STUDIO_HOST_INCOMPATIBLE' });
});

test('frozen runtime lifecycle tracks the same permission service required by compatibility', () => {
  let dependencies;
  bindFrozenRuntime({ inject: names => { dependencies = names; } }, {});
  assert.ok(dependencies.includes('permissionPresets'));
  assert.ok(!dependencies.includes('commands'), 'runtime startup must not depend on slash-command dispatch');
  const { services, compatibility } = host();
  delete services.commands;
  assert.doesNotThrow(() => compatibility.require('frozen-runtime'));
});

/** A disposable installed Host whose public modules are the only copies. */
async function installedHost(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-host-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'host', 'lib', 'index.js');
  await mkdir(join(root, 'host', 'lib'), { recursive: true });
  await writeFile(entry, 'export {};\n');
  const modules = {
    'dsh-app-boot': 'export function getDshRuntimeVersion() { return "0.2.2-rc.1"; }\n',
    'dsh-llm': 'const owned = new WeakSet();\nexport const isAgentLoopRequest = value => owned.has(value);\nexport const own = value => { owned.add(value); return value; };\n',
  };
  for (const [name, source] of Object.entries(modules)) {
    const directory = join(root, 'host', 'node_modules', '@deepseek-ai', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.2-rc.1', type: 'module', main: 'index.js' }));
    await writeFile(join(directory, 'index.js'), source);
  }
  return { root, entry };
}

test('the Host anchor is the running entry, not the first Electron argument', async t => {
  const { entry } = await installedHost(t);
  // Electron puts the app binary first and its own flags before the entry.
  assert.equal(hostModuleAnchor({ argv: ['/Applications/AgentKit Studio', '--expose-internals', entry], env: {} }), entry);
  assert.equal(hostModuleAnchor({ argv: ['/usr/bin/node', '/tmp/unrelated.mjs'], env: { AGENTKIT_DSH_HOST_ENTRY: entry } }), entry);
  assert.equal(hostModuleAnchor({ argv: ['/usr/bin/node', '--expose-internals'], env: {} }), undefined);
});

test('public Host modules come from the running Host module graph', async t => {
  const { entry } = await installedHost(t);
  const boot = await importHostModule('@deepseek-ai/dsh-app-boot', entry);
  assert.equal(boot.getDshRuntimeVersion(), '0.2.2-rc.1');
  // Identity, not just resolution: the Host's own marker must accept a request
  // the Host created, which a second copy of the module would reject.
  const llm = await importHostModule('@deepseek-ai/dsh-llm', entry);
  assert.equal(llm.isAgentLoopRequest(llm.own({})), true);
  assert.equal(llm.isAgentLoopRequest({}), false);
});

test('compatibility reads the running Host version through the anchor', async t => {
  const { entry } = await installedHost(t);
  const compatibility = await loadHostCompatibility({ get: () => undefined }, { anchor: entry });
  const report = compatibility.inspect();
  assert.equal(report.baseline.actual, '0.2.2-rc.1');
  assert.equal(report.baseline.compatible, true);
  assert.equal(report.capabilities['agent-loop-origin'], 1);
});

test('a Studio checkout without the Host packages still loads and reports the baseline', async () => {
  const compatibility = await loadHostCompatibility({ get: () => undefined }, { anchor: undefined });
  const report = compatibility.inspect();
  // Whatever this checkout can resolve, the diagnostic must not throw.
  assert.equal(report.contract.compatible, true);
  assert.ok(['string', 'object'].includes(typeof report.baseline.actual));
});
