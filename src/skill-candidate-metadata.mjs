/** Pure skill candidate metadata: directory exclusion and risk classification.
 *
 * Ported from ksadk/studio/skill_discovery.py inspect_candidate (lines 507-535)
 * and _safe_directory (line 565). No file I/O, no network, no code execution.
 *
 * Script suffixes use the inspect_candidate inline set (line 510): {.py, .sh,
 * .js, .ts, .ps1} — NOT the top-level SCRIPT_SUFFIXES (line 32) which also
 * includes .tsx and .rb.
 */
import { posix } from 'node:path';

const EXCLUDED_PARTS = new Set(['.git', '.venv', 'venv', 'node_modules', 'dist', 'build', '__pycache__']);
const RISK_SCRIPT_SUFFIXES = new Set(['.py', '.sh', '.js', '.ts', '.ps1']);
const NETWORK_MARKERS = ['http://', 'https://', 'curl ', 'wget ', 'network'];

/** Any POSIX path segment in EXCLUDED_PARTS? (skill_discovery.py:565) */
export function skillCandidateExcluded(path) {
  if (typeof path !== 'string' || !path) return false;
  return path.split('/').some(part => EXCLUDED_PARTS.has(part));
}

/** Risk classification from manifest text + file paths. (inspect_candidate:507-535) */
export function skillCandidateRisk({ manifestText, paths }) {
  if (typeof manifestText !== 'string' || !Array.isArray(paths)) {
    return { containsScripts: false, scripts: [], networkMarkers: [], requiresReview: false };
  }
  const scripts = paths.filter(path => RISK_SCRIPT_SUFFIXES.has(posix.extname(path).toLowerCase()));
  const text = manifestText.toLowerCase();
  const networkMarkers = NETWORK_MARKERS.filter(marker => text.includes(marker));
  const requiresReview = scripts.length > 0 || networkMarkers.length > 0;
  return { containsScripts: scripts.length > 0, scripts, networkMarkers, requiresReview };
}
