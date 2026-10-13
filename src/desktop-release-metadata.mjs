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
