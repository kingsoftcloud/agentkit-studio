/** Resolve generated desktop metadata against the separately published binary directory. */
export function publishedDesktopMetadata(metadata, version, target = 'mac-arm64') {
  const name = `deepseek-harness-${version}-${target}.zip`;
  if (metadata.version !== version || metadata.files?.length !== 1
    || typeof metadata.files[0].url !== 'string'
    || metadata.files[0].url.split('/').at(-1) !== name) {
    throw new Error('release metadata does not identify its signed ZIP');
  }
  const path = `../../bin/${target}/${name}`;
  return { ...metadata, path, files: [{ ...metadata.files[0], url: path }] };
}

/** Versioned KS3 storage; a stable basename keeps the updater's old-version URL valid. */
export function studioDesktopPublication(metadata, { origin, channel = 'preview', target = 'mac-arm64', mode = 'incremental' } = {}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw new Error('Studio storage must be an HTTPS origin');
  if (!['stable', 'preview'].includes(channel) || target !== 'mac-arm64' || !['incremental', 'full'].includes(mode)) throw new Error('Invalid Studio publication mode');
  const version = metadata.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid Studio publication version');
  publishedDesktopMetadata(metadata, version, target);
  const root = `studio/${version}`, name = `AgentKit-Studio-${target}`;
  const assets = { dmg: `${root}/${name}.dmg`, zip: `${root}/${mode === 'full' ? 'full/' : ''}${name}.zip`, blockmap: `${root}/${name}.zip.blockmap` };
  const url = new URL(assets.zip, base).href;
  return { assets, feedKey: `studio/feeds/${target}/${channel}-mac.yml`, releaseKey: `studio/feeds/${target}/mac-arm64-release.json`,
    metadata: { ...metadata, path: url, files: [{ ...metadata.files[0], url }], agentkitUpdateMode: mode } };
}
