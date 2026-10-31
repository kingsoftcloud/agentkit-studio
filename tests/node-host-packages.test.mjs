import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_HOST_ROOTS, readNodeHostPackages } from '../scripts/node-host-packages.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'node-host-packages-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = join(root, 'studio'), output = join(root, 'packages'), version = '0.2.1-rc.2';
  await mkdir(join(studio, 'patches', `dsh-v${version}`), { recursive: true }); await mkdir(output);
  const source = { baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), tree: 'c'.repeat(40) };
  await writeFile(join(studio, 'studio.plugin.json'), JSON.stringify({ requiredDsh: version }));
  await writeFile(join(studio, 'patches', `dsh-v${version}`, 'source.json'), JSON.stringify(source));
  const manifest = { format: 'agentkit.node-host-packages/v1', source: { ...source, dshVersion: version },
    roots: [...NODE_HOST_ROOTS], packages: [] };
  for (const [index, name] of NODE_HOST_ROOTS.entries()) {
    const bytes = Buffer.from(`archive byte fixture ${name}`), tarball = `${index}.tgz`;
    await writeFile(join(output, tarball), bytes);
    manifest.packages.push({ name, version, path: `packages/${index}`, tarball,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const path = join(output, 'host-packages.json');
  const load = async () => { await writeFile(path, JSON.stringify(manifest)); return readNodeHostPackages(path, studio); };
  return { root, output, studio, manifest, load };
}

test('maintained archives control direct and transitive npm resolution without linking a source checkout', async t => {
  const h = await fixture(t), accepted = await h.load();
  assert.deepEqual(Object.keys(accepted.dependencies).sort(), [...NODE_HOST_ROOTS].sort());
  for (const item of h.manifest.packages) {
    assert.equal(accepted.dependencies[item.name], `file:${join(h.output, item.tarball)}`);
    assert.equal(accepted.overrides[item.name], `$${item.name}`);
  }
  assert.equal(accepted.evidence.source.headCommit, h.manifest.source.headCommit);
  await writeFile(join(h.output, h.manifest.packages[0].tarball), 'modified archive');
  await assert.rejects(h.load(), /digest mismatch/);
});

test('a matching version cannot substitute a foreign source tree or incomplete/duplicate Host package set', async t => {
  const h = await fixture(t), original = structuredClone(h.manifest);
  h.manifest.source.tree = 'd'.repeat(40); await assert.rejects(h.load(), /Host source tree/);
  Object.assign(h.manifest, structuredClone(original)); h.manifest.packages[0] = structuredClone(h.manifest.packages[1]);
  await assert.rejects(h.load(), /Duplicate Host package/);
  Object.assign(h.manifest, structuredClone(original)); h.manifest.packages[0].name = '@deepseek-ai/dsh-other';
  await assert.rejects(h.load(), /Missing Host root/);
});

test('Host archive names cannot read outside their output directory or follow a substituted symlink', async t => {
  const h = await fixture(t), item = h.manifest.packages[0], original = item.tarball;
  item.tarball = '../other.tgz'; await assert.rejects(h.load());
  item.tarball = original;
  const archive = join(h.output, original), other = join(h.root, 'other.tgz');
  await writeFile(other, `archive byte fixture ${item.name}`); await rm(archive); await symlink(other, archive);
  await assert.rejects(h.load(), /not a link/);
});
