/** Desktop identity comes from DSH's packaged client, independently of plugin semver. */
export async function studioVersions(env = {}) {
  const { readFile } = await import('node:fs/promises');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return {
    version: String(env.DSH_CLIENT_VERSION || '').trim() || null,
    pluginVersion: metadata.version,
    dshVersion: env.AGENTKIT_STUDIO_DSH_VERSION || '0.2.0-rc.2',
  };
}
