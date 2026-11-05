import dshPin from '../dsh-pin.json' with { type: 'json' };
/** Desktop identity comes from Electron app.getVersion(), independently of DSH/plugin semver. */
export async function studioVersions(env = {}) {
  const { readFile } = await import('node:fs/promises');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return {
    version: String(env.AGENTKIT_STUDIO_DESKTOP_VERSION || '').trim() || null,
    pluginVersion: metadata.version,
    dshVersion: env.AGENTKIT_STUDIO_DSH_VERSION || dshPin.version,
  };
}
