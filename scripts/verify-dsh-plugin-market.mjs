/** Verify the bundles Studio enables by default through the real DSH Host.
 *
 * Studio no longer owns a plugin market: the official 已安装 / 发现 tabs read
 * DSH's plugin index, and the Host's `pluginManager` installs from it. What
 * Studio still decides is which bundles are on by default
 * (`src/host/default-bundles.mjs`), so this script installs those bundles
 * through the official manager and reports the resulting profile state.
 *
 * This intentionally mutates only the profile named by the caller. Run it with
 * --execute and an isolated DSH_HOME for CI or release evidence. The script
 * does not auto-approve dependency build scripts; a pending build is a failed
 * verification that must be explicitly approved by the operator.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || join(studioRoot, '../../deepseek-harness'));
const profile = String(process.env.AGENTKIT_DSH_PROFILE || 'web').trim() || 'web';
const defaults = [
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-cua-bundle',
];

if (!process.argv.includes('--execute')) {
  console.error('使用：AGENTKIT_DSH_HOME=/隔离的/.dsh node scripts/verify-dsh-plugin-market.mjs --execute [--plugin 包名 | --all]');
  process.exitCode = 2;
} else {
  const selected = process.argv.includes('--all')
    ? defaults
    : [String(process.env.AGENTKIT_PLUGIN || defaults[0])];
  if (selected.some(name => !defaults.includes(name))) throw new Error(`插件不在 Studio 默认清单中：${selected.join(', ')}`);
  if (!process.env.AGENTKIT_DSH_HOME && !process.env.DSH_HOME) throw new Error('必须设置 AGENTKIT_DSH_HOME 或 DSH_HOME，避免误修改用户 profile。');

  const probe = join(studioRoot, 'scripts', `.verify-dsh-plugin-market-${process.pid}.mjs`);
  const source = `
    import { runProfile } from ${JSON.stringify(pathToFileURL(join(dshRoot, 'apps/cli/src/profile-boot.ts')).href)};
    import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
    const selected = ${JSON.stringify(selected)};
    const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: ${JSON.stringify(profile)}, patchFiles: [], args: ['--no-open'] });
    try {
      const manager = ctx.get('pluginManager');
      const results = [];
      for (const spec of selected) {
        const inspection = await manager.inspect(spec, {});
        if (inspection?.status !== 'accepted') throw new Error(spec + ': ' + (inspection?.reason || inspection?.problem || 'inspection refused'));
        const change = await manager.installBundle(spec, { enabled: true, saveExact: true, ...(inspection.registry === undefined ? {} : { registry: inspection.registry }) });
        if (!change || change.error || !['applied', 'restart-required'].includes(change.application)) {
          throw new Error(spec + ': ' + JSON.stringify(change?.error || change?.application || 'no result'));
        }
        const name = String(inspection.name || spec);
        const bundle = (await manager.listBundles()).find(candidate => candidate.name === name);
        if (bundle?.installed !== true || bundle?.enabled === false) throw new Error(spec + ': not installed and enabled');
        results.push({ spec, name, version: bundle.version, application: change.application, installed: bundle.installed, enabled: bundle.enabled });
      }
      console.log(JSON.stringify({ dshRoot: ${JSON.stringify(dshRoot)}, profile: ${JSON.stringify(profile)}, results }, null, 2));
    } finally { await ctx.fiber.dispose(); }
  `;
  const fs = await import('node:fs/promises');
  await fs.writeFile(probe, source, 'utf8');
  try {
    execFileSync(process.execPath, ['--import', 'tsx/esm', probe], {
      cwd: dshRoot,
      env: { ...process.env, DSH_HOME: process.env.AGENTKIT_DSH_HOME || process.env.DSH_HOME },
      stdio: 'inherit',
      timeout: 180_000,
    });
  } finally {
    await fs.rm(probe, { force: true });
  }
}
