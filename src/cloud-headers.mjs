/**
 * Source attribution for every outbound cloud request Studio makes.
 *
 * One header, one resolver, one default. The value is a *traffic source* tag the
 * platform uses to tell Studio-originated calls apart from agent-runtime ones;
 * it is not a credential and never carries tenant data.
 *
 * Mirrors `ksadk/common/cloud_headers.py` in the Python SDK so both runtimes
 * report the same vocabulary:
 *
 * - `KSADK_TRAFFIC_SOURCE` is the single override, defaulting to `agentkit`.
 * - A caller-supplied header is dropped (case-insensitively) before the
 *   canonical one is written, so a request cannot smuggle a second value.
 * - Only printable ASCII is accepted: CR/LF would otherwise split the header,
 *   and a header record is not a place to discover that at the transport.
 */

export const DEFAULT_TRAFFIC_SOURCE = 'agentkit';
export const TRAFFIC_SOURCE_HEADER = 'X-Traffic-Source';

/** Resolve an explicit value, the process setting, or the stable default. */
export function resolveTrafficSource(value) {
  const raw = value === undefined || value === null ? process.env.KSADK_TRAFFIC_SOURCE ?? '' : value;
  if (typeof raw !== 'string' || /[^\x20-\x7e]/u.test(raw)) {
    throw Object.assign(new Error('Traffic source must contain printable ASCII characters only'), {
      code: 'TRAFFIC_SOURCE_INVALID',
    });
  }
  return raw.trim() || DEFAULT_TRAFFIC_SOURCE;
}

/**
 * Copy `headers` and stamp one canonical source header.
 *
 * Any existing spelling of the same header is removed first, so callers cannot
 * end up sending both `X-Traffic-Source` and `x-traffic-source` to a gateway
 * that then picks whichever one it happens to read.
 */
export function buildCloudHeaders(headers, trafficSource) {
  const result = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== TRAFFIC_SOURCE_HEADER.toLowerCase()),
  );
  result[TRAFFIC_SOURCE_HEADER] = resolveTrafficSource(trafficSource);
  return result;
}
