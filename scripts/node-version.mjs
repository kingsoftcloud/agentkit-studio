/** Node.js support matrix for the October 2026 security release.
 *
 * CVE-2026-111497 (Brotli decoder remote code execution) and the TLS
 * hostname-verification fixes shipped in 22.23.4, 24.22.1 and 26.12.1.
 * Studio refuses runtimes that predate the fix on their release line;
 * future majors are newer than every fixed release.
 */
const FIXED_MINIMUMS = Object.freeze({
  22: Object.freeze([23, 4]),
  24: Object.freeze([22, 1]),
  26: Object.freeze([12, 1]),
});

export const NODE_VERSION_GUIDANCE = 'Node.js 22.23.4+（22.x）、24.22.1+（24.x）或 26.12.1+（26.x）';

/** Parse `v22.23.4` / `22.23.4` into [major, minor, patch]. */
export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(version).trim());
  if (!match) throw new Error(`无法解析 Node.js 版本：${version}`);
  return match.slice(1, 4).map(Number);
}

export function nodeVersionSupported(version) {
  const [major, minor, patch] = parseNodeVersion(version);
  const minimum = FIXED_MINIMUMS[major];
  if (minimum === undefined) return major > 26;
  const [minimumMinor, minimumPatch] = minimum;
  return minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch);
}

export function nodeVersionSummary(version) {
  return `Node.js ${version}（安全基线 22.23.4 / 24.22.1 / 26.12.1）`;
}
