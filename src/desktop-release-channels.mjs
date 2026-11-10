/** Update channels shared by the Studio release tools and the packaged DSH updater.
 *
 * The DSH Desktop runtime reads `dshDesktopUpdateChannel` from the installed
 * manifest and rejects every value other than `nightly` or `latest` at startup
 * (`apps/desktop/src/update-channel.ts` in DSH 0.2.2-rc.1). New builds must
 * therefore be sealed with a native channel. `preview` and `stable` stay
 * parseable for feeds, candidates and release records written before the rc1
 * upgrade, including the one-time preview feed freeze during migration.
 *
 * Two properties of the DSH coordinator shape the channel rules below:
 * - `allowPrerelease = channel === 'nightly'`, so `latest` (and the legacy
 *   `stable` lane) rejects a prerelease feed version with
 *   `desktop update: latest feed contains a prerelease`.
 * - Studio desktop versions are `<dsh version>.<YYYYMMDD>.<ordinal>`; while the
 *   pinned DSH version carries an `-rc.N` suffix every Studio build is a
 *   prerelease, so `nightly` is the only lane a current build can use.
 */

/** Channels the packaged DSH updater accepts from an installed manifest. */
export const NATIVE_RELEASE_CHANNELS = Object.freeze(['nightly', 'latest']);

/** Channels kept for feeds and candidates published before the DSH rc1 upgrade. */
export const LEGACY_RELEASE_CHANNELS = Object.freeze(['preview', 'stable']);

/** Every channel the release tools can parse, verify or publish. */
export const RELEASE_CHANNELS = Object.freeze([...NATIVE_RELEASE_CHANNELS, ...LEGACY_RELEASE_CHANNELS]);

/**
 * Channels whose updater refuses prerelease versions.
 *
 * `latest` is the GA lane; the legacy `stable` lane used the same comparison.
 * `nightly` (and the legacy `preview` lane that mirrors it) intentionally
 * accept prerelease builds.
 */
export const STABLE_ONLY_RELEASE_CHANNELS = Object.freeze(['latest', 'stable']);

/**
 * Compatibility lanes every successful publication keeps current.
 *
 * Installed clients keep requesting the channel and feed object sealed into
 * their own `app-update.yml`; they cannot be renamed remotely. Mirroring the
 * freshly published feed bytes onto these lanes lets every historical install
 * jump straight to the newest release in one update instead of first hopping to
 * whatever version the lane happened to freeze at.
 */
export const COMPATIBILITY_RELEASE_CHANNELS = Object.freeze(['preview']);

/** Feed targets (electron-builder platform directories) the tools publish. */
export const RELEASE_FEED_TARGETS = Object.freeze(['mac-arm64', 'win-x64']);

/**
 * Channel a new production build seals unless the operator selects another one.
 *
 * DSH's updater rejects a prerelease version on `latest`, while every Studio
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

/** True for the compatibility lanes that must follow every publication. */
export function isCompatibilityReleaseChannel(value) {
  return typeof value === 'string' && COMPATIBILITY_RELEASE_CHANNELS.includes(value.trim());
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

/**
 * Parse a comma-separated channel list (for example `--compat-channels`).
 * Order is preserved and duplicates are removed.
 */
export function parseReleaseChannelList(value, label = 'channels') {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (!selected) throw new Error(`${label} is required`);
  return [...new Set(selected.split(',').map(part => assertReleaseChannel(part, label)))];
}

/**
 * True when the version is a plain `x.y.z` release.
 *
 * A stable lane must not carry a prerelease suffix, and electron-updater only
 * compares three-segment semantic versions. Studio's `<dsh version>.<date>.<n>`
 * naming yields `x.y.z` only when the build is deliberately versioned as a GA
 * release without the date suffix.
 */
export function isStableDesktopVersion(value) {
  return typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.trim());
}

/**
 * Fail fast when a channel cannot serve a version.
 *
 * `latest`/`stable` only accept a plain three-segment version; putting an
 * `-rc` feed on those lanes makes the packaged DSH coordinator throw and leaves
 * the client unable to check for updates at all. `nightly`/`preview` accept
 * prerelease builds.
 */
export function assertChannelSupportsVersion(channel, version, label = 'version') {
  const lane = assertReleaseChannel(channel);
  const selected = typeof version === 'string' ? version.trim() : '';
  if (!selected) throw new Error(`${label} is required`);
  if (STABLE_ONLY_RELEASE_CHANNELS.includes(lane) && !isStableDesktopVersion(selected)) {
    throw new Error(`${lane} channel requires a stable three-segment version without a prerelease, but ${label} is ${selected}`);
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
