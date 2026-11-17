import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyDefaultBundles, DEFAULT_ENABLED_BUNDLES, defaultBundlesDisabled } from '../src/host/default-bundles.mjs';

const MARKET = '@deepseek-ai/dsh-experimental-plugin-market-bundle';
const CUA = '@deepseek-ai/dsh-cua-bundle';

function bundle(name, extra = {}) {
  return { name, enabled: false, availability: 'installation', installed: true, ...extra };
}

function fakeManager(bundles) {
  const calls = [];
  return {
    calls,
    async listBundles() { return bundles; },
    async setBundleEnabled(name, enabled) { calls.push(['setBundleEnabled', name, enabled]); return { application: 'applied' }; },
    async installBundle(spec, options) { calls.push(['installBundle', spec, options]); return { application: 'applied' }; },
  };
}

async function withStore(run) {
  const storeDir = await mkdtemp(join(tmpdir(), 'studio-default-bundles-'));
  try {
    return await run(storeDir);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

test('shipped defaults are switched on and on-demand ones are installed', async () => {
  await withStore(async storeDir => {
    const manager = fakeManager([
      bundle(MARKET),
      bundle(CUA, { availability: 'missing', installed: false, installTarget: { spec: `${CUA}@0.2.2-rc.1` } }),
    ]);
    const result = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1' });
    assert.equal(result.applied, true);
    assert.deepEqual(result.enabled, [MARKET, CUA]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(manager.calls, [
      ['setBundleEnabled', MARKET, true],
      ['installBundle', `${CUA}@0.2.2-rc.1`, { enabled: true, saveExact: true }],
    ]);
    const marker = JSON.parse(await readFile(join(storeDir, 'default-bundles.json'), 'utf8'));
    assert.equal(marker.appliedVersion, '0.2.2-rc.1');
    assert.deepEqual(marker.enabled, [MARKET, CUA]);
  });
});

test('an already enabled bundle is left alone', async () => {
  await withStore(async storeDir => {
    const manager = fakeManager([bundle(MARKET, { enabled: true }), bundle(CUA, { enabled: true })]);
    const result = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1' });
    assert.equal(result.applied, true);
    assert.deepEqual(result.enabled, []);
    assert.deepEqual(manager.calls, []);
  });
});

test('defaults apply once per DSH version', async () => {
  await withStore(async storeDir => {
    const manager = fakeManager([bundle(MARKET), bundle(CUA)]);
    await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1' });
    manager.calls.length = 0;
    const second = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1' });
    assert.equal(second.applied, false);
    assert.equal(second.reason, 'already-applied');
    assert.deepEqual(manager.calls, []);
    // A newer product version applies the defaults again.
    const next = await applyDefaultBundles({ manager, storeDir, version: '0.2.3-rc.1' });
    assert.equal(next.applied, true);
    assert.deepEqual(next.enabled, [MARKET, CUA]);
  });
});

test('a retryable failure leaves no marker so the next start tries again', async () => {
  await withStore(async storeDir => {
    const failing = {
      calls: [],
      async listBundles() { return [bundle(MARKET), bundle(CUA)]; },
      async setBundleEnabled() { throw new Error('pnpm offline'); },
    };
    const result = await applyDefaultBundles({ manager: failing, storeDir, version: '0.2.2-rc.1' });
    assert.equal(result.applied, true);
    assert.deepEqual(result.failed.map(entry => entry.name), [MARKET, CUA]);
    await assert.rejects(() => readFile(join(storeDir, 'default-bundles.json'), 'utf8'), /ENOENT/u);

    const manager = fakeManager([bundle(MARKET), bundle(CUA)]);
    const retry = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1' });
    assert.equal(retry.applied, true);
    assert.deepEqual(retry.enabled, [MARKET, CUA]);
  });
});

test('a bundle the installation does not carry is recorded without retrying', async () => {
  await withStore(async storeDir => {
    const manager = fakeManager([bundle(MARKET)]);
    const result = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1' });
    assert.deepEqual(result.failed, [{ name: CUA, reason: 'not-shipped' }]);
    const marker = JSON.parse(await readFile(join(storeDir, 'default-bundles.json'), 'utf8'));
    assert.deepEqual(marker.failed, [{ name: CUA, reason: 'not-shipped' }]);
  });
});

test('the environment opt-out and an unavailable Host skip alignment', async () => {
  assert.equal(defaultBundlesDisabled({ AGENTKIT_STUDIO_DEFAULT_BUNDLES: '0' }), true);
  assert.equal(defaultBundlesDisabled({ AGENTKIT_STUDIO_DEFAULT_BUNDLES: 'off' }), true);
  assert.equal(defaultBundlesDisabled({}), false);
  assert.equal(defaultBundlesDisabled({ AGENTKIT_STUDIO_DEFAULT_BUNDLES: '1' }), false);
  await withStore(async storeDir => {
    const manager = fakeManager([bundle(MARKET), bundle(CUA)]);
    const optedOut = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1', env: { AGENTKIT_STUDIO_DEFAULT_BUNDLES: '0' } });
    assert.equal(optedOut.reason, 'disabled-by-environment');
    assert.deepEqual(manager.calls, []);
    const noManager = await applyDefaultBundles({ manager: undefined, storeDir, version: '0.2.2-rc.1' });
    assert.equal(noManager.reason, 'plugin-manager-unavailable');
    const noVersion = await applyDefaultBundles({ manager, storeDir, version: '' });
    assert.equal(noVersion.reason, 'version-unavailable');
    const noStore = await applyDefaultBundles({ manager, storeDir: '', version: '0.2.2-rc.1' });
    assert.equal(noStore.reason, 'store-unavailable');
    assert.deepEqual(manager.calls, []);
  });
});

test('the default list keeps the market and Computer Use', () => {
  assert.deepEqual([...DEFAULT_ENABLED_BUNDLES], [MARKET, CUA]);
});

test('a profile that is still onboarding is left untouched and retried next start', async () => {
  await withStore(async storeDir => {
    const manager = fakeManager([
      bundle(MARKET),
      bundle(CUA, { availability: 'missing', installed: false, installTarget: { spec: `${CUA}@0.2.2-rc.1` } }),
    ]);
    const result = await applyDefaultBundles({ manager, storeDir, version: '0.2.2-rc.1', profileConfigured: async () => false });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'profile-not-configured');
    // No profile write, and no marker: the next start must try again.
    assert.deepEqual(manager.calls, []);
    await assert.rejects(readFile(join(storeDir, 'default-bundles.json'), 'utf8'), { code: 'ENOENT' });
  });
});
