import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A release bumps every identity file or none.
 *
 * v0.0.18 was cut with `package.json` at 0.0.18 and `studio.plugin.json` still
 * at 0.0.17. Every unit test passed; the failure only surfaced in
 * `patched-dsh-host` → `make profile-install`:
 *
 *   Error: installed plugin manifest identity/version does not match the release package
 *
 * That gate is eight minutes of a patched Host build, so the mistake costs a
 * full CI cycle to find. This is the same assertion, one second, before the
 * release commit exists.
 */

const readJson = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));

test('the plugin manifest carries the package version', async () => {
  const pkg = await readJson('package.json');
  const manifest = await readJson('studio.plugin.json');
  assert.equal(manifest.version, pkg.version, 'studio.plugin.json must match package.json');
});

test('the plugin manifest identity is stable', async () => {
  const manifest = await readJson('studio.plugin.json');
  assert.equal(manifest.id, 'agentkit-studio');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
});

test('the changelog documents the current version', async () => {
  const pkg = await readJson('package.json');
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(
    changelog.includes(`## ${pkg.version} - `),
    `CHANGELOG.md must open with a "## ${pkg.version} - <date>" section`,
  );
});
