import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const output = join(directory, 'studio output');
  const bin = join(directory, 'bin');
  const source = join(dsh, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/deepseek-harness-0.2.0-rc.2-mac-arm64-unsigned.dmg');
  for (const path of [join(dsh, 'apps/desktop/scripts'), join(source, '..'), output, bin]) await mkdir(path, { recursive: true });
  if (result === 'fail') await writeFile(source, 'previous official build');
  if (result === 'empty') await writeFile(source, '');
  await writeFile(join(dsh, 'apps/desktop/scripts/package-target.ts'), 'invocation.unsigned && target.platform');
  // Stub only the expensive official build; exercise the real Make recipe and export.
  await writeFile(join(bin, 'pnpm'), `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { dirname } from 'node:path';\nif (process.env.STUDIO_TEST_RESULT === 'fail') process.exit(1);\nif (process.env.STUDIO_TEST_RESULT === 'success') { mkdirSync(dirname(process.env.STUDIO_TEST_SOURCE), { recursive: true }); writeFileSync(process.env.STUDIO_TEST_SOURCE, ${JSON.stringify(currentImage)}); }\n`, { mode: 0o755 });
  await writeFile(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  const artifact = join(output, 'AgentKit-Studio-0.0.1-mac-arm64-local.dmg');
  await writeFile(artifact, 'old image');
  const execute = () => run('make', ['desktop-package-mac-arm64-unsigned', '-o', 'desktop-package-preflight', `DSH_ROOT=${dsh}`, `PACK_DIR=${output}`], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUDIO_TEST_SOURCE: source, STUDIO_TEST_RESULT: result },
  });
  return { artifact, output, execute };
}

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
