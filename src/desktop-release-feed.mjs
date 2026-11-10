/** Plan and validate the byte-for-byte feed mirrors that keep old installs upgradable.
 *
 * A channel feed is the only mutable release object: it names one immutable
 * binary by absolute URL plus the digest `electron-updater` checks. Copying the
 * exact feed bytes onto another channel object therefore moves installed clients
 * to the new release without rebuilding or re-uploading signed bytes.
 *
 * Everything here is pure: it returns plans/decisions and never performs network
 * I/O or KS3 uploads, so the mirror targets can be unit tested. The release
 * scripts (`scripts/desktop-release.mjs`, the Windows publishers) own uploads and
 * public verification.
 */
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import {
  assertChannelSupportsVersion,
  assertReleaseChannel,
  channelMetadataFilename,
  COMPATIBILITY_RELEASE_CHANNELS,
  RELEASE_FEED_TARGETS,
  windowsChannelMetadataFilename,
} from './desktop-release-channels.mjs';

/** Feed object layouts: canonical Studio storage and the legacy dsh-desk surface. */
export const FEED_LAYOUTS = Object.freeze(['studio', 'legacy']);

const LAYOUT_OBJECT_ROOTS = Object.freeze({ studio: 'studio', legacy: 'dsh-desk' });

/**
 * Binary path prefixes the immutable binary behind a feed may live under.
 *
 * `studio` feeds point into the versioned Studio storage. Legacy
 * `dsh-desk/feeds/...` objects legitimately point at the same canonical
 * `studio/<version>/` bytes — that is what the live legacy feed does — while
 * feeds written by the pre-Studio layout point at `dsh-desk/bin/...`. The feed
 * object layout and the binary location are therefore validated separately:
 * both prefixes are accepted for the legacy feed layout.
 */
const LAYOUT_BINARY_PREFIXES = Object.freeze({
  studio: Object.freeze(['/studio/']),
  legacy: Object.freeze(['/studio/', '/dsh-desk/bin/']),
});

function requireString(value, label) {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (!selected) throw new Error(`${label} is required`);
  return selected;
}

/** Validate a feed object layout (`studio` or `legacy`). */
export function assertFeedLayout(layout, label = 'feed layout') {
  const selected = requireString(layout, label);
  if (!FEED_LAYOUTS.includes(selected)) throw new Error(`${label} must be one of ${FEED_LAYOUTS.join(', ')}`);
  return selected;
}

/** Validate a feed target (electron-builder platform directory). */
export function assertFeedTarget(target, label = 'feed target') {
  const selected = requireString(target, label);
  if (!RELEASE_FEED_TARGETS.includes(selected)) throw new Error(`${label} must be one of ${RELEASE_FEED_TARGETS.join(', ')}`);
  return selected;
}

/** Parse a comma-separated feed layout list (for example `--compat-layouts`). */
export function parseFeedLayoutList(value, label = 'feed layouts') {
  const selected = requireString(value, label);
  return [...new Set(selected.split(',').map(part => assertFeedLayout(part, label)))];
}

/** Object key of one channel feed, for example `studio/feeds/mac-arm64/nightly-mac.yml`. */
export function feedObjectKey({ layout, channel, target = 'mac-arm64' } = {}) {
  const selectedLayout = assertFeedLayout(layout);
  const selectedTarget = assertFeedTarget(target);
  const filename = selectedTarget === 'win-x64' ? windowsChannelMetadataFilename(channel) : channelMetadataFilename(channel);
  return `${LAYOUT_OBJECT_ROOTS[selectedLayout]}/feeds/${selectedTarget}/${filename}`;
}

/**
 * Build the evidence recorded for one compatibility mirror in a publication
 * report. Kept here so every publisher reports the same fields.
 */
export function compatMirrorEvidence({ mirror, feedUrl, bytes, status = 'unchanged', uploaded = [] } = {}) {
  if (!mirror || typeof mirror !== 'object' || typeof mirror.objectKey !== 'string'
    || typeof mirror.targetChannel !== 'string' || typeof mirror.targetLayout !== 'string') {
    throw new Error('compatibility mirror evidence needs one planned mirror');
  }
  const url = requireString(feedUrl, 'compatibility mirror feed URL');
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!payload.length) throw new Error('compatibility mirror evidence needs the mirrored feed bytes');
  if (!['updated', 'unchanged'].includes(status)) throw new Error('compatibility mirror status must be updated or unchanged');
  return {
    version: mirror.version,
    sourceChannel: mirror.sourceChannel,
    targetChannel: mirror.targetChannel,
    targetLayout: mirror.targetLayout,
    objectKey: mirror.objectKey,
    feedUrl: url,
    feedBytes: payload.length,
    feedSha512: createHash('sha512').update(payload).digest('base64'),
    status,
    uploaded,
  };
}

/**
 * Parse and validate feed metadata that is about to be republished.
 *
 * `layout` describes where the feed object lives; `allowedBinaryPrefixes`
 * describes where its immutable binary may live. Both default to the same
 * layout for canonical publications, and the legacy layout keeps accepting the
 * canonical `studio/` prefix that installed dsh-desk clients already read.
 *
 * @param {Buffer | string} bytes Raw feed bytes.
 * @param {{ expectedVersion: string, storageOrigin: string, layout?: 'studio' | 'legacy', allowedBinaryPrefixes?: string[] }} expected
 * @returns {{ version: string, binaryUrl: string, size: number, sha512: string }} Validated feed facts.
 */
