/** Guards the bundled community index the official plugin market reads.
 *
 * DSH's reader rejects a whole document on the first violation, so a broken
 * asset would leave the market empty with no obvious cause. These checks mirror
 * the parts of `format: 1` that Studio's own generator can get wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import semver from 'semver';

const INDEX_FILE = new URL('../assets/plugin-market/index.json', import.meta.url);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

const document = JSON.parse(await readFile(INDEX_FILE, 'utf8'));

test('the bundled index is a non-empty format 1 document', () => {
  assert.equal(document.format, 1);
  assert.ok(document.title && typeof document.title === 'object' && document.title.en, 'title requires en');
  assert.ok(Array.isArray(document.plugins) && document.plugins.length > 0, 'plugins must be non-empty');
});

test('every bundled plugin names a unique npm package with versions', () => {
  const seen = new Set();
  for (const plugin of document.plugins) {
    assert.match(plugin.name, PACKAGE_NAME, `invalid package name: ${plugin.name}`);
    assert.equal(seen.has(plugin.name), false, `duplicate plugin: ${plugin.name}`);
    seen.add(plugin.name);
    assert.ok(Array.isArray(plugin.versions) && plugin.versions.length > 0, `${plugin.name} has no versions`);
    const versions = new Set();
    for (const version of plugin.versions) {
      assert.ok(semver.valid(version.version), `${plugin.name} has an invalid version: ${version.version}`);
      assert.equal(versions.has(version.version), false, `${plugin.name} repeats ${version.version}`);
      versions.add(version.version);
      assert.equal(Number.isInteger(version.publishTimestamp), true, `${plugin.name}@${version.version} needs a publishTimestamp`);
      assert.ok(version.publishTimestamp > 0 && version.publishTimestamp < 1e11, `${plugin.name}@${version.version} publishTimestamp out of range`);
      assert.deepEqual(version.source, { type: 'npm' }, `${plugin.name}@${version.version} must install from npm`);
      if (version.engines?.dsh !== undefined) assert.ok(semver.validRange(version.engines.dsh), `${plugin.name}@${version.version} has an invalid engines.dsh: ${version.engines.dsh}`);
    }
    if (plugin.metadata?.category !== undefined) {
      assert.ok(document.metadata?.categories?.[plugin.metadata.category], `${plugin.name} declares an undeclared category`);
    }
    for (const label of plugin.metadata?.labels ?? []) {
      assert.ok(document.metadata?.labels?.[label], `${plugin.name} declares an undeclared label: ${label}`);
    }
  }
});

test('versions are ordered newest first and downloads are declared', () => {
  for (const plugin of document.plugins) {
    const versions = plugin.versions.map(version => version.version);
    const sorted = [...versions].sort((left, right) => {
      const [a, b] = [left.split('-')[0].split('.').map(Number), right.split('-')[0].split('.').map(Number)];
      for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return b[index] - a[index];
      }
      const [aPre, bPre] = [left.includes('-'), right.includes('-')];
      return aPre === bPre ? 0 : aPre ? 1 : -1;
    });
    assert.deepEqual(versions, sorted, `${plugin.name} versions are not newest first`);
    if (plugin.metadata?.sortKeys?.downloads !== undefined) {
      assert.equal(typeof plugin.metadata.sortKeys.downloads, 'number');
      assert.ok(plugin.metadata.sortKeys.downloads >= 0);
    }
  }
});
