import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const currentImage = 'new official pipeline image';

async function fixture(t, result = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'studio-desktop-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dsh = join(directory, 'official checkout');
  const output = join(directory, 'studio-output');
  const bin = join(directory, 'bin');
  const patches = join(directory, 'patches');
  await mkdir(patches);
  const source = join(dsh, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/deepseek-harness-0.2.0-rc.2-mac-arm64-unsigned.dmg');
  for (const path of [join(dsh, 'apps/desktop/scripts'), join(dsh, 'apps/desktop/src'), join(source, '..'), output, bin]) await mkdir(path, { recursive: true });
  if (result === 'fail') await writeFile(source, 'previous official build');
  if (result === 'empty') await writeFile(source, '');
  await writeFile(join(dsh, 'apps/desktop/scripts/package-target.ts'), 'official package target');
  await writeFile(join(dsh, 'apps/desktop/scripts/prepare-package-set.ts'), 'official package set');
  await writeFile(join(dsh, 'apps/desktop/src/project-manager.ts'), 'official project manager');
  await writeFile(join(dsh, 'package.json'), '{"version":"0.2.0-rc.2"}');
  await writeFile(join(dsh, '.gitignore'), 'node_modules/\n.desktop-build/\n.env*\n');
  const git = args => execFileSync('git', args, {cwd:dsh,encoding:'utf8'}).trim();
  git(['init','-q']); git(['add','.']); git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline']);
  const commit = git(['rev-parse','HEAD']);
  await writeFile(join(dsh,'marker.txt'),'patch marker\n');
  await writeFile(join(dsh, 'apps/desktop/scripts/package-target.ts'), 'official package target\ninvocation.unsigned && target.platform');
  await writeFile(join(dsh, 'apps/desktop/scripts/prepare-package-set.ts'), 'official package set\nDSH_DESKTOP_PLUGIN_INPUTS');
  await writeFile(join(dsh, 'apps/desktop/src/project-manager.ts'), 'official project manager\nDSH_DESKTOP_PLUGIN_BUNDLES');
  git(['add','marker.txt', 'apps/desktop/scripts/package-target.ts', 'apps/desktop/scripts/prepare-package-set.ts', 'apps/desktop/src/project-manager.ts']);
  await writeFile(join(patches,'001-marker.patch'),git(['diff','--cached'])+'\n');
  // Keep the live checkout at the pinned clean commit. The patch is applied
  // only by desktop-checkout.mjs in the isolated packaging source.
  git(['restore', '--staged', '--worktree', '.']);
  // Stub only the expensive official build; exercise the real Make recipe and export.
  await writeFile(join(bin, 'pnpm'), `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { dirname } from 'node:path';\nif (process.argv.includes('pack')) { writeFileSync(process.env.STUDIO_PACK_TARBALL, 'plugin fixture'); process.exit(0); }\nif (process.argv.includes('install')) process.exit(0);\nif (process.env.STUDIO_TEST_RESULT === 'fail') process.exit(1);\nconst source = process.cwd() + '/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/deepseek-harness-0.2.0-rc.2-mac-arm64-unsigned.dmg';\nif (process.env.STUDIO_TEST_RESULT === 'success' || process.env.STUDIO_TEST_RESULT === 'empty') { mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, process.env.STUDIO_TEST_RESULT === 'empty' ? '' : ${JSON.stringify(currentImage)}); }\n`, { mode: 0o755 });
  await writeFile(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  const artifact = join(output, 'AgentKit-Studio-0.0.1-mac-arm64-local.dmg');
  await writeFile(artifact, 'old image');
  const execute = (nextResult = result, target = 'desktop-package-mac-arm64-unsigned') => run('make', [target, '-o', 'desktop-package-preflight', `DSH_ROOT=${dsh}`, `PACK_DIR=${output}`, `PATCH_ROOT=${patches}`, `DSH_COMMIT=${commit}`, `DESKTOP_PLUGIN_INPUTS=${patches}`], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUDIO_TEST_SOURCE: source, STUDIO_TEST_RESULT: nextResult },
  });
  const preflight = () => run('make', ['desktop-package-preflight', `DSH_ROOT=${dsh}`, `PACK_DIR=${output}`, `PATCH_ROOT=${patches}`, `DSH_COMMIT=${commit}`, `DESKTOP_PLUGIN_INPUTS=${patches}`], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUDIO_PACK_TARBALL: join(output, 'kingsoftcloud-agentkit-studio-0.0.1.tgz') },
  });
  return { artifact, output, execute, preflight, dsh, commit };
}

