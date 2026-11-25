import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the Studio boundary reviews statically named imports through local aliases', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'studio-host-imports-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all(['scripts', 'src', 'host-source', 'ci'].map(name => mkdir(join(fixture, name))));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(fixture, 'node_modules'), 'junction');
  const script = join(fixture, 'scripts', 'check-harness-host-imports.mjs');
  await cp(new URL('../scripts/check-harness-host-imports.mjs', import.meta.url), script);
  await writeFile(join(fixture, 'ci', 'harness-host-imports.txt'), '');
  await writeFile(join(fixture, 'src', 'fixture.mjs'), [
    "import { createRequire as localRequireFactory } from 'node:module';",
    'const load = localRequireFactory(import.meta.url);',
    "const scope = '@kingsoftcloud/';",
    "const nodePackage = scope + 'agentkit-harness-node';",
    "const core = load('@kingsoftcloud/agentkit-harness-core');",
    'const node = await import(nodePackage);',
  ].join('\n'));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/fixture\.mjs\s+core node/);
});
