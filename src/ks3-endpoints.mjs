/**
 * Runtime-owned KS3 endpoint selection.
 *
 * Cloud control planes hand out download URLs on the public KS3 domain, but a
 * compute pool without public egress (a ``private_only`` node) can only reach
 * the region's internal endpoint. A KS3 V4 signature covers the path and query
 * only, so a pre-signed URL stays valid after the host swap.
 *
 * Selection is deliberately layered: the platform-declared network mode (env
 * ``AGENTENGINE_NETWORK_MODE``) wins, then an explicit operator override
 * (``AGENTKIT_KS3_ENDPOINT_MODE``, aligned with ksadk), then a cached TCP probe.
 * The chosen order is only a preference: a request that fails at the transport
 * level is retried against the other variant, and the variant that actually
 * worked is remembered. Downloads are idempotent GETs, so this retry cannot
 * duplicate a side effect; upload callers must resolve the endpoint before
 * signing instead of using this helper.
 */
import { connect } from 'node:net';

export const KS3_REGIONS = Object.freeze(new Set([
  'cn-beijing', 'cn-shanghai', 'cn-guangzhou', 'cn-ningbo', 'cn-qinghai',
  'cn-qingyang', 'cn-hongkong', 'rus', 'sgp',
]));

const KS3_HOSTNAME = /^(?:(?<bucket>[a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.)?ks3-(?<region>[a-z0-9-]+)\.ksyuncs\.com$/i;
const INTERNAL_SUFFIX = '-internal';
const REACHABLE_TTL_MS = 5 * 60 * 1000;
const PREFERRED_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1500;
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EADDRNOTAVAIL',
]);

// Public-endpoint reachability and the variant a real request last succeeded
// with. Both are per-process caches; a wrong probe only costs one retry.
const reachability = new Map();
const preferredVariants = new Map();
const probesInFlight = new Map();

/** Test hook: forget every cached endpoint decision. */
export function resetKs3EndpointCaches() {
  reachability.clear();
  preferredVariants.clear();
  probesInFlight.clear();
}

export class Ks3EndpointError extends Error {
  constructor(variants, attempts) {
    const hosts = [variants.publicUrl.host, variants.internalUrl.host];
    super(`KS3 存储地址不可达（已尝试 ${hosts.join(' / ')}）`);
    this.name = 'Ks3EndpointError';
    this.code = 'KS3_ENDPOINT_UNREACHABLE';
    this.details = { hosts, attempts };
  }
}

/** Cloud data regions carry a numeric suffix (``cn-beijing-6``); KS3 hostnames do not. */
export function normalizeKs3Region(region) {
  const normalized = String(region || '').trim().toLowerCase().replace(/-\d+$/, '');
  return KS3_REGIONS.has(normalized) ? normalized : null;
}

/** Parse an official KS3 hostname into ``{ bucket, region, internal }``; null otherwise. */
export function parseKs3Hostname(hostname) {
  const match = KS3_HOSTNAME.exec(String(hostname || '').trim());
  if (!match) return null;
  let region = match.groups.region;
  let internal = false;
  if (region.endsWith(INTERNAL_SUFFIX)) { internal = true; region = region.slice(0, -INTERNAL_SUFFIX.length); }
  const normalized = normalizeKs3Region(region);
  if (!normalized) return null;
  return Object.freeze({ bucket: match.groups.bucket || null, region: normalized, internal });
}

function ks3Hostname({ bucket, region }, internal) {
  return `${bucket ? `${bucket}.` : ''}ks3-${region}${internal ? INTERNAL_SUFFIX : ''}.ksyuncs.com`;
}

/**
 * Build both official variants of a KS3 URL, preserving scheme, port, path,
 * query and fragment. Returns null for any URL that is not an official KS3
 * address, so callers never rewrite an arbitrary origin.
 */
export function ks3Variants(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  const host = parseKs3Hostname(parsed.hostname);
  if (!host) return null;
  const build = internal => {
    const copy = new URL(parsed.toString());
    copy.host = `${ks3Hostname(host, internal)}${parsed.port ? `:${parsed.port}` : ''}`;
    return copy;
  };
  return { host, publicUrl: build(false), internalUrl: build(true) };
}

