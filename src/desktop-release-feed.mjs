/** Validate one channel feed before it is copied onto another channel object.
 *
 * A feed is the only mutable release object: it names one immutable binary by
 * absolute URL plus the digest electron-updater checks. Mirroring a feed is
 * therefore safe only when it still describes exactly one HTTPS binary inside
 * the selected release storage, so the copy step validates that first.
 */
import YAML from 'yaml';

const BINARY_PREFIXES = Object.freeze({ studio: '/studio/', legacy: '/dsh-desk/bin/' });

/**
 * Parse and validate feed metadata that is about to be republished.
 * @param {Buffer | string} bytes Raw feed bytes.
 * @param {{ expectedVersion: string, storageOrigin: string, layout?: 'studio' | 'legacy' }} expected
 * @returns {{ version: string, binaryUrl: string, size: number, sha512: string }} Validated feed facts.
 */
export function verifyMirroredFeed(bytes, { expectedVersion, storageOrigin, layout = 'studio' } = {}) {
  const prefix = BINARY_PREFIXES[layout];
  if (prefix === undefined) throw new Error('mirrored feed layout must be studio or legacy');
  let feed;
  try { feed = YAML.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('source feed is invalid'); }
  if (!feed || typeof feed !== 'object' || typeof feed.version !== 'string') throw new Error('source feed is invalid');
  if (feed.version !== expectedVersion) throw new Error(`source feed version ${feed.version} does not equal ${expectedVersion}`);
  const file = feed.files?.[0];
  if (!file || typeof file.url !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.sha512 !== 'string' || !file.sha512) {
    throw new Error('source feed does not describe one immutable binary');
  }
  let binary;
  try { binary = new URL(file.url); } catch { throw new Error('source feed binary URL is not absolute'); }
  if (binary.protocol !== 'https:' || binary.origin !== storageOrigin || !binary.pathname.startsWith(prefix) || binary.search || binary.hash) {
    throw new Error('source feed binary URL escapes the release storage');
  }
  return { version: feed.version, binaryUrl: binary.href, size: file.size, sha512: file.sha512 };
}
