/** Exercise the production privacy projector with actual native Sessions and the Client Controller in jsdom. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set AGENTKIT_DSH_ROOT to the installed pinned DSH checkout.');
const dsh = await realpath(process.env.AGENTKIT_DSH_ROOT);
const manifest = JSON.parse(await readFile(join(studio, 'package.json'), 'utf8'));
const patches = JSON.parse(await readFile(join(studio, `patches/dsh-v${manifest.engines.dsh}/manifest.json`), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dsh, encoding: 'utf8' }).trim();
assert.equal(commit, patches.baseCommit, 'Native UI verification requires the repository-pinned DSH baseline.');
const template = await readFile(new URL('./assistant-native-projection.spec.ts.template', import.meta.url), 'utf8');
const source = template.replace(/(['"])@(studio|dsh)\/([^'"]+)\1/g, (_match, _quote, root, suffix) =>
  JSON.stringify(join(root === 'studio' ? studio : dsh, suffix).replaceAll('\\', '/')));
const relative = `packages/client/ui-chat/tests/.agentkit-studio-assistant-projection-${randomUUID()}.client.spec.ts`;
const probe = join(dsh, relative);
const pnpm = join(dsh, 'node_modules/pnpm/bin/pnpm.cjs');
await writeFile(probe, source, { flag: 'wx' });
try {
  const result = spawnSync(process.execPath, [pnpm, 'exec', 'vitest', 'run', relative, '--reporter=verbose'], {
    cwd: dsh, env: process.env, stdio: 'inherit', timeout: 60_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) console.log('Native assistant privacy projection: actual Session validators, surface folding, Client binding, page/reconnect and request echo checks passed.');
} finally { await rm(probe, { force: true }); }
