/** Fail fast when the local Node.js runtime predates the October 2026 security release.
 *
 * Usage: node scripts/check-node-version.mjs [version]
 * The optional version makes the gate testable without changing the host runtime.
 */
import { NODE_VERSION_GUIDANCE, nodeVersionSupported, nodeVersionSummary } from './node-version.mjs';

const version = process.argv[2] ?? process.versions.node;
if (!nodeVersionSupported(version)) {
  console.error(`Node.js ${version} 低于安全基线；请安装 ${NODE_VERSION_GUIDANCE}（见 .node-version）。`);
  process.exit(1);
}
console.log(nodeVersionSummary(version));
