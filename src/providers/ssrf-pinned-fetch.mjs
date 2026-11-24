import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';
import { hostFetch } from '../http-fetch.mjs';

// Keep the v4 and v6 tables separate. Node's BlockList can match v4
// addresses against mapped v6 subnets when both share one list.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 29], ['192.0.0.170', 31],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]) blockedV4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::1', 128], ['::', 128], ['::ffff:0:0', 96], ['100::', 64], ['2001::', 23],
  ['2001:2::', 48], ['2001:db8::', 32], ['2001:10::', 28], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['fec0::', 10], ['::', 8], ['100::', 8], ['200::', 7], ['400::', 6],
  ['800::', 5], ['1000::', 4], ['4000::', 3], ['6000::', 3], ['8000::', 3],
  ['a000::', 3], ['c000::', 3], ['e000::', 4], ['f000::', 5], ['f800::', 6], ['fe00::', 9],
]) blockedV6.addSubnet(address, prefix, 'ipv6');

export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, 'ipv4');
  if (family !== 6) return true;
  const mappedV4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address)?.[1];
  if (mappedV4 && isIP(mappedV4) === 4 && blockedV4.check(mappedV4, 'ipv4')) return true;
  return blockedV6.check(address, 'ipv6');
}

/** Build an undici Agent whose connect.lookup validates every resolved
 *  address against the SSRF block, so the actual TCP connection only ever
 *  reaches a pre-validated public address. This is defense-in-depth on top of
 *  the pure adapter's own DNS check: even a DNS-rebinding race (the record
 *  changing between the pre-check and the fetch) is caught here because undici
 *  resolves the hostname again through this lookup hook immediately before
 *  connecting. No new dependency is introduced — undici is already the Host
 *  fetch dispatcher. The returned { fetch, close } uses the Agent as its
 *  dispatcher; close() releases the Agent so the process can exit cleanly. */
export function createSsrfPinnedFetch({ fetchImpl = hostFetch, ssrfBlockCheck, lookupAddress = lookup }) {
  if (typeof ssrfBlockCheck !== 'function') return { fetch: fetchImpl, close: () => {} };
  // A failure to construct the protecting Agent is fatal: never fall back to
  // an unpinned fetch that could connect to a private address.
  const agent = new Agent({ connect: { lookup: (host, options, callback) => {
    // undici re-resolves the hostname here right before connecting; reject
    // any non-public address. A literal IP host bypasses DNS but is still
    // checked against the block list. This is the actual connection pin.
    const bare = /^\[(.+)\]$/.exec(host) ? host.slice(1, -1) : host;
    if (isIP(bare) && ssrfBlockCheck(bare)) { const err = new Error(`blocked non-public address: ${bare}`); err.code = 'blocked_by_ssrf_policy'; return callback(err); }
    lookupAddress(bare, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses?.length) return callback(Object.assign(new Error('DNS returned no addresses'), { code: 'ENOTFOUND' }));
      for (const { address, family } of addresses) if (ssrfBlockCheck(address)) { const e = new Error(`blocked non-public address: ${address}`); e.code = 'blocked_by_ssrf_policy'; return callback(e); }
      // undici's connect.lookup may request either an array (options.all) or a
      // single (address, family) tuple. Return the shape the caller asked for.
      if (options.all) callback(null, addresses);
      else { const first = addresses[0]; callback(null, first.address, first.family); }
    });
  } } });
  const pinnedFetch = (url, init) => fetchImpl(url, { ...init, dispatcher: agent });
  // close() returns the Agent's close Promise so the caller can await full
  // release of the underlying sockets; never swallow the Promise.
  const close = () => agent.close();
  return { fetch: pinnedFetch, close };
}
