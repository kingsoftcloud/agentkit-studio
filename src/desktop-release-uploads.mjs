/** Immutable upload list for one desktop release publication.
 *
 * The Studio layout publishes only canonical `studio/` objects. The legacy
 * `dsh-desk/` bin and feed are compatibility surfaces for installed builds of
 * older releases and for the explicit compatibility origin; writing them from
 * every publish kept failing on release credentials scoped to `studio/*`.
 */
export function desktopReleaseUploads({ expectedBase, plan, selectedChannel, target = 'mac-arm64', storageOrigin, feedOrigin, compatibilityOrigin }) {
  const uploadRoot = `dsh-desk/bin/${target}`
  const feedRoot = `dsh-desk/feeds/${target}`
  const uploads = [
    [`${expectedBase}.dmg`, plan?.assets.dmg || `${uploadRoot}/${expectedBase}.dmg`, 'application/x-apple-diskimage', storageOrigin],
    [`${expectedBase}.zip`, plan?.assets.zip || `${uploadRoot}/${expectedBase}.zip`, 'application/zip', storageOrigin],
    [`${expectedBase}.zip.blockmap`, plan?.assets.blockmap || `${uploadRoot}/${expectedBase}.zip.blockmap`, 'application/octet-stream', storageOrigin],
    ['mac-arm64-release.json', plan?.releaseKey || `${feedRoot}/mac-arm64-release.json`, 'application/json', storageOrigin],
  ]
  if (plan) {
    uploads.push([`${selectedChannel}-mac.yml`, plan.feedKey, 'application/yaml', storageOrigin])
    if (storageOrigin !== feedOrigin) uploads.push([`${selectedChannel}-mac.yml`, plan.feedKey, 'application/yaml', feedOrigin])
  } else {
    uploads.push([`${selectedChannel}-mac.yml`, `${feedRoot}/${selectedChannel}-mac.yml`, 'application/yaml', feedOrigin])
  }
  if (compatibilityOrigin) {
    for (const origin of new Set([feedOrigin, storageOrigin, compatibilityOrigin])) {
      uploads.push([`${selectedChannel}-mac.yml`, `${feedRoot}/${selectedChannel}-mac.yml`, 'application/yaml', origin])
    }
  }
  return uploads
}
