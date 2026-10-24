/** Consume the package set exported from the pinned maintained Host source.
 * npm installs archives normally; this never patches live registry packages.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_HOST_ROOTS = Object.freeze(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-sdk-client']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readNodeHostPackages(path, studio = fileURLToPath(new URL('..', import.meta.url))) {
  const manifestPath = await realpath(path), root = dirname(manifestPath), bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes), plugin = JSON.parse(await readFile(join(studio, 'studio.plugin.json')));
  const pinned = JSON.parse(await readFile(join(studio, 'patches', `dsh-v${plugin.requiredDsh}`, 'source.json')));
  assert.equal(manifest.format, 'agentkit.node-host-packages/v1');
  for (const key of ['baseCommit', 'headCommit', 'tree']) assert.equal(manifest.source?.[key], pinned[key], `Host source ${key}`);
  assert.equal(manifest.source.dshVersion, plugin.requiredDsh);
  assert.deepEqual([...manifest.roots].sort(), [...NODE_HOST_ROOTS].sort());
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length >= NODE_HOST_ROOTS.length);
  const dependencies = {}, overrides = {}, names = new Set(), archives = new Set();
  for (const item of manifest.packages) {
    assert.match(item.name, /^@deepseek-ai\/[a-z0-9][a-z0-9-]*$/);
    assert.ok(!names.has(item.name), 'Duplicate Host package'); names.add(item.name);
    assert.equal(item.version, plugin.requiredDsh);
    assert.match(item.tarball, /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/);
    assert.ok(!archives.has(item.tarball), 'Duplicate Host archive'); archives.add(item.tarball);
    const file = join(root, item.tarball);
    assert.equal((await lstat(file)).isFile(), true, 'Host archive must be a file, not a link');
    assert.equal(sha(await readFile(file)), item.sha256, 'Host archive digest mismatch');
    dependencies[item.name] = `file:${file}`;
    // The identical direct dependency also controls transitive imports; a
    // registry copy of the same version cannot shadow the maintained build.
    overrides[item.name] = `$${item.name}`;
  }
  for (const name of NODE_HOST_ROOTS) assert.ok(names.has(name), `Missing Host root ${name}`);
  return { dependencies, overrides, evidence: { manifest: manifestPath, sha256: sha(bytes), source: manifest.source,
    packages: manifest.packages.map(({ name, version, tarball, sha256 }) => ({ name, version, tarball, sha256 })) } };
}

/** Reuse a completed fresh Host installation for additional real-process
 * acceptance. Require the exact Studio archive and unchanged normal npm lock;
 * no source checkout or development dependency directory is a fallback. */
export async function readNodeHostInstallation(path, { archive, studio = fileURLToPath(new URL('..', import.meta.url)) }) {
  const directory = await realpath(path);
  const proof = JSON.parse(await readFile(join(directory, 'proof.json')));
  assert.equal(proof.format, 'agentkit.native-node-install-proof/v1');
  assert.equal(proof.passed, true); assert.equal(proof.host, true); assert.equal(proof.installScripts, true);
  assert.equal(proof.archiveSha256, sha(await readFile(archive)), 'Fresh installation must contain the tested Studio archive');
  const lockBytes = await readFile(join(directory, 'package-lock.json'));
  assert.equal(proof.lockSha256, sha(lockBytes), 'Fresh dependency lock changed');
  const lock = JSON.parse(lockBytes);
  assert.ok(Object.keys(lock.packages).length > 10);
  assert.ok(Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/')).every(([, entry]) => !entry.link));
  const plugin = JSON.parse(await readFile(join(studio, 'studio.plugin.json')));
  const pinned = JSON.parse(await readFile(join(studio, 'patches', `dsh-v${plugin.requiredDsh}`, 'source.json')));
  for (const key of ['baseCommit', 'headCommit', 'tree'])
    assert.equal(proof.maintainedHost?.source?.[key], pinned[key], `Fresh Host source ${key}`);
  assert.equal(proof.maintainedHost.source.dshVersion, plugin.requiredDsh);
  const dependencies = join(directory, 'node_modules');
  for (const name of ['@kingsoftcloud/agentkit-studio', ...NODE_HOST_ROOTS]) {
    assert.ok((await realpath(join(dependencies, name))).startsWith(directory + '/'), `Fresh package escapes installation: ${name}`);
  }
  return { directory, dependencies, evidence: { kind: 'fresh-installation', directory, node: proof.node,
    archiveSha256: proof.archiveSha256, lockSha256: proof.lockSha256, installScripts: true,
    maintainedHost: proof.maintainedHost } };
}
