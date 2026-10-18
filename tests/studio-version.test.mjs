import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { studioVersions } from '../src/studio-version.mjs';

test('Host reports the actual Electron App version while DSH client metadata stays on its baseline', async () => {
  const { version: pluginVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(await studioVersions({ DSH_CLIENT_VERSION: '0.2.1-rc.2', AGENTKIT_STUDIO_DESKTOP_VERSION: '0.2.0-rc.2.20261013.16' }), {
    version: '0.2.0-rc.2.20261013.16', pluginVersion, dshVersion: '0.2.1-rc.2',
  });
  assert.equal((await studioVersions()).version, null);
  assert.equal((await studioVersions({ DSH_CLIENT_VERSION: '0.2.1-rc.2' })).version, null);
});
