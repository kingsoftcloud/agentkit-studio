import test from 'node:test';
import assert from 'node:assert/strict';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';

const RECORD = Object.freeze({
  metadata: { id: 'demo/reprobe', name: 'Reprobe Agent', revision: 7, local: true },
  spec: { runtime: { type: 'harness' }, bindings: { skills: ['skill:one'] } },
});

async function settle() {
  for (let index = 0; index < 12; index += 1) await new Promise(resolve => setImmediate(resolve));
}

function admissionFor(t, options = {}) {
  const registered = [];
  const unregistered = [];
  const admission = new DshPresetAdmission({
    getAgent: async () => RECORD,
    registry: {
      async register(preset) {
        registered.push(preset);
        return async () => { unregistered.push(preset.id); };
      },
    },
    ...options,
  });
  t.after(() => admission.dispose());
  return { admission, registered, unregistered };
}

const runtimeConfig = preset => preset.plugins.find(row => row.name.endsWith('/dsh-runtime-plugin')).config;

test('a degraded preset is reprobed after 30s and the placeholder is replaced on success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const info = t.mock.method(console, 'info');
  let probes = 0;
  const { admission, registered, unregistered } = admissionFor(t, {
    getSkillDefinitions: async () => {
      probes += 1;
      if (probes === 1) throw Object.assign(new Error('resource owner unavailable'), { code: 'DSH_RESOURCE_OWNER_UNAVAILABLE' });
      return [];
    },
  });
  const { presetId } = await admission.ensure(RECORD.metadata.id, { agent: RECORD, allowUnavailableResources: true });
  assert.equal(registered.length, 1);
  assert.equal(runtimeConfig(registered[0]).resourcesUnavailable, true);
  assert.equal(admission.reprobeTimers.size, 1);
  assert.equal(probes, 1);

  t.mock.timers.tick(30_000);
  await settle();

  assert.equal(probes, 2);
  assert.equal(registered.length, 2);
  assert.equal(runtimeConfig(registered[1]).resourcesUnavailable, undefined);
  assert.equal(admission.registrations.get(presetId).resourcesUnavailable, false);
  assert.equal(admission.reprobeTimers.size, 0);
  assert.deepEqual(unregistered, [presetId], 'the degraded placeholder is retired only after the strict probe succeeds');
  assert.equal(info.mock.calls.filter(call => String(call.arguments[0]).includes('recovered')).length, 1);
});

test('a later reprobe can recover after earlier failures are counted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const { admission, registered } = admissionFor(t, {
    getSkillDefinitions: async () => {
      probes += 1;
      if (probes <= 2) throw Object.assign(new Error('still unavailable'), { code: 'DSH_RESOURCE_OWNER_UNAVAILABLE' });
      return [];
    },
  });
  await admission.ensure(RECORD.metadata.id, { agent: RECORD, allowUnavailableResources: true });
  assert.equal(registered.length, 1);

  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(registered.length, 1);
  assert.equal(probes, 2);

  t.mock.timers.tick(90_000);
  await settle();
  assert.equal(probes, 3);
  assert.equal(registered.length, 2);
  assert.equal(runtimeConfig(registered[1]).resourcesUnavailable, undefined);
  assert.equal(admission.reprobeTimers.size, 0);
});

test('the 30s/2min/10min reprobe plan stops permanently after its last failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = t.mock.method(console, 'warn');
  let probes = 0;
  const { admission, registered } = admissionFor(t, {
    getSkillDefinitions: async () => {
      probes += 1;
      throw Object.assign(new Error('snapshot missing'), { code: 'DSH_RESOURCE_OWNER_UNAVAILABLE' });
    },
  });
  await admission.ensure(RECORD.metadata.id, { agent: RECORD, allowUnavailableResources: true });
  assert.equal(probes, 1);

  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(probes, 2);
  t.mock.timers.tick(90_000);
  await settle();
  assert.equal(probes, 3);
  t.mock.timers.tick(480_000);
  await settle();
  assert.equal(probes, 4);
  assert.equal(admission.reprobeTimers.size, 0);

  // Exhausted means exhausted: no fourth timer is armed, even much later.
  t.mock.timers.tick(3_600_000);
  await settle();
  assert.equal(probes, 4);
  assert.equal(registered.length, 1, 'the degraded preset stays registered between probes');
  assert.equal(warn.mock.calls.filter(call => String(call.arguments[0]).includes('reprobe failed')).length, 3);
});

test('reprobe timers honor the configured delays and dispose clears them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const { admission, registered } = admissionFor(t, {
    reprobeDelaysMs: [10, 20],
    getSkillDefinitions: async () => {
      probes += 1;
      throw new Error('resource probe failed');
    },
  });
  await admission.ensure(RECORD.metadata.id, { agent: RECORD, allowUnavailableResources: true });
  assert.equal(probes, 1);
  assert.equal(admission.reprobeTimers.size, 1);

  // No timer fires early.
  t.mock.timers.tick(9);
  await settle();
  assert.equal(probes, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(probes, 2);
  assert.equal(admission.reprobeTimers.size, 1);
  t.mock.timers.tick(9);
  await settle();
  assert.equal(probes, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(probes, 3);
  assert.equal(admission.reprobeTimers.size, 0);

  await admission.dispose();
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(probes, 3);
  assert.equal(registered.length, 1);
  assert.equal(admission.reprobeTimers.size, 0);
});

test('dispose before the first probe cancels the timer and unregisters the placeholder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const { admission, registered, unregistered } = admissionFor(t, {
    getSkillDefinitions: async () => {
      probes += 1;
      throw new Error('resource probe failed');
    },
  });
  await admission.ensure(RECORD.metadata.id, { agent: RECORD, allowUnavailableResources: true });
  assert.equal(admission.reprobeTimers.size, 1);
  await admission.dispose();
  assert.equal(admission.reprobeTimers.size, 0);
  t.mock.timers.tick(3_600_000);
  await settle();
  assert.equal(probes, 1);
  assert.equal(registered.length, 1);
  assert.equal(unregistered.length, 1);
});

test('strict admission neither degrades nor schedules a reprobe', async t => {
  const { admission, registered } = admissionFor(t, {
    strictResources: true,
    getSkillDefinitions: async () => { throw new Error('resource probe failed'); },
  });
  await admission.ensure(RECORD.metadata.id, { agent: RECORD, allowUnavailableResources: true });
  assert.equal(registered.length, 1);
  assert.equal(runtimeConfig(registered[0]).resourcesUnavailable, true);
  assert.equal(admission.reprobeTimers.size, 0);
});
