/** Validate the single DSH pin against every build and runtime input it owns. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dshPin, dshPatchRoot, dshPinBranchRef, repositoryRoot } from './dsh-pin.mjs';

const readJson = async path => JSON.parse(await readFile(join(repositoryRoot, path), 'utf8'));
const readText = async path => readFile(join(repositoryRoot, path), 'utf8');
const check = (condition, message) => { if (!condition) throw new Error(`DSH pin mismatch: ${message}`); };
const exact = (actual, expected, label) => check(actual === expected, `${label}: expected ${expected}, got ${actual}`);

export async function checkDshPin() {
  check(dshPin.schemaVersion === 1, 'schemaVersion must be 1');
  for (const [name, value] of [['version', dshPin.version], ['commit', dshPin.commit], ['ref', dshPin.ref], ['baseCommit', dshPin.baseCommit], ['nodeRange', dshPin.nodeRange], ['patchDirectory', dshPin.patchDirectory], ['patchedTree', dshPin.patchedTree], ['patchedSourceSha256', dshPin.patchedSourceSha256], ['maintenanceSource', dshPin.maintenanceSource]]) {
    check(typeof value === 'string' && value.length > 0, `${name} is required`);
  }
  check(/^[a-f0-9]{40}$/.test(dshPin.commit), 'commit must be a full Git SHA');
  check(/^[a-f0-9]{40}$/.test(dshPin.baseCommit), 'baseCommit must be a full Git SHA');
  check(dshPin.commit === dshPin.baseCommit, 'rc pin must start from its pinned tag commit');
  check(/^[a-f0-9]{40}$/.test(dshPin.patchedTree), 'patchedTree must be a Git tree SHA');
  check(/^[a-f0-9]{64}$/.test(dshPin.patchedSourceSha256), 'patchedSourceSha256 must be SHA-256');
  check(dshPatchRoot === join(repositoryRoot, dshPin.patchDirectory), 'patchDirectory must stay repository-relative');

  const [pkg, plugin, manifest, source, makefile, adapter, lockfile] = await Promise.all([
    readJson('package.json'), readJson('studio.plugin.json'), readJson(`${dshPin.patchDirectory}/manifest.json`),
    readJson(dshPin.maintenanceSource), readText('Makefile'), readText('src/session-adapter.mjs'), readText('pnpm-lock.yaml'),
  ]);
  check(Array.isArray(pkg.files) && pkg.files.includes('dsh-pin.json'), 'package.files must ship dsh-pin.json for runtime metadata');
  exact(pkg.engines?.dsh, dshPin.version, 'package.engines.dsh');
  exact(pkg.engines?.node, dshPin.nodeRange, 'package.engines.node');
  exact(pkg.dependencies?.['@deepseek-ai/dsh-experimental-agent-team'], dshPin.version, 'agent-team dependency');
  exact(plugin.requiredDsh, dshPin.version, 'studio.plugin.requiredDsh');
  exact(plugin.requiredHostApi, `dsh-native/${dshPin.version}`, 'studio.plugin.requiredHostApi');
  exact(plugin.requiredHostContract, dshPin.hostContract, 'studio.plugin.requiredHostContract');
  exact(manifest.baseCommit, dshPin.baseCommit, 'patch manifest baseCommit');
  exact(manifest.patchedTree, dshPin.patchedTree, 'patch manifest patchedTree');
  exact(manifest.patchedSourceSha256, dshPin.patchedSourceSha256, 'patch manifest patchedSourceSha256');
  exact(manifest.upstream?.ref, dshPin.ref, 'patch manifest upstream.ref');
  exact(source.baseCommit, dshPin.baseCommit, 'source descriptor baseCommit');
  exact(source.tree, dshPin.patchedTree, 'source descriptor tree');
  exact(source.sourceSha256, dshPin.patchedSourceSha256, 'source descriptor sourceSha256');
  exact(source.branchRef, dshPinBranchRef(), 'source descriptor branchRef');
  exact(source.bundle?.file, `../../host-source/${dshPin.ref}/maintenance.bundle`, 'source descriptor bundle');
  exact(dshPin.maintenanceSource, `${dshPin.patchDirectory}/source.json`, 'maintenanceSource');
  const makefilePins = {
    DSH_VERSION: '$(DSH_PIN_VERSION)',
    DSH_COMMIT: '$(DSH_PIN_COMMIT)',
    DSH_REF: '$(DSH_PIN_REF)',
    PATCH_ROOT: '$(abspath $(DSH_PIN_PATCH_DIRECTORY))',
  };
  for (const [name, expected] of Object.entries(makefilePins)) {
    const match = new RegExp(`^${name} \\?= ([^\\n]+)$`, 'm').exec(makefile);
    check(match, `Makefile ${name} is missing`);
    exact(match[1].trim(), expected, `Makefile ${name}`);
  }
  check(adapter.includes('export const DSH_VERSION = dshPin.version'), 'session adapter DSH_VERSION is not sourced from dshPin');
  check(adapter.includes('export const DSH_COMMIT = dshPin.commit'), 'session adapter DSH_COMMIT is not sourced from dshPin');
  check(lockfile.includes(`specifier: ${dshPin.version}`), 'pnpm lockfile has no pinned DSH specifier');
  check(lockfile.includes(`@deepseek-ai/dsh-experimental-agent-team@${dshPin.version}`), 'pnpm lockfile has no pinned agent-team package');
  return { version: dshPin.version, commit: dshPin.commit, ref: dshPin.ref, baseCommit: dshPin.baseCommit, patchDirectory: dshPin.patchDirectory, patchedTree: dshPin.patchedTree, maintenanceSource: dshPin.maintenanceSource };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await checkDshPin()));
}
