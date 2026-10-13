import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { studioVersions } from '../src/studio-version.mjs';

test('Host reports packaged DSH client version, not plugin or available-update version', async () => {
  const { version: pluginVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(await studioVersions({ DSH_CLIENT_VERSION: '0.2.0-rc.2.20261013.16' }), {
    version: '0.2.0-rc.2.20261013.16', pluginVersion, dshVersion: '0.2.0-rc.2',
  });
  assert.equal((await studioVersions()).version, null);
});
