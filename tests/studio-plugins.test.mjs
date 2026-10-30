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

test('version gate failures surface the required runtime instead of a bare code', async () => {
  const plugins = adapter({
    listBundles: async () => [],
    inspect: async () => ({ status: 'accepted', name: '@kingsoftcloud/agentkit-studio' }),
    installBundle: async () => ({ application: 'failed', changed: false, stage: 'install', error: {
      code: 'incompatible-version',
      incompatible: [{ name: '@kingsoftcloud/agentkit-studio', version: '0.0.5', runtimeVersion: '0.2.0-rc.2', requirements: { 'engines.dsh': '0.2.1-rc.2' } }],
    } }),
  });
  await assert.rejects(() => plugins.installDsh('@kingsoftcloud/agentkit-studio@0.0.5'), error =>
    error.code === 'DSH_PLUGIN_OPERATION_FAILED'
    && error.message.includes('不兼容')
    && error.message.includes('0.0.5')
    && error.message.includes('engines.dsh=0.2.1-rc.2')
    && error.message.includes('0.2.0-rc.2')
    && error.message.includes('更新'));
});

test('DSH shipped bundles activate without reinstalling and preserve loaded row state', async () => {
  const calls = [];
  const plugins = adapter({
    listBundles: async () => [{ name: 'optional-addon', installed: false, availability: 'installation', enabled: false, optional: true, removable: false, rows: [{ rowId: 'tool-addon', fiberPhase: 'active' }], overrides: [] }],
    inspect: async () => { throw new Error('must not inspect a shipped bundle'); },
    installBundle: async () => { throw new Error('must not reinstall a shipped bundle'); },
    setBundleEnabled: async (...args) => { calls.push(args); return { application: 'applied', changed: true }; },
  });
  const catalog = await plugins.listDsh();
  const item = catalog.items.find(row => row.pluginId === 'optional-addon');
  assert.ok(item);
  assert.equal(item.installed, true);
  assert.equal(item.source, 'bundled');
  assert.equal(item.removable, false);
  assert.equal(item.rows[0].rowId, 'tool-addon');
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
  const plugins = adapter({ listBundles: async () => [{ name: 'broken-addon', installed: true, availability: 'profile', enabled: false }], setBundleEnabled: async () => ({ application: 'failed', error: { code: 'incompatible-version' } }), setPluginEnabled: async () => { entryCalls += 1; } });
  await assert.rejects(() => plugins.setDshEnabled('broken-addon', true), error => error instanceof StudioPluginsError && error.details.error.code === 'incompatible-version');
  assert.equal(entryCalls, 0);
});

test('DSH catalog surfaces load errors and required bundles instead of enabled success', async () => {
  const plugins = adapter({ listBundles: async () => [{ name: 'broken', installed: true, availability: 'profile', enabled: true, removable: false, readOnlyReason: 'management-required', error: { code: 'invalid-patch' }, rows: [], overrides: [] }] });
  const item = (await plugins.listDsh()).items.find(row => row.pluginId === 'broken');
  assert.ok(item);
  assert.equal(item.error.code, 'invalid-patch');
  assert.equal(item.readOnlyReason, 'management-required');
  assert.equal(item.status, 'error');
});

test('DSH updates replace the dependency without removing the working bundle first', async () => {
  const calls = [];
  const plugins = adapter({
    listBundles: async () => [{ name: 'addon', installed: true, availability: 'profile', enabled: true }],
    installBundle: async (...args) => { calls.push(args); return { application: 'restart-required', changed: true }; },
    removeBundle: async () => { throw new Error('must not remove before upgrade'); },
  });
  assert.equal((await plugins.updateDsh('addon')).application, 'restart-required');
  assert.equal(calls[0][0], 'addon@latest');
  assert.equal(calls[0][1].enabled, true);
});

test('DSH cannot claim a fully loaded bundle when its UI is active but service is disabled', async () => {
  const plugins = adapter({
    listBundles: async () => [{ name: 'addon', installed: true, availability: 'profile', enabled: true, rows: [{ rowId: 'service', entryId: 'service:1' }, { rowId: 'ui', entryId: 'ui:1' }] }],
    listPlugins: async () => [{ entryId: 'service:1', enabled: false, fiberPhase: null }, { entryId: 'ui:1', enabled: true, fiberPhase: 'active' }],
  });
  assert.equal((await plugins.listDsh()).items.find(row => row.pluginId === 'addon')?.status, 'partial');
});

