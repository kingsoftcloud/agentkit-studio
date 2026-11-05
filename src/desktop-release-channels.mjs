/** Update channels shared by the Studio release tools and the packaged DSH updater.
 *
 * The DSH Desktop runtime reads `dshDesktopUpdateChannel` from the installed
 * manifest and rejects every value other than `nightly` or `latest` at startup
 * (`apps/desktop/src/update-channel.ts` in DSH 0.2.2-rc.1). New builds must
 * therefore be sealed with a native channel. `preview` and `stable` stay
 * parseable for feeds, candidates and release records written before the rc1
 * upgrade, including the one-time preview feed freeze during migration.
 */

/** Channels the packaged DSH updater accepts from an installed manifest. */
export const NATIVE_RELEASE_CHANNELS = Object.freeze(['nightly', 'latest']);

/** Channels kept for feeds and candidates published before the DSH rc1 upgrade. */
export const LEGACY_RELEASE_CHANNELS = Object.freeze(['preview', 'stable']);

/** Every channel the release tools can parse, verify or publish. */
export const RELEASE_CHANNELS = Object.freeze([...NATIVE_RELEASE_CHANNELS, ...LEGACY_RELEASE_CHANNELS]);

/**
 * Channel a new production build seals unless the operator selects another one.
 *
 * DSH's updater rejects a prerelease version on `latest`
 * (`desktop update: latest feed contains a prerelease`), while every Studio
 * build carries an `-rc.N.<stamp>` suffix. `nightly` is the only native lane
 * that accepts those versions, so it is the default until Studio ships a
 * stable-semver GA build, which may then select `latest`.
 */
export const DEFAULT_RELEASE_CHANNEL = 'nightly';

/** True for the channels a packaged manifest may carry. */
export function isNativeReleaseChannel(value) {
  return NATIVE_RELEASE_CHANNELS.includes(value);
}

/** True when the value names any channel these tools understand. */
export function isReleaseChannel(value) {
  return typeof value === 'string' && RELEASE_CHANNELS.includes(value);
}

/** Validate one channel name and return it normalized for use in object keys. */
export function assertReleaseChannel(value, label = 'channel') {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (!selected) throw new Error(`${label} is required`);
  if (!isReleaseChannel(selected)) {
    throw new Error(`${label} must be one of ${RELEASE_CHANNELS.join(', ')}`);
  }
  return selected;
}

/** electron-builder emits one channel metadata file per channel and platform. */
export function channelMetadataFilename(channel) {
  return `${assertReleaseChannel(channel)}-mac.yml`;
}

/** Windows keeps the platform-neutral channel metadata name. */
export function windowsChannelMetadataFilename(channel) {
  return `${assertReleaseChannel(channel)}.yml`;
}
