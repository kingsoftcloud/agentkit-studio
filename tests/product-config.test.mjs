import test from 'node:test';
import assert from 'node:assert/strict';
import product from '../src/product.json' with { type: 'json' };
import { resolveProductInputs } from '../scripts/product-config.mjs';
import { relocateReleaseSettings } from '../scripts/package-desktop.mjs';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('one product definition supplies every desktop target and existing version sources', () => {
  for (const target of ['mac-arm64', 'mac-x64', 'win-x64']) {
    const inputs = resolveProductInputs({ target, dshVersion: '0.2.0-rc.2', buildVersion: '0.2.0-rc.2.20261015.2' });
    assert.equal(inputs.desktopVersion, '0.2.0-rc.2.20261015.2');
    assert.equal(inputs.settings.DSH_DESKTOP_APP_ID, product.desktop.appId);
    assert.equal(inputs.environment.DSH_CLIENT_TITLE, product.brand.name);
    assert.equal(inputs.environment.DSH_DESKTOP_PLUGIN_BUNDLES, product.desktop.defaultBundles.join(','));
    assert.ok(inputs.environment.DSH_DESKTOP_PRODUCT_ICON.endsWith(product.desktop.platforms[target].icon));
    assert.equal(resolveProductInputs({ dshVersion: '0.2.0-rc.2' }).desktopVersion, '0.2.0-rc.2');
  }
});

test('explicit release feed inputs preserve origin and lane through platform settings', () => {
  const inputs = resolveProductInputs({ target: 'win-x64', updateOrigin: 'https://releases.example.org', updateChannel: 'stable' });
  const settings = parseEnv(relocateReleaseSettings("CSC_LINK='./private.p12'\nCSC_KEY_PASSWORD='fixture $value # exact'\nDSH_DESKTOP_APP_ID=com.other.app\n", tmpdir(), inputs.settings));
  assert.equal(settings.DSH_DESKTOP_APP_ID, product.desktop.appId);
  assert.equal(settings.DSH_DESKTOP_UPDATE_ORIGIN, 'https://releases.example.org');
  assert.equal(settings.DSH_DESKTOP_UPDATE_CHANNEL, 'stable');
  assert.equal(settings.CSC_LINK, join(tmpdir(), 'private.p12'));
  assert.equal(settings.CSC_KEY_PASSWORD, 'fixture $value # exact');
  assert.ok(!JSON.stringify(inputs).includes('fixture $value'));
});

test('invalid feed or version inputs fail before packaging', () => {
  const credentialUrl = new URL('https://releases.example.org'); credentialUrl.username = 'fixture'; credentialUrl.password = 'fixture';
  for (const updateOrigin of ['http://releases.example.org', credentialUrl.href, 'https://releases.example.org/?token=fixture']) assert.throws(() => resolveProductInputs({ updateOrigin }), /invalid public/);
  for (const values of [{ target: '__proto__' }, { updateChannel: 'nightly' }, { buildVersion: 'invalid' }, { pluginVersion: '9.0.0' }]) assert.throws(() => resolveProductInputs(values), /invalid public/);
});

test('product assets stay inside the source and bundle defaults remain unambiguous', () => {
  for (const change of [
    p => { p.desktop.platforms['win-x64'].icon = '../outside.png'; },
    p => { p.desktop.platforms['win-x64'].trayIcon = 'C:\\outside.ico'; },
    p => { p.desktop.defaultBundles.push(p.desktop.defaultBundles[0]); },
    p => { p.brand.name = 'Product\nInjected=true'; },
  ]) {
    const configuration = structuredClone(product); change(configuration);
    assert.throws(() => resolveProductInputs({ configuration }), /invalid public/);
  }
});
