/** Refresh the reviewed compatibility libraries as one maintained operation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_CORE_PACKAGE, NATIVE_NODE_PACKAGE } from './native-package-integrity.mjs';

const [version, unexpected] = process.argv.slice(2);
assert.ok(!unexpected && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version), 'Usage: pnpm bump:harness <exact-version>');
const pnpmEntry = process.env.npm_execpath;
assert.ok(pnpmEntry && process.env.npm_config_user_agent?.startsWith('pnpm/'), 'Run this command with pnpm');
const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['package.json', 'pnpm-lock.yaml', 'scripts/native-package-pins.json'];
const snapshot = new Map(files.map(name => [name, readFileSync(join(root, name), 'utf8')]));
const clientUi = '@kingsoftcloud/agentkit-harness-ui';
const product = JSON.parse(snapshot.get('package.json'));
assert.ok(Object.hasOwn(product.devDependencies, NATIVE_NODE_PACKAGE), `Missing test dependency: ${NATIVE_NODE_PACKAGE}`);
assert.ok(Object.hasOwn(product.devDependencies, NATIVE_CORE_PACKAGE), `Missing test dependency: ${NATIVE_CORE_PACKAGE}`);
product.devDependencies[NATIVE_NODE_PACKAGE] = version;
product.devDependencies[NATIVE_CORE_PACKAGE] = version;
if (Object.hasOwn(product.devDependencies, clientUi)) product.devDependencies[clientUi] = version;

const run = (...args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
const install = (...flags) => run(pnpmEntry, 'install', '--ignore-scripts', ...flags);
const lock = join(root, '.artifacts', 'bump-harness.lock');
mkdirSync(join(root, '.artifacts'), { recursive: true });
const owner = openSync(lock, 'wx', 0o600);
let installed = false;
try {
  for (const [name, original] of snapshot)
    assert.equal(readFileSync(join(root, name), 'utf8'), original, `Compatibility inputs changed while acquiring the lock: ${name}`);
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(product, null, 2) + '\n');
    install('--lockfile-only');
    installed = true;
    install('--frozen-lockfile');
    run('scripts/pin-native-registry.mjs');
    run('scripts/verify-native-dependencies.mjs');
  } catch (error) {
    for (const [name, original] of snapshot) writeFileSync(join(root, name), original);
    if (installed) {
      try { install('--frozen-lockfile'); }
      catch (restoreError) { throw new AggregateError([error, restoreError], 'Compatibility files restored, but dependency installation could not be restored'); }
    }
    throw error;
  }
} finally {
  closeSync(owner);
  rmSync(lock);
}