test('curated Agent Teams install is accepted only after rows and Host service pass', async () => {
  const calls = [];
  let enabled = false;
  const manager = {
    listBundles: async () => [{ name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, enabled, optional: true, rows: [
      { rowId: 'agent-team', fiberPhase: 'active' },
      { rowId: 'tool-agent-team', fiberPhase: 'active' },
      { rowId: 'ui-agent-team', fiberPhase: 'active' },
    ] }],
    listPlugins: async () => [],
    setBundleEnabled: async (...args) => { calls.push(args); enabled = args[1]; return { application: 'applied', changed: true }; },
  };
  const plugins = createStudioPlugins({
    getService: name => name === 'pluginManager' ? manager : name === 'agentTeams' ? {
      listMembers() {}, spawnTeammate() {}, createTask() {},
    } : null,
  });
  const result = await plugins.installDsh('@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.equal(result.verification.state, 'ready');
  assert.match(result.note, /Host 已加载 Agent Teams/);
  assert.deepEqual(calls, [['@deepseek-ai/dsh-experimental-agent-team-profile', true]]);
});

test('current host built-in scheduling is not advertised as an obsolete optional bundle', async () => {
  const plugins = adapter({ listBundles: async () => [], listPlugins: async () => [] });
  assert.equal((await plugins.listDsh()).items.some(item => item.pluginId.includes('schedule-bundle')), false);
});

test('official on-demand entries are missing until the exact host install target is installed', async () => {
  const name = '@deepseek-ai/dsh-experimental-agent-team-profile';
  const calls = []; let installed = false;
  const manager = {
    listBundles: async () => [{ name, official: true, installed, availability: installed ? 'profile' : 'missing', enabled: installed,
      installTarget: { spec: name + '@0.2.1-rc.2', version: '0.2.1-rc.2' }, rows: installed ? ['agent-team', 'tool-agent-team', 'ui-agent-team'].map(rowId => ({ rowId, fiberPhase: 'active' })) : [] }],
    listPlugins: async () => [],
    installBundle: async (...args) => { calls.push(args); installed = true; return { application: 'applied', changed: true }; },
    setBundleEnabled: async () => assert.fail('an absent on-demand package must be installed before enabling'),
  };
  const plugins = createStudioPlugins({ getService: key => key === 'pluginManager' ? manager : key === 'agentTeams' ? { listMembers() {}, spawnTeammate() {}, createTask() {} } : null });
  const entry = (await plugins.listDsh()).items.find(item => item.pluginId === name);
  assert.equal(entry.installed, false); assert.equal(entry.source, 'catalog'); assert.equal(entry.status, 'available');
  assert.equal(entry.readOnlyReason, '');
  assert.equal((await plugins.installDsh(name)).verification.state, 'ready');
  assert.deepEqual(calls, [[name + '@0.2.1-rc.2', { enabled: true, saveExact: true }]]);
});

test('DSH discovery decorates ecosystem rows with local install state and never reinstalls', async () => {
  const calls = [];
  const manager = {
    listBundles: async () => [{ name: 'dsh-pet', installed: true, availability: 'installation', enabled: false, version: '0.3.0' }],
    installBundle: async (...args) => { calls.push(['install', ...args]); }
  };
  const discovery = {
    discover: async options => {
      calls.push(['discover', options]);
      return {
        items: [
          { id: 'dsh-pet', packageName: 'dsh-pet', displayName: 'dsh-pet', installSpec: 'dsh-pet', featured: true },
          { id: 'dsh-mnemon', packageName: 'dsh-mnemon', displayName: 'dsh-mnemon', installSpec: 'dsh-mnemon' },
          { id: 'github:acme/dsh-tool', packageName: '', repo: 'acme/dsh-tool', displayName: 'acme/dsh-tool', installSpec: 'github:acme/dsh-tool' }
        ],
        info: { npmTotal: 10522, curated: 26 }
      };
    }
  };
  const plugins = createStudioPlugins({ getService: name => name === 'pluginManager' ? manager : null, discovery });
  const result = await plugins.discoverDsh({ force: true });
  assert.equal(result.source, 'discovery');
  assert.deepEqual(calls, [['discover', { force: true }]]);
  const pet = result.items.find(item => item.packageName === 'dsh-pet');
  assert.equal(pet.installed, true);
  assert.equal(pet.enabled, false);
  assert.equal(pet.installedVersion, '0.3.0');
  const mnemon = result.items.find(item => item.packageName === 'dsh-mnemon');
  assert.equal(mnemon.installed, false);
  assert.equal(mnemon.installedVersion, '');
  assert.equal(result.items.find(item => item.id === 'github:acme/dsh-tool').installed, false);
});
