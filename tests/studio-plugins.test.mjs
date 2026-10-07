import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioPlugins, StudioPluginsError } from '../src/studio-plugins.mjs';

function adapter(manager) { return createStudioPlugins({ getService: name => name === 'pluginManager' ? manager : null }); }

test('DSH failed install result rejects instead of claiming installation succeeded', async () => {
  const plugins = adapter({
    listBundles: async () => [],
    inspect: async () => ({ status: 'accepted', kind: 'registry', bundle: true }),
    installBundle: async () => ({ application: 'failed', changed: false, stage: 'install', target: 'addon', error: { code: 'operation-failed', diagnostic: 'pnpm store mismatch' } }),
  });
  await assert.rejects(() => plugins.installDsh('addon'), error => error instanceof StudioPluginsError && error.details.application === 'failed' && error.message.includes('pnpm store mismatch'));
});

test('DSH shipped bundles activate without reinstalling and preserve loaded row state', async () => {
  const calls = [];
  const plugins = adapter({
    listBundles: async () => [{ name: 'optional-addon', installed: false, enabled: false, optional: true, removable: false, rows: [{ rowId: 'tool-addon', live: [{ status: 'active' }] }], overrides: [] }],
    inspect: async () => { throw new Error('must not inspect a shipped bundle'); },
    installBundle: async () => { throw new Error('must not reinstall a shipped bundle'); },
    setBundleEnabled: async (...args) => { calls.push(args); return { application: 'applied', changed: true }; },
  });
  const catalog = await plugins.listDsh();
  assert.equal(catalog.items[0].installed, true);
  assert.equal(catalog.items[0].source, 'bundled');
  assert.equal(catalog.items[0].removable, false);
  assert.equal(catalog.items[0].rows[0].rowId, 'tool-addon');
  assert.equal((await plugins.installDsh('optional-addon')).application, 'applied');
  assert.deepEqual(calls, [['optional-addon', true]]);
});

test('DSH refused inspection stops before package installation', async () => {
  let installs = 0;
  const plugins = adapter({ listBundles: async () => [], inspect: async () => ({ status: 'refused', problem: 'not-a-bundle', reason: 'package has no dsh.bundle' }), installBundle: async () => { installs += 1; } });
  await assert.rejects(() => plugins.installDsh('plain-package'), error => error.code === 'DSH_PLUGIN_INSPECTION_REFUSED' && error.message.includes('package has no dsh.bundle'));
  assert.equal(installs, 0);
});

test('DSH enable failure does not fall through and toggle an unrelated loader entry', async () => {
  let entryCalls = 0;
  const plugins = adapter({ listBundles: async () => [{ name: 'broken-addon', installed: true, enabled: false }], setBundleEnabled: async () => ({ application: 'failed', error: { code: 'incompatible-version' } }), setPluginEnabled: async () => { entryCalls += 1; } });
  await assert.rejects(() => plugins.setDshEnabled('broken-addon', true), error => error instanceof StudioPluginsError && error.details.error.code === 'incompatible-version');
  assert.equal(entryCalls, 0);
});

test('DSH catalog surfaces load errors and required bundles instead of enabled success', async () => {
  const plugins = adapter({ listBundles: async () => [{ name: 'broken', installed: true, enabled: true, removable: false, readOnlyReason: 'management-required', error: { code: 'invalid-patch' }, rows: [], overrides: [] }] });
  const item = (await plugins.listDsh()).items[0];
  assert.equal(item.error.code, 'invalid-patch');
  assert.equal(item.readOnlyReason, 'management-required');
  assert.equal(item.status, 'error');
});

test('DSH updates replace the dependency without removing the working bundle first', async () => {
  const calls = [];
  const plugins = adapter({
    listBundles: async () => [{ name: 'addon', installed: true, enabled: true }],
    installBundle: async (...args) => { calls.push(args); return { application: 'restart-required', changed: true }; },
    removeBundle: async () => { throw new Error('must not remove before upgrade'); },
  });
  assert.equal((await plugins.updateDsh('addon')).application, 'restart-required');
  assert.equal(calls[0][0], 'addon@latest');
  assert.equal(calls[0][1].enabled, true);
});

test('DSH cannot claim a fully loaded bundle when its UI is active but service is disabled', async () => {
  const plugins = adapter({
    listBundles: async () => [{ name: 'addon', installed: true, enabled: true, rows: [{ rowId: 'service', entryId: 'service:1' }, { rowId: 'ui', entryId: 'ui:1' }] }],
    listPlugins: async () => [{ entryId: 'service:1', enabled: false, fiberPhase: null }, { entryId: 'ui:1', enabled: true, fiberPhase: 'active' }],
  });
  assert.equal((await plugins.listDsh()).items[0].status, 'partial');
});
