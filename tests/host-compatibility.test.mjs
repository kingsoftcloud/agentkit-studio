import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostCompatibility } from '../src/host/compatibility.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { createNativeAutomationRunner } from '../src/native-automation-runner.mjs';
import { createStudioRoutes } from '../src/host/routes/index.mjs';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';

function host(options = {}) {
  const unused = () => { throw new Error('Inspection must not invoke a Host operation'); };
  const services = {
    agentPresets: { register: unused, pluginsFor: unused },
    sessionController: { promptFingerprintVersion: 1, ...Object.fromEntries(['create', 'selectModel', 'resolveAgent', 'prompt', 'page', 'projections'].map(name => [name, unused])) },
    agents: { withoutInitiator: unused }, commands: { execute: unused }, approval: { setPolicy: unused },
  };
  return { services, compatibility: createHostCompatibility({ getService: name => services[name], requiredDsh: '0.2.0-rc.2', dshVersion: '0.2.0-rc.2', ...options }) };
}

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
  services.commands = undefined;
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