test('desktop preflight applies hooks in the isolated checkout and leaves pinned DSH clean', async t => {
  const { dsh, output, preflight, commit } = await fixture(t);
  await preflight();
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dsh, encoding: 'utf8' }).trim(), commit);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dsh, encoding: 'utf8' }).trim(), '');
  const [cache] = await readdir(join(output, 'desktop-checkouts'));
  const checkout = join(output, 'desktop-checkouts', cache, 'source');
  assert.match(await readFile(join(checkout, 'apps/desktop/scripts/prepare-package-set.ts'), 'utf8'), /DSH_DESKTOP_PLUGIN_INPUTS/);
  assert.match(await readFile(join(checkout, 'apps/desktop/src/project-manager.ts'), 'utf8'), /DSH_DESKTOP_PLUGIN_BUNDLES/);
  assert.match(await readFile(join(checkout, 'apps/desktop/scripts/package-target.ts'), 'utf8'), /invocation\.unsigned && target\.platform/);
  assert.doesNotMatch(await readFile(join(dsh, 'apps/desktop/scripts/package-target.ts'), 'utf8'), /invocation\.unsigned/);
});

test('successful official packaging replaces the Studio delivery image and records its digest', async t => {
  const { artifact, execute } = await fixture(t);
  await execute();
  assert.equal(await readFile(artifact, 'utf8'), currentImage, 'successful Make target must not leave the old Studio DMG');
  const digest = createHash('sha256').update(currentImage).digest('hex');
  assert.equal(await readFile(`${artifact}.sha256`, 'utf8'), `${digest}  AgentKit-Studio-0.0.1-mac-arm64-local.dmg\n`);
  const record = JSON.parse(await readFile(`${artifact}.json`, 'utf8'));
  assert.equal(record.sha256, digest);
  assert.equal(record.bytes, Buffer.byteLength(currentImage));
  assert.equal(record.unsigned, true);
  assert.equal(record.dshVersion, '0.2.0-rc.2');
  assert.doesNotMatch(JSON.stringify(record), /studio-desktop-delivery-/);
});

for (const result of ['fail', 'missing', 'empty']) test(`official ${result} output cannot be reported as a new Studio package`, async t => {
  const { artifact, execute } = await fixture(t, result);
  await assert.rejects(execute());
  assert.equal(await readFile(artifact, 'utf8'), 'old image', 'a failed build must not destroy the previous working image');
});

test('a cached previous image is not exported when a later build produces no image', async t => {
  const {artifact,execute}=await fixture(t);
  await execute();
  await assert.rejects(execute('missing'));
  assert.equal(await readFile(artifact,'utf8'),currentImage);
});

test('failed signed preparation removes only its temporary settings and keeps the original', async t => {
  const {dsh,output,execute}=await fixture(t);
  const settings="CSC_LINK=./private.p12\nCSC_KEY_PASSWORD='fixture secret'\n";
  const original=join(dsh,'apps/desktop/.env.macos');
  await writeFile(original,settings,{mode:0o600});
  await assert.rejects(execute('fail','desktop-package-mac-arm64'));
  assert.equal(await readFile(original,'utf8'),settings);
  const [cache]=await readdir(join(output,'desktop-checkouts'));
  await assert.rejects(access(join(output,'desktop-checkouts',cache,'source/apps/desktop/.env.macos')));
});
