/** Verify a curated DSH bundle through the real DSH Host and Studio adapter.
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
const curated = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
];

if (!process.argv.includes('--execute')) {
  console.error('使用：AGENTKIT_DSH_HOME=/隔离的/.dsh node scripts/verify-dsh-plugin-market.mjs --execute [--plugin 包名 | --all]');
  process.exitCode = 2;
} else {
  const selected = process.argv.includes('--all')
    ? curated
    : [String(process.env.AGENTKIT_PLUGIN || '@deepseek-ai/dsh-experimental-agent-team-profile')];
  if (selected.some(name => !curated.includes(name))) throw new Error(`插件不在 Studio 精选清单中：${selected.join(', ')}`);
  if (!process.env.AGENTKIT_DSH_HOME && !process.env.DSH_HOME) throw new Error('必须设置 AGENTKIT_DSH_HOME 或 DSH_HOME，避免误修改用户 profile。');

  const probe = join(studioRoot, 'scripts', `.verify-dsh-plugin-market-${process.pid}.mjs`);
  const source = `
    import { runProfile } from ${JSON.stringify(pathToFileURL(join(dshRoot, 'apps/cli/src/profile-boot.ts')).href)};
    import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
    import { createStudioPlugins } from ${JSON.stringify(pathToFileURL(join(studioRoot, 'src/studio-plugins.mjs')).href)};
    const selected = ${JSON.stringify(selected)};
    const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: ${JSON.stringify(profile)}, patchFiles: [], args: ['--no-open'] });
    try {
      const plugins = createStudioPlugins({ getService: name => ctx.get(name) });
      const results = [];
      for (const pluginId of selected) {
        const result = await plugins.installDsh(pluginId);
        if (result.verification?.state !== 'ready') throw new Error(pluginId + ': ' + JSON.stringify(result.verification));
        results.push({ pluginId, verification: result.verification, application: result.application });
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
  } finally { await fs.rm(probe, { force: true }); }
}