/** TCP reachability of the region's public KS3 endpoint; DNS failures count as unreachable. */
export function probeKs3PublicReachability(region, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const socket = connect({ host: ks3Hostname({ bucket: null, region }, false), port: 443 });
    const finish = reachable => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function transportCode(error) {
  for (const value of [error?.code, error?.cause?.code, error?.errno]) {
    if (typeof value === 'string' && (TRANSPORT_CODES.has(value) || value.startsWith('UND_ERR_'))) return value;
  }
  return '';
}

/** A failed connection is the only signal that justifies retrying another host. */
export function isKs3TransportError(error) {
  if (!error || error.name === 'AbortError') return false;
  if (transportCode(error)) return true;
  // undici reports DNS/connect failures as TypeError('fetch failed', { cause }).
  return error.name === 'TypeError' && /fetch failed/i.test(String(error.message || ''));
}

function rememberedMode(region) {
  const cached = preferredVariants.get(region);
  if (cached && cached.expiresAt > Date.now()) return cached.mode;
  preferredVariants.delete(region);
  return null;
}

function rememberMode(region, mode) {
  preferredVariants.set(region, { mode, expiresAt: Date.now() + PREFERRED_TTL_MS });
}

async function publicReachable(region, probe) {
  const cached = reachability.get(region);
  if (cached && cached.expiresAt > Date.now()) return cached.reachable;
  const pending = probesInFlight.get(region);
  if (pending) return pending;
  const task = Promise.resolve()
    .then(() => probe(region))
    .then(reachable => {
      reachability.set(region, { reachable: Boolean(reachable), expiresAt: Date.now() + REACHABLE_TTL_MS });
      return Boolean(reachable);
    })
    .catch(() => false)
    .finally(() => probesInFlight.delete(region));
  probesInFlight.set(region, task);
  return task;
}

/**
 * Resolve the preferred endpoint mode for a region:
 * explicit operator override -> last variant that actually worked -> platform
 * declaration -> cached TCP probe. Observed reachability outranks a declared
 * mode because it can only be recorded after a successful transfer.
 * ``internal`` is also accepted as an alias for private network environments.
 */
export async function resolveEndpointMode({ env = process.env, region, probe = probeKs3PublicReachability } = {}) {
  const override = String(env.AGENTKIT_KS3_ENDPOINT_MODE || '').trim().toLowerCase();
  if (override === 'public') return 'public';
  if (override === 'internal' || override === 'private') return 'internal';
  const remembered = rememberedMode(region);
  if (remembered) return remembered;
  const declared = String(env.AGENTENGINE_NETWORK_MODE || '').trim().toLowerCase();
  if (declared === 'public') return 'public';
  if (declared === 'private' || declared === 'internal') return 'internal';
  return (await publicReachable(region, probe)) ? 'public' : 'internal';
}

/**
 * Fetch a KS3 object, preferring the variant the workload can reach and
 * retrying the other variant on a transport-level failure. Non-KS3 URLs are
 * passed through untouched.
 */
export async function fetchKs3(url, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const variants = ks3Variants(url);
  if (!variants) return fetchImpl(url, init);
  const region = variants.host.region;
  const mode = options.mode
    || await resolveEndpointMode({ env: options.env || process.env, region, probe: options.probe });
  const order = mode === 'internal'
    ? [variants.internalUrl, variants.publicUrl]
    : [variants.publicUrl, variants.internalUrl];
  const attempts = [];
  for (const target of order) {
    try {
      const response = await fetchImpl(target, init);
      rememberMode(region, parseKs3Hostname(target.hostname)?.internal ? 'internal' : 'public');
      return response;
    } catch (error) {
      if (!isKs3TransportError(error)) throw error;
      attempts.push({ url: `${target.origin}${target.pathname}`, code: transportCode(error) || 'TRANSPORT_FAILED' });
      // A cancelled request must not be retried behind the caller's back.
      if (init.signal?.aborted) break;
    }
  }
  throw new Ks3EndpointError(variants, attempts);
}