export function verifyMirroredFeed(bytes, { expectedVersion, storageOrigin, layout = 'studio', allowedBinaryPrefixes } = {}) {
  const selectedLayout = assertFeedLayout(layout);
  const version = requireString(expectedVersion, 'expected version');
  const storage = requireString(storageOrigin, 'storage origin');
  const prefixes = allowedBinaryPrefixes === undefined ? LAYOUT_BINARY_PREFIXES[selectedLayout] : allowedBinaryPrefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0
    || prefixes.some(prefix => typeof prefix !== 'string' || !prefix.startsWith('/') || prefix.endsWith('//'))) {
    throw new Error('allowed binary prefixes must be absolute path prefixes');
  }
  let feed;
  try { feed = YAML.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('source feed is invalid'); }
  if (!feed || typeof feed !== 'object' || typeof feed.version !== 'string') throw new Error('source feed is invalid');
  if (feed.version !== version) throw new Error(`source feed version ${feed.version} does not equal ${version}`);
  const file = feed.files?.[0];
  if (!file || typeof file.url !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.sha512 !== 'string' || !file.sha512) {
    throw new Error('source feed does not describe one immutable binary');
  }
  let binary;
  try { binary = new URL(file.url); } catch { throw new Error('source feed binary URL is not absolute'); }
  if (binary.protocol !== 'https:' || binary.origin !== storage || binary.search || binary.hash) {
    throw new Error('source feed binary URL escapes the release storage');
  }
  if (!prefixes.some(prefix => binary.pathname.startsWith(prefix))) {
    throw new Error(`source feed binary URL is outside the ${selectedLayout} feed binary prefixes (${prefixes.join(', ')})`);
  }
  return { version: feed.version, binaryUrl: binary.href, size: file.size, sha512: file.sha512 };
}

function channelList(channels, label) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error(`${label} must be a non-empty channel list`);
  return [...new Set(channels.map(channel => assertReleaseChannel(channel, label)))];
}

/**
 * Plan the compatibility mirrors for one published feed.
 *
 * Each mirror copies the exact source feed bytes onto a compatibility channel
 * object, in every selected layout. The source channel is skipped (its canonical
 * object is already being published), so mirroring a `preview` publication is a
 * no-op and repeated runs stay idempotent.
 *
 * @returns {{ version: string, sourceChannel: string, target: string, mirrors: Array<{ version: string, sourceChannel: string, targetChannel: string, targetLayout: string, objectKey: string, contentType: string }> }}
 */
export function compatMirrorPlan({ version, sourceChannel, target = 'mac-arm64',
  channels = COMPATIBILITY_RELEASE_CHANNELS, layouts = FEED_LAYOUTS } = {}) {
  const selectedVersion = requireString(version, 'feed version');
  const source = assertReleaseChannel(sourceChannel, 'source channel');
  assertChannelSupportsVersion(source, selectedVersion, 'source feed version');
  const selectedTarget = assertFeedTarget(target);
  const selectedChannels = channelList(channels, 'compatibility channels')
    .filter(channel => channel !== source);
  const selectedLayouts = Array.isArray(layouts) && layouts.length > 0
    ? [...new Set(layouts.map(layout => assertFeedLayout(layout)))]
    : (() => { throw new Error('compatibility layouts must be a non-empty feed layout list'); })();
  const mirrors = [];
  for (const targetChannel of selectedChannels) {
    assertChannelSupportsVersion(targetChannel, selectedVersion, 'mirror feed version');
    for (const targetLayout of selectedLayouts) {
      mirrors.push({
        version: selectedVersion,
        sourceChannel: source,
        targetChannel,
        targetLayout,
        objectKey: feedObjectKey({ layout: targetLayout, channel: targetChannel, target: selectedTarget }),
        contentType: 'application/yaml',
      });
    }
  }
  return { version: selectedVersion, sourceChannel: source, target: selectedTarget, mirrors };
}

function assertOrigin(value, label) {
  const selected = requireString(value, label);
  let parsed;
  try { parsed = new URL(selected); } catch { throw new Error(`${label} must be an absolute origin`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTPS origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

/**
 * Expand a mirror plan into the exact upload list, one entry per target object
 * and origin. Uploading the same bytes to several origins is intentional: the
 * feed origin and the storage origin may be served by different buckets.
 */
export function compatMirrorUploads(plan, { origins = [] } = {}) {
  if (!plan || !Array.isArray(plan.mirrors)) throw new Error('compatibility mirror plan is required');
  if (!Array.isArray(origins) || origins.length === 0) throw new Error('compatibility mirror needs at least one upload origin');
  const selectedOrigins = [...new Set(origins.map(origin => assertOrigin(origin, 'compatibility mirror origin')))];
  return plan.mirrors.flatMap(mirror => selectedOrigins.map(origin => ({
    origin,
    objectKey: mirror.objectKey,
    contentType: mirror.contentType,
  })));
}

/**
 * Decide whether an existing compatibility feed already carries the published
 * bytes. A current target is left untouched so repeated publications/mirrors
 * neither fail nor record duplicate uploads.
 */
export function compatMirrorIsCurrent(current, desired) {
  if (current === undefined || current === null || desired === undefined || desired === null) return false;
  return Buffer.from(current).equals(Buffer.from(desired));
}
